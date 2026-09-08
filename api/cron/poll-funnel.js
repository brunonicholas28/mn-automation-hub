// Pulls the top of the cold-outreach funnel out of Instantly and writes it
// onto the cohort hashes that /api/metrics serves.
//
// Totals are recomputed from Instantly every run rather than incremented, so
// running this twice can never double-count.
//
// Cohort identity comes from the campaign name: one campaign per cohort,
// named with its cYYYYMMDD id. A campaign whose name carries no cohort id
// falls back to a slug of the name, which keeps it visible and countable
// instead of silently dropped - it just will not line up with the tagged
// batches until it is renamed.

import { listCampaigns, listCampaignLeads } from "../../lib/instantly.js";
import { listEnrolmentDeals, ENROLMENT_STAGES } from "../../lib/pipedrive.js";
import { normaliseCohortId, setCohortFields } from "../../lib/cohort.js";
import { setState } from "../../lib/kv.js";

// Deals that carry no Cohort value cannot be assigned to a batch. They are
// counted and stored separately rather than dropped or spread across cohorts,
// so the size of the attribution hole stays visible instead of looking like
// a run of honest zeros.
export const UNATTRIBUTED_KEY = "funnel:unattributed";

function authorised(req) {
  const expected = process.env.FUNNEL_CRON_KEY;
  // Unset means the endpoint is open. It only reads and aggregates, so that
  // is survivable for bootstrapping - but set the key and this closes.
  if (!expected) return true;
  const supplied =
    req.query?.key ||
    (req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  return supplied === expected;
}

// Instantly's own status codes are not documented consistently across plans,
// so bounce is read from whichever signal is actually present and the run
// reports what it saw. Do not trust the bounce number until the diagnostics
// below confirm which signal is populated on this account.
function isBounced(lead) {
  if (lead.bounceCount > 0) return true;
  if (lead.status === -1) return true;
  const s = lead.statusSummary;
  if (s && typeof s === "object") {
    if (s.is_bounced === true) return true;
    if (typeof s.status === "string" && /bounce/i.test(s.status)) return true;
  }
  if (typeof s === "string" && /bounce/i.test(s)) return true;
  return false;
}

export default async function handler(req, res) {
  if (!authorised(req)) return res.status(401).json({ ok: false, error: "bad key" });

  const startedAt = Date.now();
  const perCampaign = [];
  const byCohort = new Map();
  const statusTally = {};
  const bounceSignalsSeen = { bounceCount: 0, statusMinusOne: 0, statusSummary: 0 };

  try {
    const campaigns = await listCampaigns();

    for (const campaign of campaigns) {
      const cohort = normaliseCohortId(campaign.name) || normaliseCohortId(campaign.id);
      if (!cohort) continue;

      let leads = [];
      try {
        leads = await listCampaignLeads(campaign.id);
      } catch (err) {
        perCampaign.push({ campaign: campaign.name, cohort, error: String(err.message || err) });
        continue;
      }

      const acc = byCohort.get(cohort) || { sent: 0, bounced: 0, replied: 0 };
      for (const lead of leads) {
        const key = JSON.stringify(lead.status);
        statusTally[key] = (statusTally[key] || 0) + 1;

        if (lead.lastContactAt) acc.sent += 1;
        if (lead.replyCount > 0) acc.replied += 1;
        if (isBounced(lead)) {
          acc.bounced += 1;
          if (lead.bounceCount > 0) bounceSignalsSeen.bounceCount += 1;
          if (lead.status === -1) bounceSignalsSeen.statusMinusOne += 1;
          if (lead.statusSummary) bounceSignalsSeen.statusSummary += 1;
        }
      }
      byCohort.set(cohort, acc);

      perCampaign.push({
        campaign: campaign.name,
        campaignStatus: campaign.status,
        cohort,
        leads: leads.length,
        sent: acc.sent,
        replied: acc.replied,
        bounced: acc.bounced,
      });
    }

    // ---- Bottom of the funnel, from the Pipedrive enrolment pipeline ----
    // A deal sits in one stage, so each level counts "reached this stage or
    // beyond" - otherwise progressing a deal erases it from the level below.
    let pipedrive = null;
    try {
      const deals = await listEnrolmentDeals();
      const buckets = new Map();
      const unattributed = { started: 0, completed: 0, booked: 0, deals: 0 };

      for (const d of deals) {
        const started = d.stageId >= ENROLMENT_STAGES.reportStarted ? 1 : 0;
        const completed = d.stageId >= ENROLMENT_STAGES.reportCompleted ? 1 : 0;
        const booked = d.stageId >= ENROLMENT_STAGES.callBooked ? 1 : 0;

        const cohort = normaliseCohortId(d.cohort);
        if (!cohort) {
          unattributed.deals += 1;
          unattributed.started += started;
          unattributed.completed += completed;
          unattributed.booked += booked;
          continue;
        }
        // Only "booked" is taken from Pipedrive. Report starts and
        // completions come from Fillout (api/track stage=started and
        // api/fillout-hook), which sees the utm_campaign tag directly -
        // writing them from here as well would overwrite the real numbers
        // with whatever Pipedrive's untagged deals happen to add up to.
        const acc = buckets.get(cohort) || { booked: 0 };
        acc.booked += booked;
        buckets.set(cohort, acc);
      }

      for (const [cohort, acc] of buckets.entries()) {
        const existing = byCohort.get(cohort) || {};
        byCohort.set(cohort, { ...existing, ...acc });
      }

      await setState(UNATTRIBUTED_KEY, { ...unattributed, updatedAt: new Date().toISOString() });
      pipedrive = { dealsSeen: deals.length, attributedCohorts: [...buckets.keys()], unattributed };
    } catch (err) {
      console.error("poll-funnel pipedrive step failed:", err);
      pipedrive = { error: String(err.message || err) };
    }

    for (const [cohort, acc] of byCohort.entries()) {
      await setCohortFields(cohort, acc);
    }

    return res.status(200).json({
      ok: true,
      ranAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      campaignsSeen: campaigns.length,
      cohortsWritten: [...byCohort.keys()],
      perCampaign,
      pipedrive,
      diagnostics: {
        statusTally,
        bounceSignalsSeen,
        note: "statusTally shows the raw Instantly lead status codes on this account. Until a bounce signal shows up here, treat the bounced column as unconfirmed rather than as a real zero.",
      },
    });
  } catch (err) {
    console.error("poll-funnel failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err), perCampaign });
  }
}
