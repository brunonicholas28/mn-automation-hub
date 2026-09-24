// Ad spend, and the cost-per-outcome numbers that come out of it.
//
// Everything else on this dashboard is polled automatically. Spend is the one
// input that cannot be, and it is worth being plain about why: the LinkedIn
// token this project holds is a Direct API conversions token from Signals
// Manager (LINKEDIN_CAPI_TOKEN), scoped to writing conversion events. Reading
// campaign spend needs an ads-reporting scope on a LinkedIn developer app,
// which is a separate authorisation. Until that exists, spend is set here.
//
// Two ways in, both set-and-forget rather than weekly typing:
//
//   1. A monthly figure posted to /api/spend, stored per calendar month.
//   2. LINKEDIN_AD_SPEND_MONTHLY / COLD_OUTREACH_SPEND_MONTHLY env vars, used
//      for any month with no stored figure. If the budget is steady this is
//      all that is ever needed.
//
// When neither is set the cost metrics return null, and the dashboard prints
// a dash and says spend is not set. It never prints a zero: a cost per sale of
// £0 reads as "free", which is the opposite of "we do not know".

import { getState, setState } from "./kv.js";

export function currentMonth(d = new Date()) {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

function spendKey(month) {
  return "spend:" + month;
}

function envFallback() {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const linkedin = num(process.env.LINKEDIN_AD_SPEND_MONTHLY);
  const cold = num(process.env.COLD_OUTREACH_SPEND_MONTHLY);
  if (linkedin === null && cold === null) return null;
  return { linkedin, cold, source: "env" };
}

export async function readSpend(month = currentMonth()) {
  const stored = await getState(spendKey(month));
  if (stored && (stored.linkedin != null || stored.cold != null)) {
    return { ...stored, month, source: "stored" };
  }
  const fallback = envFallback();
  return fallback ? { ...fallback, month } : { linkedin: null, cold: null, month, source: "unset" };
}

export async function writeSpend({ month = currentMonth(), linkedin, cold }) {
  const existing = (await getState(spendKey(month))) || {};
  const num = (v, prev) => {
    if (v === undefined || v === null || v === "") return prev ?? null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error("spend must be a non-negative number");
    return n;
  };
  const next = {
    linkedin: num(linkedin, existing.linkedin),
    cold: num(cold, existing.cold),
    updatedAt: new Date().toISOString(),
  };
  await setState(spendKey(month), next);
  return { ...next, month, source: "stored" };
}

// Divide, but only when both sides mean something. A cost per sale with no
// sales yet is unknown, not infinite, and not zero.
function per(spend, count) {
  if (spend === null || spend === undefined) return null;
  if (!count) return null;
  return Math.round((spend / count) * 100) / 100;
}

export function costMetrics(spend, funnel) {
  return {
    spend: spend ?? null,
    // A visit to the landing page is the closest thing to a click this stack
    // can see first-hand, so it is what cost-per-click is computed from
    // rather than a number read off the ad platform.
    costPerClick: per(spend, funnel?.visits),
    costPerReport: per(spend, funnel?.completed),
    costPerCall: per(spend, funnel?.booked),
    costPerCallHeld: per(spend, funnel?.held),
    costPerSale: per(spend, funnel?.sold),
  };
}
