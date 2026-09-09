// Instantly.ai API v2 client - polling only (webhooks are gated behind the
// Hyper Growth plan; polling the read API works on the existing Growth plan).
// Docs: https://developer.instantly.ai/api-reference/lead/list-leads
//
// Env vars required: INSTANTLY_API_KEY. INSTANTLY_CAMPAIGN_ID is only needed
// by the older single-campaign scoring path.

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

export async function listCampaigns() {
  const out = [];
  let after;
  do {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("starting_after", after);
    const json = await instantly(`/campaigns?${qs.toString()}`, { method: "GET" });
    for (const c of json.items || []) {
      out.push({
        id: c.id,
        name: c.name,
        status: c.status,
        createdAt: c.timestamp_created || null,
      });
    }
    after = json.next_starting_after || null;
  } while (after && out.length < 500);
  return out;
}

// Every field the funnel counts, plus the raw status so a poll can report a
// tally back rather than silently guessing at codes it has not seen.
export async function listCampaignLeads(campaignId) {
  const leads = [];
  let after;
  do {
    const json = await instantly("/leads/list", {
      body: { campaign: campaignId, limit: 100, starting_after: after },
    });
    for (const item of json.items || []) {
      leads.push({
        id: item.id,
        email: (item.email || "").trim().toLowerCase(),
        status: item.status,
        statusSummary: item.status_summary ?? null,
        espCode: item.esp_code ?? null,
        verification: item.verification_status ?? null,
        replyCount: Number(item.email_reply_count || 0),
        openCount: Number(item.email_open_count || 0),
        clickCount: Number(item.email_click_count || 0),
        bounceCount: Number(item.email_bounced_count ?? item.email_bounce_count ?? 0),
        lastContactAt: item.timestamp_last_contact || null,
        lastReplyAt: item.timestamp_last_reply || null,
      });
    }
    after = json.next_starting_after || null;
  } while (after && leads.length < 20000);
  return leads;
}

// Kept for the LinkedIn Lane 2 scoring pipeline, which matches back to
// Pipedrive by email and still runs against a single campaign.
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

// Instantly auto-adds a lead to the blocklist when it detects an opt-out reply,
// which makes the blocklist the single source of truth for "do not contact" -
// no human step, and it covers every future opt-out automatically.
//
// The v2 path for this is not pinned in the docs we have, so try the plausible
// ones and report which answered rather than silently returning an empty list.
// An empty blocklist and a broken endpoint must never look the same: the caller
// suppresses nobody in both cases, so it has to be able to tell them apart.
const BLOCKLIST_PATHS = [
  "/blocklist-entries",
  "/block-lists",
  "/blocklist",
];

export async function listBlocklist() {
  const attempts = [];
  for (const path of BLOCKLIST_PATHS) {
    try {
      const entries = [];
      let after;
      do {
        const qs = new URLSearchParams({ limit: "100" });
        if (after) qs.set("starting_after", after);
        const json = await instantly(`${path}?${qs.toString()}`, { method: "GET" });
        const items = json.items || json.data || (Array.isArray(json) ? json : []);
        for (const it of items) {
          const v = (typeof it === "string" ? it : it.bl_value || it.value || it.email || it.domain || "")
            .trim()
            .toLowerCase();
          if (v) entries.push(v);
        }
        after = json.next_starting_after || null;
      } while (after && entries.length < 10000);
      return { ok: true, path, entries, attempts };
    } catch (err) {
      attempts.push({ path, error: String(err.message || err).slice(0, 160) });
    }
  }
  return { ok: false, path: null, entries: [], attempts };
}

// An entry blocks an address either exactly or as its whole domain.
export function isBlocked(email, blocklist) {
  if (!email) return false;
  const e = String(email).trim().toLowerCase();
  if (blocklist.includes(e)) return true;
  const domain = e.split("@")[1];
  return domain ? blocklist.includes(domain) || blocklist.includes("@" + domain) : false;
}


// Moving a lead between campaigns, rather than adding it to a second one, is
// deliberate: two live sequences on one person means two emails in one week
// from the same sender, which is the fastest way to turn an interested
// prospect into a spam complaint.
//
// The v2 path for a bulk move is not pinned in the docs we hold, so try the
// plausible ones and report which answered. Callers must treat ok:false as a
// hard stop rather than falling back to "add without removing" - a silent
// double-send is worse than not sending at all.
const MOVE_PATHS = [
  { path: "/leads/move", body: (ids, to) => ({ ids, to_campaign_id: to }) },
  { path: "/leads/move", body: (ids, to) => ({ lead_ids: ids, to_campaign_id: to }) },
  { path: "/leads/move", body: (ids, to) => ({ ids, campaign: to }) },
];

export async function moveLeadsToCampaign(leadIds, toCampaignId) {
  if (!leadIds.length) return { ok: true, moved: 0, path: null, attempts: [] };
  if (!toCampaignId) throw new Error("moveLeadsToCampaign: no target campaign id");
  const attempts = [];
  for (const candidate of MOVE_PATHS) {
    try {
      const json = await instantly(candidate.path, { body: candidate.body(leadIds, toCampaignId) });
      return { ok: true, moved: leadIds.length, path: candidate.path, response: json, attempts };
    } catch (err) {
      attempts.push({ path: candidate.path, error: String(err.message || err).slice(0, 200) });
    }
  }
  return { ok: false, moved: 0, path: null, attempts };
}
