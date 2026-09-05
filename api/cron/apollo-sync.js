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

import { searchContactsByStage } from "../../lib/apollo.js";
import { findOrCreatePerson, findDealsByPersonId, createDeal } from "../../lib/pipedrive.js";
import { getState, setState } from "./../../lib/kv.js";

const STAGE_ID = process.env.APOLLO_STAGE_ID || "6a8ab4ad5a018d0020c4bd18"; // "Cold"
const PIPELINE_ID = Number(process.env.PIPEDRIVE_PIPELINE_ID || 4); // "MN: Enrolment"
const STAGE_ID_NEW_LEAD = Number(process.env.PIPEDRIVE_STAGE_ID_NEW_LEAD || 20);
const MAX_PAGES_PER_RUN = 5; // safety cap; a bigger-than-usual backlog just finishes over a few days

const CURSOR_KEY = "apollo-sync:lastSyncedUpdatedAt";

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

  const lastSyncedAt = await getState(CURSOR_KEY, null);
  const { cohortLetter, cohortStartDate } = currentCohort();

  let page = 1;
  let created = 0;
  let skippedNoEmail = 0;
  let newestSeen = lastSyncedAt;
  let reachedCursor = false;

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

        const person = await findOrCreatePerson({ name: contact.name, email, linkedinUrl: contact.linkedin_url });
        const existingDeals = await findDealsByPersonId(person.id);
        if (existingDeals && existingDeals.length > 0) continue; // already synced

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
      }

      if (page >= totalPages) break;
      page++;
    }

    if (newestSeen && newestSeen !== lastSyncedAt) {
      await setState(CURSOR_KEY, newestSeen);
    }

    return res.status(200).json({
      ok: true,
      created,
      skippedNoEmail,
      pagesProcessed: page,
      reachedCursor,
      cohort: cohortLetter,
    });
  } catch (err) {
    console.error("apollo-sync failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
