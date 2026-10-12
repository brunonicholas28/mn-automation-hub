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
    reach: { ...reach, latest: reachWeeks[0] || null, weeks: reachWeeks.length },
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
