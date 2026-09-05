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

export async function createPerson({ name, email }) {
  return pd("/persons", {
    method: "POST",
    body: { name, email: [{ value: email, primary: true }] },
  });
}

export async function findOrCreatePerson({ name, email }) {
  const existing = await findPersonByEmail(email);
  if (existing) return existing;
  return createPerson({ name, email });
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
