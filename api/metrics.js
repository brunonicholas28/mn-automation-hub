// Assembled per-cohort funnel table, served to the Email Marketing dashboard
// and to the weekly analyst agent.
//
// GET /api/metrics            -> every cohort, newest first
// GET /api/metrics?cohort=... -> one cohort

import { readAllCohorts, readCohort, normaliseCohortId } from "../lib/cohort.js";
import { getState } from "../lib/kv.js";

// Verification rows written while wiring the beacon. Dated 1970 so they sort
// last and read as obviously synthetic, and hidden here so nobody mistakes a
// test for a batch.
const TEST_COHORTS = new Set(["c19700101"]);

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
    },
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

    const rows = cohorts.filter((c) => !TEST_COHORTS.has(c.cohort)).map(withRates);
    const totals = rows.reduce(
      (acc, r) => {
        for (const k of ["sent", "bounced", "replied", "visits", "started", "completed", "booked"]) {
          acc[k] += r[k] || 0;
        }
        return acc;
      },
      { sent: 0, bounced: 0, replied: 0, visits: 0, started: 0, completed: 0, booked: 0 }
    );

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
      caveats: [
        "Open and click rates are absent by design - tracking pixels are off in Instantly for deliverability.",
        "Landing page visits stand in for click-through and count only traffic carrying a cohort tag.",
        "c20260908 is cohort zero: it sent before cohort tagging, so its funnel below the send count is attributable to cold email but not cleanly separable from later batches.",
        "Attribution is last-touch and single-channel.",
        "Report completions and booked calls only split by cohort once the Fillout to Pipedrive webhook writes utm_campaign into the deal Cohort field. Until then they appear under unattributed.",
      ],
    });
  } catch (err) {
    console.error("metrics failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
