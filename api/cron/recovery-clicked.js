// Sweep: leads who clicked the email link and reached the landing page, but
// never opened the report form.
//
// This is the warmest segment in the funnel and, until now, the only one with
// no follow-up of its own - they were simply getting the same generic Day 10
// that everyone else gets. Copy lives in
// clicked-no-start-followup-copy-v1.md.
//
// Three rules this endpoint enforces, in order of how badly they would hurt
// if broken:
//
// 1. Never contact an opted-out lead. If the Instantly blocklist cannot be
//    read, the run aborts. An unreadable blocklist and an empty blocklist
//    must never produce the same behaviour.
// 2. Never put one person in two live sequences. Leads are MOVED into the
//    recovery campaign, not added alongside the main one. If the move fails,
//    nothing is sent.
// 3. Never nudge twice. nudgedAt is stamped on the lead record, and a lead
//    carrying it is skipped for good.
//
// Dry run is the default. Pass ?live=1 to actually move anyone.

import { listCohortIds } from "../../lib/cohort.js";
import { listLeadTokens, readLeads, markNudged } from "../../lib/leads.js";
import { listBlocklist, isBlocked, listCampaignLeads, moveLeadsToCampaign } from "../../lib/instantly.js";

// Long enough that the nudge does not arrive while they still have the tab
// open, short enough that the click is still a live memory.
const MIN_HOURS_SINCE_VISIT = Number(process.env.RECOVERY_MIN_HOURS || 24);
// Past this, the click is stale and the ordinary cadence has moved on.
const MAX_DAYS_SINCE_VISIT = Number(process.env.RECOVERY_MAX_DAYS || 10);

const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 36e5;

function authorised(req) {
  const expected = process.env.FUNNEL_CRON_KEY;
  if (!expected) return true; // Matches poll-funnel: key is optional until set.
  const given = req.query.key || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return given === expected;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });

  const live = req.query.live === "1";
  const sourceCampaign = process.env.INSTANTLY_CAMPAIGN_ID;
  const recoveryCampaign = process.env.INSTANTLY_RECOVERY_CAMPAIGN_ID;

  try {
    const cohorts = req.query.cohort ? [req.query.cohort] : await listCohortIds();
    const report = { live, cohorts: [], moved: 0, skipped: {} };

    // Read once, not per cohort. A failure here stops everything.
    const blocklist = await listBlocklist();
    if (!blocklist.ok) {
      return res.status(503).json({
        ok: false,
        error: "Instantly blocklist could not be read - aborting rather than risk contacting an opted-out lead",
        attempts: blocklist.attempts,
      });
    }

    // Reply state lives in Instantly, not in our KV. Someone who has already
    // written back does not need a nudge to fill in a form.
    let sourceLeads = [];
    if (sourceCampaign) sourceLeads = await listCampaignLeads(sourceCampaign);
    const byEmail = new Map(sourceLeads.map((l) => [l.email, l]));

    const bump = (reason) => {
      report.skipped[reason] = (report.skipped[reason] || 0) + 1;
    };

    for (const cohort of cohorts) {
      const tokens = await listLeadTokens(cohort);
      if (!tokens.length) continue;
      const leads = await readLeads(tokens);

      const candidates = [];
      for (const lead of leads) {
        if (!lead.visitedAt) { bump("never reached the landing page"); continue; }
        if (lead.startedAt) { bump("started the form"); continue; }
        if (lead.completedAt) { bump("completed the report"); continue; }
        if (lead.nudgedAt) { bump("already nudged"); continue; }

        const age = hoursSince(lead.visitedAt);
        if (age < MIN_HOURS_SINCE_VISIT) { bump("clicked too recently"); continue; }
        if (age > MAX_DAYS_SINCE_VISIT * 24) { bump("click too stale"); continue; }

        if (isBlocked(lead.email, blocklist.entries)) { bump("on the Instantly blocklist"); continue; }

        const source = byEmail.get(lead.email);
        if (!source) { bump("no matching Instantly lead to move"); continue; }
        if (source.replyCount > 0) { bump("already replied"); continue; }
        if (source.bounceCount > 0) { bump("bounced"); continue; }

        candidates.push({ lid: lead.lid, email: lead.email, instantlyId: source.id });
      }

      const entry = { cohort, eligible: candidates.length, moved: 0 };

      if (candidates.length && live) {
        if (!recoveryCampaign) {
          entry.error = "INSTANTLY_RECOVERY_CAMPAIGN_ID is not set - nothing moved";
        } else {
          const move = await moveLeadsToCampaign(candidates.map((c) => c.instantlyId), recoveryCampaign);
          if (!move.ok) {
            // Fail closed. Adding them to the recovery campaign without
            // removing them from the main one would double-send.
            entry.error = "Instantly move failed - nobody was contacted";
            entry.attempts = move.attempts;
          } else {
            for (const c of candidates) await markNudged(c.lid, recoveryCampaign);
            entry.moved = candidates.length;
            entry.via = move.path;
            report.moved += candidates.length;
          }
        }
      }

      report.cohorts.push(entry);
    }

    return res.status(200).json({
      ok: true,
      ...report,
      note: live
        ? undefined
        : "dry run - nobody was contacted. Add ?live=1 once the counts look right.",
      config: {
        sourceCampaignSet: Boolean(sourceCampaign),
        recoveryCampaignSet: Boolean(recoveryCampaign),
        minHoursSinceVisit: MIN_HOURS_SINCE_VISIT,
        maxDaysSinceVisit: MAX_DAYS_SINCE_VISIT,
        blocklistPath: blocklist.path,
        blocklistSize: blocklist.entries.length,
      },
    });
  } catch (err) {
    console.error("recovery-clicked failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
