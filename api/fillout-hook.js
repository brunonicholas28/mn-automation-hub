// Receives completed Growth Gap Report submissions straight from Fillout and
// counts them against the cohort that produced them.
//
// Why not read this from Pipedrive: the existing Fillout -> phoenix -> Pipedrive
// webhook creates the deal and writes the score, but leaves the Cohort and UTM
// Source fields empty - a check on 2026-09-08 found 0 of 296 deals carrying
// either. Taking completions from Fillout directly means cohort attribution
// does not wait on that pipeline being fixed.
//
// Unauthenticated by necessity (Fillout signs nothing here), so every
// submission is deduplicated on its Fillout submission id before it is allowed
// to move a counter. A replayed or duplicated POST cannot inflate the funnel.

import { Redis } from "@upstash/redis";
import { bumpCohort, splitCampaignTag } from "../lib/cohort.js";
import { normaliseToken, markLeadStage } from "../lib/leads.js";

const kv = Redis.fromEnv();
const SEEN_TTL_SECONDS = 60 * 60 * 24 * 120;

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return {};
  }
}

// Fillout has moved this around between payload versions, so look everywhere
// it plausibly lives rather than pinning one path and silently reading null.
function findParam(payload, matcher) {
  const candidates = [
    payload?.submission?.urlParameters,
    payload?.urlParameters,
    payload?.submission?.hiddenFields,
    payload?.hiddenFields,
    payload?.submission?.calculations,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (Array.isArray(c)) {
      const hit = c.find((p) => matcher.test(p?.name || p?.id || ""));
      if (hit && hit.value) return hit.value;
    } else if (typeof c === "object") {
      for (const [k, v] of Object.entries(c)) {
        if (matcher.test(k) && v) return v;
      }
    }
  }
  // Last resort: the submission URL itself.
  const url = payload?.submission?.url || payload?.url;
  if (typeof url === "string") {
    try {
      for (const [k, v] of new URL(url, "https://x.invalid").searchParams) {
        if (matcher.test(k) && v) return v;
      }
    } catch {
      // A malformed submission URL is not worth failing a webhook over.
    }
  }
  return null;
}

const findCampaign = (payload) => findParam(payload, /utm_?campaign/i);
const findLeadToken = (payload) => findParam(payload, /^lid$/i);

function findSubmissionId(payload) {
  return (
    payload?.submission?.submissionId ||
    payload?.submissionId ||
    payload?.submission?.id ||
    payload?.id ||
    null
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const payload = readBody(req);
    const submissionId = findSubmissionId(payload);
    if (!submissionId) {
      // Respond 200 so Fillout does not retry a payload we will never parse.
      console.warn("fillout-hook: no submission id in payload");
      return res.status(200).json({ ok: true, counted: false, reason: "no submission id" });
    }

    const seenKey = `fillout:seen:${submissionId}`;
    const fresh = await kv.set(seenKey, 1, { nx: true, ex: SEEN_TTL_SECONDS });
    if (!fresh) {
      return res.status(200).json({ ok: true, counted: false, reason: "duplicate" });
    }

    const { cohort } = splitCampaignTag(findCampaign(payload));
    if (!cohort) {
      await kv.incr("funnel:completionsWithoutCohort");
      return res.status(200).json({ ok: true, counted: false, reason: "no cohort tag" });
    }

    await bumpCohort(cohort, "completed", 1);

    // Close the loop on the per-lead token so the clicked-but-did-not-start
    // sweep can never nudge someone who has already finished the report.
    const lid = normaliseToken(findLeadToken(payload));
    if (lid) await markLeadStage(lid, "completed");
    return res.status(200).json({ ok: true, counted: true, cohort });
  } catch (err) {
    console.error("fillout-hook failed:", err);
    return res.status(200).json({ ok: false, counted: false });
  }
}
