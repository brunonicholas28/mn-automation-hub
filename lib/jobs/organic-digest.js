// 8am daily email for the organic LinkedIn push: what needs doing today, how
// yesterday went against target, and what the posts produced.
//
// Dispatched by api/cron/run.js (?job=organic-digest) from a GitHub Actions
// schedule that fires several times each morning. The first run at or after
// 8am UK time sends, so it is 8am in both BST and GMT without editing the
// schedule twice a year. A KV flag stops a second send on the same day.
//
// Recipients: ORGANIC_DIGEST_TO (comma-separated). Overdue tasks are flagged
// in the email itself, so whoever is on the list sees them.

import { Redis } from "@upstash/redis";
import { readAllCohorts } from "../cohort.js";
import { openTasks, countLog, ukDate, weekStart, TARGETS, ACTIONS, ROUTES } from "./organic.js";

const kv = Redis.fromEnv();
const PAGE_URL = process.env.ORGANIC_PAGE_URL || "https://mn-automation-hub.vercel.app/organic";

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return (req.headers.authorization || "") === `Bearer ${secret}`;
}

function ukHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(d));
}

function addDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Cumulative organic funnel across every li-* cohort. Totals only ever grow,
// so yesterday's numbers are today's snapshot minus the one stored a day ago.
async function organicTotals() {
  const cohorts = await readAllCohorts();
  const t = { posts: 0, visits: 0, started: 0, completed: 0, booked: 0 };
  for (const c of cohorts) {
    if (!/^li-/i.test(String(c.cohort || ""))) continue;
    t.posts++;
    for (const k of ["visits", "started", "completed", "booked"]) t[k] += Number(c[k] || 0);
  }
  return t;
}

export async function buildDigest() {
  const today = ukDate();
  const yesterday = addDays(today, -1);
  const rawLog = await kv.lrange("organic:log", 0, 4999);
  const log = (rawLog || []).map((r) => (typeof r === "string" ? JSON.parse(r) : r));
  const y = countLog(log, yesterday, yesterday);
  const wk = countLog(log, weekStart(today), today);

  let tasks = [];
  let tasksError = null;
  try {
    tasks = (await openTasks()).filter((t) => !t.due || t.due <= today);
  } catch (e) {
    tasksError = e.message;
  }
  const overdue = tasks.filter((t) => t.due && t.due < today);

  const totals = await organicTotals();
  const prev = await kv.get("organic:digest:totals");
  const delta = {};
  for (const k of ["visits", "started", "completed", "booked"]) delta[k] = prev ? Math.max(0, totals[k] - (prev[k] || 0)) : null;
  const net = Object.values((await kv.hgetall("organic:network")) || {}).map((v) => (typeof v === "string" ? JSON.parse(v) : v));
  const netPending = net.filter((c) => c.status === "pending").length;

  const n = (k, c = y) => c.byAction[k] || 0;
  const subject =
    `LinkedIn today: ${tasks.length} to action` +
    (overdue.length ? ` (${overdue.length} overdue)` : "") +
    ` · network DMs yesterday ${y.networkDms}/${TARGETS.networkDmsPerDay}`;

  const taskRows = tasks.length
    ? tasks.map((t) => `<li>${t.due && t.due < today ? '<b style="color:#c0392b">OVERDUE since ' + esc(t.due) + "</b> · " : ""}${esc(t.subject)}${t.note ? `<br><span style="color:#5f6f7f">${esc(t.note.slice(0, 220))}</span>` : ""}</li>`).join("")
    : "<li>Nothing waiting.</li>";

  const funnelLine = delta.visits === null
    ? `Totals so far across ${totals.posts} tracked posts: ${totals.visits} visits · ${totals.started} reports started · ${totals.completed} completed · ${totals.booked} calls booked. (Day-by-day figures start tomorrow.)`
    : `${delta.visits} visits · ${delta.started} reports started · ${delta.completed} completed · ${delta.booked} calls booked`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#14212e;max-width:600px">
    <h2 style="color:#103A62;margin:0 0 4px">LinkedIn today</h2>
    <p style="margin:0 0 16px"><a href="${PAGE_URL}" style="background:#103A62;color:#fff;padding:9px 14px;border-radius:8px;text-decoration:none;display:inline-block">Open today's list</a></p>

    <h3 style="margin:18px 0 6px">Do today</h3>
    ${tasksError ? `<p style="color:#c0392b">Couldn't read Pipedrive: ${esc(tasksError)}</p>` : `<ul style="padding-left:18px;margin:0">${taskRows}</ul>`}
    <p style="margin:8px 0 0">Network: message ${TARGETS.networkDmsPerDay} today${net.length ? ` (${netPending} of ${net.length} still to go)` : " (list not loaded yet)"}. Reply to every new comment within the hour.</p>

    <h3 style="margin:18px 0 6px">Yesterday</h3>
    <p style="margin:0"><b>From the posts:</b> ${funnelLine}</p>
    <p style="margin:6px 0 0"><b>Marina's actions:</b> ${y.networkDms}/${TARGETS.networkDmsPerDay} network DMs · ${n("connect")} connection requests · ${n("dm") - y.networkDms} other DMs · ${n("comment_reply")} comment replies · ${n("reply")} replies received · ${n("call")} calls booked</p>

    <h3 style="margin:18px 0 6px">This week so far</h3>
    <p style="margin:0">${wk.networkDms} network DMs · ${n("connect", wk)} connections · ${n("dm", wk)} DMs in total · ${n("reply", wk)} replies · ${n("call", wk)} calls booked</p>
    ${overdue.length ? `<p style="margin:14px 0 0;color:#c0392b"><b>${overdue.length} task(s) overdue.</b> A report completer who hasn't heard from Marina within a day is the most expensive thing on this list.</p>` : ""}
    <p style="color:#8a99a8;font-size:13px;margin-top:22px">Sent at 8am every day. Actions are counted from what's logged on the list page.</p>
  </div>`;

  return { subject, html, totals, today };
}

export default async function organicDigest(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });
  const force = String(req.query.force || "") === "1";
  const dry = String(req.query.dry || "") === "1";

  // Any run between 8am and noon UK sends, once a day (the KV flag below).
  // GitHub's scheduler can run late or skip a slot, so the workflow fires
  // several times a morning; an exact-hour check silently sent nothing when
  // a run drifted past 9am.
  const h = ukHour();
  if (!force && !dry && (h < 8 || h >= 12)) return res.status(200).json({ ok: true, skipped: "outside 8am-noon UK" });

  try {
    const d = await buildDigest();
    if (dry) return res.status(200).json({ ok: true, dry: true, subject: d.subject, html: d.html });

    const sentFlag = `organic:digest:sent:${d.today}`;
    if (!force && (await kv.get(sentFlag))) return res.status(200).json({ ok: true, skipped: "already sent today" });

    const to = String(process.env.ORGANIC_DIGEST_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!to.length || !process.env.RESEND_API_KEY) return res.status(500).json({ ok: false, error: "ORGANIC_DIGEST_TO or RESEND_API_KEY not set" });

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.DIGEST_FROM_EMAIL || "hello@marinanicholas.com", to, subject: d.subject, html: d.html }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ ok: false, error: "resend", detail: body });

    await kv.set(sentFlag, 1, { ex: 60 * 60 * 36 });
    await kv.set("organic:digest:totals", d.totals);
    return res.status(200).json({ ok: true, sent: to.length, subject: d.subject });
  } catch (err) {
    console.error("[organic-digest] failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err).slice(0, 300) });
  }
}
