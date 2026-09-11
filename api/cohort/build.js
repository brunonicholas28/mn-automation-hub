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

import {
  findCampaignByName,
  getCampaign,
  createCampaign,
  createLead,
  listCampaignLeads,
} from "../../lib/instantly.js";
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

async function loadCohortLeads(cohort) {
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
    rows.push({
      lid,
      email,
      firstName: String(lead.firstName || "").trim(),
      company: String(lead.company || "").trim(),
      hook: String(lead.hook || "").trim(),
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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });

  const cohort = normaliseCohortId(req.query.cohort) || nextTuesday(new Date());
  if (!/^c\d{8}$/.test(cohort)) {
    return res.status(400).json({ ok: false, error: "cohort must look like c20260915" });
  }

  const step = String(req.query.step || "inspect").trim().toLowerCase();
  const KNOWN_STEPS = ["inspect", "campaign", "import", "all"];
  if (!KNOWN_STEPS.includes(step)) {
    return res.status(400).json({ ok: false, error: "unknown step: " + step, knownSteps: KNOWN_STEPS });
  }
  const live = String(req.query.live || "") === "1";

  const hookTemplate = process.env.INSTANTLY_TEMPLATE_HOOK || "";
  const noHookTemplate = process.env.INSTANTLY_TEMPLATE_NOHOOK || "";

  const out = {
    ok: true,
    cohort,
    cohortDay: cohortDay(cohort),
    step,
    live,
    config: {
      hookTemplateSet: Boolean(hookTemplate),
      noHookTemplateSet: Boolean(noHookTemplate),
      landing: LANDING,
    },
  };

  try {
    const loaded = await loadCohortLeads(cohort);
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
      out.note =
        "Nothing was changed. Run with step=campaign to create the pair, then step=import, then add live=1 once the counts look right.";
      return res.status(200).json(out);
    }

    // A cohort with nothing in it means mint-batch has not run yet. Creating
    // an empty pair of campaigns every Monday would quietly fill Instantly
    // with clutter and make the real ones harder to find, so stop instead.
    if (loaded.rows.length === 0 && step !== "inspect") {
      out.note =
        "No leads are minted for this cohort yet, so nothing was created. Run mint-batch first, then run this again.";
      return res.status(200).json(out);
    }

    if (step === "campaign" || step === "all") {
      out.campaignsBuilt = {
        hook: await ensureCampaign(cohort, hookTemplate, cohort, live),
        noHook: await ensureCampaign(cohort + " B", noHookTemplate, cohort, live),
      };
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
    }

    if (!live) {
      out.note = "Dry run, nothing was written to Instantly. Add live=1 to apply.";
    } else {
      out.note = "Campaigns are created paused. Nothing sends until someone presses Launch in Instantly.";
    }

    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      cohort,
      step,
      error: String(err.message || err).slice(0, 300),
    });
  }
}
