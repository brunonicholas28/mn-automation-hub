// Pipedrive API v1 client.
//
// Auth: current Pipedrive docs (https://pipedrive.readme.io/docs/core-api-concepts-authentication)
// require the API token in an `x-api-token` header, not the old `?api_token=`
// query param. Base URL is api.pipedrive.com (confirmed still valid in
// Pipedrive's own docs as of writing) - set PIPEDRIVE_BASE_URL to override
// with a company-subdomain URL if Pipedrive fully retires the generic host.
//
// Env vars required: PIPEDRIVE_API_TOKEN
// Env vars optional: PIPEDRIVE_BASE_URL (default https://api.pipedrive.com/v1)

import { getState, setState } from "./kv.js";
import { Redis } from "@upstash/redis";

const BASE_URL = process.env.PIPEDRIVE_BASE_URL || "https://api.pipedrive.com/v1";
const TOKEN = process.env.PIPEDRIVE_API_TOKEN;

// Person custom field: "LinkedIn URL" (varchar, field id 27), created during
// the Sept 2026 backfill (session-update-2026-09-05-linkedin-url-backfill-complete-260-of-260.md).
// Pipedrive addresses custom fields by this opaque key, not the display name.
const PERSON_LINKEDIN_URL_FIELD_KEY = process.env.PIPEDRIVE_LINKEDIN_URL_FIELD_KEY || "fc2a686381501e4476e241197f5fde72d9e10d64";

// ---- Shared daily call counter ----------------------------------------
//
// Why this lives here and not in the caller, 2026-09-19.
//
// apollo-sync kept its own count and stopped itself at 1200. On run #6 it
// stopped at nothing: Pipedrive returned 429 "daily request budget exceeded"
// while our counter read 1106. The guard was watching one job's spend and
// Pipedrive was billing for all of them - mint-batch, cohort-build,
// linkedin-shortlist and poll-funnel share the same token and were invisible
// to it. A budget guard that only sees one consumer is not a budget guard.
//
// So every request through this client counts itself, whoever made it. The
// count is flushed in batches rather than per call, because doubling the round
// trips to protect against a limit we rarely approach would be a poor trade.
// A failed request counts too: Pipedrive charged for it either way.
const kv = Redis.fromEnv();

// Deliberately below the ~1106 at which Pipedrive actually refused us on
// 2026-09-19. Pipedrive does not publish this number per account and it is
// shared with anything else touching the same token, so treat it as an
// observed ceiling rather than a documented one and leave real headroom.
export const PIPEDRIVE_DAILY_BUDGET = Number(process.env.PIPEDRIVE_DAILY_BUDGET || 900);

const callsKey = () => `pipedrive:calls:${new Date().toISOString().slice(0, 10)}`;
const FLUSH_EVERY = 25;
let pendingCalls = 0;

async function flushCalls() {
  if (pendingCalls <= 0) return;
  const n = pendingCalls;
  pendingCalls = 0;
  try {
    const k = callsKey();
    await kv.incrby(k, n);
    await kv.expire(k, 3 * 24 * 60 * 60);
  } catch (err) {
    // Put it back rather than lose it. Over-counting later costs us a little
    // throughput; under-counting costs us the day.
    pendingCalls += n;
    console.error("pipedrive: could not record call count:", err);
  }
}

// What every job has spent against the shared token today, including calls
// this process has made but not yet flushed.
export async function pipedriveSpentToday() {
  await flushCalls();
  try {
    return Number((await kv.get(callsKey())) || 0);
  } catch (err) {
    console.error("pipedrive: could not read today's call count:", err);
    return 0;
  }
}

// Call before returning from a job, so a run that ends early still leaves an
// honest number behind.
export async function flushPipedriveSpend() {
  await flushCalls();
}

async function pd(path, { method = "GET", body } = {}) {
  if (!TOKEN) throw new Error("PIPEDRIVE_API_TOKEN is not set");
  pendingCalls++;
  if (pendingCalls >= FLUSH_EVERY) await flushCalls();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "x-api-token": TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(
      `Pipedrive ${method} ${path} failed: ${res.status} ${JSON.stringify(json)}`
    );
  }
  return json.data;
}

// ---- Custom deal fields: resolve by human-readable name, create if missing ----
// Pipedrive custom fields are addressed internally by an opaque hash key, not
// their display name. We cache name -> key in KV so we only hit /dealFields
// when the cache is empty or a name is missing from it.

const DEAL_FIELDS_CACHE_KEY = "pipedrive:dealFieldsMap";

export async function getDealFieldsMap({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await getState(DEAL_FIELDS_CACHE_KEY);
    if (cached) return cached;
  }
  const fields = await pd("/dealFields");
  const map = {};
  for (const f of fields) map[f.name] = { key: f.key, field_type: f.field_type };
  await setState(DEAL_FIELDS_CACHE_KEY, map);
  return map;
}

// options: { field_type: 'varchar' | 'double' | 'date' | 'enum' | ..., options: [{label}] for enum }
export async function ensureDealField(name, options = { field_type: "varchar" }) {
  const map = await getDealFieldsMap();
  if (map[name]) return map[name];

  const created = await pd("/dealFields", {
    method: "POST",
    body: { name, field_type: options.field_type, options: options.options },
  });
  const refreshed = await getDealFieldsMap({ forceRefresh: true });
  return refreshed[name] || { key: created.key, field_type: created.field_type };
}

// Convenience: given { "Cohort": "B", "Lane2 Score": 45 }, resolve each name
// to its field key (creating the field first if it doesn't exist yet) and
// return the { [key]: value } object Pipedrive's update/create endpoints want.
export async function resolveCustomFields(namedValues, fieldTypeHints = {}) {
  const out = {};
  for (const [name, value] of Object.entries(namedValues)) {
    const field = await ensureDealField(name, fieldTypeHints[name] || { field_type: "varchar" });
    out[field.key] = value;
  }
  return out;
}

// ---- Persons ----

export async function findPersonByEmail(email) {
  const result = await pd(
    `/persons/search?term=${encodeURIComponent(email)}&fields=email&exact_match=true`
  );
  const item = result?.items?.[0]?.item;
  return item || null;
}

export async function createPerson({ name, email, linkedinUrl }) {
  const body = { name, email: [{ value: email, primary: true }] };
  if (linkedinUrl) body[PERSON_LINKEDIN_URL_FIELD_KEY] = linkedinUrl;
  return pd("/persons", { method: "POST", body });
}

// Sets the LinkedIn URL field on an existing person. Used as a safety net so
// a person record that already existed (created before this field existed,
// or added to Pipedrive by hand) still ends up with a LinkedIn URL rather
// than silently staying blank.
export async function updatePersonLinkedInUrl(personId, linkedinUrl) {
  return pd(`/persons/${personId}`, {
    method: "PUT",
    body: { [PERSON_LINKEDIN_URL_FIELD_KEY]: linkedinUrl },
  });
}

export async function findOrCreatePerson({ name, email, linkedinUrl }) {
  const existing = await findPersonByEmail(email);
  if (existing) {
    if (linkedinUrl && !existing[PERSON_LINKEDIN_URL_FIELD_KEY]) {
      await updatePersonLinkedInUrl(existing.id, linkedinUrl);
    }
    return existing;
  }
  return createPerson({ name, email, linkedinUrl });
}

// ---- Deals ----

// Why this uses v2, 2026-09-20.
//
// This was `pd("/deals?person_id=" + personId)`. Pipedrive's v1 GET /deals has
// no person_id parameter - their own staff say so on the developer forum, in a
// thread requesting it be added - and v1 does not reject unknown query
// parameters. It ignored person_id and returned the first page of ALL deals.
//
// So this function never returned an empty array, apollo-sync read that as
// "this person already has a deal", and it skipped every single contact it has
// ever looked at. created:0 was not a supply problem. It was this.
//
// Proof, if it is ever doubted again: on 2026-09-20 twenty-five contacts that
// had never been prospected, never been in Pipedrive and were saved in Apollo
// minutes earlier all came back as already-synced, at exactly two Pipedrive
// calls each, with nothing created.
//
// person_id IS supported on v2, which is also strict about parameters it does
// not know - so a mistake like this one fails loudly there instead of silently.
const BASE_URL_V2 = process.env.PIPEDRIVE_BASE_URL_V2 || "https://api.pipedrive.com/api/v2";

async function pdV2(path, { method = "GET", body } = {}) {
  if (!TOKEN) throw new Error("PIPEDRIVE_API_TOKEN is not set");
  pendingCalls++;
  if (pendingCalls >= FLUSH_EVERY) await flushCalls();
  const res = await fetch(`${BASE_URL_V2}${path}`, {
    method,
    headers: { "x-api-token": TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`Pipedrive v2 ${method} ${path} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.data;
}

export async function findDealsByPersonId(personId) {
  const data = await pdV2(`/deals?person_id=${encodeURIComponent(personId)}&limit=1`);
  return Array.isArray(data) ? data : [];
}

// Pages through every deal in a given pipeline/stage. Used by the LinkedIn
// scoring job to find this week's cold-outreach cohort deals.
// status defaults to "open" because Pipedrive's /deals endpoint defaults to
// "all_not_deleted" - it hands back lost and won deals alongside open ones.
// That default is what put 21 deals Marina had personally disqualified into
// the c20260915 cohort on 2026-09-15: every pre-324 deal in that 265-row file
// was a lost deal, and three of them were minted, loaded into Instantly and
// only caught the morning of the send. A caller that genuinely wants closed
// deals has to ask for them by name.
export async function listDealsByPipelineStage(
  pipelineId,
  stageId,
  { limit = 100, status = "open" } = {}
) {
  const deals = [];
  let start = 0;
  for (;;) {
    const page = await pd(
      `/deals?pipeline_id=${pipelineId}&stage_id=${stageId}&status=${encodeURIComponent(status)}&start=${start}&limit=${limit}`
    );
    if (!page || page.length === 0) break;
    deals.push(...page);
    if (page.length < limit) break;
    start += limit;
  }
  return deals;
}

export async function getPersonById(personId) {
  return pd(`/persons/${personId}`);
}

export async function createDeal({ title, personId, pipelineId, stageId, customFieldsByName }) {
  const custom = customFieldsByName
    ? await resolveCustomFields(customFieldsByName)
    : {};
  return pd("/deals", {
    method: "POST",
    body: {
      title,
      person_id: personId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      ...custom,
    },
  });
}

export async function updateDeal(dealId, customFieldsByName) {
  const custom = await resolveCustomFields(customFieldsByName);
  return pd(`/deals/${dealId}`, { method: "PUT", body: custom });
}

export async function createNote(dealId, content, { pinned = false } = {}) {
  return pd("/notes", {
    method: "POST",
    body: { deal_id: dealId, content, pinned_to_deal_flag: pinned ? 1 : 0 },
  });
}

// ---- Funnel analytics ----
// The MN: Enrolment pipeline is the bottom of the cold-outreach funnel:
// 20 New Lead -> 21 Report Started -> 22 Report Completed -> 23 Call Booked
// -> 24 Call Held -> 25 Tier Sold -> 26 Retainer Attached.
//
// A deal sits in exactly one stage, so "completed" has to mean "reached stage
// 22 or beyond", not "currently in stage 22" - otherwise every deal that
// progresses to a booked call silently drops out of the completed count.
export const ENROLMENT_PIPELINE_ID = Number(process.env.PIPEDRIVE_PIPELINE_ID || 4);
export const ENROLMENT_STAGES = {
  newLead: 20,
  reportStarted: 21,
  reportCompleted: 22,
  callBooked: 23,
  callHeld: 24,
  tierSold: 25,
};

// Cohort is written by the Fillout -> Pipedrive webhook when it carries the
// email's utm_campaign. Deals without it cannot be attributed to a batch.
export const DEAL_FIELD_COHORT =
  process.env.PIPEDRIVE_COHORT_FIELD_KEY || "c9842bde303467cc36b06cfd2cca00ad454749ea";
export const DEAL_FIELD_UTM_SOURCE =
  process.env.PIPEDRIVE_UTM_SOURCE_FIELD_KEY || "c06a6900378e4db6078a66263475819699632ab3";

export async function listEnrolmentDeals() {
  const out = [];
  let start = 0;
  for (let page = 0; page < 20; page++) {
    const json = await pd(`/deals?status=all&limit=500&start=${start}`);
    const items = json || [];
    for (const d of items) {
      if (Number(d.pipeline_id) !== ENROLMENT_PIPELINE_ID) continue;
      out.push({
        stageId: Number(d.stage_id),
        cohort: d[DEAL_FIELD_COHORT] || null,
        utmSource: d[DEAL_FIELD_UTM_SOURCE] || null,
        addTime: d.add_time || null,
      });
    }
    if (items.length < 500) break;
    start += 500;
  }
  return out;
}
