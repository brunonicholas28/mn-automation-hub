// Organic LinkedIn tracker: Marina's to-do list, the action log and the
// numbers behind them. Added 2026-10-10 when the business went all-in on
// organic LinkedIn.
//
// Served through api/cron/run.js (?job=organic) because api/ is at Vercel
// Hobby's 12-function cap. vercel.json rewrites /organic to the page and
// /api/organic to the API, so neither URL mentions cron.
//
// Where things live:
//   - People and every touch: Pipedrive. A person per LinkedIn contact, a
//     done activity per action ("[LinkedIn] DM sent"), and open activities
//     as the to-do list. phoenix's report webhook creates the to-do for an
//     organic report completer; this file closes it.
//   - The log the numbers are counted from: Upstash (organic:log). Counting
//     from Pipedrive would cost a page of API calls on every page load, and a
//     Pipedrive wobble must never lose a logged action - so the log is written
//     first and Pipedrive is mirrored best-effort.
//
// LinkedIn itself is never touched. It offers no API for a member's viewers,
// comments or messages, and automation on Marina's account risks getting it
// restricted. Everything that happens on LinkedIn is logged by hand, in about
// a tap per action.
//
// Auth: ORGANIC_KEY. The page asks for it once and keeps it on the phone; it
// travels in a header, never in a URL. view=stats returns counts only and is
// open, so the weekly report can read it.

import { Redis } from "@upstash/redis";
import { pipedrive, PERSON_LINKEDIN_URL_FIELD_KEY } from "../pipedrive.js";
import { PAGE_HTML } from "./organic-page.js";

const kv = Redis.fromEnv();
const LOG = "organic:log";
const NETWORK = "organic:network"; // hash id -> contact JSON
const PERSON_MAP = "organic:person"; // hash identity -> Pipedrive person id
const LOG_CAP = 20000;
export const TASK_PREFIX = "[LinkedIn]";

export const ROUTES = {
  report: "Completed the report",
  viewer: "Viewed her profile",
  commenter: "Commented on a post",
  growth: "Commented GROWTH",
  network: "Existing network",
  other: "Other",
};

export const ACTIONS = {
  connect: "Connection request sent",
  accepted: "Connection accepted",
  dm: "DM sent",
  comment_reply: "Replied to a comment",
  reply: "They replied",
  call: "Call booked",
  not_fit: "Not a fit",
};

export const TARGETS = { networkDmsPerDay: 12, commentReplyHours: 1, reportDmHours: 24 };

// ---------------------------------------------------------------- helpers

export function ukDate(d = new Date()) {
  // en-CA gives YYYY-MM-DD; Europe/London handles BST/GMT.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);
}

function addDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday of the UK week containing ymd.
export function weekStart(ymd) {
  const d = new Date(ymd + "T12:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(ymd, -dow);
}

function clean(v, max = 200) {
  return String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

function normaliseUrl(u) {
  const s = clean(u, 300);
  if (!s) return "";
  const m = s.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? `https://www.linkedin.com/in/${m[1].toLowerCase()}` : "";
}

function identity({ url, name, company }) {
  if (url) return "u:" + url;
  return "n:" + (name + "|" + (company || "")).toLowerCase().replace(/\s+/g, " ");
}

function authorised(req) {
  const key = process.env.ORGANIC_KEY;
  if (!key) return false; // Fail closed: names and companies sit behind this.
  return (req.headers["x-organic-key"] || "") === key;
}

async function readLog(limit = LOG_CAP) {
  const raw = await kv.lrange(LOG, 0, limit - 1);
  return (raw || []).map((r) => (typeof r === "string" ? JSON.parse(r) : r));
}

// ------------------------------------------------------------ Pipedrive

async function findOrCreatePerson({ name, url, company, personId }) {
  if (personId) return Number(personId);
  const id = identity({ url, name, company });
  const known = await kv.hget(PERSON_MAP, id);
  if (known) return Number(known);
  const body = { name };
  if (url) body[PERSON_LINKEDIN_URL_FIELD_KEY] = url;
  const created = await pipedrive("/persons", { method: "POST", body });
  if (company) {
    // Keep it visible without creating organisations for every viewer.
    await pipedrive("/notes", {
      method: "POST",
      body: { person_id: created.id, content: `Company: ${company}` },
    }).catch(() => {});
  }
  await kv.hset(PERSON_MAP, { [id]: String(created.id) });
  return created.id;
}

export async function openTasks() {
  // user_id=0: every user's activities, so a task assigned to Marina or to the
  // API token's owner both show. Pipedrive pages at 500.
  const rows = (await pipedrive(`/activities?user_id=0&done=0&type=task&limit=500`)) || [];
  return rows
    .filter((a) => String(a.subject || "").startsWith(TASK_PREFIX))
    .map((a) => ({
      id: a.id,
      subject: String(a.subject).slice(TASK_PREFIX.length).trim(),
      due: a.due_date,
      personId: a.person_id || null,
      personName: a.person_name || "",
      dealId: a.deal_id || null,
      orgName: a.org_name || "",
      note: String(a.note || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400),
    }))
    .sort((x, y) => String(x.due).localeCompare(String(y.due)));
}

async function closeTask(id) {
  await pipedrive(`/activities/${id}`, { method: "PUT", body: { done: 1 } });
}

async function closeOpenTasksForPerson(personId) {
  if (!personId) return 0;
  const tasks = (await openTasks()).filter((t) => Number(t.personId) === Number(personId));
  for (const t of tasks) await closeTask(t.id);
  return tasks.length;
}

async function mirrorToPipedrive(entry) {
  const out = {};
  if (entry.action === "comment_reply") return out; // a counter, not a person
  const personId = await findOrCreatePerson(entry);
  out.personId = personId;
  const today = ukDate();
  await pipedrive("/activities", {
    method: "POST",
    body: {
      subject: `${TASK_PREFIX} ${ACTIONS[entry.action]}`,
      type: "task",
      done: 1,
      due_date: today,
      person_id: personId,
      ...(entry.dealId ? { deal_id: Number(entry.dealId) } : {}),
      note: [`Route: ${ROUTES[entry.route] || entry.route}`, entry.note].filter(Boolean).join("<br>"),
    },
  });
  if (entry.taskId) await closeTask(entry.taskId);
  // A DM to someone who completed the report gets a follow-up three days on;
  // network DMs do not - at 12 a day that would bury the list.
  if (entry.action === "dm" && entry.route === "report") {
    await pipedrive("/activities", {
      method: "POST",
      body: {
        subject: `${TASK_PREFIX} Follow up with ${entry.name} if no reply`,
        type: "task",
        due_date: addDays(today, 3),
        person_id: personId,
        ...(entry.dealId ? { deal_id: Number(entry.dealId) } : {}),
      },
    });
  }
  if (entry.action === "reply" || entry.action === "call" || entry.action === "not_fit") {
    out.closed = await closeOpenTasksForPerson(personId);
  }
  return out;
}

// ------------------------------------------------------------- numbers

export function countLog(entries, fromYmd, toYmd) {
  const c = { byAction: {}, byRoute: {}, networkDms: 0, people: 0 };
  const people = new Set();
  for (const e of entries) {
    if (e.day < fromYmd || e.day > toYmd) continue;
    c.byAction[e.action] = (c.byAction[e.action] || 0) + 1;
    const k = e.route + ":" + e.action;
    c.byRoute[k] = (c.byRoute[k] || 0) + 1;
    if (e.action === "dm" && e.route === "network") c.networkDms++;
    if (e.action !== "comment_reply") people.add(e.identity);
  }
  c.people = people.size;
  return c;
}

// Funnel per route: of the people touched in the window, how many got each
// further step at any time. Answers "do DMs turn into replies, and replies
// into calls" - the leak the weekly report is looking for.
export function routeFunnel(entries, fromYmd, toYmd) {
  const firstSeen = new Map();
  for (const e of [...entries].reverse()) {
    if (e.action === "comment_reply") continue;
    if (!firstSeen.has(e.identity)) firstSeen.set(e.identity, e);
  }
  const steps = new Map();
  for (const e of entries) {
    if (e.action === "comment_reply") continue;
    if (!steps.has(e.identity)) steps.set(e.identity, new Set());
    steps.get(e.identity).add(e.action);
  }
  const out = {};
  for (const [id, first] of firstSeen) {
    if (first.day < fromYmd || first.day > toYmd) continue;
    const r = (out[first.route] ||= { people: 0, connect: 0, accepted: 0, dm: 0, reply: 0, call: 0, not_fit: 0 });
    r.people++;
    for (const a of steps.get(id) || []) if (a in r) r[a]++;
  }
  return out;
}

async function networkQueue(limit) {
  const all = (await kv.hgetall(NETWORK)) || {};
  const rows = Object.values(all).map((v) => (typeof v === "string" ? JSON.parse(v) : v));
  const pending = rows.filter((r) => r.status === "pending").sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  return { total: rows.length, pending: pending.length, next: pending.slice(0, limit) };
}

// ------------------------------------------------------------- handler

export default async function organic(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const view = String(req.query.view || "");

  if (req.method === "GET" && view === "page") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(PAGE_HTML);
  }

  try {
    if (req.method === "GET" && view === "stats") {
      // Counts only - no names - so the Monday report can read it unauthenticated.
      const log = await readLog();
      const today = ukDate();
      const weeks = [];
      for (let i = 0; i < 8; i++) {
        const from = addDays(weekStart(today), -7 * i);
        const to = addDays(from, 6);
        weeks.push({ from, to, ...countLog(log, from, to), funnel: routeFunnel(log, from, to) });
      }
      const net = await networkQueue(0);
      return res.status(200).json({ ok: true, today, targets: TARGETS, weeks, network: { total: net.total, pending: net.pending } });
    }

    if (!authorised(req)) return res.status(401).json({ ok: false, error: "key required" });

    if (req.method === "GET" && view === "today") {
      const today = ukDate();
      const [log, tasks, net] = await Promise.all([readLog(2000), openTasks().catch((e) => ({ error: e.message })), networkQueue(15)]);
      return res.status(200).json({
        ok: true,
        today,
        targets: TARGETS,
        tasks: Array.isArray(tasks) ? tasks.filter((t) => !t.due || t.due <= today) : [],
        upcoming: Array.isArray(tasks) ? tasks.filter((t) => t.due && t.due > today).length : 0,
        tasksError: Array.isArray(tasks) ? null : tasks.error,
        counts: { today: countLog(log, today, today), week: countLog(log, weekStart(today), today) },
        network: net,
        recent: log.slice(0, 30).map(({ id, ts, day, name, company, url, route, action, personId, identity: ident }) => ({ id, ts, day, name, company, url, route, action, personId, identity: ident })),
      });
    }

    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const op = String(b.op || "");

      if (op === "log") {
        const action = clean(b.action, 20);
        const route = clean(b.route, 20) || "other";
        if (!ACTIONS[action]) return res.status(400).json({ ok: false, error: "unknown action" });
        if (!ROUTES[route]) return res.status(400).json({ ok: false, error: "unknown route" });
        const name = clean(b.name, 120);
        if (action !== "comment_reply" && !name) return res.status(400).json({ ok: false, error: "name required" });
        const url = normaliseUrl(b.url);
        const company = clean(b.company, 120);
        const entry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          ts: new Date().toISOString(),
          day: ukDate(),
          name, url, company, route, action,
          note: clean(b.note, 500),
          taskId: b.taskId ? Number(b.taskId) : null,
          dealId: b.dealId ? Number(b.dealId) : null,
          personId: b.personId ? Number(b.personId) : null,
          networkId: clean(b.networkId, 60) || null,
        };
        // An action taken on an earlier entry or a to-do carries that entry's
        // identity, so connect -> DM -> reply join up as one person.
        const given = clean(b.identity, 400);
        entry.identity = /^[unp]:/.test(given) ? given : entry.personId ? "p:" + entry.personId : identity(entry);

        // Log first: a Pipedrive failure must never lose the action.
        await kv.lpush(LOG, JSON.stringify(entry));
        await kv.ltrim(LOG, 0, LOG_CAP - 1);

        if (entry.networkId) {
          const raw = await kv.hget(NETWORK, entry.networkId);
          if (raw) {
            const c = typeof raw === "string" ? JSON.parse(raw) : raw;
            c.status = action === "not_fit" ? "skipped" : "done";
            c.doneOn = entry.day;
            await kv.hset(NETWORK, { [entry.networkId]: JSON.stringify(c) });
          }
        }

        let mirror = {};
        let mirrorError = null;
        try {
          mirror = await mirrorToPipedrive(entry);
          if (mirror.personId && !entry.personId) {
            // Remember the Pipedrive person on the log line. Only if it is still
            // the newest line - another tap may have landed in between.
            const head = await kv.lindex(LOG, 0);
            const h = typeof head === "string" ? JSON.parse(head) : head;
            if (h && h.id === entry.id) {
              entry.personId = mirror.personId;
              await kv.lset(LOG, 0, JSON.stringify(entry));
            }
          }
        } catch (err) {
          mirrorError = String(err.message || err).slice(0, 300);
          console.error("[organic] Pipedrive mirror failed:", mirrorError);
        }
        return res.status(200).json({ ok: true, entry: { id: entry.id, action, route, name }, pipedrive: mirrorError ? { error: mirrorError } : mirror });
      }

      if (op === "skip-task" && b.taskId) {
        await closeTask(Number(b.taskId));
        return res.status(200).json({ ok: true });
      }

      if (op === "import-network") {
        const list = Array.isArray(b.contacts) ? b.contacts : [];
        const write = {};
        for (const c of list.slice(0, 5000)) {
          const name = clean(c.name, 120);
          if (!name) continue;
          const url = normaliseUrl(c.url);
          const id = clean(c.id, 60) || (url ? url.split("/in/")[1] : name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 60);
          write[id] = JSON.stringify({
            id, name, url,
            company: clean(c.company, 120),
            position: clean(c.position, 160),
            rank: Number(c.rank) || 9999,
            why: clean(c.why, 200),
            knows: c.knows === true,
            status: "pending",
          });
        }
        if (Object.keys(write).length) await kv.hset(NETWORK, write);
        return res.status(200).json({ ok: true, imported: Object.keys(write).length });
      }

      return res.status(400).json({ ok: false, error: "unknown op" });
    }

    return res.status(400).json({ ok: false, error: "unknown view" });
  } catch (err) {
    console.error("[organic] failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err).slice(0, 300) });
  }
}
