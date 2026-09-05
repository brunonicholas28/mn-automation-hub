// Thin wrapper around Upstash Redis, used to persist small pieces of state
// between cron runs (last-synced cursor, resolved Pipedrive custom field
// keys, etc). Requires an Upstash Redis integration connected to this
// project via the Vercel Marketplace (Storage tab -> Browse Marketplace ->
// Upstash) - Vercel's own native "KV" product was discontinued, but the
// Upstash integration still injects the same KV_REST_API_URL /
// KV_REST_API_TOKEN env var names, which Redis.fromEnv() reads automatically.

import { Redis } from "@upstash/redis";

const kv = Redis.fromEnv();

export async function getState(key, fallback = null) {
  const value = await kv.get(key);
  return value === null || value === undefined ? fallback : value;
}

export async function setState(key, value) {
  await kv.set(key, value);
}
