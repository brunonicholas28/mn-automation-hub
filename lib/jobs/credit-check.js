// Job: credit-check - the smoke alarm on the Growth Gap Report pipeline.
//
// Why it exists. On 13 Sep 2026 the Anthropic credit balance ran out and
// report generation stopped. Nothing noticed. Submissions still reached
// Fillout and then died at the synthesis step, so the prospect saw "your
// report is taking a little longer than usual", got no report, and - because
// the Pipedrive push happens only after synthesis succeeds - no deal was ever
// created. Those leads were lost, not delayed. It surfaced because someone
// filled the form in by hand and complained. The same failure had already
// happened once, on 17 Aug 2026.
//
// What it can see. The Anthropic API exposes no credit-balance endpoint, so
// there is no way to warn at "getting low" - only at zero. Real prevention is
// auto-reload in the Anthropic console; this is the backstop for when that is
// off or itself fails. Credit is billed per organisation, so probing this
// project's key detects exhaustion that also takes down the report pipeline's
// separate key on the same account.
//
// Deliberately self-contained: it shares no helper with the jobs it is
// watching, so a bad deploy to lib/anthropic.js or lib/email.js cannot take
// the alarm down at the same moment it is needed. The only shared import is
// the KV wrapper, which it needs to remember what it already told you.
//
// Call it as /api/cron/run?job=credit-check&key=<FUNNEL_CRON_KEY>.
// Returns 200 healthy / 503 broken, so the GitHub Actions workflow that calls
// it turns red as a second channel alongside the email.

import { getState, setState } from "../kv.js";

const STATE_KEY = "alert:anthropic-credits";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

// How long before repeating an alert for a fault that is still unfixed. An
// hourly alarm nobody can silence gets filtered into a folder, and then the
// next real one is missed too.
const RENOTIFY_AFTER_MS = 12 * 60 * 60 * 1000;

// One failed probe is not an outage. Rate limits and 5xx are noise; they only
// become an alert if they persist across this many consecutive checks.
const TRANSIENT_TOLERANCE = 3;

// Faults that never clear on their own. Every report from now until someone
// acts will fail, so these alert on the first sighting. no_key is included
// because a monitor that cannot see anything is its own kind of broken.
const HARD_FAULTS = new Set(["out_of_credits", "auth", "no_key"]);

const HUMAN = {
  ok: "healthy",
  out_of_credits: "OUT OF CREDITS",
  auth: "API key rejected",
  no_key: "ANTHROPIC_API_KEY is not set",
  rate_limited: "rate limited",
  api_error: "Anthropic API error",
  error: "unexpected error",
};

function authorised(req) {
  const expected = process.env.CREDIT_CHECK_KEY || process.env.FUNNEL_CRON_KEY;
  if (!expected) return true;
  const supplied =
    req.query?.key || (req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  return supplied === expected;
}

// The probe has to be a real /messages call: /models answers happily on an
// account with a zero balance, so only an actual completion proves there is
// credit to spend. max_tokens 1 on the cheapest model makes that a rounding
// error - about one hundredth of a penny per run.
//
// Never throws. The caller wants a verdict, and "the API is unreachable" is a
// result rather than a bug.
async function probe() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { status: "no_key", detail: "ANTHROPIC_API_KEY is not set on this project" };

  const headers = {
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };

  let model = process.env.CREDIT_PROBE_MODEL || null;
  if (!model) {
    // Pick the newest Haiku rather than pinning an id, so a model retirement
    // does not turn into a fake outage at 3am.
    try {
      const r = await fetch(ANTHROPIC_BASE + "/models?limit=100", { headers });
      const j = await r.json().catch(() => ({}));
      const all = j.data || [];
      const pool = all.filter((m) => /haiku/i.test(m.id));
      const use = (pool.length ? pool : all).sort((a, b) =>
        String(b.created_at || "").localeCompare(String(a.created_at || ""))
      );
      if (use.length) model = use[0].id;
    } catch {
      // Fall through - the /messages call below reports the real fault.
    }
  }
  if (!model) model = "claude-haiku-4-5";

  let res;
  let json;
  try {
    res = await fetch(ANTHROPIC_BASE + "/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    });
    json = await res.json().catch(() => ({}));
  } catch (err) {
    return { status: "api_error", model, detail: String(err.message || err).slice(0, 300) };
  }

  if (res.ok) return { status: "ok", model, httpStatus: res.status };

  const detail = (json && json.error && json.error.message) || JSON.stringify(json).slice(0, 300);

  // Anthropic returns the credit fault as a 400 invalid_request_error whose
  // message names the balance, not as a 402, so this matches on the message.
  if (/credit balance is too low|insufficient (credit|funds)|billing/i.test(detail)) {
    return { status: "out_of_credits", model, detail, httpStatus: res.status };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: "auth", model, detail, httpStatus: res.status };
  }
  if (res.status === 429) return { status: "rate_limited", model, detail, httpStatus: res.status };
  if (res.status >= 500) return { status: "api_error", model, detail, httpStatus: res.status };
  return { status: "error", model, detail, httpStatus: res.status };
}
async function email({ subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_TO_EMAIL || process.env.DIGEST_TO_EMAIL;
  const from = process.env.DIGEST_FROM_EMAIL || "hello@marinanicholas.com";
  if (!apiKey || !to) {
    console.warn("credit-check: RESEND_API_KEY or ALERT_TO_EMAIL/DIGEST_TO_EMAIL unset, no email sent");
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

function faultHtml({ status, detail, model, since }) {
  const headline = {
    out_of_credits: "The Anthropic credit balance has run out.",
    auth: "The Anthropic API key is being rejected.",
    no_key: "ANTHROPIC_API_KEY is not set on the automation hub, so nothing is being monitored.",
  }[status] || "The Anthropic API has failed several consecutive checks.";

  return [
    "<h2>Growth Gap Report pipeline: " + (HUMAN[status] || status) + "</h2>",
    "<p><strong>" + headline + "</strong></p>",
    "<p>While this is true, every Growth Gap Report submission fails silently.",
    "The prospect sees &ldquo;your report is taking a little longer than usual&rdquo;,",
    "gets no report, and <strong>no Pipedrive deal is created</strong> &mdash;",
    "the lead is lost, not delayed.</p>",
    "<h3>Fix</h3><ol>",
    "<li>Anthropic console &rarr; Plans &amp; Billing &rarr; add credits.</li>",
    "<li>Turn on <strong>auto-reload</strong> while you are there, so it cannot happen a third time.</li>",
    "<li>Re-test: submit the form at growth.marinanicholas.com and confirm a report renders.</li>",
    "</ol><h3>Detail</h3><ul>",
    "<li>Status: <code>" + status + "</code></li>",
    "<li>Model probed: <code>" + (model || "n/a") + "</code></li>",
    "<li>Failing since: " + (since ? new Date(since).toUTCString() : "just now") + "</li>",
    "<li>API said: <code>" + String(detail || "").slice(0, 300) + "</code></li>",
    "</ul><p style=\"color:#667\">Sent by the credit-check job on mn-automation-hub.</p>",
  ].join("\n");
}

function recoveryHtml({ since, model }) {
  return [
    "<h2>Growth Gap Report pipeline: back to healthy</h2>",
    "<p>The Anthropic API is answering again, so report generation is working.</p>",
    "<ul>",
    "<li>Was failing since: " + (since ? new Date(since).toUTCString() : "unknown") + "</li>",
    "<li>Model probed: <code>" + (model || "n/a") + "</code></li>",
    "</ul>",
    "<p>Worth checking whether any submissions were lost during the outage &mdash;",
    "they will not be in Pipedrive.</p>",
  ].join("\n");
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorised(req)) return res.status(401).json({ ok: false, error: "bad key" });
  // Fire drill: ...&drill=out_of_credits sends the real alert through the real
  // channel, so the path is proven before an outage needs it. An alarm nobody
  // has ever heard ring is not an alarm. It deliberately does NOT touch stored
  // state, so a drill can never leave the monitor believing the pipeline is
  // down, and it always returns 200 so the scheduled workflow stays green.
  const drill = String(req.query.drill || "").trim();
  if (drill) {
    const drillStatus = HUMAN[drill] ? drill : "out_of_credits";
    let drillEmailed = false;
    let drillError = null;
    try {
      drillEmailed = !(
        await email({
          subject: "[DRILL] Growth Gap Report pipeline - " + (HUMAN[drillStatus] || drillStatus),
          html:
            "<p><strong>This is a test. Nothing is wrong.</strong> It proves the alert " +
            "email actually arrives. Below is exactly what a real alert looks like.</p><hr>" +
            faultHtml({
              status: drillStatus,
              detail: "simulated by ?drill=" + drill,
              model: "n/a",
              since: Date.now(),
            }),
        })
      ).skipped;
    } catch (err) {
      drillError = String(err.message || err).slice(0, 200);
    }
    return res.status(200).json({
      ok: true,
      drill: drillStatus,
      emailed: drillEmailed,
      emailError: drillError,
      stateUntouched: true,
    });
  }

  const now = Date.now();
  const result = await probe();
  const prev = (await getState(STATE_KEY, null)) || {
    status: "ok",
    since: null,
    lastNotifiedAt: null,
    consecutiveTransient: 0,
  };

  let status = result.status;
  let consecutiveTransient = 0;
  if (status !== "ok" && !HARD_FAULTS.has(status)) {
    consecutiveTransient = (prev.consecutiveTransient || 0) + 1;
    if (consecutiveTransient < TRANSIENT_TOLERANCE) status = "ok";
  }

  const broken = status !== "ok";
  const wasBroken = prev.status !== "ok";
  const since = broken ? (wasBroken && prev.since ? prev.since : now) : null;

  let notify = null;
  if (broken && !wasBroken) notify = "new";
  else if (broken && wasBroken && now - (prev.lastNotifiedAt || 0) >= RENOTIFY_AFTER_MS) notify = "reminder";
  else if (!broken && wasBroken) notify = "recovered";

  let emailed = false;
  let emailError = null;
  if (notify) {
    const subject =
      notify === "recovered"
        ? "Recovered: Growth Gap Report pipeline is generating again"
        : (notify === "reminder" ? "Still broken" : "ALERT") +
          ": Growth Gap Report pipeline - " + (HUMAN[status] || status);
    const html =
      notify === "recovered"
        ? recoveryHtml({ since: prev.since, model: result.model })
        : faultHtml({ status, detail: result.detail, model: result.model, since });
    try {
      emailed = !(await email({ subject, html })).skipped;
    } catch (err) {
      // A failed alert email must not fail the check: the 503 below is still a
      // signal, and swallowing the reason would hide two faults at once.
      emailError = String(err.message || err).slice(0, 200);
    }
  }

  await setState(STATE_KEY, {
    status,
    since,
    lastNotifiedAt: notify === "recovered" ? null : notify ? now : prev.lastNotifiedAt || null,
    consecutiveTransient,
    lastCheckedAt: now,
    lastDetail: result.detail || null,
  });

  return res.status(broken ? 503 : 200).json({
    ok: !broken,
    status,
    human: HUMAN[status] || status,
    model: result.model || null,
    httpStatus: result.httpStatus || null,
    detail: result.detail || null,
    consecutiveTransient,
    since,
    notified: notify,
    emailed,
    emailError,
  });
}
