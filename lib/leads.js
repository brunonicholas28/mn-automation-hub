// Per-lead funnel tokens.
//
// The landing-page beacon is anonymous by design: it counts a tagged visit
// without storing an IP, a user agent or a cookie, which is what keeps the
// page free of a consent banner. That is the right default, but it means we
// cannot tell WHO clicked and did not start - only how many did.
//
// So each lead gets an opaque random token, minted when the send CSV is
// built, and carried on the email link as ?lid=<token>. The token maps to
// the lead inside our own KV and nowhere else. The prospect's email address
// never appears in a URL: query strings leak into referrer headers, browser
// history, and every third-party script on any page the link touches.
//
// Storage per lead: lead:<lid> -> { email, firstName, company, cohort,
// createdAt, visitedAt, startedAt, completedAt, nudgedAt, nudgeCampaign }.
// Plus a set lead:index:<cohort> so a cron can sweep one cohort without
// scanning the keyspace.

import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

const kv = Redis.fromEnv();

// Tokens live as long as a cadence plus a wide margin, then expire. There is
// no reason to hold a mapping from a random string to a person's email
// address for longer than the campaign that needs it.
export const LEAD_TTL_SECONDS = 120 * 24 * 60 * 60;

export const leadKey = (lid) => `lead:${lid}`;
export const leadIndexKey = (cohort) => `lead:index:${cohort}`;

// 9 random bytes -> 12 url-safe characters. Long enough that guessing one is
// pointless, short enough that the link still looks like a link.
export function mintToken() {
  return crypto.randomBytes(9).toString("base64url");
}

// Values arrive from a public endpoint, so a token is never used as a key
// until it has been scrubbed to the alphabet we actually mint.
export function normaliseToken(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(s)) return null;
  return s;
}

const nowIso = () => new Date().toISOString();

export async function putLead(lid, { email, firstName, company, cohort }) {
  const key = leadKey(lid);
  const p = kv.pipeline();
  p.hset(key, {
    email: String(email || "").trim().toLowerCase(),
    firstName: firstName || "",
    company: company || "",
    cohort: cohort || "",
    createdAt: nowIso(),
  });
  p.expire(key, LEAD_TTL_SECONDS);
  if (cohort) {
    p.sadd(leadIndexKey(cohort), lid);
    p.expire(leadIndexKey(cohort), LEAD_TTL_SECONDS);
  }
  await p.exec();
}

// First touch wins for each stage: a lead who reloads the landing page five
// times visited once, and the timestamp we care about is the first one,
// because the nudge delay is measured from it.
export async function markLeadStage(lid, stage) {
  const field = { visit: "visitedAt", started: "startedAt", completed: "completedAt" }[stage];
  if (!field) return false;
  const key = leadKey(lid);
  // hsetnx on a key that does not exist would mint a junk lead record from a
  // guessed or stale token, so only mark tokens we actually issued.
  const exists = await kv.hexists(key, "createdAt");
  if (!exists) return false;
  await kv.hsetnx(key, field, nowIso());
  return true;
}

export async function readLead(lid) {
  const raw = (await kv.hgetall(leadKey(lid))) || {};
  if (!raw.createdAt) return null;
  return { lid, ...raw };
}

export async function listLeadTokens(cohort) {
  const ids = await kv.smembers(leadIndexKey(cohort));
  return (ids || []).filter(Boolean);
}

// One pipeline rather than one round trip per lead - a cohort is hundreds of
// leads and a serial read would time out the function long before it finished.
export async function readLeads(lids) {
  if (!lids.length) return [];
  const p = kv.pipeline();
  for (const lid of lids) p.hgetall(leadKey(lid));
  const rows = await p.exec();
  return lids
    .map((lid, i) => {
      const raw = rows[i] || {};
      return raw && raw.createdAt ? { lid, ...raw } : null;
    })
    .filter(Boolean);
}

export async function markNudged(lid, campaignId) {
  await kv.hset(leadKey(lid), { nudgedAt: nowIso(), nudgeCampaign: campaignId || "" });
}
