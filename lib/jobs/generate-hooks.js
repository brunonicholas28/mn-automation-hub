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
// THE 12 SEP 2026 REWRITE. The first live run returned 3 hooks from 265
// leads, 1.1%, against a hand-researched benchmark of 48% on the same cohort.
// The cohort was not dry. Three things were wrong and all three are fixed
// here:
//
//   1. The model was not searching. searchesUsed was 0 on most passes, which
//      came back in under four seconds. The old brief front-loaded four
//      disqualifying bars and closed on "answer NO-TRIGGER, that is a good
//      outcome, not a failure" - permission to give up, read before the model
//      had looked at anything, under a one-line output format that rewards
//      answering immediately. The search is now mandatory, named as specific
//      queries, and instructed before the bar rather than after it.
//   2. The model was given a bare company name. "Clear", "Fabric", "Strategy"
//      and "Vention" are not searchable strings. The email domain was sitting
//      on the lead record the whole time and is now in the brief.
//   3. Every failure mode collapsed into NO-TRIGGER, which is a claim about
//      the PROSPECT. A parse failure, a truncated answer and a paused search
//      turn all got written onto the lead as "no news exists", permanently,
//      because a lead with a verdict is never picked up again. Those are now
//      RETRY, which leaves the lead unmarked for the next pass.
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

// Three at a time, down from four. Each turn now really does search, so a
// turn costs ten to forty seconds instead of two, and three is what fits the
// deadline with room for the retry below.
const DEFAULT_BATCH = 3;

// Headroom, so a slow turn cannot run the function past its timeout and lose
// the whole batch's writes.
const DEADLINE_MS = 45000;

// After this many failed attempts the lead is settled as UNRESEARCHED rather
// than retried forever. UNRESEARCHED is deliberately its own verdict and not
// NO-TRIGGER: it says "we never managed to look", which is a fact about us,
// where NO-TRIGGER says "we looked and there is nothing", which is a fact
// about the prospect. Conflating them is what made a broken run look like a
// quiet cohort. Downstream both route to the no-hook campaign, because
// api/cohort/build.js splits on whether a hook exists, not on the verdict.
const MAX_ATTEMPTS = 3;

const EM_DASH = /[—–]/;
const MAX_TRIGGER_WORDS = 14;

// Free mailbox providers tell us nothing about the company, so they are not
// worth putting in front of the model as if they were a corporate domain.
const FREE_MAIL =
  /^(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|icloud|me|mac|aol|gmx|protonmail|proton|mail|yandex|zoho|msn|btinternet|comcast)\./i;

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

// The company's own domain, which is usually the only thing that makes a
// generic company name findable. Taken from the prospect's work email, which
// every lead in a cohort has, because that is how they got into the cohort.
export function domainFor(lead) {
  const email = String((lead && lead.email) || "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  const domain = email.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return "";
  if (FREE_MAIL.test(domain)) return "";
  return domain;
}

// Search triggering is steerable from the system prompt and essentially not
// steerable any other way: the API offers no tool_choice for the server-side
// web search. So the instruction that the model must search lives here, at
// the highest priority the request has, rather than buried in the brief.
const SYSTEM = [
  "You are a research analyst preparing one line of a cold email. You have a web_search tool and you are expected to use it on every single prospect.",
  "Answering from memory is not acceptable. You do not know what happened to a private company in the last twelve months, and a verdict reached without searching is worthless.",
  "Search first, decide second. Reaching a verdict with zero searches is the one failure mode that is never acceptable, including when the company name looks unfamiliar or generic.",
].join(" ");

// This brief is the mn-cold-outreach-hooks skill's brief. If you change one,
// change both.
//
// Order matters here and is the whole fix. The old brief was: bar, screen,
// output format, "NO-TRIGGER is a good outcome". A model reads that as
// permission to answer NO-TRIGGER, and the one-line output format makes
// answering immediately the path of least resistance. This one is: who they
// are, go and search, here are the queries, THEN the bar, then the format.
// The quality bar is unchanged. Only the point at which the model is allowed
// to give up has moved, from before the search to after it.
function briefFor(lead, { harder = false } = {}) {
  const who = lead.firstName || "the named contact";
  const company = lead.company || "the company";
  const domain = domainFor(lead);

  const identity = ["Company: " + company, "Contact: " + who];
  if (domain) {
    identity.push("Company website: " + domain);
    identity.push(
      "Use the domain to make sure you have the right company. The company name on its own is often ambiguous and sometimes a common word."
    );
  }

  const q = domain ? domain.replace(/^www\./, "").split(".")[0] : company;

  const lines = [
    "Find ONE genuinely notable, recent fact about the company below, for the opening line of a cold email.",
    "",
    ...identity,
    "",
    "STEP 1. SEARCH. This is not optional and it comes before any verdict.",
    "Run at least three of these, and more if the early ones are thin:",
    '  "' + company + '" news 2026',
    '  "' + company + '" funding OR acquisition OR award OR launch OR contract',
    '  "' + company + '" announcement ' + (domain ? "site:" + domain : "press release"),
    '  "' + q + '" ' + (domain ? domain : "company") + " 2026",
    "Do not stop at the first empty result page. A company with no news on page one of one query often has a funding round or an award on the second query.",
    "",
    "STEP 2. JUDGE what you found. THE FACT BAR, all four must hold:",
    "1. Published in the last 6 to 12 months.",
    "2. Specific and dated, a real event.",
    "3. Sourced: a real URL you actually retrieved. No URL, no fact.",
    "4. Genuinely notable: funding, an award, an acquisition THEY made, a launch, an expansion, a major contract, or a senior hire announced with fanfare.",
    "",
    "A routine registry filing, an undated 'now available' blurb, an address change or a directory listing FAILS bar 4 even when it passes 1 to 3. If that is all you find, there is no fact. A hollow congratulations is worse than no congratulations.",
    "For a fund, a fund close or a deal they led and announced counts. A portfolio company's own round is not the fund's milestone.",
    "",
    "STEP 3. THE SCREEN. Only three disqualifiers:",
    "(a) The company is defunct or no longer an independent operating business. A company acquired but still trading under its own brand with the named contact still in post is IN SCOPE.",
    "(b) The company itself is an investment bank, an M&A advisory or a business brokerage. A fund or fund manager is fine.",
    "(c) Pre-revenue, or under about 5 staff with no real revenue.",
    "",
    "Everything else is in scope. Do NOT exclude PE funds, VC funds, fund managers, wealth managers, enterprise-only vendors, government suppliers, recruiters or management consultancies. Never screen on who the prospect sells to. Never screen on sector, geography or the leader's age.",
    "Also EXCLUDE if the named contact has died or has clearly left the company.",
    "EXCLUDE is a real verdict with a real reason behind it. Use it when one of those three applies, and do not fall back on NO-TRIGGER instead.",
    "",
    "STEP 4. OUTPUT. Reply with ONE line and nothing else. No preamble, no explanation, no markdown:",
    "verdict | trigger | url | date | confidence",
    "",
    "verdict: DRAFT, NO-TRIGGER or EXCLUDE",
    'trigger: slots into the sentence "Saw {trigger}, congratulations!" Under about 12 words, concrete, and natural in that slot. Write \'none\' when the verdict is not DRAFT.',
    "url: the source you retrieved, or 'none'",
    "date: the publication date as YYYY-MM-DD, or 'none'",
    "confidence: High or Low",
    "",
    "NEVER use an em dash anywhere in the trigger phrase.",
    "NO-TRIGGER is an honest answer once you have searched and found nothing that clears the bar. It is not an answer you may give before searching, and it is not a way to avoid a judgement call on a fact you did find.",
  ];

  if (harder) {
    lines.push(
      "",
      "You answered this prospect without running a single search. That answer was discarded. Search now, properly, before you reply."
    );
  }

  return lines.join("\n");
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
//
// RETRY is the one verdict that is not written to the lead. NO-TRIGGER is a
// claim about the prospect: we looked, there is no news. A model that replied
// in the wrong shape has told us nothing about the prospect at all, and
// recording that as NO-TRIGGER both loses the lead forever and quietly
// inflates the "no news" count that the yield is judged on.
function validate(row) {
  if (!row) return { verdict: "RETRY", reason: "the model did not answer in the expected format" };
  if (row.verdict === "EXCLUDE") return { verdict: "EXCLUDE", reason: "screened out" };
  if (row.verdict !== "DRAFT" && row.verdict !== "NO-TRIGGER") {
    return { verdict: "RETRY", reason: "unrecognised verdict: " + row.verdict.slice(0, 24) };
  }
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

// One attempt. Kept separate from researchLead so the retry is visibly the
// same call with a harder brief, not a different code path.
async function attempt(lead, model, harder) {
  const res = await researchOnce(briefFor(lead, { harder }), { model, system: SYSTEM });
  return { res, checked: validate(parseRow(res.text)) };
}

// A verdict only counts if the model actually looked. Zero searches means the
// answer is about the model's memory, not about the prospect, whatever the
// verdict says - so it is retried once with the harder brief and, if it still
// will not search, left unmarked rather than recorded as a finding.
function unusable({ res, checked }) {
  if (checked.verdict === "RETRY") return "the model did not answer in the expected format";
  if (res.stopReason === "max_tokens") return "the answer was cut off before the verdict line";
  if (res.searches === 0 && checked.verdict !== "DRAFT") return "the model answered without searching";
  return null;
}

async function researchLead(lid, lead, model, { debug = false } = {}) {
  const attemptsSoFar = Number(lead.hookAttempts || 0) || 0;
  try {
    let a = await attempt(lead, model, false);
    let why = unusable(a);
    let retried = false;

    if (why) {
      retried = true;
      const b = await attempt(lead, model, true);
      const stillWhy = unusable(b);
      if (!stillWhy) {
        a = b;
        why = null;
      } else {
        a = b;
        why = stillWhy;
      }
    }

    const { res, checked } = a;

    if (why) {
      const attempts = attemptsSoFar + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;

      // No verdict while attempts remain, so the next pass picks the lead up
      // again instead of it silently becoming a NO-TRIGGER. Once they are
      // exhausted it settles as UNRESEARCHED so the workflow loop can finish.
      if (!debug) {
        await updateLead(
          lid,
          exhausted
            ? {
                hookAttempts: String(attempts),
                hookVerdict: "UNRESEARCHED",
                hookReason: why,
                hook: "",
                hookCheckedAt: new Date().toISOString(),
              }
            : { hookAttempts: String(attempts) }
        );
      }

      return {
        verdict: exhausted ? "UNRESEARCHED" : "RETRY",
        reason: why,
        attempts,
        searches: res.searches,
        tokens: res.inputTokens + res.outputTokens,
        raw: debug ? res.text.slice(0, 400) : undefined,
      };
    }

    const patch = {
      hookVerdict: checked.verdict,
      hookCheckedAt: new Date().toISOString(),
      hookSearches: String(res.searches),
      hookStopReason: String(res.stopReason || ""),
      hookRetried: retried ? "1" : "0",
      hookAttempts: String(attemptsSoFar + 1),
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

    if (!debug) await updateLead(lid, patch);

    return {
      verdict: checked.verdict,
      searches: res.searches,
      retried,
      tokens: res.inputTokens + res.outputTokens,
      raw: debug ? res.text.slice(0, 400) : undefined,
    };
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

  // Researches a few leads for real and returns the model's raw reply without
  // writing anything. This is how you check the model is searching, in one
  // call, instead of inferring it from a whole run's yield afterwards.
  const debug = String(req.query.debug || "") === "1";

  // Clears the verdict on every lead in the cohort so the next run researches
  // it again. Needed after a bad run: a lead with a verdict is never picked
  // up, so fixing the researcher does nothing on its own.
  const reset = String(req.query.reset || "") === "1";

  const startedAt = Date.now();

  try {
    const tokens = await listLeadTokens(cohort);
    const leads = await readLeads(tokens);

    if (reset) {
      if (!live) {
        return res.status(200).json({
          ok: true,
          cohort,
          reset: true,
          live: false,
          wouldClear: leads.filter((l) => l.hookVerdict).length,
          note: "Dry run. Add live=1 to actually clear these verdicts.",
        });
      }
      let cleared = 0;
      for (const lead of leads) {
        if (!lead.hookVerdict) continue;
        await updateLead(lead.lid, {
          hookVerdict: "",
          hook: "",
          hookReason: "",
          hookSource: "",
          hookDate: "",
          hookConfidence: "",
          hookSearches: "",
          hookStopReason: "",
          hookAttempts: "",
        });
        cleared += 1;
      }
      return res.status(200).json({ ok: true, cohort, reset: true, live: true, cleared });
    }

    const pending = [];
    const counts = { DRAFT: 0, "NO-TRIGGER": 0, EXCLUDE: 0, UNRESEARCHED: 0, unresearched: 0 };

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

    if (!live && !debug) {
      out.note =
        "Dry run. " +
        pending.length +
        " would be researched on this call, " +
        counts.unresearched +
        " in total. Add live=1 to spend credits.";
      return res.status(200).json(out);
    }

    const model = await resolveModel();
    const results = await Promise.all(pending.map((p) => researchLead(p.lid, p.lead, model, { debug })));

    const run = { DRAFT: 0, "NO-TRIGGER": 0, EXCLUDE: 0, UNRESEARCHED: 0, RETRY: 0, ERROR: 0 };
    let searches = 0;
    let tokensUsed = 0;
    let retries = 0;
    const errors = [];
    for (const r of results) {
      if (run[r.verdict] !== undefined) run[r.verdict] += 1;
      searches += r.searches || 0;
      tokensUsed += r.tokens || 0;
      if (r.retried) retries += 1;
      if (r.error) errors.push(r.error);
    }

    // RETRY and ERROR left no verdict, so those leads are still outstanding.
    const settled = run.DRAFT + run["NO-TRIGGER"] + run.EXCLUDE + run.UNRESEARCHED;
    out.model = model;
    out.researched = results.length;
    out.thisRun = run;
    out.searchesUsed = searches;
    out.tokensUsed = tokensUsed;
    out.retried = retries;
    out.elapsedMs = Date.now() - startedAt;
    out.remaining = Math.max(0, counts.unresearched - settled);
    if (errors.length) out.errorSample = errors.slice(0, 3);

    // The one number worth watching. A pass where the model did not search is
    // a pass that learned nothing about anybody, and it used to be invisible.
    out.searchesPerLead = results.length ? Number((searches / results.length).toFixed(2)) : 0;

    if (debug) {
      out.debug = true;
      out.note = "Debug run. Nothing was written to any lead record.";
      out.replies = results.map((r) => ({
        verdict: r.verdict,
        searches: r.searches || 0,
        reason: r.reason,
        raw: r.raw,
      }));
      return res.status(200).json(out);
    }

    out.note =
      "Hooks are written to the lead record only. Nothing sends: the campaign they feed is created paused.";

    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, cohort, error: String(err.message || err).slice(0, 300) });
  }
}
