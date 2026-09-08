// Builds the automated version of Phase 2 in
// claude/linkedin-outreach-automation-gameplan.md (previously just a plan -
// the only thing actually running was the Phase 1 manual weekly spreadsheet
// pull). Runs once/day; each run only acts on cohorts that are AT their
// day 5-6 window today, per claude/linkedin-lane2-scoring-spec.md.
//
// TWO OPEN DECISIONS this build could not resolve on its own (flagged, not
// guessed) - see the inline TODOs and the handoff notes:
//   1. Deal-value scoring input (criterion 3) - gameplan doc flags this needs
//      Marina's input: wait for real Growth Gap Report data, or use the
//      Apollo revenue/team-size proxy from day one. Currently reads a
//      "Revenue Band" Pipedrive field if present; treats anything there as
//      the proxy signal (score 5) until a report exists, and does NOT yet
//      implement the "Tier-3-shaped severity" upgrade to score 10 - that
//      needs Marina to define what "Tier-3-shaped" means as a field/value.
//   2. Network proximity (1st/2nd-degree LinkedIn connections) - no
//      automated source identified in the project docs. This creates a
//      "Network Proximity" Yes/No field on the deal for Marina to set
//      manually; defaults to No until she does.

import { listAllLeadsEngagement, listBlocklist, isBlocked } from "../../lib/instantly.js";
import {
  listDealsByPipelineStage,
  getDealFieldsMap,
  ensureDealField,
  updateDeal,
  getPersonById,
} from "../../lib/pipedrive.js";
import { computeScore, buildWeeklyShortlist } from "../../lib/scoring.js";
import { sendShortlistDigest } from "../../lib/email.js";

const PIPELINE_ID = Number(process.env.PIPEDRIVE_PIPELINE_ID || 4);
const STAGE_ID_NEW_LEAD = Number(process.env.PIPEDRIVE_STAGE_ID_NEW_LEAD || 20);
const WEEKLY_CAP = Number(process.env.LANE2_WEEKLY_CAP || 80);
const FAST_TRACK_BUFFER = Number(process.env.LANE2_FAST_TRACK_BUFFER || 15);

function daysBetween(dateStr) {
  const start = new Date(`${dateStr}T00:00:00Z`);
  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return Math.round((todayUTC - start) / (24 * 60 * 60 * 1000));
}

function personEmail(deal) {
  if (deal.person_id && typeof deal.person_id === "object") {
    const emailField = deal.person_id.email;
    if (Array.isArray(emailField) && emailField[0]?.value) return emailField[0].value;
    if (typeof emailField === "string") return emailField;
  }
  return null;
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  try {
    await ensureDealField("Cohort", { field_type: "varchar" });
    await ensureDealField("Cohort Start Date", { field_type: "date" });
    await ensureDealField("Lane2 Score", { field_type: "double" });
    await ensureDealField("Email Opened At", { field_type: "varchar" });
    await ensureDealField("Email Replied At", { field_type: "varchar" });
    await ensureDealField("Network Proximity", {
      field_type: "enum",
      options: [{ label: "Yes" }, { label: "No" }],
    });
    // Manual override, for opt-outs that arrive somewhere Instantly cannot see
    // them - a LinkedIn message, a phone call, a forwarded complaint.
    await ensureDealField("Do Not Contact", {
      field_type: "enum",
      options: [{ label: "Yes" }, { label: "No" }],
    });
    const fieldsMap = await getDealFieldsMap({ forceRefresh: true });

    const deals = await listDealsByPipelineStage(PIPELINE_ID, STAGE_ID_NEW_LEAD);
    const inWindow = deals.filter((deal) => {
      const cohortStart = deal[fieldsMap["Cohort Start Date"].key];
      if (!cohortStart) return false;
      const d = daysBetween(cohortStart);
      return d === 4 || d === 5; // "day 5-6" is 4/5 days after a day-1 Monday start
    });

    if (inWindow.length === 0) {
      return res.status(200).json({ ok: true, message: "no cohort in day 5-6 window today" });
    }

    const engagement = await listAllLeadsEngagement();
    const engagementByEmail = new Map(engagement.map((e) => [e.email?.toLowerCase(), e]));

    // Anyone who has opted out must never reach the LinkedIn shortlist.
    // This is not a nicety: computeScore gives a reply a 1000-point bonus and
    // does not care whether the reply was "sounds great" or "stop", so without
    // this filter the person who just asked us to leave them alone lands at
    // the TOP of the weekly list for a connection request and a voice note.
    // They said stop - not "stop emailing" - and the cold email copy promises
    // exactly that.
    const blocklist = await listBlocklist();
    if (!blocklist.ok) {
      // Failing open would silently resume contacting opted-out people, which
      // is the one outcome worth aborting the whole run to avoid.
      console.error("linkedin-score: blocklist unreadable", blocklist.attempts);
      return res.status(503).json({
        ok: false,
        error: "Instantly blocklist could not be read - aborting rather than risk contacting an opted-out lead",
        attempts: blocklist.attempts,
      });
    }

    const suppressed = [];
    const scored = [];
    for (const deal of inWindow) {
      let email = personEmail(deal);
      if (!email && deal.person_id) {
        const personId = typeof deal.person_id === "object" ? deal.person_id.value : deal.person_id;
        const person = await getPersonById(personId).catch(() => null);
        email = person?.email?.[0]?.value || null;
      }
      if (!email) continue;

      if (isBlocked(email, blocklist.entries)) {
        suppressed.push({ dealId: deal.id, reason: "on the Instantly blocklist" });
        continue;
      }
      if (deal[fieldsMap["Do Not Contact"]?.key] === "Yes") {
        suppressed.push({ dealId: deal.id, reason: "Do Not Contact set on the deal" });
        continue;
      }

      const lead = engagementByEmail.get(email.toLowerCase());
      const revenueBand = deal[fieldsMap["Revenue Band"]?.key];
      const reportUrl = deal[fieldsMap["Report URL"]?.key];
      const networkProximityRaw = deal[fieldsMap["Network Proximity"].key];

      const score = computeScore({
        replied: !!lead?.replied,
        opened: !!lead?.opened,
        hasSpecificTrigger: false, // TODO: no per-contact trigger-type field synced yet
        reportCompleted: !!reportUrl,
        reportIsTier3Shaped: false, // TODO: needs Marina's definition, see file header
        revenueBandUpperFit: !reportUrl && !!revenueBand,
      });

      await updateDeal(deal.id, {
        "Lane2 Score": score,
        "Email Opened At": lead?.lastOpenAt || "",
        "Email Replied At": lead?.lastReplyAt || "",
      });

      scored.push({
        dealId: deal.id,
        name: deal.person_id?.name || deal.title,
        email,
        score,
        earliestEngagementAt: lead?.lastReplyAt || lead?.lastOpenAt || null,
        networkProximity: networkProximityRaw === "Yes",
        cohortLetter: deal[fieldsMap["Cohort"].key],
        dealUrl: process.env.PIPEDRIVE_COMPANY_DOMAIN
          ? `https://${process.env.PIPEDRIVE_COMPANY_DOMAIN}.pipedrive.com/deal/${deal.id}`
          : null,
      });
    }

    const byCohort = new Map();
    for (const c of scored) {
      if (!byCohort.has(c.cohortLetter)) byCohort.set(c.cohortLetter, []);
      byCohort.get(c.cohortLetter).push(c);
    }

    const results = [];
    for (const [cohortLetter, contacts] of byCohort.entries()) {
      const { fastTrack, ranked, overflowFastTrack } = buildWeeklyShortlist(contacts, {
        weeklyCap: WEEKLY_CAP,
        fastTrackBuffer: FAST_TRACK_BUFFER,
      });
      await sendShortlistDigest({ cohortLetter, fastTrack, ranked });
      results.push({
        cohortLetter,
        totalScored: contacts.length,
        fastTrackCount: fastTrack.length,
        rankedCount: ranked.length,
        overflowFastTrackCount: overflowFastTrack.length,
      });
    }

    return res.status(200).json({
      ok: true,
      cohortsProcessed: results,
      suppressedCount: suppressed.length,
      suppressed,
      blocklistSource: blocklist.path,
      blocklistSize: blocklist.entries.length,
    });
  } catch (err) {
    console.error("linkedin-score failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
