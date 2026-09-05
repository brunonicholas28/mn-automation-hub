// Thin wrapper around Vercel KV, used to persist small pieces of state
// between cron runs (last-synced cursor, resolved Pipedrive custom field
// keys, etc). Requires a Vercel KV store connected to this project
// (Storage tab -> Create Database -> KV) - Vercel wires the required
// KV_REST_API_URL / KV_REST_API_TOKEN env vars automatically once connected.

import { kv } from "@vercel/kv";

export async function getState(key, fallback = null) {
  const value = await kv.get(key);
  return value === null || value === undefined ? fallback : value;
}

export async function setState(key, value) {
  await kv.set(key, value);
}
