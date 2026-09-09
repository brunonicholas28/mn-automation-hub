// Assembled per-cohort funnel table, served to the Email Marketing dashboard
// and to the weekly analyst agent.
//
// GET /api/metrics            -> every cohort, newest first
// GET /api/metrics?cohort=... -> one cohort

import { readAllCohorts, readCohort, normaliseCohortId } from "../lib/cohort.js";
import { getState } from "../lib/kv.js";

// Rows that exist in the store but must never reach a reader.
// - c19700101: the 1970-dated verification row written while wiring the beacon.
// - no-phone-cadence-...: the first poll ran before the Instantly campaign
//   name was aliased onto c20260908, so it wrote the same 2026-09-08 sends
//   under the raw campaign slug. Left in place but hidden, because showing it
//   would count that batch twice in the totals.
const HIDDEN_COHORTS = new Set([
  // The 1970-dated verification row written while wiring the beacon.
  "c19700101",
  // The first poll ran before the Instantly campaign name was aliased onto
  // c20260908, so it wrote the same 2026-09-08 sends under the raw campaign
  // slug. Hidden because showing it would count that batch twice.
  "no-phone-cadence---cold-outreach-v1untitled-camp",
  // Written before placeholder tags were rejected at the source; Fillout's
  // preview link carries utm_campaign=xxxxx.
  "xxxxx",
]);

// Anything tagged ctest-* is a deliberate end-to-end check. Making the rule a
// pattern rather than a list means a future test hides itself instead of
// needing a code change to tidy up after it.
function isHidden(cohort) {
  return HIDDEN_COHORTS.has(cohort) || /^ctest[-_]/.test(cohort || "");
}

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

    // Asking for a cohort by name is a deliberate act, so it can see the hidden
    // rows - otherwise a test row is impossible to inspect even on purpose.
    const rows = (one ? cohorts : cohorts.filter((c) => !isHidden(c.cohort))).map(withRates);
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
        "Bounces read zero because no bounce signal has yet appeared on this Instantly account. Treat the bounce column as unconfirmed rather than as a real zero until a bounce is seen.",
        "Report completions and booked calls only split by cohort once the Fillout to Pipedrive webhook writes utm_campaign into the deal Cohort field. Until then they appear under unattributed.",
      ],
    });
  } catch (err) {
    console.error("metrics failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
