// Builds the week's Instantly campaigns and imports the cohort into them.
//
// This replaces two manual steps: creating the cohort campaign in the
// Instantly UI, and pasting a CSV of leads into it. Both were on the audit as
// manual, and both are the kind of step that is fine ninety times and then
// quietly skipped once, which is how a cohort ends up unattributable.
//
// What it does NOT do is send anything. Instantly creates a campaign paused
// and this file never calls the activate endpoint, so Marina still presses
// Launch. That is deliberate and should stay that way: the standing rule on
// this funnel is that a human sends.
//
// Two campaigns per cohort, mirroring the 2026-09-08 setup that is already
// live. Instantly sends one template per campaign, and the Day 2 email has a
// personalised opening line that only exists when the research found a real,
// dated, notable fact. An empty merge variable would leave a blank paragraph,
// so the lead is ROUTED instead:
//
//   "c20260915"    leads that have a hook   - cloned from INSTANTLY_TEMPLATE_HOOK
//   "c20260915 B"  leads that do not        - cloned from INSTANTLY_TEMPLATE_NOHOOK
//
// Both names contain the cohort id, and normaliseCohortId() matches c\d{8}
// anywhere in a string, so the funnel analytics fold the pair back into one
// cohort row on their own. Do not rename them to something without the id.
//
// Cohort membership is whatever mint-batch already minted. That is the single
// definition of "who is in this week's batch" and it lives in one place on
// purpose - this file never decides who gets contacted, it only ships the
// list mint-batch produced.
//
// Idempotent throughout. A second run finds the campaigns it made last time
// by name, and skips any lead already sitting in the campaign. Re-running it
// after adding more leads tops the campaign up.
//
// Deliberately returns counts and reasons only, never an email address or a
// name. The GitHub Actions workflow that calls it writes its response into a
// run log, and this repository is public.
//
// 2026-09-15: this file used to answer ok:true no matter what happened. On
// 2026-09-15 the no-hook campaign was never created - its template had an
// empty first step - so importLeads returned {skipped: "..."} for that half,
// 131 of 249 leads never reached Instantly, and the workflow went green
// because its only test was grep '"ok":true'. The failure was found on send
// morning. Everything below that can come back short is now an assertion in
// checks[], ok is false when any of them fails, and the endpoint answers 409
// so curl --fail-with-body turns it into a red run. step=verify re-runs those
// same assertions read-only, which is what the preflight schedule calls.

import {
  findCampaignByName,
  getCampaign,
  createCampaign,
  createLead,
  listAccounts,
  listCampaignLeads,
  listCampaigns,
} from "../../lib/instantly.js";
import {
  ENROLMENT_PIPELINE_ID,
  ENROLMENT_STAGES,
  listDealsByPipelineStage,
} from "../../lib/pipedrive.js";
import { listLeadTokens, readLeads } from "../../lib/leads.js";
import { normaliseCohortId } from "../../lib/cohort.js";

export const config = { maxDuration: 60 };

const LANDING = process.env.LANDING_PAGE_URL || "https://growth.marinanicholas.com";
const TOUCH = "day2";

// Import in small waves. Instantly rate limits, and a cohort is a couple of
// hundred leads at most, so there is nothing to gain from hammering it.
const IMPORT_CHUNK = 5;

function authorised(req) {
  const expected = process.env.FUNNEL_CRON_KEY;
  if (!expected) return false;
  const supplied = String(req.query.key || "").trim();
  return supplied.length > 0 && supplied === expected;
}

// Cohort ids are Tuesdays: the id encodes the Email #1 send date, which is
// Day 5 of the cadence. With no cohort given, assume the next one due.
function nextTuesday(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const ahead = (2 - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + ahead);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return "c" + d.getUTCFullYear() + mm + dd;
}

// Day 1 is the Friday the profile views start. The cohort id is Day 5.
// See cadence-day-numbering-canonical.md - it is plus five, never plus one.
function cohortDay(cohort) {
  const m = /^c(\d{4})(\d{2})(\d{2})$/.exec(cohort || "");
  if (!m) return null;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - start) / 86400000) + 5;
}

function reportLinkFor(lid, cohort) {
  const url = new URL(LANDING);
  url.searchParams.set("utm_source", "instantly");
  url.searchParams.set("utm_medium", "email");
  url.searchParams.set("utm_campaign", cohort + "-" + TOUCH);
  url.searchParams.set("lid", lid);
  return url.toString();
}

// The template still carries last cohort's tag, or none at all on the very
// first one. Retag every link in the cloned sequence so this cohort's clicks
// land on this cohort's row. Anything already carrying the right tag, or a
// link with no utm_campaign at all, is left exactly as it is.
function retagSequences(sequences, cohort) {
  let changed = 0;
  const want = cohort + "-" + TOUCH;
  const walk = (node) => {
    if (node === null || node === undefined) return node;
    if (typeof node === "string") {
      const out = node.replace(/utm_campaign=([A-Za-z0-9_.-]+)/g, (whole, current) => {
        if (current === want) return whole;
        changed += 1;
        return "utm_campaign=" + want;
      });
      return out;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object") {
      const copy = {};
      for (const k of Object.keys(node)) copy[k] = walk(node[k]);
      return copy;
    }
    return node;
  };
  const retagged = walk(sequences);
  return { sequences: retagged, retaggedLinks: changed };
}

// Clone the shape Instantly needs and nothing else. Ids, counters and
// timestamps from the template must not travel, or Instantly either rejects
// the payload or silently attaches the new campaign to the old one's stats.
function clonePayload(template, name) {
  const payload = { name };
  const carry = [
    "campaign_schedule",
    "email_list",
    "daily_limit",
    "email_gap",
    "random_wait_max",
    "text_only",
    "stop_on_reply",
    "stop_on_auto_reply",
    "link_tracking",
    "open_tracking",
    "prioritize_new_leads",
    "match_lead_esp",
    "stop_for_company",
    "insert_unsubscribe_header",
    "allow_risky_contacts",
    "disable_bounce_protect",
  ];
  for (const k of carry) {
    if (template[k] !== undefined && template[k] !== null) payload[k] = template[k];
  }
  return payload;
}

async function ensureCampaign(name, templateId, cohort, live) {
  const existing = await findCampaignByName(name);
  if (existing) {
    return { name, id: existing.id, status: existing.status, reused: true, retaggedLinks: 0 };
  }
  if (!templateId) {
    return { name, id: null, reused: false, error: "no template campaign configured" };
  }

  const template = await getCampaign(templateId);
  const payload = clonePayload(template, name);
  const retag = retagSequences(template.sequences || [], cohort);
  payload.sequences = retag.sequences;

  if (!live) {
    return {
      name,
      id: null,
      reused: false,
      wouldCreate: true,
      fromTemplate: templateId,
      sequenceSteps: Array.isArray(payload.sequences) ? payload.sequences.length : 0,
      retaggedLinks: retag.retaggedLinks,
    };
  }

  const created = await createCampaign(payload);
  return {
    name,
    id: created.id || null,
    reused: false,
    created: true,
    fromTemplate: templateId,
    sequenceSteps: Array.isArray(payload.sequences) ? payload.sequences.length : 0,
    retaggedLinks: retag.retaggedLinks,
    status: created.status,
  };
}

// openDealIds is the set of deals still open in New Lead. A lead is only in
// this cohort because a deal existed when it was minted, and between minting
// on Thursday and sending on Tuesday Marina works through the list marking the
// ones she does not want. c20260915 carried 21 of those and three reached
// Instantly. The caller fetches the set once and hands it in; if Pipedrive
// cannot be read the caller aborts rather than let a run proceed unchecked.
//
// EXCLUDE is the other filter, and it mattered more than it looked. The hook
// screen rejects a lead when the company is defunct, is an M&A advisory or a
// brokerage, is pre-revenue, or the named contact has died or left. Those
// leads carry no hook - so before this they fell through into the no-hook half
// and would have been emailed. Exactly the people the screen exists to stop.
async function loadCohortLeads(cohort, { openDealIds } = {}) {
  const tokens = await listLeadTokens(cohort);
  const leads = await readLeads(tokens);
  const rows = [];
  const skipped = {};
  const bump = (r) => { skipped[r] = (skipped[r] || 0) + 1; };

  for (let i = 0; i < tokens.length; i += 1) {
    const lid = tokens[i];
    const lead = leads[i];
    if (!lead) { bump("token has no lead record"); continue; }
    const email = String(lead.email || "").trim().toLowerCase();
    if (!email.includes("@")) { bump("no usable email"); continue; }

    if (String(lead.hookVerdict || "").toUpperCase() === "EXCLUDE") {
      bump("screened out by the ICP check");
      continue;
    }

    const dealId = lead.dealId ? String(lead.dealId) : "";
    if (openDealIds && dealId && !openDealIds.has(dealId)) {
      bump("its deal is no longer open in New Lead");
      continue;
    }

    rows.push({
      lid,
      email,
      firstName: String(lead.firstName || "").trim(),
      company: String(lead.company || "").trim(),
      hook: String(lead.hook || "").trim(),
      dealId,
      reportLink: reportLinkFor(lid, cohort),
    });
  }
  return { rows, skipped, tokenCount: tokens.length };
}

async function importLeads(rows, campaignId, live) {
  let already = new Set();
  try {
    const existing = await listCampaignLeads(campaignId);
    already = new Set(existing.map((l) => String(l.email || "").toLowerCase()).filter(Boolean));
  } catch (err) {
    return {
      imported: 0,
      aborted: "could not read the campaign's existing leads, so refusing to import and risk duplicates",
      detail: String(err.message || err).slice(0, 160),
    };
  }

  const todo = rows.filter((r) => !already.has(r.email));
  const skippedAlready = rows.length - todo.length;

  if (!live) {
    return { wouldImport: todo.length, skippedAlreadyInCampaign: skippedAlready, imported: 0 };
  }

  let imported = 0;
  const failures = [];
  for (let i = 0; i < todo.length; i += IMPORT_CHUNK) {
    const wave = todo.slice(i, i + IMPORT_CHUNK);
    const results = await Promise.allSettled(
      wave.map((r) =>
        createLead({
          campaign: campaignId,
          email: r.email,
          first_name: r.firstName || undefined,
          company_name: r.company || undefined,
          custom_variables: {
            reportLink: r.reportLink,
            hook: r.hook || undefined,
          },
        })
      )
    );
    for (const res of results) {
      if (res.status === "fulfilled") imported += 1;
      else failures.push(String(res.reason && res.reason.message ? res.reason.message : res.reason).slice(0, 120));
    }
  }

  return {
    imported,
    skippedAlreadyInCampaign: skippedAlready,
    failed: failures.length,
    failureSample: failures.slice(0, 3),
  };
}

// ---------------------------------------------------------------------------
// Assertions.
//
// A check is a named claim about the world with a severity. "fail" means this
// run is wrong now. "warn" means it is not wrong yet but will be by Tuesday -
// on Friday the campaigns legitimately do not exist yet, and a gate that
// screamed about that every Friday would be ignored by the second week.
// strict=1 promotes every warn to a fail, which is what the Monday and
// Tuesday runs use, so the same assertions serve an early heads-up and a
// hard pre-send gate without being written twice.
// ---------------------------------------------------------------------------
export function checker(strict) {
  const checks = [];
  const add = (name, severity, ok, detail) => {
    checks.push({ name, severity, ok: Boolean(ok), detail: detail || "" });
    return Boolean(ok);
  };
  return {
    checks,
    fail: (name, ok, detail) => add(name, "fail", ok, detail),
    warn: (name, ok, detail) => add(name, "warn", ok, detail),
    failures: () => checks.filter((c) => !c.ok && (c.severity === "fail" || strict)),
  };
}

// Every way an import half can come back short. The count assertion is the
// important one: imported + already-there must equal what we set out to load,
// because an import that quietly does nothing looks identical to one that had
// nothing to do.
export function assertImported(c, half, result, expected) {
  if (expected === 0) return c.fail("import." + half, true, "nothing to load");
  if (!result) return c.fail("import." + half, false, "no import result");
  if (result.skipped) return c.fail("import." + half, false, result.skipped);
  if (result.aborted) return c.fail("import." + half, false, result.aborted);
  if (result.failed) {
    c.fail(
      "import." + half + ".rejected",
      false,
      result.failed + " lead(s) rejected: " + (result.failureSample || []).join(" | ")
    );
  }
  const landed = Number(result.imported || 0) + Number(result.skippedAlreadyInCampaign || 0);
  return c.fail(
    "import." + half + ".count",
    landed === expected,
    landed + " of " + expected + " accounted for"
  );
}

// Walk whatever shape Instantly hands back and collect every object carrying a
// subject or a body. Written as a walk rather than against a fixed path on
// purpose: the empty first step that broke the no-hook clone would have slid
// past any check that assumed it knew where the steps lived.
export function collectVariants(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) collectVariants(n, out);
    return out;
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(node, k);
  if (has("subject") || has("body")) {
    out.push({
      subject: String(node.subject || "").trim(),
      body: String(node.body || "").trim(),
    });
  }
  for (const k of Object.keys(node)) collectVariants(node[k], out);
  return out;
}

// The merge fields importLeads actually populates, plus the Instantly
// built-ins it fills from first_name and company_name. A template asking for
// anything outside this set renders a blank in every email it sends.
const SATISFIABLE_VARIABLES = new Set([
  "firstName",
  "companyName",
  "email",
  "reportLink",
  "hook",
]);

async function assertTemplate(c, label, templateId, { needsHook }) {
  const key = "template." + label;
  if (!templateId) {
    return c.fail(key, false, "INSTANTLY_TEMPLATE_" + label.toUpperCase() + " is not set");
  }
  let template;
  try {
    template = await getCampaign(templateId);
  } catch (err) {
    return c.fail(key, false, "could not be read: " + String(err.message || err).slice(0, 120));
  }

  const variants = collectVariants(template.sequences || []);
  if (!variants.length) {
    return c.fail(key, false, "carries no sequence steps at all");
  }

  const blank = variants.filter((v) => !v.body).length;
  c.fail(key + ".steps", blank === 0, blank + " of " + variants.length + " step(s) have an empty body");

  const used = new Set();
  for (const v of variants) {
    for (const m of (v.subject + " " + v.body).matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
      used.add(m[1]);
    }
  }
  const unknown = [...used].filter((v) => !SATISFIABLE_VARIABLES.has(v));
  c.fail(
    key + ".variables",
    unknown.length === 0,
    unknown.length ? "asks for " + unknown.join(", ") + ", which nothing populates" : "all satisfiable"
  );

  // The whole reason the cohort is split in two. A no-hook template that
  // still references the hook would send a blank line to everyone in it.
  c.fail(
    key + ".hookUse",
    needsHook ? used.has("hook") : !used.has("hook"),
    needsHook
      ? used.has("hook") ? "uses hook" : "does not use hook, so the researched personalisation is thrown away"
      : used.has("hook") ? "references hook but its leads have none" : "correctly does not use hook"
  );

  return template;
}

// One place decides whether a run passed, so no caller can forget to look.
//
// The status code matters as much as the body: the GitHub workflows call this
// with curl --fail-with-body, so a 409 is what turns a half-loaded cohort into
// a red run. Returning 200 with a problem buried in the body is exactly how
// 131 leads went missing without anyone noticing.
function respond(res, out, c) {
  const failures = c.failures();
  out.checks = c.checks;
  out.ok = failures.length === 0;
  out.failed = failures.map((f) => f.name + ": " + f.detail);
  out.passed = c.checks.filter((x) => x.ok).length;
  return res.status(out.ok ? 200 : 409).json(out);
}

// Reads the world back and asserts it matches what the build set out to do.
// Writes nothing, so it is safe to run on a schedule as often as is useful.
async function runVerify(c, { cohort, loaded, withHook, withoutHook, hookTemplate, noHookTemplate }) {
  const out = {};

  // 1. Is there a cohort at all yet?
  c.fail("cohort.minted", loaded.tokenCount > 0, loaded.tokenCount + " token(s) minted");
  c.fail(
    "cohort.usable",
    loaded.rows.length === loaded.tokenCount,
    loaded.rows.length + " of " + loaded.tokenCount + " tokens resolve to a usable lead"
  );

  // 2. Fields the emails actually merge. company is a warn rather than a fail
  //    because the whole of c20260915 shipped with it blank and a hard fail
  //    would block every run until that is fixed at source in mint-batch.
  const noFirstName = loaded.rows.filter((r) => !r.firstName).length;
  const noLink = loaded.rows.filter((r) => !r.reportLink).length;
  const noCompany = loaded.rows.filter((r) => !r.company).length;
  c.fail("leads.firstName", noFirstName === 0, noFirstName + " lead(s) have no first name");
  c.fail("leads.reportLink", noLink === 0, noLink + " lead(s) have no report link");
  c.warn("leads.company", noCompany === 0, noCompany + " of " + loaded.rows.length + " lead(s) have no company");

  // 3. Is everyone in the cohort still someone we are allowed to email?
  //    mint-batch used to read /deals without a status filter, and Pipedrive
  //    defaults that to all_not_deleted, so 21 deals Marina had personally
  //    disqualified were minted into c20260915. That is fixed at source; this
  //    catches anything disqualified after minting.
  // loadCohortLeads has already dropped anyone whose deal closed, so this
  // reports how many it dropped rather than re-checking the survivors.
  const dropped = Number(loaded.skipped["its deal is no longer open in New Lead"] || 0);
  const screened = Number(loaded.skipped["screened out by the ICP check"] || 0);
  c.warn("deals.closedDropped", dropped === 0, dropped + " lead(s) dropped: their deal is no longer open");
  c.warn("leads.screenedOut", screened === 0, screened + " lead(s) dropped: EXCLUDE on the ICP check");
  c.warn(
    "deals.linked",
    loaded.rows.every((r) => r.dealId),
    loaded.rows.filter((r) => r.dealId).length + " of " + loaded.rows.length + " lead(s) carry a deal id"
  );

  // 4. Are the two templates in a state worth cloning?
  const templates = {};
  templates.hook = await assertTemplate(c, "hook", hookTemplate, { needsHook: true });
  templates.noHook = await assertTemplate(c, "nohook", noHookTemplate, { needsHook: false });

  // 5. Did the campaigns get built, and did the right people land in them?
  const pairs = [
    { half: "hook", name: cohort, expected: withHook.length, wantsHook: true },
    { half: "noHook", name: cohort + " B", expected: withoutHook.length, wantsHook: false },
  ];
  out.campaigns = {};

  for (const pair of pairs) {
    const campaign = await findCampaignByName(pair.name);
    const key = "campaign." + pair.half;

    if (!campaign) {
      // Before Monday's build this is simply not done yet, which is why it is
      // a warn. From Monday on the preflight runs strict and it is a failure.
      c.warn(key + ".exists", pair.expected === 0, "no campaign named " + pair.name + " yet");
      out.campaigns[pair.half] = { name: pair.name, exists: false, expected: pair.expected };
      continue;
    }

    let leads = [];
    let readError = null;
    try {
      leads = await listCampaignLeads(campaign.id);
    } catch (err) {
      readError = String(err.message || err).slice(0, 120);
    }

    if (readError) {
      c.fail(key + ".leads", false, "could not read its leads: " + readError);
      out.campaigns[pair.half] = { name: pair.name, exists: true, expected: pair.expected };
      continue;
    }

    c.fail(
      key + ".leadCount",
      leads.length === pair.expected,
      leads.length + " in the campaign, " + pair.expected + " expected"
    );

    // Merge variables on the leads themselves. If Instantly's list response
    // carries no variables at all we say so rather than reporting a pass we
    // did not actually earn.
    const seen = leads.filter((l) => l.customVariables && typeof l.customVariables === "object");
    if (!seen.length && leads.length) {
      c.warn(key + ".variables", false, "Instantly returned no custom variables to check");
    } else {
      const missingLink = seen.filter((l) => !l.customVariables.reportLink).length;
      c.fail(key + ".reportLink", missingLink === 0, missingLink + " lead(s) carry no report link");
      if (pair.wantsHook) {
        const missingHook = seen.filter((l) => !l.customVariables.hook).length;
        c.fail(key + ".hook", missingHook === 0, missingHook + " lead(s) in the hook campaign carry no hook");
      }
    }

    // 6. Capacity. Instantly does not error when a cohort outgrows its
    //    mailboxes - it carries the remainder into the next sending day,
    //    which stretches a one-day send across the week and pulls every
    //    downstream touch off the cadence day numbering.
    try {
      // findCampaignByName comes from listCampaigns(), which projects to id,
      // name and status only - it carries no email_list. Reading it there gave
      // "0 sends/day across 0 warm mailboxes" on a campaign with nine attached,
      // which is a check that would have been ignored by its second week.
      const full = await getCampaign(campaign.id);
      const attached = new Set(
        ((full && full.email_list) || []).map((e) => String(e || "").trim().toLowerCase())
      );
      const accounts = await listAccounts();
      const sendable = accounts.filter((a) => attached.has(a.email) && a.active && a.dailyLimit > 0);
      const perDay = sendable.reduce((n, a) => n + a.dailyLimit, 0);
      out.campaigns[pair.half] = {
        name: pair.name,
        exists: true,
        expected: pair.expected,
        loaded: leads.length,
        mailboxes: sendable.length,
        mailboxesAttached: attached.size,
        dailyCapacity: perDay,
      };
      c.warn(
        key + ".capacity",
        perDay >= pair.expected,
        perDay + " sends/day across " + sendable.length + " warm mailbox(es) for " + pair.expected + " lead(s)"
      );
    } catch (err) {
      c.warn(key + ".capacity", false, "accounts could not be read: " + String(err.message || err).slice(0, 120));
      out.campaigns[pair.half] = { name: pair.name, exists: true, expected: pair.expected, loaded: leads.length };
    }
  }

  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });

  const cohort = normaliseCohortId(req.query.cohort) || nextTuesday(new Date());
  if (!/^c\d{8}$/.test(cohort)) {
    return res.status(400).json({ ok: false, error: "cohort must look like c20260915" });
  }

  const step = String(req.query.step || "inspect").trim().toLowerCase();
  const KNOWN_STEPS = ["inspect", "campaign", "import", "all", "verify"];
  if (!KNOWN_STEPS.includes(step)) {
    return res.status(400).json({ ok: false, error: "unknown step: " + step, knownSteps: KNOWN_STEPS });
  }
  const live = String(req.query.live || "") === "1";
  const strict = String(req.query.strict || "") === "1";
  const gate = checker(strict);

  const hookTemplate = process.env.INSTANTLY_TEMPLATE_HOOK || "";
  const noHookTemplate = process.env.INSTANTLY_TEMPLATE_NOHOOK || "";

  const out = {
    ok: true,
    cohort,
    cohortDay: cohortDay(cohort),
    step,
    live,
    strict,
    config: {
      hookTemplateSet: Boolean(hookTemplate),
      noHookTemplateSet: Boolean(noHookTemplate),
      landing: LANDING,
    },
  };

  try {
    // Fail closed. Not being able to tell whether a lead is still wanted is a
    // worse reason to send than any reason to skip.
    let openDealIds;
    try {
      const open = await listDealsByPipelineStage(ENROLMENT_PIPELINE_ID, ENROLMENT_STAGES.newLead);
      openDealIds = new Set(open.map((d) => String(d.id)));
      out.openDealsInStage = openDealIds.size;
    } catch (err) {
      return res.status(503).json({
        ok: false,
        cohort,
        step,
        error:
          "Pipedrive could not be read, so there is no way to tell which deals are still open. Refusing to build or import rather than risk contacting someone already disqualified.",
        detail: String(err.message || err).slice(0, 200),
      });
    }

    const loaded = await loadCohortLeads(cohort, { openDealIds });
    const withHook = loaded.rows.filter((r) => r.hook);
    const withoutHook = loaded.rows.filter((r) => !r.hook);

    out.leads = {
      tokensInCohort: loaded.tokenCount,
      usable: loaded.rows.length,
      withHook: withHook.length,
      withoutHook: withoutHook.length,
      skipped: loaded.skipped,
    };

    if (step === "inspect") {
      out.campaigns = {
        hook: await findCampaignByName(cohort),
        noHook: await findCampaignByName(cohort + " B"),
      };
      // Listing what already exists is how you pick the two template ids
      // for INSTANTLY_TEMPLATE_HOOK and INSTANTLY_TEMPLATE_NOHOOK without
      // going hunting in the Instantly UI. Names and ids only, no people.
      out.availableCampaigns = (await listCampaigns()).map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
      }));
      out.note =
        "Nothing was changed. Run with step=campaign to create the pair, then step=import, then add live=1 once the counts look right.";
      return res.status(200).json(out);
    }

    // A cohort with nothing in it means mint-batch has not run yet. Creating
    // an empty pair of campaigns every Monday would quietly fill Instantly
    // with clutter and make the real ones harder to find, so stop instead.
    if (loaded.rows.length === 0 && step !== "inspect" && step !== "verify") {
      out.note =
        "No leads are minted for this cohort yet, so nothing was created. Run mint-batch first, then run this again.";
      gate.fail("cohort.minted", false, "nothing is minted for " + cohort);
      return respond(res, out, gate);
    }

    if (step === "verify") {
      out.verified = await runVerify(gate, {
        cohort,
        loaded,
        withHook,
        withoutHook,
        hookTemplate,
        noHookTemplate,
      });
      out.note = strict
        ? "Read-only. Strict: anything not passing is a failure."
        : "Read-only. Warnings are things that are not wrong yet but must be true by Tuesday.";
      return respond(res, out, gate);
    }

    if (step === "campaign" || step === "all") {
      out.campaignsBuilt = {
        hook: await ensureCampaign(cohort, hookTemplate, cohort, live),
        noHook: await ensureCampaign(cohort + " B", noHookTemplate, cohort, live),
      };

      // "no template campaign configured" used to be a string in the response
      // that nothing read. If a half has leads waiting, not having somewhere
      // to put them is a failure of this run, not a note.
      for (const [half, expected] of [["hook", withHook.length], ["noHook", withoutHook.length]]) {
        const built = out.campaignsBuilt[half] || {};
        if (expected === 0) continue;
        gate.fail("campaign." + half + ".built", !built.error, built.error || "ready");
        if (live) {
          gate.fail("campaign." + half + ".id", Boolean(built.id), built.id ? "created or reused" : "no campaign id came back");
        }
      }
    }

    if (step === "import" || step === "all") {
      const hookCampaign = await findCampaignByName(cohort);
      const noHookCampaign = await findCampaignByName(cohort + " B");

      out.importRun = {
        hook: hookCampaign
          ? await importLeads(withHook, hookCampaign.id, live)
          : { skipped: "the hook campaign does not exist yet, run step=campaign with live=1 first" },
        noHook: noHookCampaign
          ? await importLeads(withoutHook, noHookCampaign.id, live)
          : { skipped: "the no-hook campaign does not exist yet, run step=campaign with live=1 first" },
      };

      // The assertion this file was missing on 2026-09-15.
      if (live) {
        assertImported(gate, "hook", out.importRun.hook, withHook.length);
        assertImported(gate, "noHook", out.importRun.noHook, withoutHook.length);
      }
    }

    if (!live) {
      out.note = "Dry run, nothing was written to Instantly. Add live=1 to apply.";
    } else {
      out.note = "Campaigns are created paused. Nothing sends until someone presses Launch in Instantly.";
    }

    return respond(res, out, gate);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      cohort,
      step,
      error: String(err.message || err).slice(0, 300),
    });
  }
}
