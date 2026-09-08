// Cohort store for the cold-outreach funnel.
//
// One Redis hash per send cohort: cohort:<id> -> { sent, bounced, replied,
// visits, started, completed, booked, firstSeenAt, lastUpdatedAt }, plus a
// set at cohort:index listing every cohort id we have ever written.
//
// Cohort ids are cYYYYMMDD, taken from the batch's first send date. They
// travel through the funnel as utm_campaign=<cohortId>-<touch> and through
// Instantly as one campaign per cohort. See
// cold-outreach-funnel-analytics-build-spec.md.

import { Redis } from "@upstash/redis";

const kv = Redis.fromEnv();

export const COHORT_INDEX = "cohort:index";

export const COUNTERS = [
  "sent",
  "bounced",
  "replied",
  "visits",
  "started",
  "completed",
  "booked",
];

// The 2026-09-08 batch went out before cohort tagging existed, carrying a
// plain utm_campaign=day2. Fold it onto its real send date so it lines up
// with every properly tagged batch after it. Nothing later will ever send
// bare "day2" again - from c20260915 on, the tag is <cohort>-<touch>.
const LEGACY_ALIASES = {
  day2: "c20260908",
  day10: "c20260908",
  day18: "c20260908",
};

// Values reaching here come from a public endpoint and from Instantly
// campaign names, so they are never trusted as a key without scrubbing.
export function normaliseCohortId(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  const dated = s.match(/c\d{8}/);
  if (dated) return dated[0];

  const slug = s.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (!slug) return null;
  return LEGACY_ALIASES[slug] || slug;
}

// utm_campaign is "<cohort>-<touch>", e.g. c20260915-day2. Split it so we can
// tell which touch in the cadence actually drove the visit.
export function splitCampaignTag(raw) {
  const cohort = normaliseCohortId(raw);
  if (!cohort) return { cohort: null, touch: null };
  const s = String(raw).trim().toLowerCase();
  const touch = (s.match(/(day\s*\d+)/) || [])[1] || null;
  return { cohort, touch: touch ? touch.replace(/\s+/g, "") : null };
}

export function cohortKey(id) {
  return `cohort:${id}`;
}

const nowIso = () => new Date().toISOString();

export async function bumpCohort(id, field, by = 1) {
  const key = cohortKey(id);
  const p = kv.pipeline();
  p.hincrby(key, field, by);
  p.hsetnx(key, "firstSeenAt", nowIso());
  p.hset(key, { lastUpdatedAt: nowIso() });
  p.sadd(COHORT_INDEX, id);
  await p.exec();
}

// Polls recompute totals from the source of truth every run rather than
// incrementing, so a re-run can never double-count.
export async function setCohortFields(id, fields) {
  const key = cohortKey(id);
  const p = kv.pipeline();
  p.hset(key, { ...fields, lastUpdatedAt: nowIso() });
  p.hsetnx(key, "firstSeenAt", nowIso());
  p.sadd(COHORT_INDEX, id);
  await p.exec();
}

export async function listCohortIds() {
  const ids = await kv.smembers(COHORT_INDEX);
  return (ids || []).filter(Boolean).sort().reverse();
}

export async function readCohort(id) {
  const raw = (await kv.hgetall(cohortKey(id))) || {};
  const out = { cohort: id };
  for (const c of COUNTERS) out[c] = Number(raw[c] || 0);
  out.firstSeenAt = raw.firstSeenAt || null;
  out.lastUpdatedAt = raw.lastUpdatedAt || null;
  if (raw.touches) {
    try {
      out.touches = typeof raw.touches === "string" ? JSON.parse(raw.touches) : raw.touches;
    } catch {
      out.touches = null;
    }
  }
  return out;
}

export async function readAllCohorts() {
  const ids = await listCohortIds();
  return Promise.all(ids.map(readCohort));
}
