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
  // Held and sold arrive with the hourly Pipedrive poll. They exist so spend
  // can be divided by something that happened rather than something booked -
  // a cost per call that counts no-shows flatters every channel equally.
  "held",
  "sold",
];

// The 2026-09-08 batch went out before cohort tagging existed, carrying a
// plain utm_campaign=day2. Fold it onto its real send date so it lines up
// with every properly tagged batch after it. Nothing later will ever send
// bare "day2" again - from c20260915 on, the tag is <cohort>-<touch>.
const LEGACY_ALIASES = {
  day2: "c20260908",
  day10: "c20260908",
  day18: "c20260908",
  // The Instantly campaign that carried the 2026-09-08 batch was created
  // before the one-campaign-per-cohort rule and its name got mangled on save.
  // Alias it so its sends land on the same row as its landing-page visits.
  // Renaming the campaign to include c20260908 makes this alias inert.
  "no-phone-cadence---cold-outreach-v1untitled-camp": "c20260908",
};

// Values reaching here come from a public endpoint and from Instantly
// campaign names, so they are never trusted as a key without scrubbing.
export function normaliseCohortId(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // Fillout's own preview and share links fill the UTM slots with literal
  // placeholder text ("xxxxx"), so previewing the form would otherwise mint a
  // junk cohort row on the dashboard every time anyone looked at it.
  if (/^x+$/.test(s) || s === "utm_campaign" || s === "null" || s === "undefined") return null;

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

// Rows that exist in the store but must never reach a reader or a metric.
//
// This rule lived inside api/metrics.js only, which is why /api/fillout-stats
// spent a week reporting four ctest-beacon partials as real questionnaire
// starts while the dashboard beside it hid them. One definition now, read by
// everything that counts anything.
//
// - c19700101: the 1970-dated verification row written while wiring the beacon.
// - no-phone-cadence-...: the first poll ran before the Instantly campaign
//   name was aliased onto c20260908, so it wrote the same 2026-09-08 sends
//   under the raw campaign slug. Showing it would count that batch twice.
// - xxxxx: Fillout's preview link fills the UTM slots with literal placeholders.
export const HIDDEN_COHORTS = new Set([
  "c19700101",
  "no-phone-cadence---cold-outreach-v1untitled-camp",
  "xxxxx",
]);

// Patterns rather than a list, so a future end-to-end test hides itself
// instead of needing a code change to tidy up after it.
export function isHiddenCohort(cohort) {
  const id = String(cohort || "");
  return HIDDEN_COHORTS.has(id) || /^ctest[-_]/.test(id) || /^watchdog[-_]/.test(id);
}

// Which channel a VISIT came from, read from utm_source as the beacon
// forwarded it. This exists because a cohort id is not a channel: c20260922
// is both an Instantly send batch and the utm_campaign on the LinkedIn ad
// set, so classifying the whole cohort by "does it have sends" filed every
// paid click under cold outreach and left the LinkedIn panel showing only
// legacy test traffic.
//
// Source vocabulary actually in use: "instantly" (minted report links),
// "email" (the older beacon default), "linkedin" (the ad set's utm_source),
// "session-recovery", and "growth-gap-session-page" (the landing page's own
// default when a visit carries no utm_source).
export const LINKEDIN_SOURCES = new Set(["linkedin", "linkedin-ads", "paid-social"]);

export function isLinkedInSource(raw) {
  return LINKEDIN_SOURCES.has(String(raw || "").trim().toLowerCase());
}

// Split a cohort's visit counter into LinkedIn and non-LinkedIn using its
// :sources hash.
//
// The hash is only written when a beacon carried a source, and it started
// being written after some traffic had already landed, so it can undercount
// the visits counter. The counter is the authority on how many visits there
// were; the hash is the authority only on how many were LinkedIn. Whatever
// the hash cannot account for stays on the non-LinkedIn side rather than
// being invented into either channel - under-crediting LinkedIn is the safe
// direction, because over-crediting it would flatter cost per click.
export function splitVisitsBySource(visits, sources) {
  const total = Math.max(0, Number(visits) || 0);
  let linkedin = 0;
  let identified = 0;
  for (const [key, value] of Object.entries(sources || {})) {
    const n = Number(value) || 0;
    if (n <= 0) continue;
    identified += n;
    if (isLinkedInSource(key)) linkedin += n;
  }
  // Never let a stale or over-counted hash exceed the counter itself.
  linkedin = Math.min(linkedin, total);
  return { linkedin, other: Math.max(0, total - linkedin), identified };
}

export async function readCohortSources(id) {
  try {
    return (await kv.hgetall(`${cohortKey(id)}:sources`)) || {};
  } catch {
    return {};
  }
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
