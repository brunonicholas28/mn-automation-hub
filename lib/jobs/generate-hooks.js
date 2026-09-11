// Job: generate-hooks.
//
// Finds the one notable fact behind each prospect's Day 2 opening line, and
// writes it onto the lead record where api/cohort/build.js looks for it.
//
// The Day 2 email has exactly one per-prospect variable. Everything else is
// fixed mail-merge. So this job is narrow on purpose: one fact per company,
// screened, or nothing at all.
//
// Nothing here sends. The hook lands on the lead record; the campaign it
// feeds is created paused; Marina reads the hooks in Instantly and presses
// Launch. That is the review step, and it is why this can run unattended
// without breaking the standing rule that AI drafts and a human sends.
//
// No hook is better than a weak one. A lead with no hook is not a failure, it
// routes to the B campaign whose template opens on the Q4 paragraph instead.
// A filler line or a hollow congratulations IS a failure, and the checks
// below exist because both have shipped before: on 5 Sep 2026 a run
// congratulated a company on a routine Companies House filing.
//
// Resumable by design. Each call takes a small batch of leads that have no
// verdict yet and stops well inside the function timeout, reporting how many
// are left. The workflow calls it in a loop until nothing remains, so a
// cohort of 250 is a few minutes of looping rather than one long request that
// cannot survive a timeout.

import { researchOnce, resolveModel, listModels } from "../anthropic.js";
import { listLeadTokens, readLeads, updateLead } from "../leads.js";
import { normaliseCohortId } from "../cohort.js";

export const config = { maxDuration: 60 };

// Four at a time. Each turn is a handful of searches and takes ten to thirty
// seconds, so four in parallel fits inside the timeout with room spare, and
// the loop in the workflow makes batch size a throughput knob rather than a
// ceiling on cohort size.
const DEFAULT_BATCH = 4;

// Headroom, so a slow turn cannot run the function past its timeout and lose
// the whole batch's writes.
const DEADLINE_MS = 45000;

const EM_DASH = /[—–]/;
const MAX_TRIGGER_WORDS = 14;

function authorised(req) {
  const expected = process.env.FUNNEL_CRON_KEY;
  if (!expected) return false;
  const supplied = String(req.query.key || "").trim();
  return supplied.length > 0 && supplied === expected;
}

function nextTuesday(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const ahead = (2 - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + ahead);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return "c" + d.getUTCFullYear() + mm + dd;
}

// This brief is the mn-cold-outreach-hooks skill's brief, close to verbatim,
// because it is the part that has been tuned against real failures. If you
// change one, change both.
function briefFor(lead) {
  const who = lead.firstName || "the named contact";
  const company = lead.company || "the company";

  return [
    "You are researching one prospect for a cold email. Search the web and find ONE genuinely notable, recent fact about this company.",
    "",
    "Company: " + company,
    "Contact: " + who,
    "",
    "THE FACT BAR. All four must hold:",
    "1. Published in the last 6 to 12 months.",
    "2. Specific and dated, a real event.",
    "3. Sourced: a real URL you actually retrieved. No URL, no fact.",
    "4. Genuinely notable: funding, an award, an acquisition THEY made, a launch, an expansion, a major contract, or a senior hire announced with fanfare.",
    "",
    "A routine registry filing, an undated 'now available' blurb, an address change or a directory listing FAILS bar 4 even when it passes 1 to 3. If that is all you find, there is no fact. A hollow congratulations is worse than no congratulations.",
    "For a fund, a fund close or a deal they led and announced counts. A portfolio company's own round is not the fund's milestone.",
    "",
    "THE SCREEN. Only three disqualifiers:",
    "(a) The company is defunct or no longer an independent operating business. A company acquired but still trading under its own brand with the named contact still in post is IN SCOPE.",
    "(b) The company itself is an investment bank, an M&A advisory or a business brokerage. A fund or fund manager is fine.",
    "(c) Pre-revenue, or under about 5 staff with no real revenue.",
    "",
    "Everything else is in scope. Do NOT exclude PE funds, VC funds, fund managers, wealth managers, enterprise-only vendors, government suppliers, recruiters or management consultancies. Never screen on who the prospect sells to. Never screen on sector, geography or the leader's age.",
    "Also EXCLUDE if the named contact has died or has clearly left the company.",
    "",
    "OUTPUT. Reply with ONE line and nothing else. No preamble, no explanation, no markdown:",
    "verdict | trigger | url | date | confidence",
    "",
    "verdict: DRAFT, NO-TRIGGER or EXCLUDE",
    "trigger: slots into the sentence \"Saw {trigger}, congratulations!\" Under about 12 words, concrete, and natural in that slot. Write 'none' when the verdict is not DRAFT.",
    "url: the source you retrieved, or 'none'",
    "date: the publication date as YYYY-MM-DD, or 'none'",
    "confidence: High or Low",
    "",
    "NEVER use an em dash anywhere in the trigger phrase.",
    "If you are not confident the fact clears all four bars, answer NO-TRIGGER. That is a good outcome, not a failure.",
  ].join("\n");
}

// The model is asked for one clean line, but a model that has just searched
// sometimes narrates first. Take the last line that looks like the format.
function parseRow(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("|"));
  if (!lines.length) return null;

  const parts = lines[lines.length - 1].split("|").map((p) => p.trim());
  if (parts.length < 5) return null;

  const [verdict, trigger, url, date, confidence] = parts;
  return {
    verdict: String(verdict || "").toUpperCase().replace(/[^A-Z-]/g, ""),
    trigger: String(trigger || ""),
    url: String(url || ""),
    date: String(date || ""),
    confidence: /low/i.test(confidence || "") ? "Low" : "High",
  };
}

// Everything here demotes to NO-TRIGGER rather than repairing the text.
// Rewriting a trigger to satisfy a rule would mean shipping a line no human
// wrote and no source backs.
function validate(row) {
  if (!row) return { verdict: "NO-TRIGGER", reason: "the model did not answer in the expected format" };
  if (row.verdict === "EXCLUDE") return { verdict: "EXCLUDE", reason: "screened out" };
  if (row.verdict !== "DRAFT") return { verdict: "NO-TRIGGER", reason: "no fact cleared the bar" };

  const trigger = row.trigger.trim();
  const url = row.url.trim();

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

  return { verdict: "DRAFT", trigger, url, date: row.date, confidence: row.confidence };
}

async function researchLead(lid, lead, model) {
  try {
    const res = await researchOnce(briefFor(lead), { model });
    const checked = validate(parseRow(res.text));

    const patch = {
      hookVerdict: checked.verdict,
      hookCheckedAt: new Date().toISOString(),
      hookSearches: String(res.searches),
    };

    if (checked.verdict === "DRAFT") {
      patch.hook = checked.trigger;
      patch.hookSource = checked.url;
      patch.hookDate = checked.date || "";
      patch.hookConfidence = checked.confidence;
    } else {
      patch.hook = "";
      patch.hookReason = checked.reason || "";
    }

    await updateLead(lid, patch);
    return { verdict: checked.verdict, searches: res.searches, tokens: res.inputTokens + res.outputTokens };
  } catch (err) {
    // A failure is not a verdict. Leaving the lead unmarked means the next
    // loop picks it up again, rather than quietly sending it to campaign B
    // because an API call timed out once.
    return { verdict: "ERROR", error: String(err.message || err).slice(0, 160) };
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });

  // Reading the model list costs nothing and is how the right HOOK_MODEL gets
  // chosen in the first place.
  if (String(req.query.probe || "") === "1") {
    try {
      return res
        .status(200)
        .json({ ok: true, probe: true, resolved: await resolveModel(), models: await listModels() });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err.message || err).slice(0, 300) });
    }
  }

  const cohort = normaliseCohortId(req.query.cohort) || nextTuesday(new Date());
  if (!/^c\d{8}$/.test(cohort)) {
    return res.status(400).json({ ok: false, error: "cohort must look like c20260915" });
  }

  const batch = Math.max(1, Math.min(8, Number(req.query.batch) || DEFAULT_BATCH));
  const live = String(req.query.live || "") === "1";
  const startedAt = Date.now();

  try {
    const tokens = await listLeadTokens(cohort);
    const leads = await readLeads(tokens);

    const pending = [];
    const counts = { DRAFT: 0, "NO-TRIGGER": 0, EXCLUDE: 0, unresearched: 0 };

    for (let i = 0; i < tokens.length; i += 1) {
      const lead = leads[i];
      if (!lead) continue;
      const verdict = String(lead.hookVerdict || "");
      if (verdict) {
        if (counts[verdict] !== undefined) counts[verdict] += 1;
        continue;
      }
      counts.unresearched += 1;
      if (pending.length < batch) pending.push({ lid: tokens[i], lead });
    }

    const out = {
      ok: true,
      cohort,
      live,
      batch,
      leadsInCohort: tokens.length,
      counts,
      remaining: counts.unresearched,
    };

    if (!pending.length) {
      out.remaining = 0;
      out.note = "Every lead in this cohort has a verdict. Nothing left to research.";
      return res.status(200).json(out);
    }

    if (!live) {
      out.note =
        "Dry run. " +
        pending.length +
        " would be researched on this call, " +
        counts.unresearched +
        " in total. Add live=1 to spend credits.";
      return res.status(200).json(out);
    }

    const model = await resolveModel();
    const results = await Promise.all(pending.map((p) => researchLead(p.lid, p.lead, model)));

    const run = { DRAFT: 0, "NO-TRIGGER": 0, EXCLUDE: 0, ERROR: 0 };
    let searches = 0;
    let tokensUsed = 0;
    const errors = [];
    for (const r of results) {
      if (run[r.verdict] !== undefined) run[r.verdict] += 1;
      searches += r.searches || 0;
      tokensUsed += r.tokens || 0;
      if (r.error) errors.push(r.error);
    }

    const settled = run.DRAFT + run["NO-TRIGGER"] + run.EXCLUDE;
    out.model = model;
    out.researched = results.length;
    out.thisRun = run;
    out.searchesUsed = searches;
    out.tokensUsed = tokensUsed;
    out.elapsedMs = Date.now() - startedAt;
    out.remaining = Math.max(0, counts.unresearched - settled);
    if (errors.length) out.errorSample = errors.slice(0, 3);
    out.note =
      "Hooks are written to the lead record only. Nothing sends: the campaign they feed is created paused.";

    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, cohort, error: String(err.message || err).slice(0, 300) });
  }
}
