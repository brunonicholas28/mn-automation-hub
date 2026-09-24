// Assembled per-cohort funnel table, served to the Email Marketing dashboard
// and to the weekly analyst agent.
//
// GET /api/metrics            -> every cohort, newest first
// GET /api/metrics?cohort=... -> one cohort

import { readAllCohorts, readCohort, normaliseCohortId, isHiddenCohort } from "../lib/cohort.js";
import { getState } from "../lib/kv.js";
import { readBudget, costMetrics } from "../lib/spend.js";

// The list of rows that must never reach a reader now lives in lib/cohort.js
// as isHiddenCohort, because /api/fillout-stats needs exactly the same rule
// and had been counting the test rows this endpoint was already hiding.
const isHidden = isHiddenCohort;

// Returns null rather than 0 when the denominator is zero, so the dashboard
// can render "-" instead of a confident-looking 0.0% that means nothing.
function rate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function withRates(c) {
  return {
    ...c,
    rates: {
      bounce: rate(c.bounced, c.sent),
      reply: rate(c.replied, c.sent),
      clickThrough: rate(c.visits, c.sent),
      reportStart: rate(c.started, c.visits),
      formCompletion: rate(c.completed, c.started),
      reportToCall: rate(c.booked, c.completed),
      endToEnd: rate(c.booked, c.sent),
      showRate: rate(c.held, c.booked),
      callToSale: rate(c.sold, c.held),
    },
    // Which motion produced this row. A cohort with sends came from Instantly
    // and is cold outreach; one with visits but no sends is paid traffic to
    // the Growth Gap Session page. Both are tagged cYYYYMMDD, so they already
    // sit side by side - this only names which is which.
    channel: c.sent > 0 ? "cold" : (c.visits > 0 ? "linkedin" : "unknown"),
    // Below roughly 200 sends or 20 replies, differences between cohorts are
    // noise. The dashboard and the analyst agent both read this flag so
    // nobody optimises against a sample that cannot support a decision.
    thin: c.sent < 200 || c.replied < 20,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

  try {
    const one = normaliseCohortId(req.query?.cohort);
    const cohorts = one ? [await readCohort(one)] : await readAllCohorts();

    // Asking for a cohort by name is a deliberate act, so it can see the hidden
    // rows - otherwise a test row is impossible to inspect even on purpose.
    const rows = (one ? cohorts : cohorts.filter((c) => !isHidden(c.cohort))).map(withRates);
    const totals = rows.reduce(
      (acc, r) => {
        for (const k of ["sent", "bounced", "replied", "visits", "started", "completed", "booked", "held", "sold"]) {
          acc[k] += r[k] || 0;
        }
        return acc;
      },
      { sent: 0, bounced: 0, replied: 0, visits: 0, started: 0, completed: 0, booked: 0, held: 0, sold: 0 }
    );

    // Same sum again, split by channel, so each side can carry its own cost
    // per outcome against its own spend.
    const blank = () => ({ sent: 0, bounced: 0, replied: 0, visits: 0, started: 0, completed: 0, booked: 0, held: 0, sold: 0 });
    const byChannel = { cold: blank(), linkedin: blank() };
    for (const r of rows) {
      const bucket = byChannel[r.channel];
      if (!bucket) continue;
      for (const k of Object.keys(bucket)) bucket[k] += r[k] || 0;
    }

    const [coldBudget, linkedinBudget] = await Promise.all([
      readBudget("cold"),
      readBudget("linkedin"),
    ]);
    const channels = {
      cold: { ...withRates({ cohort: "cold", ...byChannel.cold }), cost: costMetrics(coldBudget, byChannel.cold) },
      linkedin: { ...withRates({ cohort: "linkedin", ...byChannel.linkedin }), cost: costMetrics(linkedinBudget, byChannel.linkedin) },
    };

    // Report completions and booked calls that carry no Cohort value. Shown
    // separately rather than folded into a cohort, because guessing which
    // batch they belong to would be worse than admitting we cannot tell.
    const unattributed = (await getState("funnel:unattributed")) || null;

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      cohorts: rows,
      unattributed,
      totals: withRates({ cohort: "all", ...totals }),
      channels,
      budgets: { cold: coldBudget, linkedin: linkedinBudget },
      caveats: [
        "Open and click rates are absent by design - tracking pixels are off in Instantly for deliverability.",
        "Landing page visits stand in for click-through and count only traffic carrying a cohort tag.",
        "c20260908 is cohort zero: it sent before cohort tagging, so its funnel below the send count is attributable to cold email but not cleanly separable from later batches.",
        "Attribution is last-touch and single-channel.",
        "Bounces read zero because no bounce signal has yet appeared on this Instantly account. Treat the bounce column as unconfirmed rather than as a real zero until a bounce is seen.",
        "Report completions and booked calls only split by cohort once the Fillout to Pipedrive webhook writes utm_campaign into the deal Cohort field. Until then they appear under unattributed.",
        "Cost per click divides spend by landing page visits, which is what this stack can see first-hand. It is not the ad platform's own CPC and will differ from it.",
        "Spend is a committed budget over a flight, set by hand - the LinkedIn token here is scoped to writing conversions, not reading ad reporting. Cost figures show a dash until it is set.",
        "Cost per outcome divides spend TO DATE, not the whole budget: the budget pro-rated by how much of the flight has elapsed, assuming an even daily rate. Mid-flight the whole-budget figure would overstate every cost several times over.",
        "Calls held and tiers sold are read from the Pipedrive enrolment stages, so they are only as current as the pipeline is kept.",
      ],
    });
  } catch (err) {
    console.error("metrics failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
