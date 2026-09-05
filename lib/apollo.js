// Apollo.io API client - contacts search only (this is a poll-based replacement
// for the old Zapier "Contact Updated" trigger; Apollo has no reliable outbound
// webhook we can point at our own endpoint).
//
// Env vars required: APOLLO_API_KEY

const BASE_URL = "https://api.apollo.io/api/v1";
const API_KEY = process.env.APOLLO_API_KEY;

async function apollo(path, { method = "GET", body } = {}) {
  if (!API_KEY) throw new Error("APOLLO_API_KEY is not set");
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Apollo ${method} ${path} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

// Fetch one page of contacts sitting in a given contact stage (e.g. the
// "Cold" stage ID this project already uses), sorted newest-updated first.
// We page through until we hit contacts we've already processed (tracked
// separately via KV in the cron handler) rather than relying on a
// last-modified filter param, since Apollo's search API doesn't expose one.
export async function searchContactsByStage(stageId, { page = 1, perPage = 100 } = {}) {
  const json = await apollo("/contacts/search", {
    method: "POST",
    body: {
      contact_stage_ids: [stageId],
      sort_by_field: "contact_updated_at",
      sort_ascending: false,
      page,
      per_page: perPage,
    },
  });
  return {
    contacts: json.contacts || [],
    totalPages: json.pagination?.total_pages || 1,
  };
}
