// Job: hook-io. The bridge between research done OUTSIDE this app and the
// lead records the Instantly build reads.
//
// WHY THIS EXISTS
//
// generate-hooks researches through the Anthropic API, which is metered. The
// same research can be done inside a scheduled Claude session, which is paid
// for by a subscription Bruno already has. The research is the easy half. The
// hard half is that a Claude session has no business holding FUNNEL_CRON_KEY,
// and the hooks have to land in Upstash KV or the Instantly CSV never sees
// them.
//
// So the session never touches the key. It reads a cohort roster this job
// exports, researches it, and commits the results as JSON to the repo. A
// GitHub Action holds the secret and posts that file back here. Two modes,
// one file, one slot in the dispatcher:
//
//   ?job=hook-io&mode=export           roster out, no credentials needed to read it
//   ?job=hook-io&mode=import&live=1    verdicts in, posted by the Action
//
// WHAT NEVER LEAVES
//
// The export is committed to a PUBLIC repo, so it carries dealId, company and
// the company's own web domain, and nothing else. No email addresses, no
// contact names. The domain is derived here from the prospect's work email
// because a bare company name is often unsearchable ("Clear", "Fabric",
// "Strategy"), but the address itself stays in KV where it belongs.
//
// WHAT IS ENFORCED ON THE WAY IN
//
// Everything import writes goes through the same validator generate-hooks
// uses on the model's own output: a real URL, no em dash, under fourteen
// words, no "congratulations" doubling the template's own. Research arriving
// from a session is not more trusted than research arriving from the API, and
// a hook that fails the bar is recorded as NO-TRIGGER rather than repaired.

import { listLeadTokens, readLeads, updateLead } from "../leads.js";
import { normaliseCohortId } from "../cohort.js";

export const config = { maxDuration: 60 };

const EM_DASH = /[—–]/;
const MAX_TRIGGER_WORDS = 14;

const FREE_MAIL =
  /^(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|icloud|me|mac|aol|gmx|protonmail|proton|mail|yandex|zoho|msn|btinternet|comcast)\./i;

function authorised(req) {
  const expected = process.env.FUNNEL_CRON_KEY;
  if (!expected) return false; // Fail closed: export reveals the prospect list.
  const given =
    String(req.query.key || "").trim() ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return given.length > 0 && given === expected;
}

function domainOf(lead) {
  const email = String((lead && lead.email) || "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  const domain = email.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return "";
  if (FREE_MAIL.test(domain)) return "";
  return domain;
}

// Same rules as generate-hooks. Kept deliberately strict and deliberately
// dumb: it demotes, it never rewrites. A trigger nobody wrote and no source
// backs is the one output this whole pipeline exists to prevent.
export function checkRow(row) {
  const verdict = String(row.verdict || "").toUpperCase().replace(/[^A-Z-]/g, "");

  if (verdict === "EXCLUDE") return { verdict: "EXCLUDE", reason: "screened out" };
  if (verdict !== "DRAFT" && verdict !== "NO-TRIGGER") {
    return { verdict: "REJECT", reason: "unrecognised verdict: " + verdict.slice(0, 24) };
  }
  if (verdict === "NO-TRIGGER") return { verdict: "NO-TRIGGER", reason: "no fact cleared the bar" };

  const trigger = String(row.trigger || "").trim();
  const url = String(row.url || "").trim();

  if (!trigger || /^none$/i.test(trigger)) {
    return { verdict: "NO-TRIGGER", reason: "verdict was DRAFT but no trigger came back" };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { verdict: "NO-TRIGGER", reason: "no source URL, and no URL means no fact" };
  }
  if (EM_DASH.test(trigger)) {
    return { verdict: "NO-TRIGGER", reason: "trigger contained an em dash, which the copy rules forbid" };
  }
  if (trigger.split(/\s+/).length > MAX_TRIGGER_WORDS) {
    return { verdict: "NO-TRIGGER", reason: "trigger was too long to sit in the sentence" };
  }
  if (/congratulat/i.test(trigger)) {
    return { verdict: "NO-TRIGGER", reason: "trigger repeated the congratulations already in the template" };
  }

  return {
    verdict: "DRAFT",
    trigger,
    url,
    date: String(row.date || "").trim(),
    confidence: /low/i.test(String(row.confidence || "")) ? "Low" : "High",
  };
}

function parseBody(req) {
  const b = req.body;
  if (!b) return null;
  const obj = typeof b === "string" ? JSON.parse(b) : b;
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.rows)) return obj.rows;
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });

  const cohort = normaliseCohortId(req.query.cohort);
  if (!cohort || !/^c\d{8}$/.test(cohort)) {
    return res.status(400).json({ ok: false, error: "cohort is required, e.g. ?cohort=c20260915" });
  }

  const mode = String(req.query.mode || "export").toLowerCase();
  const live = String(req.query.live || "") === "1";

  try {
    const tokens = await listLeadTokens(cohort);
    const leads = await readLeads(tokens);

    if (mode === "export") {
      const rows = leads
        .map((l) => ({
          dealId: String(l.dealId || ""),
          company: String(l.company || ""),
          domain: domainOf(l),
          researched: l.hookVerdict ? String(l.hookVerdict) : "",
        }))
        .filter((r) => r.dealId || r.company);
      return res.status(200).json({
        ok: true,
        cohort,
        count: rows.length,
        note: "dealId, company and web domain only. No addresses, no contact names.",
        rows,
      });
    }

    if (mode !== "import") {
      return res.status(400).json({ ok: false, error: "mode must be export or import" });
    }

    let rows;
    try {
      rows = parseBody(req);
    } catch (err) {
      return res.status(400).json({ ok: false, error: "body is not valid JSON" });
    }
    if (!rows || !rows.length) {
      return res.status(400).json({ ok: false, error: "POST a JSON array of rows, or {rows:[...]}" });
    }

    // dealId is the join key because it is the one identifier the research
    // side is allowed to see. Matching on it also means a row for someone
    // outside this cohort simply finds no lead and is reported, rather than
    // quietly writing a hook onto a stranger.
    const byDeal = new Map();
    for (const lead of leads) {
      const id = String(lead.dealId || "").trim();
      if (id) byDeal.set(id, lead);
    }

    const out = { DRAFT: 0, "NO-TRIGGER": 0, EXCLUDE: 0, REJECT: 0, unmatched: 0 };
    const problems = [];

    for (const raw of rows) {
      const id = String((raw && (raw.dealId ?? raw.deal_id ?? raw.id)) || "").trim();
      const lead = byDeal.get(id);
      if (!lead) {
        out.unmatched += 1;
        if (problems.length < 10) problems.push({ dealId: id, why: "no lead in this cohort" });
        continue;
      }

      const checked = checkRow(raw || {});
      if (checked.verdict === "REJECT") {
        out.REJECT += 1;
        if (problems.length < 10) problems.push({ dealId: id, why: checked.reason });
        continue;
      }

      out[checked.verdict] += 1;
      if (!live) continue;

      const patch = {
        hookVerdict: checked.verdict,
        hookCheckedAt: new Date().toISOString(),
        hookSource2: "session",
      };
      if (checked.verdict === "DRAFT") {
        patch.hook = checked.trigger;
        patch.hookSource = checked.url;
        patch.hookDate = checked.date || "";
        patch.hookConfidence = checked.confidence;
        patch.hookReason = "";
      } else {
        patch.hook = "";
        patch.hookReason = checked.reason || "";
      }
      await updateLead(lead.lid, patch);
    }

    const hooks = out.DRAFT;
    return res.status(200).json({
      ok: true,
      cohort,
      mode: "import",
      live,
      received: rows.length,
      leadsInCohort: tokens.length,
      applied: out,
      hookRate: tokens.length ? Number(((100 * hooks) / tokens.length).toFixed(1)) : 0,
      problems,
      note: live
        ? "Written to the lead records. Nothing sends: the campaign they feed is created paused."
        : "Dry run. Add live=1 to write.",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, cohort, error: String(err.message || err).slice(0, 300) });
  }
}
