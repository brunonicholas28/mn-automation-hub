// Job: funnel-watchdog - does a real prospect who fills in the Growth Gap
// Report actually get one?
//
// Why it exists. credit-check watches one specific way the pipeline dies (the
// Anthropic balance). On 15 Sep 2026 it died a different way: Vercel's
// automatic DDoS mitigation started returning a 403 "Vercel Security
// Checkpoint" challenge page to Fillout's webhook POSTs. Fillout is a server
// and cannot solve a JavaScript challenge, so pages/api/webhook.js was never
// reached at all. Nothing in the stack noticed - credit-check was correctly
// green the whole time, because credits were fine. It surfaced because Bruno
// filled the form in by hand on launch day.
//
// So this watches the outcome rather than any one cause. Two checks:
//
//   A. Reachability - can a server-to-server POST still get through to the
//      three endpoints the funnel depends on, and does the app itself answer
//      rather than a firewall? Runs every time, costs nothing, has no side
//      effects, and catches breakage BEFORE a prospect hits it.
//
//   B. Pending sweep - every real submission that api/fillout-hook has seen is
//      recorded with its rid. Any that is older than the grace period and has
//      no ready report is a person who filled in the form and got nothing.
//      Catches every failure mode, including ones nobody has thought of, and
//      names the person so they can be recovered by hand.
//
// Deliberately self-contained, same reasoning as credit-check: it shares no
// helper with the pipeline it watches, so a bad deploy cannot take the alarm
// down at the moment it is needed. It talks to Redis directly rather than
// through lib/kv.js because it needs sorted-set operations that wrapper does
// not expose.
//
// Call it as /api/cron/run?job=funnel-watchdog&key=<FUNNEL_CRON_KEY>.
// Returns 200 healthy / 503 broken.

import { Redis } from "@upstash/redis";

const kv = Redis.fromEnv();

const REACH_STATE_KEY = "alert:funnel-reachability";
const PENDING_STATE_KEY = "alert:funnel-pending";

const PENDING_INDEX = "pending:report:index";
const PENDING_PREFIX = "pending:report:";
const FAILURES_KEY = "funnel:failures";
const FAILURES_KEEP = 200;

// A report normally renders in about 15 seconds. Eight minutes is long enough
// that a slow model call, a retry or a cold start is never mistaken for an
// outage, and short enough to still be useful on the day.
const GRACE_MS = 8 * 60 * 1000;

// Repeat interval for a fault that is still unfixed. An alarm nobody can
// silence gets filtered into a folder, and then the next real one is missed.
const RENOTIFY_AFTER_MS = 12 * 60 * 60 * 1000;

// Lost-submission emails aggregate rather than firing per person, and never
// more often than this, so a total outage cannot flood the inbox.
const PENDING_RENOTIFY_MS = 30 * 60 * 1000;

// One failed probe is not an outage. Timeouts and 5xx are noise until they
// persist. A firewall challenge is not noise and alerts immediately.
const TRANSIENT_TOLERANCE = 3;
const HARD_FAULTS = new Set(["blocked", "wrong_app", "status_api_broken", "hook_broken"]);

const HUMAN = {
  ok: "healthy",
  blocked: "BLOCKED BY A FIREWALL CHALLENGE",
  wrong_app: "webhook endpoint is not answering as the report app",
  status_api_broken: "report-status endpoint is not answering",
  hook_broken: "the hub's own Fillout receiver is not answering",
  unreachable: "unreachable",
  server_error: "server error",
};

const REPORT_BASE = (process.env.REPORT_BASE_URL || "https://result.marinanicholas.com").replace(
  /\/+$/,
  ""
);
const HUB_BASE = (process.env.HUB_BASE_URL || "https://mn-automation-hub.vercel.app").replace(
  /\/+$/,
  ""
);

function authorised(req) {
  const expected = process.env.FUNNEL_CRON_KEY || process.env.CREDIT_CHECK_KEY;
  if (!expected) return true;
  const supplied =
    req.query?.key || (req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  return supplied === expected;
}

async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const looksLikeChallenge = (body, contentType) =>
  /Vercel Security Checkpoint|Attack Challenge|_vercel\/challenge|cf-browser-verification/i.test(
    body || ""
  ) || /text\/html/i.test(contentType || "");

// The webhook probe deliberately sends NO secret. The report app answers an
// unauthenticated POST with its own 401 JSON, which proves three things at
// once: DNS resolves, the firewall let a server-to-server POST through, and
// the function is executing. It needs no credential and has no side effect -
// the handler rejects it before it parses or stores anything.
async function probeWebhook() {
  const url = REPORT_BASE + "/api/webhook";
  let res;
  let body = "";
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ probe: "funnel-watchdog" }),
    });
    body = (await res.text()).slice(0, 600);
  } catch (err) {
    return { status: "unreachable", detail: String(err.message || err).slice(0, 200), url };
  }

  const contentType = res.headers.get("content-type") || "";

  if (looksLikeChallenge(body, contentType)) {
    return {
      status: "blocked",
      httpStatus: res.status,
      detail: "Got an HTML challenge page instead of the app's JSON",
      url,
    };
  }
  if (res.status >= 500) {
    return { status: "server_error", httpStatus: res.status, detail: body, url };
  }
  // 401 is the expected answer. 400/405 also mean the app itself replied,
  // which is all this probe is asserting.
  if ([400, 401, 403, 405, 422].includes(res.status)) {
    return { status: "ok", httpStatus: res.status, url };
  }
  return {
    status: "wrong_app",
    httpStatus: res.status,
    detail: "Unexpected response to an unauthenticated POST: " + body,
    url,
  };
}

// The /generating page polls this. If it stops answering, every prospect sits
// on a spinner even when their report generated perfectly.
async function probeStatusApi() {
  const url = REPORT_BASE + "/api/report-status?rid=funnel-watchdog-probe";
  let res;
  let body = "";
  try {
    res = await fetchWithTimeout(url);
    body = (await res.text()).slice(0, 400);
  } catch (err) {
    return { status: "unreachable", detail: String(err.message || err).slice(0, 200), url };
  }
  if (looksLikeChallenge(body, res.headers.get("content-type"))) {
    return { status: "blocked", httpStatus: res.status, detail: "HTML challenge page", url };
  }
  if (res.status >= 500) return { status: "server_error", httpStatus: res.status, detail: body, url };
  try {
    const json = JSON.parse(body);
    if (typeof json.status === "string") return { status: "ok", httpStatus: res.status, url };
  } catch {
    // fall through
  }
  return { status: "status_api_broken", httpStatus: res.status, detail: body, url };
}

// Check B depends entirely on the hub's own Fillout receiver still being wired
// up and answering. If it is silently broken the sweep below would go quiet
// and look healthy, which is the worst failure a monitor can have.
async function probeHubHook() {
  const url = HUB_BASE + "/api/fillout-hook";
  let res;
  let body = "";
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ probe: "funnel-watchdog" }),
    });
    body = (await res.text()).slice(0, 400);
  } catch (err) {
    return { status: "unreachable", detail: String(err.message || err).slice(0, 200), url };
  }
  if (looksLikeChallenge(body, res.headers.get("content-type"))) {
    return { status: "blocked", httpStatus: res.status, detail: "HTML challenge page", url };
  }
  // A payload with no submission id is answered 200 {counted:false} and counts
  // nothing, so this probe cannot move a funnel number.
  if (res.status === 200 && /counted/.test(body)) return { status: "ok", httpStatus: 200, url };
  if (res.status >= 500) return { status: "server_error", httpStatus: res.status, detail: body, url };
  return { status: "hook_broken", httpStatus: res.status, detail: body, url };
}

// Worst of the three wins, so one broken endpoint cannot hide behind two
// healthy ones.
const SEVERITY = ["ok", "server_error", "unreachable", "hook_broken", "status_api_broken", "wrong_app", "blocked"];

async function reachability() {
  const [webhook, statusApi, hubHook] = await Promise.all([
    probeWebhook(),
    probeStatusApi(),
    probeHubHook(),
  ]);
  const parts = { webhook, statusApi, hubHook };
  let worst = "ok";
  for (const p of Object.values(parts)) {
    if (SEVERITY.indexOf(p.status) > SEVERITY.indexOf(worst)) worst = p.status;
  }
  const failing = Object.entries(parts).find(([, p]) => p.status === worst && worst !== "ok");
  return {
    status: worst,
    parts,
    failingProbe: failing ? failing[0] : null,
    detail: failing ? failing[1].detail || null : null,
    url: failing ? failing[1].url : null,
  };
}

// ---------------------------------------------------------------------------
// Check B: real submissions that never became a report
// ---------------------------------------------------------------------------

async function reportStatusFor(rid) {
  try {
    const res = await fetchWithTimeout(
      REPORT_BASE + "/api/report-status?rid=" + encodeURIComponent(rid)
    );
    const body = (await res.text()).slice(0, 400);
    try {
      const json = JSON.parse(body);
      return { status: String(json.status || "unknown"), message: json.message || null };
    } catch {
      return { status: "unreadable", message: body.slice(0, 200) };
    }
  } catch (err) {
    return { status: "unreadable", message: String(err.message || err).slice(0, 200) };
  }
}

async function sweepPending(now) {
  let due = [];
  try {
    due = (await kv.zrange(PENDING_INDEX, 0, now - GRACE_MS, { byScore: true })) || [];
  } catch (err) {
    return { checked: 0, failures: [], error: String(err.message || err).slice(0, 200) };
  }

  const failures = [];
  let checked = 0;

  for (const submissionId of due.slice(0, 50)) {
    const key = PENDING_PREFIX + submissionId;
    let record = null;
    try {
      record = await kv.get(key);
    } catch {
      record = null;
    }

    // The record's own TTL outlived the index entry, or vice versa. Nothing to
    // check and nothing to report.
    if (!record) {
      await kv.zrem(PENDING_INDEX, submissionId).catch(() => {});
      continue;
    }

    checked += 1;

    // No rid means the submission came in by a route that never carried one
    // (a direct link to the form, say). There is nothing to poll, so it is
    // dropped rather than reported as a failure it may not be.
    if (!record.rid) {
      await kv.zrem(PENDING_INDEX, submissionId).catch(() => {});
      await kv.del(key).catch(() => {});
      continue;
    }

    const result = await reportStatusFor(record.rid);

    if (result.status === "ready") {
      await kv.zrem(PENDING_INDEX, submissionId).catch(() => {});
      await kv.del(key).catch(() => {});
      continue;
    }

    const failure = {
      submissionId,
      rid: record.rid,
      name: record.name || null,
      email: record.email || null,
      cohort: record.cohort || null,
      submittedAt: record.ts || null,
      reportStatus: result.status,
      message: result.message || null,
    };
    failures.push(failure);

    // Reported once, then moved out of the index into a durable list. Leaving
    // it in would re-report the same person on every sweep.
    await kv.zrem(PENDING_INDEX, submissionId).catch(() => {});
    await kv.del(key).catch(() => {});
    await kv.lpush(FAILURES_KEY, { ...failure, detectedAt: now }).catch(() => {});
    await kv.ltrim(FAILURES_KEY, 0, FAILURES_KEEP - 1).catch(() => {});
  }

  return { checked, failures, due: due.length };
}

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

async function email({ subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_TO_EMAIL || process.env.DIGEST_TO_EMAIL;
  const from = process.env.DIGEST_FROM_EMAIL || "hello@marinanicholas.com";
  if (!apiKey || !to) {
    console.warn("funnel-watchdog: RESEND_API_KEY or ALERT_TO_EMAIL/DIGEST_TO_EMAIL unset, no email sent");
    return { skipped: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) throw new Error("Resend " + res.status + " " + (await res.text()).slice(0, 200));
  return { skipped: false };
}

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function reachabilityHtml({ status, failingProbe, detail, url, since }) {
  const headline =
    {
      blocked:
        "A firewall is returning a challenge page to server-to-server requests, so Fillout's webhook cannot get through.",
      wrong_app: "The webhook endpoint answered, but not as the report app does.",
      status_api_broken:
        "The endpoint the /generating page polls is not returning JSON, so every prospect will sit on a spinner.",
      hook_broken:
        "The hub's own Fillout receiver is not answering, which also means the lost-submission watch below is blind.",
    }[status] || "The funnel endpoints have failed several consecutive checks.";

  return [
    "<h2>Growth Gap Report funnel: " + esc(HUMAN[status] || status) + "</h2>",
    "<p><strong>" + esc(headline) + "</strong></p>",
    "<p>While this is true, a prospect who completes the form gets no report, no email,",
    "and <strong>no Pipedrive deal is created</strong> &mdash; the lead is lost, not delayed.</p>",
    "<h3>Where to look</h3><ol>",
    "<li><strong>Vercel &rarr; the affected project &rarr; Firewall.</strong> A persistent Challenge or Deny",
    "action under DDoS Mitigation is what caused the 15 Sep 2026 outage.</li>",
    "<li><strong>Fillout &rarr; Growth Gap Report &rarr; Integrate &rarr; Webhook &rarr; Test.</strong>",
    "It shows the raw response, which names the problem immediately.</li>",
    "<li>Check the endpoint is still deployed and the domain still resolves.</li>",
    "</ol><h3>Detail</h3><ul>",
    "<li>Status: <code>" + esc(status) + "</code></li>",
    "<li>Failing probe: <code>" + esc(failingProbe || "n/a") + "</code></li>",
    "<li>URL: <code>" + esc(url || "n/a") + "</code></li>",
    "<li>Failing since: " + (since ? new Date(since).toUTCString() : "just now") + "</li>",
    "<li>Response: <code>" + esc(String(detail || "").slice(0, 300)) + "</code></li>",
    "</ul>",
    '<p style="color:#667">Sent by the funnel-watchdog job on mn-automation-hub.</p>',
  ].join("\n");
}

function reachabilityRecoveryHtml({ since }) {
  return [
    "<h2>Growth Gap Report funnel: endpoints reachable again</h2>",
    "<p>The webhook, the status endpoint and the hub's Fillout receiver are all answering normally.</p>",
    "<ul><li>Was failing since: " + (since ? new Date(since).toUTCString() : "unknown") + "</li></ul>",
    "<p>Anyone who completed the form during the outage will not be in Pipedrive.",
    "Check Fillout &rarr; Results for submissions in that window and re-run them by hand.</p>",
  ].join("\n");
}

function pendingHtml(failures) {
  const rows = failures
    .map((f) =>
      [
        "<tr>",
        "<td>" + esc(f.name || "(no name)") + "</td>",
        "<td>" + esc(f.email || "(no email)") + "</td>",
        "<td>" + esc(f.cohort || "-") + "</td>",
        "<td><code>" + esc(f.reportStatus) + "</code></td>",
        "<td>" + (f.submittedAt ? new Date(f.submittedAt).toUTCString() : "-") + "</td>",
        "</tr>",
      ].join("")
    )
    .join("\n");

  const plural = failures.length === 1 ? "person" : "people";

  return [
    "<h2>" + failures.length + " " + plural + " completed the Growth Gap Report and got nothing</h2>",
    "<p>Each of these submitted the form more than 8 minutes ago and still has no finished report.",
    "They have had no email, and there is <strong>no Pipedrive deal</strong> for them &mdash;",
    "the deal is only created after synthesis succeeds.</p>",
    '<table cellpadding="6" border="1" style="border-collapse:collapse;font-size:14px">',
    "<tr><th>Name</th><th>Email</th><th>Cohort</th><th>Status</th><th>Submitted</th></tr>",
    rows,
    "</table>",
    "<h3>What to do</h3><ol>",
    "<li>Check the cause: Vercel &rarr; Firewall for a challenge, then the Anthropic balance.</li>",
    "<li>Their answers are safe in <strong>Fillout &rarr; Results</strong> &mdash; nothing is lost from there.</li>",
    "<li>Once the cause is fixed, re-run each submission so they get their report.</li>",
    "</ol>",
    '<p style="color:#667">Sent by the funnel-watchdog job on mn-automation-hub.',
    "Reported once per person; the full list is kept in Redis under <code>funnel:failures</code>.</p>",
  ].join("\n");
}

// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorised(req)) return res.status(401).json({ ok: false, error: "bad key" });

  // Fire drill: ...&drill=blocked or &drill=pending sends the real alert
  // through the real channel. It touches no stored state and always returns
  // 200, so a drill can never leave the monitor believing the funnel is down.
  const drill = String(req.query.drill || "").trim();
  if (drill) {
    let emailed = false;
    let emailError = null;
    const isPending = drill === "pending";
    try {
      const html = isPending
        ? pendingHtml([
            {
              name: "Drill Example",
              email: "nobody@example.com",
              cohort: "c20260915",
              reportStatus: "unknown",
              submittedAt: Date.now() - 10 * 60 * 1000,
            },
          ])
        : reachabilityHtml({
            status: HUMAN[drill] ? drill : "blocked",
            failingProbe: "webhook",
            detail: "simulated by ?drill=" + drill,
            url: REPORT_BASE + "/api/webhook",
            since: Date.now(),
          });
      emailed = !(
        await email({
          subject:
            "[DRILL] Growth Gap Report funnel - " +
            (isPending ? "submissions with no report" : HUMAN[drill] || drill),
          html:
            "<p><strong>This is a test. Nothing is wrong.</strong> It proves the alert " +
            "email actually arrives. Below is exactly what a real alert looks like.</p><hr>" +
            html,
        })
      ).skipped;
    } catch (err) {
      emailError = String(err.message || err).slice(0, 200);
    }
    return res
      .status(200)
      .json({ ok: true, drill, emailed, emailError, stateUntouched: true });
  }

  const now = Date.now();

  // ---- Check A: reachability -------------------------------------------
  const reach = await reachability();
  const prev = (await kv.get(REACH_STATE_KEY)) || {
    status: "ok",
    since: null,
    lastNotifiedAt: null,
    consecutiveTransient: 0,
  };

  let reachStatus = reach.status;
  let consecutiveTransient = 0;
  if (reachStatus !== "ok" && !HARD_FAULTS.has(reachStatus)) {
    consecutiveTransient = (prev.consecutiveTransient || 0) + 1;
    if (consecutiveTransient < TRANSIENT_TOLERANCE) reachStatus = "ok";
  }

  const broken = reachStatus !== "ok";
  const wasBroken = prev.status !== "ok";
  const since = broken ? (wasBroken && prev.since ? prev.since : now) : null;

  let notify = null;
  if (broken && !wasBroken) notify = "new";
  else if (broken && wasBroken && now - (prev.lastNotifiedAt || 0) >= RENOTIFY_AFTER_MS)
    notify = "reminder";
  else if (!broken && wasBroken) notify = "recovered";

  let emailed = false;
  let emailError = null;
  if (notify) {
    const subject =
      notify === "recovered"
        ? "Recovered: Growth Gap Report funnel endpoints are reachable again"
        : (notify === "reminder" ? "Still broken" : "ALERT") +
          ": Growth Gap Report funnel - " +
          (HUMAN[reachStatus] || reachStatus);
    const html =
      notify === "recovered"
        ? reachabilityRecoveryHtml({ since: prev.since })
        : reachabilityHtml({
            status: reachStatus,
            failingProbe: reach.failingProbe,
            detail: reach.detail,
            url: reach.url,
            since,
          });
    try {
      emailed = !(await email({ subject, html })).skipped;
    } catch (err) {
      emailError = String(err.message || err).slice(0, 200);
    }
  }

  await kv.set(REACH_STATE_KEY, {
    status: reachStatus,
    since,
    lastNotifiedAt: notify === "recovered" ? null : notify ? now : prev.lastNotifiedAt || null,
    consecutiveTransient,
    lastCheckedAt: now,
    lastDetail: reach.detail || null,
  });

  // ---- Check B: submissions with no report ------------------------------
  const sweep = await sweepPending(now);
  let pendingEmailed = false;
  let pendingEmailError = null;

  if (sweep.failures.length) {
    const pendingPrev = (await kv.get(PENDING_STATE_KEY)) || { lastNotifiedAt: 0 };
    const quiet = now - (pendingPrev.lastNotifiedAt || 0) < PENDING_RENOTIFY_MS;
    if (!quiet) {
      try {
        pendingEmailed = !(
          await email({
            subject:
              "ALERT: " +
              sweep.failures.length +
              " Growth Gap Report submission" +
              (sweep.failures.length === 1 ? "" : "s") +
              " produced no report",
            html: pendingHtml(sweep.failures),
          })
        ).skipped;
      } catch (err) {
        pendingEmailError = String(err.message || err).slice(0, 200);
      }
      await kv.set(PENDING_STATE_KEY, { lastNotifiedAt: now, lastCount: sweep.failures.length });
    }
  }

  const unhealthy = broken || sweep.failures.length > 0;

  return res.status(unhealthy ? 503 : 200).json({
    ok: !unhealthy,
    reachability: {
      status: reachStatus,
      human: HUMAN[reachStatus] || reachStatus,
      raw: reach.status,
      probes: Object.fromEntries(
        Object.entries(reach.parts).map(([k, v]) => [k, { status: v.status, httpStatus: v.httpStatus || null }])
      ),
      consecutiveTransient,
      since,
      notified: notify,
      emailed,
      emailError,
    },
    pending: {
      due: sweep.due || 0,
      checked: sweep.checked,
      failed: sweep.failures.length,
      people: sweep.failures.map((f) => ({ email: f.email, status: f.reportStatus })),
      emailed: pendingEmailed,
      emailError: pendingEmailError,
      error: sweep.error || null,
    },
    checkedAt: new Date(now).toISOString(),
  });
}
