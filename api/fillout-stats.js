// Live Fillout numbers for the funnel dashboard.
//
// Returns counts only - never submission content, names or emails - because
// this endpoint is public.
//
// What Fillout's REST API can and cannot give is not obvious from the docs,
// so the response carries a `coverage` block naming exactly which of the
// dashboard's six metrics are real and which are unavailable. Better an
// explicit "not available" than a confident zero.

import {
  resolveKey,
  listForms,
  listSubmissions,
  campaignOf,
  durationSeconds,
} from "../lib/fillout.js";
import { normaliseCohortId } from "../lib/cohort.js";

const FORM_NAME_MATCH = /growth\s*gap\s*report/i;

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Bruno's and Marina's own QA submissions outnumber the real ones roughly
// 35 to 1 as of 2026-09-08. Counting them would make every rate meaningless,
// so they are excluded and reported separately rather than silently dropped.
const INTERNAL = /(brunonicholas28|marina@marinanicholas\.com|@example\.com|test)/i;

function looksInternal(sub) {
  const blob = JSON.stringify(sub?.questions || []) + JSON.stringify(sub?.calculations || []);
  return INTERNAL.test(blob);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");

  const { name: keyName } = resolveKey();
  if (!keyName) {
    return res.status(200).json({
      ok: false,
      error:
        "No Fillout API key found in this project's environment. Add it as FILLOUT_API_KEY to mn-automation-hub (not phoenix) and redeploy.",
    });
  }

  try {
    const forms = await listForms();
    const form =
      forms.find((f) => FORM_NAME_MATCH.test(f.name || "")) || forms[0] || null;
    if (!form) {
      return res.status(200).json({ ok: false, keyEnvVar: keyName, error: "No forms returned", forms });
    }

    const [finished, partial] = await Promise.all([
      listSubmissions(form.formId),
      listSubmissions(form.formId, { status: "in_progress" }).catch(() => []),
    ]);

    const realFinished = finished.filter((s) => !looksInternal(s));
    const internalCount = finished.length - realFinished.length;

    const durations = realFinished.map(durationSeconds).filter((d) => d !== null && d < 60 * 60 * 24 * 7);

    const byCohort = {};
    const bump = (cohort, field) => {
      const key = cohort || "untagged";
      byCohort[key] = byCohort[key] || { started: 0, finished: 0 };
      byCohort[key][field] += 1;
    };
    for (const s of realFinished) bump(normaliseCohortId(campaignOf(s)), "finished");
    for (const s of partial) bump(normaliseCohortId(campaignOf(s)), "started");

    return res.status(200).json({
      ok: true,
      keyEnvVar: keyName,
      form: { id: form.formId, name: form.name },
      generatedAt: new Date().toISOString(),
      totals: {
        finished: realFinished.length,
        inProgress: partial.length,
        internalTestSubmissions: internalCount,
      },
      medianSecondsToComplete: median(durations),
      durationSampleSize: durations.length,
      byCohort,
      coverage: {
        finished: "live",
        inProgress: "live - Fillout only retains a partial once someone gets far enough to be resumable, so this undercounts abandonment",
        uniqueVisitors:
          "not available from the API - Fillout shows it in Results > Analytics only. The landing-page beacon in /api/metrics is the closest live equivalent",
        perPageDropOff:
          "not available from the API - Results > Analytics only, and it cannot be filtered per cohort there either",
        completionRate:
          "derived here as finished / (finished + inProgress), which is not the same number Fillout's UI shows: theirs is finished / unique visitors",
        avgTimeToComplete:
          durations.length
            ? "median rather than mean, because one resumed form days later drags a mean into nonsense"
            : "not computable - Fillout did not return a start timestamp on these submissions",
      },
      caveat:
        "Internal QA submissions are excluded from every count above. As of 2026-09-08 that was 35 of 36 all-time submissions.",
    });
  } catch (err) {
    console.error("fillout-stats failed:", err);
    return res.status(200).json({ ok: false, keyEnvVar: keyName, error: String(err.message || err) });
  }
}
