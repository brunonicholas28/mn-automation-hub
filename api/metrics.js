// Assembled per-cohort funnel table, served to the Email Marketing dashboard
// and to the weekly analyst agent.
//
// GET /api/metrics            -> every cohort, newest first
// GET /api/metrics?cohort=... -> one cohort

import { readAllCohorts, readCohort, normaliseCohortId } from "../lib/cohort.js";

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

    const rows = cohorts.map(withRates);
    const totals = rows.reduce(
      (acc, r) => {
        for (const k of ["sent", "bounced", "replied", "visits", "started", "completed", "booked"]) {
          acc[k] += r[k] || 0;
        }
        return acc;
      },
      { sent: 0, bounced: 0, replied: 0, visits: 0, started: 0, completed: 0, booked: 0 }
    );

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      cohorts: rows,
      totals: withRates({ cohort: "all", ...totals }),
      caveats: [
        "Open and click rates are absent by design - tracking pixels are off in Instantly for deliverability.",
        "Landing page visits stand in for click-through and count only traffic carrying a cohort tag.",
        "c20260908 is cohort zero: it sent before cohort tagging, so its funnel below the send count is attributable to cold email but not cleanly separable from later batches.",
        "Attribution is last-touch and single-channel.",
      ],
    });
  } catch (err) {
    console.error("metrics failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
