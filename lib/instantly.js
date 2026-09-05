// Instantly.ai API v2 client - polling only (webhooks are gated behind the
// Hyper Growth plan; polling the read API works on the existing Growth plan
// and is all this project needs since scoring only runs weekly, not in
// real time). Docs: https://developer.instantly.ai/api-reference/lead/list-leads
//
// Env vars required: INSTANTLY_API_KEY, INSTANTLY_CAMPAIGN_ID

const BASE_URL = "https://api.instantly.ai/api/v2";
const API_KEY = process.env.INSTANTLY_API_KEY;
const CAMPAIGN_ID = process.env.INSTANTLY_CAMPAIGN_ID;

async function instantly(path, { method = "POST", body } = {}) {
  if (!API_KEY) throw new Error("INSTANTLY_API_KEY is not set");
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Instantly ${method} ${path} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

// Pages through every lead in the campaign, returning the engagement fields
// the scoring formula needs. Matches back to Pipedrive by email.
export async function listAllLeadsEngagement() {
  if (!CAMPAIGN_ID) throw new Error("INSTANTLY_CAMPAIGN_ID is not set");
  const leads = [];
  let startingAfter;
  do {
    const json = await instantly("/leads/list", {
      body: { campaign: CAMPAIGN_ID, limit: 100, starting_after: startingAfter },
    });
    for (const item of json.items || []) {
      leads.push({
        email: item.email,
        opened: (item.email_open_count || 0) > 0,
        replied: (item.email_reply_count || 0) > 0,
        lastOpenAt: item.timestamp_last_open || null,
        lastReplyAt: item.timestamp_last_reply || null,
      });
    }
    startingAfter = json.next_starting_after || null;
  } while (startingAfter);
  return leads;
}
