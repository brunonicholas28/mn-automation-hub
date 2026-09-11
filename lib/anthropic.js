// Anthropic Messages API client, used for one job only: finding the single
// notable fact behind a cohort's Day 2 hook.
//
// Web search runs as a server tool inside the API call rather than as a
// separate search step, which matters here for one specific reason: the fact
// bar says no URL, no fact. Having the model search and cite in the same turn
// means the citation comes back attached to the claim instead of being
// reconstructed afterwards, which is where fabrications get in.
//
// Env: ANTHROPIC_API_KEY. HOOK_MODEL optionally pins the model; without it
// the client asks the API which models exist and takes the newest Sonnet, so
// a model being retired does not silently break the weekly run.

const BASE_URL = "https://api.anthropic.com/v1";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const VERSION = "2023-06-01";

let cachedModel = null;

async function anthropic(path, { method = "POST", body } = {}) {
  if (!API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": VERSION,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json && json.error ? json.error.message : JSON.stringify(json);
    throw new Error(
      "Anthropic " + method + " " + path + " " + res.status + ": " + String(detail).slice(0, 200)
    );
  }
  return json;
}

export async function listModels() {
  const json = await anthropic("/models?limit=100", { method: "GET" });
  return (json.data || []).map((m) => ({ id: m.id, name: m.display_name, createdAt: m.created_at }));
}

// Newest Sonnet wins. Sonnet is the right weight for this work: it is reading
// a handful of search results and judging whether one of them clears the fact
// bar, not reasoning at length.
export async function resolveModel() {
  if (process.env.HOOK_MODEL) return process.env.HOOK_MODEL;
  if (cachedModel) return cachedModel;

  const models = await listModels();
  const sonnets = models.filter((m) => /sonnet/i.test(m.id));
  const pool = sonnets.length ? sonnets : models;
  pool.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  if (!pool.length) throw new Error("the Anthropic API returned no models");
  cachedModel = pool[0].id;
  return cachedModel;
}

// One research turn. Returns the assistant's plain text plus how many
// searches it actually ran, so a run can report what it cost.
export async function researchOnce(prompt, { model, maxSearches = 4, maxTokens = 900 } = {}) {
  const useModel = model || (await resolveModel());
  const json = await anthropic("/messages", {
    body: {
      model: useModel,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }],
    },
  });

  let text = "";
  let searches = 0;
  for (const block of json.content || []) {
    if (block.type === "text") text += block.text;
    if (block.type === "server_tool_use" && block.name === "web_search") searches += 1;
  }
  const usage = json.usage || {};
  return {
    model: useModel,
    text: text.trim(),
    searches,
    stopReason: json.stop_reason || null,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
  };
}
