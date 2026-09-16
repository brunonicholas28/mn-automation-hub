// Reads what Instantly actually sent and fails if it is not what we wrote.
//
// WHY THIS EXISTS
//
// On 2026-09-15 cohort c20260915's Email #1 went to 233 people with the
// subject line rendered literally:
//
//   {quick one, Thomas|before the year closes out, Thomas}
//
// On 2026-09-16 cohort c20260908's Email #2 went to 179 more as:
//
//   {6 out of 10|most won't say this out loud}
//
// Instantly substitutes {{variables}} at send time but does not expand spintax
// on this account. Every check in cohort-preflight passed both mornings,
// because all eighteen of them read configuration: lead counts, merge fields,
// template health, warm capacity. The templates were exactly what we meant
// them to be. Nothing looked at a sent message, so nobody found out until
// Bruno opened his laptop.
//
// This job is the missing half. It reads the emails Instantly has actually
// sent today and asserts that no template syntax survived into them. It runs
// a few times in the first hour of the sending window, so a bad render costs
// twenty emails instead of a whole cohort.
//
// It writes nothing to the campaigns. Finding out is its whole job; pausing
// stays a human act.
//
// Call: /api/cron/run?job=send-audit&key=<FUNNEL_CRON_KEY>
//   &campaign=<id>   audit one campaign instead of every active one
//   &drill=1         send the real alert with fabricated findings, touch no state

import { Redis } from "@upstash/redis";
import { listCampaigns, listSentEmails } from "../instantly.js";
import { renderFaultsIn, describeFaults } from "../render-check.js";

const kv = Redis.fromEnv();

const STATE_KEY = "alert:send-audit";

// A fault is the same fault all morning. Don't re-mail every run.
const RENOTIFY_AFTER_MS = 6 * 60 * 60 * 1000;

// How many recent sends to inspect per campaign. The fault we are looking for
// is a template fault, so it is in every email or none - a handful is plenty,
// and it keeps the job inside one Vercel invocation.
const SAMPLE_PER_CAMPAIGN = 10;

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function sameUtcDay(iso, now) {
  if (!iso) return false;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return false;
  return (
    t.getUTCFullYear() === now.getUTCFullYear() &&
    t.getUTCMonth() === now.getUTCMonth() &&
    t.getUTCDate() === now.getUTCDate()
  );
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export async function auditCampaign(campaign, { now = new Date() } = {}) {
  const result = {
    campaign: campaign.name,
    campaignId: campaign.id,
    inspected: 0,
    sentToday: 0,
    bad: [],
    error: null,
  };

  let emails;
  try {
    emails = await listSentEmails({ campaignId: campaign.id, limit: SAMPLE_PER_CAMPAIGN });
  } catch (err) {
    result.error = String(err.message || err).slice(0, 200);
    return result;
  }

  for (const mail of emails) {
    if (!mail.outbound) continue;
    result.inspected += 1;
    if (sameUtcDay(mail.sentAt, now)) result.sentToday += 1;

    // allowVariables:false - this is the rendered article. A {{firstName}}
    // still sitting in it never resolved.
    const faults = renderFaultsIn(mail, { allowVariables: false });
    if (faults.length) {
      result.bad.push({
        to: mail.to,
        sentAt: mail.sentAt,
        subject: mail.subject,
        detail: describeFaults(faults),
      });
    }
  }

  return result;
}

async function email({ subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_TO_EMAIL || process.env.DIGEST_TO_EMAIL;
  const from = process.env.DIGEST_FROM_EMAIL || "hello@marinanicholas.com";
  if (!apiKey || !to) {
    console.warn("send-audit: RESEND_API_KEY or ALERT_TO_EMAIL/DIGEST_TO_EMAIL unset, no email sent");
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

export function alertHtml(findings) {
  const rows = findings.flatMap((f) =>
    f.bad.map((b) =>
      "<tr>" +
      "<td>" + esc(f.campaign) + "</td>" +
      "<td>" + esc(b.to || "(unknown)") + "</td>" +
      "<td><code>" + esc(b.subject) + "</code></td>" +
      "<td>" + esc(b.detail) + "</td>" +
      "</tr>"
    )
  );
  const total = findings.reduce((n, f) => n + f.bad.length, 0);

  return [
    "<h2>Emails are going out with template syntax in them</h2>",
    "<p><strong>" + total + " of the messages sampled</strong> still contain spintax, an ",
    "unresolved <code>{{variable}}</code> or a leftover placeholder. Recipients are seeing ",
    "this exactly as printed below.</p>",
    "<p>Instantly does not expand spintax on this account. If the fault is a subject like ",
    "<code>{a|b}</code>, every email in the step carries it, not just these.</p>",
    "<p><strong>To stop it:</strong> pause the campaign in Instantly, replace the spintax with ",
    "one plain line, then resume. An Active campaign is read-only, so it has to be paused ",
    "before the editor will accept the change.</p>",
    "<table border='1' cellpadding='6' cellspacing='0'>",
    "<tr><th>Campaign</th><th>Recipient</th><th>Subject as sent</th><th>Fault</th></tr>",
    rows.join(""),
    "</table>",
    "<p style='color:#666'>send-audit, mn-automation-hub. Reads sent mail only; changes nothing.</p>",
  ].join("");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const key = process.env.FUNNEL_CRON_KEY;
  if (key && String(req.query.key || "") !== key) {
    return res.status(401).json({ ok: false, error: "bad key" });
  }

  const now = new Date();

  // Fire drill: proves the alert arrives, without waiting for a real fault.
  if (String(req.query.drill || "") === "1") {
    const fake = [{
      campaign: "DRILL - not a real campaign",
      bad: [{
        to: "nobody@example.com",
        subject: "{6 out of 10|most won't say this out loud}",
        detail: 'subject spintax "{6 out of 10|most won\'t say this out loud}"',
      }],
    }];
    let emailed = false;
    let emailError = null;
    try {
      emailed = !(await email({
        subject: "DRILL - send-audit alert test",
        html:
          "<p><strong>This is a test. Nothing is wrong.</strong> It proves the alert email " +
          "actually arrives. Below is exactly what a real alert looks like.</p><hr>" +
          alertHtml(fake),
      })).skipped;
    } catch (err) {
      emailError = String(err.message || err).slice(0, 200);
    }
    return res.status(200).json({ ok: true, drill: true, emailed, emailError, stateUntouched: true });
  }

  const only = String(req.query.campaign || "").trim();

  let campaigns;
  try {
    campaigns = await listCampaigns();
  } catch (err) {
    // Not knowing is not the same as nothing being wrong.
    return res.status(503).json({
      ok: false,
      error: "could not list campaigns: " + String(err.message || err).slice(0, 200),
    });
  }

  const targets = campaigns.filter((c) => {
    if (only) return c.id === only;
    // Anything that could be sending right now. Instantly's status codes vary,
    // so match on the shape rather than a magic number.
    const status = String(c.status == null ? "" : c.status).toLowerCase();
    return status === "1" || status === "active" || status === "running";
  });

  const findings = [];
  for (const c of targets) {
    findings.push(await auditCampaign(c, { now }));
  }

  const withFaults = findings.filter((f) => f.bad.length);
  const unreadable = findings.filter((f) => f.error);
  const totalBad = withFaults.reduce((n, f) => n + f.bad.length, 0);
  const inspected = findings.reduce((n, f) => n + f.inspected, 0);

  const prev = (await kv.get(STATE_KEY).catch(() => null)) || { lastNotifiedAt: 0 };
  const nowMs = now.getTime();

  let emailed = false;
  let emailError = null;
  if (totalBad && nowMs - (prev.lastNotifiedAt || 0) >= RENOTIFY_AFTER_MS) {
    try {
      emailed = !(
        await email({
          subject: "ALERT - " + totalBad + " email(s) sent with template syntax in them",
          html: alertHtml(withFaults),
        })
      ).skipped;
    } catch (err) {
      // A failed alert must not swallow the finding. The non-200 below still
      // turns the workflow red.
      emailError = String(err.message || err).slice(0, 200);
    }
  }

  await kv
    .set(STATE_KEY, {
      lastCheckedAt: now.toISOString(),
      lastNotifiedAt: totalBad ? (emailed ? nowMs : prev.lastNotifiedAt || 0) : 0,
      lastTotalBad: totalBad,
    })
    .catch(() => {});

  const body = {
    ok: totalBad === 0 && unreadable.length === 0,
    checkedAt: now.toISOString(),
    campaignsAudited: findings.length,
    emailsInspected: inspected,
    sentToday: findings.reduce((n, f) => n + f.sentToday, 0),
    faults: totalBad,
    emailed,
    emailError,
    // Names and counts only. These logs are public.
    detail: findings.map((f) => ({
      campaign: f.campaign,
      inspected: f.inspected,
      sentToday: f.sentToday,
      faults: f.bad.length,
      worst: f.bad.length ? f.bad[0].detail : null,
      error: f.error,
    })),
  };

  return res.status(body.ok ? 200 : 409).json(body);
}
