// The whole organic pipeline on one page, from post impressions to sales.
// Added 2026-10-11 at Bruno's request: until now the numbers sat in four
// places (LinkedIn analytics, the hub, Marina's page, Pipedrive) and only met
// once a week in the Monday scorecard.
//
// Where each stage comes from:
//   - Impressions, link clicks, followers: LinkedIn, which offers no API for
//     a member's post stats. The Monday scheduled task reads them in Chrome
//     (logged in as Marina) and POSTs them here (op "set-reach"), so these
//     rows move weekly, not live.
//   - Visits, reports started/completed: the li-* cohorts, live.
//   - DMs, replies, connections: Marina's log (organic:log), live.
//   - Calls booked onwards: Pipedrive deals in MN: Enrolment created since
//     the organic push began, test deals excluded, counted as "reached this
//     stage or beyond" so a deal that moves on is not lost from earlier rows.
//
// Counts only, no names, so the page can be open like the campaign dashboard.
// Pipedrive is read at most every five minutes (cached in Upstash), so an
// open tab or a crawler cannot burn the daily API budget.

import { Redis } from "@upstash/redis";
import { readAllCohorts } from "../cohort.js";
import { pipedriveV2 } from "../pipedrive.js";

const kv = Redis.fromEnv();
export const PUSH_START = process.env.ORGANIC_START_DATE || "2026-10-07";
const TEST_RE = /\b(test|e2e|capi|bruno|klarite|please ignore|dummy)\b/i;
const CACHE = "organic:pipeline:pd";

// Monthly revenue, entered by hand (added 2026-10-29 at Bruno's request).
// One entry per month; `total` is the month's revenue and `clients` splits it
// by client id, so each client gets its own line under the total. Overridden
// by the "organic:revenue" key once op "set-revenue" has been used.
export const REVENUE_DEFAULT = {
  clients: [{ id: "c1", name: "Active Client 1 (OpenAI)" }],
  activeClients: 1,
  funnelClients: 1,
  months: [
    { month: "2026-08", total: 10030, expenses: 3401, clients: { c1: 10030 } },
    { month: "2026-09", total: 11932, expenses: 5864, clients: { c1: 11932 } },
    { month: "2026-10", total: 14796, expenses: 4853, clients: { c1: 14796 } },
  ],
};

// Calls and deals that happened outside Pipedrive, added on top of its
// counts. Seeded 2026-10-29: 1 call booked and held that has no Pipedrive
// deal in MN: Enrolment. If that deal is later added to Pipedrive, set these
// back to 0 (op "set-adjust") or it will be counted twice.
export const ADJUST_DEFAULT = { booked: 1, held: 1, proposal: 0, sold: 0 };

async function pipedriveStages() {
  const cached = await kv.get(CACHE);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return { ...cached, cached: true };

  const stages = ((await pipedriveV2(`/stages?pipeline_id=4&limit=100`)) || [])
    .map((s) => ({ id: s.id, name: s.name, order: s.order_nr }))
    .sort((a, b) => a.order - b.order);
  // One page of 500 deals updated since the push began is far beyond what a
  // week of organic traffic produces; older deals are filtered out below.
  const deals = (await pipedriveV2(`/deals?pipeline_id=4&updated_since=${encodeURIComponent(PUSH_START + "T00:00:00Z")}&limit=500`)) || [];
  const order = new Map(stages.map((s) => [s.id, s.order]));
  const real = deals.filter(
    (d) => String(d.add_time || "").slice(0, 10) >= PUSH_START && !TEST_RE.test(String(d.title || ""))
  );
  const reached = (stageOrder) => real.filter((d) => (order.get(d.stage_id) ?? -1) >= stageOrder).length;
  const find = (re) => stages.find((s) => re.test(s.name));
  const s = {
    completed: find(/report completed/i),
    booked: find(/call booked/i),
    held: find(/call held/i),
    proposal: find(/proposal/i),
    sold: find(/sold/i),
  };
  const out = {
    at: Date.now(),
    deals: real.length,
    stages: stages.map((x) => x.name),
    reportCompletedDeals: s.completed ? reached(s.completed.order) : null,
    booked: s.booked ? reached(s.booked.order) : null,
    held: s.held ? reached(s.held.order) : null,
    proposal: s.proposal ? reached(s.proposal.order) : null,
    sold: s.sold ? reached(s.sold.order) : null,
    won: real.filter((d) => d.status === "won").length,
  };
  await kv.set(CACHE, out);
  return out;
}

export async function pipelineData({ readLog, countLog, routeFunnel, openTasks, ukDate, weekStart, TARGETS }) {
  const today = ukDate();
  const wk = weekStart(today);

  const cohorts = (await readAllCohorts()).filter((c) => /^li-/i.test(String(c.cohort || "")));
  const posts = cohorts
    .map((c) => ({ cohort: c.cohort, visits: +c.visits || 0, started: +c.started || 0, completed: +c.completed || 0, booked: +c.booked || 0 }))
    .sort((a, b) => a.cohort.localeCompare(b.cohort));
  const hub = posts.reduce((t, p) => ({ visits: t.visits + p.visits, started: t.started + p.started, completed: t.completed + p.completed, booked: t.booked + p.booked }), { visits: 0, started: 0, completed: 0, booked: 0 });

  const reachRaw = (await kv.hgetall("organic:reach")) || {};
  const reachWeeks = Object.values(reachRaw).map((v) => (typeof v === "string" ? JSON.parse(v) : v)).sort((a, b) => String(b.week).localeCompare(String(a.week)));
  const reach = reachWeeks.reduce((t, r) => ({ impressions: t.impressions + (+r.impressions || 0), linkClicks: t.linkClicks + (+r.linkClicks || 0), engagements: t.engagements + (+r.engagements || 0) }), { impressions: 0, linkClicks: 0, engagements: 0 });
  // Oldest first, for the weekly charts. Connections can also be recorded on
  // their own (op "set-connections"), keyed by the same Monday.
  const connRaw = (await kv.hgetall("organic:connections")) || {};
  const series = [...reachWeeks].reverse().map((w) => ({
    week: w.week, from: w.from, to: w.to,
    impressions: w.impressions ?? null, engagements: w.engagements ?? null,
    followers: w.followers ?? null,
    connections: connRaw[w.week] != null ? Number(connRaw[w.week]) : w.connections ?? null,
    membersReached: w.membersReached ?? null, inNetworkPct: w.inNetworkPct ?? null,
  }));
  for (const [week, n] of Object.entries(connRaw)) {
    if (!series.some((x) => x.week === week)) series.push({ week, from: week, to: null, impressions: null, engagements: null, followers: null, connections: Number(n), membersReached: null, inNetworkPct: null });
  }
  series.sort((a, b) => String(a.week).localeCompare(String(b.week)));

  const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
  const revenue = parse(await kv.get("organic:revenue")) || REVENUE_DEFAULT;
  const adjust = { ...ADJUST_DEFAULT, ...(parse(await kv.get("organic:adjust")) || {}) };

  const postReach = {};
  for (const r of [...reachWeeks].reverse()) for (const p of r.posts || []) if (p.cohort) postReach[p.cohort] = p;

  const log = await readLog();
  const sinceStart = countLog(log, PUSH_START, today);
  const thisWeek = countLog(log, wk, today);
  const routes = routeFunnel(log, PUSH_START, today);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - i);
    const ymd = d.toISOString().slice(0, 10);
    const c = countLog(log, ymd, ymd);
    days.push({ day: ymd, networkDms: c.networkDms, dms: c.byAction.dm || 0, connects: c.byAction.connect || 0, comments: c.byAction.comment_reply || 0 });
  }

  let tasks = { open: null, overdue: null };
  try {
    const t = await openTasks();
    tasks = { open: t.filter((x) => !x.due || x.due <= today).length, overdue: t.filter((x) => x.due && x.due < today).length, upcoming: t.filter((x) => x.due && x.due > today).length };
  } catch (e) {
    tasks.error = e.message;
  }

  let pd = null;
  let pdError = null;
  try {
    pd = await pipedriveStages();
  } catch (e) {
    pdError = String(e.message || e).slice(0, 200);
  }

  return {
    ok: true,
    today,
    pushStart: PUSH_START,
    targets: TARGETS,
    reach: { ...reach, latest: reachWeeks[0] || null, weeks: reachWeeks.length, series },
    revenue,
    adjust,
    hub,
    actions: {
      sinceStart: { dms: sinceStart.byAction.dm || 0, replies: sinceStart.byAction.reply || 0, calls: sinceStart.byAction.call || 0, connects: sinceStart.byAction.connect || 0, accepted: sinceStart.byAction.accepted || 0, comments: sinceStart.byAction.comment_reply || 0, networkDms: sinceStart.networkDms },
      thisWeek: { dms: thisWeek.byAction.dm || 0, replies: thisWeek.byAction.reply || 0, calls: thisWeek.byAction.call || 0, connects: thisWeek.byAction.connect || 0, accepted: thisWeek.byAction.accepted || 0, comments: thisWeek.byAction.comment_reply || 0, networkDms: thisWeek.networkDms },
      days,
      routes,
    },
    tasks,
    pipedrive: pd,
    pipedriveError: pdError,
    // Every post LinkedIn reported, plus any tagged cohort with traffic, so a
    // post nobody clicked still shows its impressions.
    posts: [...new Set([...posts.map((p) => p.cohort), ...Object.keys(postReach)])]
      .sort()
      .map((id) => {
        const p = posts.find((x) => x.cohort === id) || { cohort: id, visits: 0, started: 0, completed: 0, booked: 0 };
        const r = postReach[id] || {};
        return { ...p, impressions: r.impressions ?? null, opening: r.opening || null, date: r.date || null };
      }),
  };
}
