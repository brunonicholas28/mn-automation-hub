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

const BASE_URL = process.env.PIPEDRIVE_BASE_URL || "https://api.pipedrive.com/v1";
const TOKEN = process.env.PIPEDRIVE_API_TOKEN;

// Person custom field: "LinkedIn URL" (varchar, field id 27), created during
// the Sept 2026 backfill (session-update-2026-09-05-linkedin-url-backfill-complete-260-of-260.md).
// Pipedrive addresses custom fields by this opaque key, not the display name.
const PERSON_LINKEDIN_URL_FIELD_KEY = process.env.PIPEDRIVE_LINKEDIN_URL_FIELD_KEY || "fc2a686381501e4476e241197f5fde72d9e10d64";

async function pd(path, { method = "GET", body } = {}) {
  if (!TOKEN) throw new Error("PIPEDRIVE_API_TOKEN is not set");
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

export async function findDealsByPersonId(personId) {
  return pd(`/deals?person_id=${personId}`);
}

// Pages through every deal in a given pipeline/stage. Used by the LinkedIn
// scoring job to find this week's cold-outreach cohort deals.
export async function listDealsByPipelineStage(pipelineId, stageId, { limit = 100 } = {}) {
  const deals = [];
  let start = 0;
  for (;;) {
    const page = await pd(
      `/deals?pipeline_id=${pipelineId}&stage_id=${stageId}&start=${start}&limit=${limit}`
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
