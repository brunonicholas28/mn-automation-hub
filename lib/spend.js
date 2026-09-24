// Ad spend, and the cost-per-outcome numbers that come out of it.
//
// Everything else on this dashboard is polled automatically. Spend is the one
// input that cannot be, and it is worth being plain about why: the LinkedIn
// token this project holds is a Direct API conversions token from Signals
// Manager (LINKEDIN_CAPI_TOKEN), scoped to writing conversion events. Reading
// campaign spend needs an ads-reporting scope on a LinkedIn developer app,
// which is a separate authorisation. Until that exists, spend is set here.
//
// A budget over a period, not a figure per calendar month
// -------------------------------------------------------
// The first version of this stored a monthly figure, and it was wrong twice
// over. Budgets are committed per flight ("£2,090 to 15 October"), which does
// not respect month boundaries; and the funnel counters this divides into are
// cumulative totals for a campaign, not per-month counts. Dividing one month's
// spend by an all-time outcome count compares two different windows.
//
// So a budget is { budget, from, to } and what the cost metrics actually use
// is SPEND TO DATE - the budget pro-rated by how much of the flight has
// elapsed. Mid-flight this matters enormously: on day 2 of a 24-day flight,
// dividing the whole £2,090 by the bookings so far would report a cost per
// call roughly twelve times the truth.
//
// Pro-rating assumes spend is even across the flight. It will not be exactly,
// but it is far closer than either alternative (the whole budget, or nothing),
// and the dashboard says the figure is pro-rated rather than implying it was
// read off the ad platform.

import { getState, setState } from "./kv.js";

const DAY = 24 * 60 * 60 * 1000;

function key(channel) {
  return "spend:budget:" + channel;
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(String(v).length <= 10 ? String(v) + "T00:00:00Z" : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function envBudget(channel) {
  const budget = num(process.env[channel.toUpperCase() + "_AD_BUDGET"]);
  if (budget === null) return null;
  return {
    budget,
    from: process.env[channel.toUpperCase() + "_AD_BUDGET_FROM"] || null,
    to: process.env[channel.toUpperCase() + "_AD_BUDGET_TO"] || null,
    source: "env",
  };
}

// How much of the budget has been spent by now, assuming an even daily rate.
// Before the flight starts: nothing. After it ends: all of it.
export function spendToDate(row, now = new Date()) {
  if (!row || row.budget === null || row.budget === undefined) return null;
  const from = toDate(row.from);
  const to = toDate(row.to);
  if (!from || !to || to <= from) return row.budget; // no usable window: treat as spent
  const span = to.getTime() - from.getTime();
  const elapsed = now.getTime() - from.getTime();
  const frac = Math.max(0, Math.min(1, elapsed / span));
  return Math.round(row.budget * frac * 100) / 100;
}

export function daysLeft(row, now = new Date()) {
  const to = toDate(row?.to);
  if (!to) return null;
  return Math.max(0, Math.ceil((to.getTime() - now.getTime()) / DAY));
}

export async function readBudget(channel) {
  const stored = await getState(key(channel));
  const row = stored && stored.budget !== undefined && stored.budget !== null
    ? { ...stored, source: "stored" }
    : envBudget(channel);
  if (!row) return { budget: null, from: null, to: null, source: "unset", toDate: null, daysLeft: null };
  return { ...row, toDate: spendToDate(row), daysLeft: daysLeft(row) };
}

export async function writeBudget(channel, { budget, from, to }) {
  const b = num(budget);
  if (b === null) throw new Error("budget must be a non-negative number");
  const row = {
    budget: b,
    from: from ? String(from).slice(0, 10) : null,
    to: to ? String(to).slice(0, 10) : null,
    updatedAt: new Date().toISOString(),
  };
  await setState(key(channel), row);
  return { ...row, source: "stored", toDate: spendToDate(row), daysLeft: daysLeft(row) };
}

// Divide, but only when both sides mean something. A cost per sale with no
// sales yet is unknown, not infinite, and not zero.
function per(spend, count) {
  if (spend === null || spend === undefined) return null;
  if (!count) return null;
  return Math.round((spend / count) * 100) / 100;
}

export function costMetrics(budgetRow, funnel) {
  const spent = budgetRow ? budgetRow.toDate : null;
  return {
    budget: budgetRow ? budgetRow.budget : null,
    from: budgetRow ? budgetRow.from : null,
    to: budgetRow ? budgetRow.to : null,
    daysLeft: budgetRow ? budgetRow.daysLeft : null,
    spentToDate: spent,
    // A visit to the landing page is the closest thing to a click this stack
    // can see first-hand, so cost-per-click is computed from that rather than
    // a number read off the ad platform.
    costPerClick: per(spent, funnel?.visits),
    costPerReport: per(spent, funnel?.completed),
    costPerCall: per(spent, funnel?.booked),
    costPerCallHeld: per(spent, funnel?.held),
    costPerSale: per(spent, funnel?.sold),
  };
}
