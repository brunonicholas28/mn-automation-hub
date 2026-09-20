// Job: apollo-sync.
// Moved out of api/cron/ so all four cron jobs share one serverless function.
// Vercel Hobby caps a deployment at 12 functions and we were at 12.
// api/cron/run.js dispatches here; the old /api/cron/apollo-sync URL still works
// via a rewrite in vercel.json, so every existing caller keeps working.
// Replaces the old Zapier "Apollo to Pipedrive - New Lead" Zap.
// Polls Apollo for contacts in the Cold/In-Sequence stage, newest-updated
// first, and creates the matching Pipedrive person + deal for any contact
// not yet synced. Runs once/day on Vercel's free Hobby cron tier (see
// vercel.json) - see the build plan doc for why daily is fine here.
//
// Also auto-tags each new deal with a rolling Cohort (A/B/C/D by week) and
// Cohort Start Date, which was previously a manual step (Phase 1 step 1 in
// linkedin-outreach-automation-gameplan.md) - doing it here removes that
// manual step entirely.

import { searchContactsByStage } from "../apollo.js";
import {
  findOrCreatePerson,
  findDealsByPersonId,
  createDeal,
  pipedriveSpentToday,
  flushPipedriveSpend,
  PIPEDRIVE_DAILY_BUDGET,
} from "../pipedrive.js";
import { getState, setState } from "./../kv.js";
import { screenProspect } from "../icp.js";
import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

const kv = Redis.fromEnv();

const STAGE_ID = process.env.APOLLO_STAGE_ID || "6a8ab4ad5a018d0020c4bd18"; // "Cold"
const PIPELINE_ID = Number(process.env.PIPEDRIVE_PIPELINE_ID || 4); // "MN: Enrolment"
const STAGE_ID_NEW_LEAD = Number(process.env.PIPEDRIVE_STAGE_ID_NEW_LEAD || 20);

// Was 5, then 3. Now 30, because the page cap is no longer what protects this
// job and was quietly the thing stopping it.
//
// On 2026-09-19 run #5 reported created:0 on all ten calls with
// skippedAlreadySynced settling at 299 and reachedCursor:false. Three pages is
// 300 contacts, so the job was looking at the newest 300 in the Cold stage,
// finding every one of them already in Pipedrive, and stopping - never once
// reaching page 4. Anything unsynced further down the list was unreachable.
//
// The run is now bounded by the clock and by the Pipedrive budget, both of
// which stop cleanly and say so. A page cap bounds nothing useful: a page of
// already-synced contacts costs no Pipedrive calls at all, so sweeping deep is
// close to free and the guards still catch a page full of genuinely new people.
const MAX_PAGES_PER_RUN = Number(process.env.APOLLO_MAX_PAGES || 30);

const CURSOR_KEY = "apollo-sync:lastSyncedUpdatedAt";
const SCREEN_KEY = "apollo-sync:icpScreen:latest";

// Why this exists, 2026-09-18.
//
// This job exhausted Pipedrive's DAILY API request budget and then 429'd for
// days, which starved mint-batch, which starved export-cohort, which starved
// the hook research. Nothing alerted, because every link in the chain treats
// "nothing to do" as success.
//
// The cursor alone was not enough. Apollo bumps contact_updated_at whenever a
// contact is touched or re-enriched, so the same people kept looking new every
// hour and were re-checked against Pipedrive - two calls each - only to be
// skipped for already having a deal. At roughly 3 calls per contact, 5 pages,
// every hour, that is thousands of wasted calls a day.
//
// So: remember who we have already synced, in our own store, and never ask
// Pipedrive about them again. A contact we have seen now costs zero Pipedrive
// calls instead of two.
// Stored as short digests rather than addresses: the set is read in full on
// every run, and at 6,600 sends a month a year of raw emails would be megabytes
// of needless transfer four times a day. It also avoids keeping a second copy
// of every prospect's address in a key that nothing else needs to read.
const SYNCED_SET = "apollo-sync:synced";
const digest = (email) =>
  crypto.createHash("sha256").update(String(email).trim().toLowerCase()).digest("base64url").slice(0, 12);

// Hard stop before Pipedrive's own limit, so a bad day degrades into "we did
// some of it and said so" instead of an outage that takes the week's cohort
// with it.
//
// The ceiling and the counter now live in lib/pipedrive.js, where every job
// spending against the same token is counted. This job kept its own private
// tally until run #6 on 2026-09-19, when Pipedrive refused it at 1106 calls
// while that tally read a comfortable 1080 of 1200 - mint-batch, cohort-build,
// linkedin-shortlist and poll-funnel were spending the same budget and were
// invisible to it.
const DAILY_BUDGET = PIPEDRIVE_DAILY_BUDGET;
const CALLS_PER_CONTACT = 3; // persons/search, deals-by-person, createDeal

// Why this exists, 2026-09-19.
//
// The first run with the synced set in place died on a Vercel 504
// (FUNCTION_INVOCATION_TIMEOUT) after 60 seconds. Nothing was wrong with the
// logic: the set starts empty, so the run has to back-fill it by asking
// Pipedrive about every contact it already knows - two calls each, several
// hundred contacts - and a serverless function on the Hobby plan gets 60
// seconds, full stop.
//
// A hard timeout is the worst way to stop, because the run is killed between
// statements: the day's Pipedrive spend was only written after the loop, so a
// killed run spent hundreds of calls and recorded none of them. Re-running it
// a few times would have walked straight back into the exhausted-budget
// outage this file was rewritten to prevent.
//
// So the run now watches the clock, stops itself while it still has time to
// tidy up, and says it was not finished. The workflow calls again until the
// response says it is done.
const RUN_DEADLINE_MS = Number(process.env.APOLLO_MAX_MS || 40000);

// Spend is recorded by the Pipedrive client itself now, on every call, so
// there is nothing left for this job to tally by hand.

// Exported so the guard that decides whether the week's supply keeps flowing is
// covered by a test rather than by hope. Returns true when processing one more
// contact would take the day's Pipedrive spend past the budget.
export function wouldExceedBudget(spentToday, callsThisRun, budget = DAILY_BUDGET, perContact = CALLS_PER_CONTACT) {
  return Number(spentToday || 0) + Number(callsThisRun || 0) + perContact > budget;
}
// Exported for the same reason as wouldExceedBudget: getting this wrong is
// silent. Advancing the cursor after an early stop makes every later run
// report a clean "nothing to do" while the queue sits untouched, which is
// indistinguishable from success until a cohort comes up empty.
export function hasSweptQueue({ reachedCursor, pagesExhausted, budgetStopped, timeStopped }) {
  return Boolean((reachedCursor || pagesExhausted) && !budgetStopped && !timeStopped);
}

export { digest as emailDigest };

function currentCohort() {
  const now = new Date();
  const monday = new Date(now);
  const day = monday.getUTCDay(); // 0 = Sunday
  const diffToMonday = (day + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);

  const jan1 = new Date(Date.UTC(monday.getUTCFullYear(), 0, 1));
  const weekNumber = Math.floor((monday - jan1) / (7 * 24 * 60 * 60 * 1000));
  const letters = ["A", "B", "C", "D"];
  return {
    cohortLetter: letters[weekNumber % 4],
    cohortStartDate: monday.toISOString().slice(0, 10),
  };
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  // The synced set is a cache of a question we used to answer wrongly. Every
  // entry written before 2026-09-20 records "this contact already has a
  // Pipedrive deal", decided by a lookup that always said yes (see
  // findDealsByPersonId in lib/pipedrive.js). Fixing the lookup does nothing on
  // its own: the cache answers first, so the corrected code is never reached.
  //
  // reset=1 empties it and clears the cursor, forcing a genuine re-check of
  // everyone. It is deliberately a manual switch rather than something a
  // deploy does automatically - re-checking every contact costs two Pipedrive
  // calls each, which is most of a day's budget.
  if (String(req.query?.reset || "") === "1") {
    await kv.del(SYNCED_SET);
    await setState(CURSOR_KEY, null);
    console.log("apollo-sync: synced set and cursor cleared by reset=1");
  }

  const lastSyncedAt = await getState(CURSOR_KEY, null);
  const { cohortLetter, cohortStartDate } = currentCohort();

  // One read, held in memory for the run. Asking Upstash per contact would be
  // correct too but adds a round trip to every one of them for no benefit.
  const syncedEmails = new Set(((await kv.smembers(SYNCED_SET)) || []).filter(Boolean));
  const spentToday = await pipedriveSpentToday();

  let page = 1;
  let created = 0;
  let skippedNoEmail = 0;
  let skippedAlreadySynced = 0;
  let pdCalls = 0;
  let budgetStopped = false;
  let timeStopped = false;
  let newestSeen = lastSyncedAt;
  let reachedCursor = false;
  let pagesExhausted = false;

  const startedAt = Date.now();

  // The ICP screen runs here but does not gate anything. It records what it
  // would have questioned so the flags can be read for a few weeks before
  // anyone decides whether to act on them. See lib/icp.js for why it is built
  // to let people through rather than to filter them out.
  const screenCounts = { in: 0, review: 0, out: 0 };
  const flagged = [];

  try {
    while (page <= MAX_PAGES_PER_RUN && !reachedCursor) {
      const { contacts, totalPages } = await searchContactsByStage(STAGE_ID, { page });
      if (contacts.length === 0) break;

      for (const contact of contacts) {
        if (lastSyncedAt && contact.contact_updated_at <= lastSyncedAt) {
          reachedCursor = true;
          break;
        }
        if (!newestSeen || contact.contact_updated_at > newestSeen) {
          newestSeen = contact.contact_updated_at;
        }

        const email = contact.email;
        if (!email || email === "unavailable") {
          skippedNoEmail++;
          continue;
        }

        // Already synced on a previous run: costs nothing, ask nobody.
        const emailKey = digest(email);
        if (syncedEmails.has(emailKey)) {
          skippedAlreadySynced++;
          continue;
        }

        // Stop cleanly while there is still budget for everything else that
        // needs Pipedrive today, rather than running into a 429 and dying.
        if (wouldExceedBudget(spentToday, pdCalls)) {
          budgetStopped = true;
          break;
        }

        // Stop cleanly while there is still time to record what we spent,
        // rather than being killed mid-contact by the platform.
        if (Date.now() - startedAt > RUN_DEADLINE_MS) {
          timeStopped = true;
          break;
        }

        const person = await findOrCreatePerson({ name: contact.name, email, linkedinUrl: contact.linkedin_url });
        const existingDeals = await findDealsByPersonId(person.id);
        pdCalls += 2;
        if (existingDeals && existingDeals.length > 0) {
          // Pipedrive already has it; record that so the next run does not
          // spend two calls rediscovering the same fact.
          syncedEmails.add(emailKey);
          await kv.sadd(SYNCED_SET, emailKey);
          skippedAlreadySynced++;
          continue;
        }

        const screen = screenProspect({
          company: contact.organization_name,
          title: contact.title,
          employees: null,
          publiclyTraded: false,
          foundedYear: null,
        });
        screenCounts[screen.verdict] += 1;
        if (screen.verdict !== "in" && flagged.length < 200) {
          flagged.push({
            personId: person.id,
            company: contact.organization_name || "",
            title: contact.title || "",
            verdict: screen.verdict,
            reasons: screen.reasons,
            review: screen.review,
          });
        }

        await createDeal({
          title: `Cold Outreach - ${contact.organization_name || contact.name}`,
          personId: person.id,
          pipelineId: PIPELINE_ID,
          stageId: STAGE_ID_NEW_LEAD,
          customFieldsByName: {
            "Lead Source": "Cold outreach (Apollo/Instantly)",
            Cohort: cohortLetter,
            "Cohort Start Date": cohortStartDate,
          },
        });
        created++;
        pdCalls += 1;
        syncedEmails.add(emailKey);
        await kv.sadd(SYNCED_SET, emailKey);
      }

      if (budgetStopped || timeStopped) break;
      if (page >= totalPages) {
        pagesExhausted = true;
        break;
      }
      page++;
    }

    await flushPipedriveSpend();

    // A run that swept the whole queue has genuinely caught up, and the cursor
    // can move. A run that stopped early has NOT: it worked newest-first and
    // everything it did not reach is OLDER than the newest thing it saw, so
    // writing that timestamp would tell the next run to stop at the first
    // contact it looks at and report a clean "nothing to do" forever. Leaving
    // the cursor alone costs a re-scan of contacts already in the synced set,
    // which is free - they never reach Pipedrive.
    const sweptQueue = hasSweptQueue({ reachedCursor, pagesExhausted, budgetStopped, timeStopped });
    if (sweptQueue && newestSeen && newestSeen !== lastSyncedAt) {
      await setState(CURSOR_KEY, newestSeen);
    }

    if (flagged.length) {
      await setState(SCREEN_KEY, { at: new Date().toISOString(), counts: screenCounts, flagged });
    }

    return res.status(200).json({
      ok: true,
      created,
      skippedNoEmail,
      skippedAlreadySynced,
      pagesProcessed: page,
      reachedCursor,
      // The workflow loops on this: false means there is more queue to walk and
      // it should call again, true means this run caught up.
      done: sweptQueue,
      cohort: cohortLetter,
      pipedrive: {
        callsThisRun: pdCalls,
        spentToday: spentToday + pdCalls,
        dailyBudget: DAILY_BUDGET,
        budgetStopped,
        timeStopped,
      },
      // Surfaced so a run that quietly did nothing is visible in the workflow
      // log without anyone having to reason about it.
      note: budgetStopped
        ? "stopped early: Pipedrive daily budget guard tripped, will resume next run"
        : timeStopped
          ? "stopped early: hit the run time limit before the platform could kill us, call again to continue"
          : created === 0 && skippedAlreadySynced === 0 && !reachedCursor
            ? "no new contacts found in Apollo"
            : undefined,
      icpScreen: { counts: screenCounts, flagged: flagged.length, advisoryOnly: true },
    });
  } catch (err) {
    // Record what was spent before giving up. A failed run that hides its own
    // Pipedrive usage is how the budget went missing the first time.
    try {
      await flushPipedriveSpend();
    } catch (flushErr) {
      console.error("apollo-sync could not record its Pipedrive spend:", flushErr);
    }
    console.error("apollo-sync failed:", err);
    return res.status(500).json({ ok: false, error: err.message, pipedrive: { callsThisRun: pdCalls } });
  }
}
