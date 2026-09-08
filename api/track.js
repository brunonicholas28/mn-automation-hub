// Public beacon endpoint for landing-page visits.
//
// Open and click tracking are deliberately off in Instantly for
// deliverability, so a tagged visit to growth.marinanicholas.com is our
// stand-in for click-through rate. This counts visits that carry a cohort
// tag; untagged traffic is a different metric and is ignored here.
//
// Deliberately stores nothing but counters: no IP, no user agent, no
// cookies, no identifiers, no third party. That is what keeps the landing
// page free of a consent banner.

import { bumpCohort, splitCampaignTag, cohortKey } from "../lib/cohort.js";
import { Redis } from "@upstash/redis";

const kv = Redis.fromEnv();

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

// navigator.sendBeacon posts a Blob, so the body may arrive as a raw string
// rather than parsed JSON depending on the content type it was given.
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

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const body = readBody(req);
    const { cohort, touch } = splitCampaignTag(body.campaign || body.cohort);

    if (!cohort) {
      // Untagged traffic is expected and fine - just not ours to count.
      return res.status(200).json({ ok: true, counted: false, reason: "no cohort tag" });
    }

    await bumpCohort(cohort, "visits", 1);

    if (touch) {
      await kv.hincrby(`${cohortKey(cohort)}:touches`, touch, 1);
    }
    if (body.source) {
      await kv.hincrby(`${cohortKey(cohort)}:sources`, String(body.source).slice(0, 32), 1);
    }

    return res.status(200).json({ ok: true, counted: true, cohort, touch: touch || null });
  } catch (err) {
    // Never let a tracking failure surface to a prospect's browser as an
    // error - the beacon is fire-and-forget by design.
    console.error("track failed:", err);
    return res.status(200).json({ ok: false, counted: false });
  }
}
