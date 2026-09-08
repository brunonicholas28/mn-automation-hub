// Fillout REST API client.
//
// Docs: https://www.fillout.com/help/fillout-rest-api
// Auth: Bearer token from Settings -> Developer -> Enable API.
//
// The env var name is not pinned to one spelling because the key is created
// and pasted in by hand; accepting the obvious variants avoids a silent
// "no data" state caused by nothing worse than a naming mismatch.

const BASE_URL = "https://api.fillout.com/v1/api";

const KEY_CANDIDATES = [
  "FILLOUT_API_KEY",
  "FILLOUT_KEY",
  "FILLOUT_TOKEN",
  "FILLOUT_API_TOKEN",
];

export function resolveKey() {
  for (const name of KEY_CANDIDATES) {
    const v = process.env[name];
    if (v && String(v).trim()) return { name, value: String(v).trim() };
  }
  return { name: null, value: null };
}

async function fillout(path) {
  const { value } = resolveKey();
  if (!value) throw new Error("No Fillout API key set (tried " + KEY_CANDIDATES.join(", ") + ")");
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${value}` },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Fillout ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Fillout ${path} failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

export async function listForms() {
  const json = await fillout("/forms");
  const arr = Array.isArray(json) ? json : json.forms || [];
  return arr.map((f) => ({ formId: f.formId || f.id, name: f.name }));
}

// status: undefined for completed submissions, "in_progress" for partials.
export async function listSubmissions(formId, { status } = {}) {
  const out = [];
  let offset = 0;
  const limit = 150;
  for (let page = 0; page < 40; page++) {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (status) qs.set("status", status);
    const json = await fillout(`/forms/${encodeURIComponent(formId)}/submissions?${qs.toString()}`);
    const rows = json.responses || json.submissions || [];
    out.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
  }
  return out;
}

// Fillout has shuffled where URL parameters live between payload versions, so
// read defensively rather than pinning one path and silently getting null.
export function campaignOf(submission) {
  const params = submission?.urlParameters || submission?.url_parameters;
  if (Array.isArray(params)) {
    const hit = params.find((p) => /utm_?campaign/i.test(p?.name || p?.id || ""));
    if (hit && hit.value) return hit.value;
  } else if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      if (/utm_?campaign/i.test(k) && v) return v;
    }
  }
  return null;
}

// Duration is only computable when Fillout gives both ends. startedAt is not
// always present, so this returns null rather than inventing a number.
export function durationSeconds(submission) {
  const start = submission?.startedAt || submission?.startTime || submission?.createdAt;
  const end = submission?.submissionTime || submission?.lastUpdatedAt;
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 1000;
}
