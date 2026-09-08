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
import { normaliseCohortId, setCohortFields } from "../../lib/cohort.js";

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
