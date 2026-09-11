// The weekly LinkedIn connection-request shortlist, for the people we have
// actually emailed.
//
// Why this is a new endpoint rather than a patch to api/cron/linkedin-score.js:
// that job can never produce a list for this batch. It gates on a Pipedrive
// "Cohort Start Date" that only apollo-sync writes, and only onto deals
// apollo-sync itself created - so the 267-lead c20260908 batch, which predates
// apollo-sync, fails the gate on every single run. See
// linkedin-scoring-status-audit-2026-09-10.md.
//
// The second problem was the score. It was specified around email opens, and
// open tracking is deliberately OFF on the campaign for deliverability, so
// that term is permanently zero. Link tracking is off too. And c20260908 has
// no per-lead landing tokens - it went out before lids existed - so the only
// engagement signal that survives for these 267 is a reply, of which there is
// exactly one.
//
// So this ranks on FIT, from the Apollo enrichment we already pay for, and
// layers engagement on top wherever it exists. Fit is a weaker signal than
// engagement and this file does not pretend otherwise. It beats sending 80
// requests in whatever order Pipedrive happened to return them.
//
// The ICP screen follows Marina's 2026-09-06 correction in
// icp-master-unified-profile.md: a prospect's own customer base is NOT a
// disqualifier. Only three things are - a dead or stale record, a business
// that IS investment banking or M&A advisory, and a pre-revenue startup with
// no real team. Everything else that was being auto-failed is a valid fit.
//
// GET  ?key=...              ranked JSON, top 'cap'
//      &cap=80               how many make the cut (default 80)
//      &mode=inspect         coverage counts only, no personal data
//      &mode=followups       Day 7 voice-note scripts for requests sent 3-14 days ago
//      &refresh=1            rebuild rather than serve the 10-minute cache
//      &live=1               also write Lane2 Score + LinkedIn Batch to Pipedrive
//
// Key-guarded and fails closed, because it returns names, emails and LinkedIn
// URLs. Same rule as /api/leads/import.

import { Redis } from "@upstash/redis";
import { listCampaigns, listCampaignLeads, listBlocklist, isBlocked } from "../../lib/instantly.js";
import { listCohortIds, normaliseCohortId } from "../../lib/cohort.js";
import { listLeadTokens, readLeads } from "../../lib/leads.js";
import { updateDeal } from "../../lib/pipedrive.js";

export const config = { maxDuration: 60 };

const kv = Redis.fromEnv();

const PD_BASE = process.env.PIPEDRIVE_BASE_URL || "https://api.pipedrive.com/v1";
const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PERSON_LINKEDIN_KEY =
  process.env.PIPEDRIVE_LINKEDIN_URL_FIELD_KEY || "fc2a686381501e4476e241197f5fde72d9e10d64";
const PIPELINE_ID = Number(process.env.PIPEDRIVE_PIPELINE_ID || 4);
const PD_DOMAIN = process.env.PIPEDRIVE_COMPANY_DOMAIN;
const APOLLO_KEY = process.env.APOLLO_API_KEY;
const APOLLO_STAGE_ID = process.env.APOLLO_STAGE_ID || "6a8ab4ad5a018d0020c4bd18";
const SOURCE_CAMPAIGN = process.env.INSTANTLY_CAMPAIGN_ID;

// ---- Day 4 connection-request notes ----
// The research is already done and already paid for. For each of these people
// the outreach agent found a specific, dated, sourced, genuinely notable fact
// and wrote it into the Email #1 draft pinned on that deal - all 267 of which
// were normalised and reviewed on 2026-09-08. This reads that same fact back
// out and restyles it for LinkedIn. No second research pass, no new facts, and
// nothing that has not already been through the review the drafts had.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
// Cached per person and keyed on the fact it was written from, so rebuilding
// the roster costs nothing and re-researching a company regenerates its note.
const NOTE_CACHE_PREFIX = "linkedin:note:v1:";
// LinkedIn's own cap. The whole note has to fit, greeting included.
const NOTE_LIMIT = 300;
// Generation shares the same 60s function as the roster build, so it gets a
// budget rather than a promise. Anything not reached goes out blank and is
// written on the next load, because the cache survives.
const NOTE_BUDGET_MS = 22000;
const NOTE_BATCH = 8;
const NOTE_CONCURRENCY = 3;

// How many of this week's requests carry a note at all. FIVE, because a free
// LinkedIn account can only send about five personalised invitations a month
// (unlimited blank ones, up to the weekly cap). Premium and Sales Navigator
// remove that cap, so on an upgrade this is the only number that changes.
//
// It is also the right number on the evidence, not just the permitted one.
// Across the public datasets the variable that matters is note QUALITY, not
// note presence: Belkins (20M+ requests) found acceptance essentially
// identical with or without a note, 26.42% against 26.37%, and Waalaxy (~10M)
// found full notes actively worse, 26% against 38% blank. Every dataset agrees
// on one thing though, which is that a GENERIC note is the worst of the three
// options, below both a blank request and a specific one. So there is no
// filler note in this file any more. A person either has a real researched
// fact and holds one of the scarce slots, or the request goes out blank.
//
// The note is not where the researched fact pays best either. Expandi's 13.2M
// sample puts connection-note reply rates at 3.0% and falling, against 10.4%
// and stable for a message sent after connecting, which is why the same fact
// also drives the Day 7 follow-up in mode=followups below.
const NOTE_SLOTS = Number(process.env.LINKEDIN_NOTE_SLOTS || 5);

// Day 7 follow-ups: who is due one, counted from the day their request was
// marked sent. Opens at 3 days so there has been time to accept, closes at 14
// so a stale list does not pile up.
const FOLLOWUP_MIN_DAYS = 3;
const FOLLOWUP_MAX_DAYS = 14;
const FOLLOWUP_CACHE_PREFIX = "linkedin:followup:v1:";

// Apollo returns the company on a separate top-level array, not nested on the
// contact, so the join has to happen here. Held at module scope because orgOf
// is called from three places and threading the map through all of them buys
// nothing.
let APOLLO_ORGS = new Map();
let APOLLO_SHAPE = { contact: [], org: [] };

const CACHE_KEY = "linkedin:shortlist:roster";
const CACHE_TTL_SECONDS = 600;
// Which people have already had their request sent. Kept here rather than in
// Pipedrive so ticking one off is instant and needs no CRM write.
const REQUESTED_KEY = "linkedin:requested";

function authorised(req) {
  const expected = process.env.FUNNEL_CRON_KEY;
  if (!expected) return false; // Fail closed: this endpoint returns email addresses.
  const given = req.query.key || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return given === expected;
}

const lower = (v) => String(v || "").trim().toLowerCase();
const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

// R1/R2/R3 run at T+0, T+4 and T+8. A connection request landing inside that
// window would put up to seven touches in ten days from one brand, which is
// the line the escalation model calls pursuit. Wait until the breakup has
// landed before the LinkedIn rail is allowed to start.
const RECOVERY_QUIET_DAYS = 10;

// One Instantly campaign per cohort, so the campaign list IS the cohort list.
// A campaign only qualifies if its name normalises to a cYYYYMMDD id - that
// picks up the 2026-09-08 batch through its legacy alias and leaves out the
// recovery campaign, whose leads are mid-sequence and handled separately.
async function listCohortCampaigns() {
  const out = [];
  for (const c of await listCampaigns()) {
    const cohort = normaliseCohortId(c.name);
    if (cohort && /^c\d{8}$/.test(cohort)) out.push({ id: c.id, name: c.name, cohort });
  }
  return out;
}

// A cohort id encodes its own send date, so working out which batch is in its
// connection-request window needs no extra state. Send day is day 1.
function cohortDay(cohort) {
  const m = /^c(\d{4})(\d{2})(\d{2})$/.exec(cohort || "");
  if (!m) return null;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - start) / 86400000) + 1;
}

// Fresh cohort wins the slot. Someone who clicked once, never opened the form
// and then ignored all three recovery emails has declined four times against
// one positive signal - and that signal is unproven: 22 landing visits on
// c20260908 produced zero form starts. So they only backfill slots the active
// cohort cannot fill. Repliers and repeat clickers are exempt, because coming
// BACK to the page after the nudge is a second, independent signal rather than
// the same click counted twice.
function tierOf(row, activeCohort) {
  if (row.replied || row.repeatClicker) return 1;
  if (activeCohort && row.cohort === activeCohort) return 1;
  return 2;
}

async function pd(path) {
  if (!PD_TOKEN) throw new Error("PIPEDRIVE_API_TOKEN is not set");
  const res = await fetch(PD_BASE + path, {
    headers: { "x-api-token": PD_TOKEN, "Content-Type": "application/json" },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error("Pipedrive GET " + path + " failed: " + res.status);
  }
  return json.data || [];
}

// One paged list beats 267 individual /persons/:id calls, which would time the
// function out long before they finished.
async function listAllPersons() {
  const out = [];
  let start = 0;
  for (let page = 0; page < 20; page++) {
    const items = await pd("/persons?start=" + start + "&limit=500");
    if (!items || items.length === 0) break;
    out.push(...items);
    if (items.length < 500) break;
    start += 500;
  }
  return out;
}

async function listPipelineDeals() {
  const out = [];
  let start = 0;
  for (let page = 0; page < 20; page++) {
    const items = await pd("/deals?status=all&start=" + start + "&limit=500");
    if (!items || items.length === 0) break;
    for (const d of items) if (Number(d.pipeline_id) === PIPELINE_ID) out.push(d);
    if (items.length < 500) break;
    start += 500;
  }
  return out;
}

// One paged list, same reasoning as listAllPersons: 80 separate
// /notes?deal_id= calls would spend most of the function's budget on round
// trips before the first note was even written.
async function listAllNotes() {
  const out = [];
  let start = 0;
  for (let page = 0; page < 20; page++) {
    const items = await pd("/notes?start=" + start + "&limit=500");
    if (!items || items.length === 0) break;
    out.push(...items);
    if (items.length < 500) break;
    start += 500;
  }
  return out;
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    // Decoded before the trigger regex runs, because the pre-2026-09-04
    // generation of drafts separates the fact from "congratulations" with an
    // em dash and it arrives from Pipedrive as an entity.
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Every normalised draft opens "Saw {fact}, congratulations!" when the agent
// found something worth opening on, and skips that paragraph entirely when it
// did not - the documented no-clean-trigger fallback. So the presence of this
// line is itself the signal that a real, sourced, notable fact exists for this
// person: the fact-quality bar was applied when the draft was written, and
// this does not second-guess it. The older em-dash generation is matched too,
// in case a draft predates the 2026-09-08 normalisation.
function triggerFromDraft(content) {
  const text = stripHtml(content);
  const m =
    /\bSaw\s+([^\n]{8,220}?)\s*(?:,|–|—|-)\s*congratulations/i.exec(text) ||
    /\bSaw\s+([^\n.!?]{8,220})[.!?]/i.exec(text);
  if (!m) return null;
  const fact = m[1].replace(/\s+/g, " ").replace(/[\s,–—-]+$/, "").trim();
  if (fact.length < 8) return null;
  // The looser second pattern can over-reach on an oddly punctuated draft.
  if (/congratulation/i.test(fact)) return null;
  // The retired personalisation-theatre openers are not facts, and neither is
  // an unfilled template variable.
  if (/\{\{|\[INSERT|following your work|been following/i.test(fact)) return null;
  return fact;
}

// The enrichment lives in Apollo, not Pipedrive - apollo-sync only ever copied
// Lead Source, Cohort and Cohort Start Date across. So the fit signals have to
// be read back out of Apollo and joined on email.
async function listApolloContacts() {
  if (!APOLLO_KEY) return [];
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch("https://api.apollo.io/api/v1/contacts/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
      body: JSON.stringify({
        contact_stage_ids: [APOLLO_STAGE_ID],
        sort_by_field: "contact_updated_at",
        sort_ascending: false,
        page,
        per_page: 100,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("Apollo search failed: " + res.status);
    // The company record lives in accounts/organizations alongside the
    // contacts, keyed by account_id. Without this join, estimated_num_employees
    // and annual_revenue are simply absent and every fit score collapses to
    // "team size unknown, revenue unknown".
    for (const a of json.accounts || []) {
      if (a && a.id) APOLLO_ORGS.set(String(a.id), a);
      if (a && a.organization_id) APOLLO_ORGS.set(String(a.organization_id), a);
    }
    for (const o of json.organizations || []) {
      if (o && o.id) APOLLO_ORGS.set(String(o.id), o);
    }
    const contacts = json.contacts || [];
    if (!APOLLO_SHAPE.contact.length && contacts[0]) {
      APOLLO_SHAPE.contact = Object.keys(contacts[0]).slice(0, 60);
    }
    const anyOrg = (json.accounts || [])[0] || (json.organizations || [])[0];
    if (!APOLLO_SHAPE.org.length && anyOrg) {
      APOLLO_SHAPE.org = Object.keys(anyOrg).slice(0, 60);
    }
    out.push(...contacts);
    const totalPages = (json.pagination && json.pagination.total_pages) || 1;
    if (page >= totalPages || contacts.length === 0) break;
  }
  return out;
}

// Apollo's contact search returns account_id but not the account itself, so
// team size and revenue have to be fetched separately and joined. Without this
// every fit score collapses to "team size unknown, revenue unknown", which is
// how the first live run came back.
async function listApolloAccounts() {
  if (!APOLLO_KEY) return 0;
  let seen = 0;
  for (let page = 1; page <= 10; page++) {
    const res = await fetch("https://api.apollo.io/api/v1/accounts/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
      body: JSON.stringify({ page, per_page: 100 }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("Apollo accounts search failed: " + res.status);
    const accounts = json.accounts || [];
    if (!APOLLO_SHAPE.org.length && accounts[0]) {
      APOLLO_SHAPE.org = Object.keys(accounts[0]).slice(0, 60);
    }
    for (const a of accounts) {
      if (a && a.id) APOLLO_ORGS.set(String(a.id), a);
      if (a && a.organization_id) APOLLO_ORGS.set(String(a.organization_id), a);
      seen++;
    }
    const totalPages = (json.pagination && json.pagination.total_pages) || 1;
    if (page >= totalPages || accounts.length === 0) break;
  }
  return seen;
}

// Apollo puts the company under 'account' for a saved contact and
// 'organization' for a raw person, and not every record carries both.
function orgOf(c) {
  if (!c) return {};
  if (c.organization && typeof c.organization === "object") return c.organization;
  if (c.account && typeof c.account === "object") return c.account;
  const id = c.account_id || c.organization_id;
  if (id && APOLLO_ORGS.has(String(id))) return APOLLO_ORGS.get(String(id));
  return {};
}
function employeesOf(c) {
  const o = orgOf(c);
  const n = Number(
    o.estimated_num_employees || o.employee_count || o.num_employees ||
    (c && c.organization_num_employees) || 0
  );
  return Number.isFinite(n) && n > 0 ? n : null;
}
// Apollo's saved-account payload carries neither headcount nor revenue - both
// came back empty on the first two live runs, and the account shape confirms
// the fields simply are not there. Getting them would mean an enrichment call
// per company, which spends Apollo credits, so the fit score uses what the
// account record actually has instead.
function foundedYearOf(c) {
  const o = orgOf(c);
  const n = Number(o.founded_year || 0);
  return n > 1800 && n <= new Date().getFullYear() ? n : null;
}
function publiclyTradedOf(c) {
  const o = orgOf(c);
  return Boolean(o.publicly_traded_symbol || o.publicly_traded_exchange);
}
function revenueOf(c) {
  const o = orgOf(c);
  const n = Number(
    o.annual_revenue || o.organization_revenue || o.estimated_annual_revenue ||
    (c && c.organization_annual_revenue) || 0
  );
  return Number.isFinite(n) && n > 0 ? n : null;
}

const OWNER_TITLE =
  /\b(founder|co-?founder|owner|proprietor|ceo|chief executive|managing director|managing partner|president)\b/i;
const LEADER_TITLE =
  /\b(coo|cfo|cto|cmo|chief|director|partner|vp|vice president|head of|general manager)\b/i;
const MANAGER_TITLE = /\bmanager\b/i;

// Marina's 2026-09-06 correction: the prospect's own customer base is not a
// disqualifier. Only the business-model exclusion survives - a company that IS
// an investment bank or M&A advisory, not one that merely sells to one. Kept
// deliberately narrow so it cannot quietly grow back into the over-broad screen
// that wrongly failed 160 records.
const IB_ADVISORY =
  /\b(investment bank|m&a advisory|mergers and acquisitions advisor|corporate finance advisory)\b/i;

function scoreOf(row) {
  const reasons = [];
  let score = 0;

  if (row.replied) {
    score += 1000;
    reasons.push("replied to the email");
  }
  if (row.visitedAt) {
    score += 200;
    reasons.push("clicked through to the landing page");
  }

  const title = row.title || "";
  if (OWNER_TITLE.test(title)) {
    score += 30;
    reasons.push("owner-level decision maker");
  } else if (LEADER_TITLE.test(title)) {
    score += 18;
    reasons.push("senior leader");
  } else if (MANAGER_TITLE.test(title)) {
    score += 5;
    reasons.push("manager level");
  }

  // Age stands in for "established, not too early". It is a proxy, not a
  // revenue check, but pre-revenue startups are one of the three things the
  // ICP genuinely disqualifies and a company trading for a decade is not one.
  const age = row.foundedYear ? new Date().getFullYear() - row.foundedYear : null;
  if (age === null) {
    reasons.push("age unknown");
  } else if (age >= 10) {
    score += 20;
    reasons.push("trading " + age + " years");
  } else if (age >= 5) {
    score += 12;
    reasons.push("trading " + age + " years");
  } else {
    reasons.push("only " + age + " years old");
  }

  if (row.employees !== null) {
    score += 25;
    reasons.push(row.employees + " people");
  }

  return { score, reasons };
}

// Anti-ICP, per Section 15 and the 2026-09-06 correction. Only three things
// disqualify, and "we do not know" is never one of them.
function excludeReason(row) {
  if (!row.linkedinUrl) return "no LinkedIn URL on the record";
  if (row.bounced) return "email bounced, stale record";
  if (row.blocked) return "on the Instantly blocklist";
  if (row.employees !== null && row.employees < 5) return "under 5 people, anti-ICP";
  if (row.startedAt) return "already opened the report form";
  if (row.nudgedAt && !row.repeatClicker && daysSince(row.nudgedAt) < RECOVERY_QUIET_DAYS) {
    return "recovery sequence still running";
  }
  // Section 17: once a business needs board approval and a procurement layer to
  // buy anything, it has left this ICP entirely.
  if (row.publiclyTraded) return "publicly listed, outside the ICP";
  if (IB_ADVISORY.test(row.company || "") || IB_ADVISORY.test(row.title || "")) {
    return "investment banking or M&A advisory";
  }
  return null;
}

async function buildRoster() {
  if (!SOURCE_CAMPAIGN) throw new Error("INSTANTLY_CAMPAIGN_ID is not set");
  APOLLO_ORGS = new Map();
  APOLLO_SHAPE = { contact: [], org: [] };

  // Campaign membership is the definition of "people we emailed". Using the
  // Pipedrive stage instead would sweep in deals that were never sent to.
  const cohortCampaigns = await listCohortCampaigns();
  if (!cohortCampaigns.length) cohortCampaigns.push({ id: SOURCE_CAMPAIGN, cohort: null });

  const [blocklist, persons, deals, apollo, notes] = await Promise.all([
    listBlocklist(),
    listAllPersons(),
    listPipelineDeals(),
    listApolloContacts().catch(() => []),
    // A missing note is a missing personal opener, not a missing person. The
    // list still has to build if Pipedrive's notes endpoint is unhappy.
    listAllNotes().catch(() => []),
  ]);

  // Every cohort is loaded, not just the active one, because the backfill tier
  // is drawn from the older ones.
  const campaignLeads = [];
  for (const c of cohortCampaigns) {
    for (const lead of await listCampaignLeads(c.id)) {
      campaignLeads.push(Object.assign({}, lead, { cohort: c.cohort }));
    }
  }

  // Exactly one cohort sits in its day 7-9 connection-request window in any
  // given week. On every other day - which is most of them - fall back to the
  // newest cohort so the page is never empty.
  const cohortIds = [...new Set(cohortCampaigns.map((c) => c.cohort).filter(Boolean))]
    .sort()
    .reverse();
  const activeCohort =
    cohortIds.find((c) => {
      const d = cohortDay(c);
      return d !== null && d >= 7 && d <= 9;
    }) || cohortIds[0] || null;

  // Sequential and after the contacts, because it fills the same map and a
  // failure here should degrade the score, not fail the whole list.
  await listApolloAccounts().catch(() => 0);

  if (!blocklist.ok) {
    throw new Error(
      "Instantly blocklist could not be read - refusing to build a contact list that might include someone who opted out"
    );
  }

  const personByEmail = new Map();
  for (const p of persons) {
    const emails = Array.isArray(p.email) ? p.email : [];
    for (const e of emails) {
      const addr = lower(e.value);
      if (addr && !personByEmail.has(addr)) personByEmail.set(addr, p);
    }
  }

  const dealByPersonId = new Map();
  for (const d of deals) {
    const pid = typeof d.person_id === "object" ? d.person_id && d.person_id.value : d.person_id;
    if (pid && !dealByPersonId.has(pid)) dealByPersonId.set(pid, d);
  }

  // The researched fact, read back out of the draft that was already reviewed.
  // A person without one is not a failure: it means the agent found nothing
  // genuinely notable for that company and the draft correctly fell back to
  // the generic opener. Newest matching draft wins, since a deal can carry
  // several generations of note.
  const triggerByDealId = new Map();
  for (const n of notes) {
    const did = typeof n.deal_id === "object" ? n.deal_id && n.deal_id.value : n.deal_id;
    if (!did) continue;
    const fact = triggerFromDraft(n.content);
    if (!fact) continue;
    const at = String(n.update_time || n.add_time || "");
    const prev = triggerByDealId.get(did);
    if (!prev || at > prev.at) triggerByDealId.set(did, { fact, at });
  }

  const apolloByEmail = new Map();
  for (const c of apollo) {
    const addr = lower(c.email);
    if (addr && !apolloByEmail.has(addr)) apolloByEmail.set(addr, c);
  }

  // Per-lead landing clicks, where tokens exist. c20260908 has none - that
  // batch predates lids - so this stays empty for the current 267 and starts
  // contributing from c20260915 on.
  const leadState = new Map();
  try {
    for (const cohort of await listCohortIds()) {
      const tokens = await listLeadTokens(cohort);
      if (!tokens.length) continue;
      for (const lead of await readLeads(tokens)) {
        if (lead.email) leadState.set(lower(lead.email), lead);
      }
    }
  } catch (err) {
    // A bonus signal, not a dependency. A KV hiccup must not stop the list.
  }

  const rows = [];
  for (const lead of campaignLeads) {
    const email = lower(lead.email);
    if (!email) continue;
    const person = personByEmail.get(email) || null;
    const deal = person ? dealByPersonId.get(person.id) : null;
    const contact = apolloByEmail.get(email) || null;
    const state = leadState.get(email) || {};
    const org = orgOf(contact);

    const linkedinUrl =
      (person && person[PERSON_LINKEDIN_KEY]) || (contact && contact.linkedin_url) || null;

    const row = {
      email,
      name: (person && person.name) || (contact && contact.name) || email,
      title: (contact && contact.title) || null,
      company:
        (contact && contact.organization_name) ||
        org.name ||
        ((deal && deal.title) || "").replace(/^Cold Outreach - /, "") ||
        null,
      linkedinUrl: linkedinUrl ? String(linkedinUrl).trim() : null,
      employees: employeesOf(contact),
      revenue: revenueOf(contact),
      foundedYear: foundedYearOf(contact),
      publiclyTraded: publiclyTradedOf(contact),
      replied: lead.replyCount > 0,
      bounced: lead.bounceCount > 0,
      blocked: isBlocked(email, blocklist.entries),
      cohort: lead.cohort || null,
      visitedAt: state.visitedAt || null,
      startedAt: state.startedAt || null,
      nudgedAt: state.nudgedAt || null,
      repeatClicker: Number(state.visitCount || 0) > 1 && !state.startedAt,
      trigger: (deal && (triggerByDealId.get(deal.id) || {}).fact) || null,
      personId: (person && person.id) || null,
      dealId: (deal && deal.id) || null,
      dealUrl: deal && PD_DOMAIN ? "https://" + PD_DOMAIN + ".pipedrive.com/deal/" + deal.id : null,
      personKey: String((deal && deal.id) || (person && person.id) || email),
    };

    row.excluded = excludeReason(row);
    row.tier = tierOf(row, activeCohort);
    const scored = scoreOf(row);
    row.score = scored.score;
    row.reasons = scored.reasons;
    rows.push(row);
  }

  // Deterministic all the way down, so two runs give the same order and
  // "number 41" means the same person tomorrow as it does today.
  // Score alone leaves a very wide tie block - every owner-level contact at an
  // established company lands on the same number - and sorting that block by
  // name means the cut at 80 is really a cut at "surnames up to about L".
  // Longest-trading first is at least a reason. Name stays last so the order is
  // still deterministic and rank 41 means the same person tomorrow.
  rows.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.score - a.score ||
      (a.foundedYear || 9999) - (b.foundedYear || 9999) ||
      a.name.localeCompare(b.name)
  );

  return {
    builtAt: new Date().toISOString(),
    activeCohort,
    cohortDay: cohortDay(activeCohort),
    cohorts: cohortIds,
    totals: {
      emailed: rows.length,
      withLinkedIn: rows.filter((r) => r.linkedinUrl).length,
      withApolloTitle: rows.filter((r) => r.title).length,
      withEmployees: rows.filter((r) => r.employees !== null).length,
      withRevenue: rows.filter((r) => r.revenue !== null).length,
      withFoundedYear: rows.filter((r) => r.foundedYear !== null).length,
      publiclyTraded: rows.filter((r) => r.publiclyTraded).length,
      inActiveCohort: rows.filter((r) => !r.excluded && r.tier === 1).length,
      backfillPool: rows.filter((r) => !r.excluded && r.tier === 2).length,
      repeatClickers: rows.filter((r) => r.repeatClicker).length,
      withDeal: rows.filter((r) => r.dealId).length,
      withTrigger: rows.filter((r) => r.trigger).length,
      replied: rows.filter((r) => r.replied).length,
      clicked: rows.filter((r) => r.visitedAt).length,
      excluded: rows.filter((r) => r.excluded).length,
      blocklistSize: blocklist.entries.length,
      apolloContactsSeen: apollo.length,
      apolloOrgsSeen: APOLLO_ORGS.size,
    },
    // Field names only, never values - this is how we can tell from a public
    // run log whether Apollo changed its payload shape under us.
    apolloShape: APOLLO_SHAPE,
    rows,
  };
}

async function getRoster(refresh) {
  if (!refresh) {
    const cached = await kv.get(CACHE_KEY);
    if (cached) return typeof cached === "string" ? JSON.parse(cached) : cached;
  }
  const roster = await buildRoster();
  await kv.set(CACHE_KEY, JSON.stringify(roster), { ex: CACHE_TTL_SECONDS });
  return roster;
}

// ------------------------------------------------------------------ render

function esc(s) {
  return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Inline CSS and no external requests, because this page is opened with a key
// in the URL and has no business talking to anything else.
const PAGE_CSS = [
  ":root{--bg:#F7F9FB;--panel:#fff;--ink:#16324F;--muted:#5B7186;--line:#E2E8EE;",
  "--accent:#16324F;--teal:#2F7D93;--done:#EAF3EE;--doneline:#BEDCC9;--on-accent:#fff}",
  "@media(prefers-color-scheme:dark){:root{--bg:#0F1720;--panel:#16202B;--ink:#E8EFF5;",
  "--muted:#9DB0C0;--line:#26333F;--accent:#5DC9D6;--teal:#5DC9D6;--done:#16281F;",
  "--doneline:#2C5540;--on-accent:#0F1720}}",
  "*{box-sizing:border-box}",
  "body{margin:0;background:var(--bg);color:var(--ink);",
  "font:15px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif}",
  "header{position:sticky;top:0;z-index:5;background:var(--panel);",
  "border-bottom:1px solid var(--line);padding:14px 0}",
  ".wrap{max-width:940px;margin:0 auto;padding:0 16px}",
  "h1{margin:0;font-size:17px;font-weight:700;letter-spacing:-.01em}",
  ".sub{margin:3px 0 0;font-size:13px;color:var(--muted)}",
  ".bar{height:6px;border-radius:99px;background:var(--line);margin-top:10px;overflow:hidden}",
  ".bar span{display:block;height:100%;background:var(--teal);transition:width .2s ease}",
  "ul{list-style:none;margin:18px auto;padding:0 16px;max-width:940px}",
  ".row{display:grid;grid-template-columns:38px 1fr auto auto;gap:14px;align-items:center;",
  "background:var(--panel);border:1px solid var(--line);border-radius:12px;",
  "padding:12px 14px;margin-bottom:8px}",
  ".row.done{background:var(--done);border-color:var(--doneline);opacity:.7}",
  ".rank{font-weight:700;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}",
  ".nm{font-weight:650}",
  ".meta{font-size:13px;color:var(--muted);margin-top:1px}",
  ".chips{margin-top:6px;display:flex;flex-wrap:wrap;gap:5px}",
  ".chip{font-size:11px;color:var(--muted);border:1px solid var(--line);",
  "border-radius:99px;padding:2px 8px;white-space:nowrap}",
  ".score{font-variant-numeric:tabular-nums;font-weight:700;color:var(--teal);",
  "min-width:44px;text-align:right}",
  ".actions{display:flex;gap:8px}",
  ".btn{appearance:none;font:inherit;font-size:13px;font-weight:600;cursor:pointer;",
  "border-radius:8px;padding:8px 13px;text-decoration:none;white-space:nowrap;",
  "border:1px solid var(--line);background:transparent;color:var(--ink)}",
  ".btn.open{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}",
  ".btn:hover{filter:brightness(.95)}",
  ".note{grid-column:1/-1;margin-top:11px;padding-top:11px;border-top:1px solid var(--line)}",
  ".note.blank{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}",
  ".blanklabel{font-size:12px;font-weight:650;color:var(--muted)}",
  ".blanklabel.slot{display:block;margin-bottom:6px;color:var(--teal)}",
  ".notetext{display:block;width:100%;resize:vertical;font:inherit;font-size:13.5px;",
  "line-height:1.5;color:var(--ink);background:var(--bg);border:1px solid var(--line);",
  "border-radius:8px;padding:9px 10px}",
  ".notetext:focus{outline:2px solid var(--teal);outline-offset:-1px}",
  ".noterow{display:flex;align-items:center;gap:10px;margin-top:6px;flex-wrap:wrap}",
  ".cnt{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}",
  ".cnt.over{color:#C0392B;font-weight:700}",
  ".warn{font-size:12px;color:var(--muted)}",
  ".noterow .copy{margin-left:auto}",
  ".btn.copied{background:var(--teal);border-color:var(--teal);color:var(--on-accent)}",
  "footer{max-width:940px;margin:0 auto 60px;padding:0 16px;font-size:13px;color:var(--muted)}",
  "footer p{margin:8px 0}",
  "@media(max-width:700px){.row{grid-template-columns:30px 1fr;",
  "grid-template-areas:'r w' '. s' '. a' 'n n'}.rank{grid-area:r}.who{grid-area:w}",
  ".score{grid-area:s;text-align:left}.actions{grid-area:a;margin-top:6px}",
  ".note{grid-area:n}}",
].join("");

const PAGE_JS = [
  "var KEY=document.body.dataset.key,TOTAL=+document.body.dataset.total;",
  "document.getElementById('list').addEventListener('click',function(ev){",
  "var b=ev.target.closest('button.mark');if(!b)return;",
  "var row=b.closest('.row'),done=!row.classList.contains('done');",
  "row.classList.toggle('done',done);b.textContent=done?'Sent':'Mark sent';",
  "var n=document.querySelectorAll('.row.done').length;",
  "document.getElementById('count').textContent=n;",
  "document.getElementById('prog').style.width=(TOTAL?n/TOTAL*100:0)+'%';",
  "fetch(location.pathname+'?key='+encodeURIComponent(KEY),{method:'POST',",
  "headers:{'Content-Type':'application/json'},",
  "body:JSON.stringify({personKey:row.dataset.k,done:done})}).catch(function(){});",
  "});",
  // The note is editable, so the counter has to follow what is actually there,
  // not what was rendered.
  "document.getElementById('list').addEventListener('input',function(ev){",
  "var t=ev.target;if(!t.classList.contains('notetext'))return;",
  "var c=t.closest('.note').querySelector('.cnt');var n=t.value.length;",
  // The shortlist counts against LinkedIn's 300 cap; the Day 7 script has no
  // cap, so it just counts. Keep whichever format the row was rendered with.
  "if(c.textContent.indexOf('/')>-1){c.textContent=n+'/300';",
  "c.classList.toggle('over',n>300);}else{c.textContent=n+' chars';}});",
  "document.getElementById('list').addEventListener('click',function(ev){",
  "var b=ev.target.closest('button.copy');if(!b)return;",
  "var t=b.closest('.note').querySelector('.notetext');",
    // The label is restored from whatever it was, because the shortlist says
  // 'Copy note' and the Day 7 page says 'Copy script'.
  "var was=b.textContent;",
  "var done=function(){b.textContent='Copied';b.classList.add('copied');",
  "setTimeout(function(){b.textContent=was;b.classList.remove('copied')},1200);};",
  "if(navigator.clipboard&&navigator.clipboard.writeText){",
  "navigator.clipboard.writeText(t.value).then(done,function(){t.select();",
  "try{document.execCommand('copy')}catch(e){}done();});}",
  "else{t.select();try{document.execCommand('copy')}catch(e){}done();}",
  "});",
].join("");

function firstNameOf(row) {
  const n = String(row.name || "").trim();
  if (!n || n.includes("@")) return "there";
  const first = n.split(/\s+/)[0];
  return first.length > 1 ? first : n;
}

// The Day 4 shape from no-phone-cadence-copy-v1.md, with the closing clause
// cut. "Following {Company}'s growth with interest" spent about fifty of the
// three hundred characters and carried no information, and every dataset that
// measures length puts the sweet spot at 140-180 characters rather than a
// filled cap. What is left is the greeting, the researched fact, and the ask.
//
// Only the middle fragment is ever generated. The greeting and the ask are
// fixed here, so no model output can drift the template and the character
// budget is known before the call rather than discovered after it.
//
// An empty string means "send this one blank", which is a real instruction
// rather than a failure. There is deliberately no generic fallback: a filler
// note is the worst-performing of the three options in every dataset.
function assembleNote(row, fragment) {
  if (!fragment) return "";
  const first = firstNameOf(row);
  const frag = String(fragment).trim().replace(/[.\s]+$/, "");
  const full = "Hi " + first + ", " + frag + ". Would love to connect.";
  if (full.length <= NOTE_LIMIT) return full;
  return "";
}

function fragmentBudget(row) {
  // 180 rather than the 300 cap, per the length findings above. The hard cap
  // still applies in assembleNote; this is the target handed to the model.
  const overhead = ("Hi " + firstNameOf(row) + ", . Would love to connect.").length;
  return Math.max(40, Math.min(NOTE_LIMIT, 180) - overhead);
}

// Restyle, do not re-research. Every hard rule here already exists in the
// project: the no-em-dash guardrail and the "a routine filing is not an
// achievement" bar from ai-cold-outreach-research-agent-design.md, and the
// "no pitch in the note itself, the report is named at Day 7" rule from
// linkedin-campaign-launch-strategy.md.
const NOTE_SYSTEM = [
  "You write the opening fragment of a LinkedIn connection-request note for Marina Nicholas, a UK growth consultant doing cold outreach to owners and senior leaders.",
  "For each person you are given one fact that has already been researched, sourced and approved. Restyle that fact. Never add a fact, figure, date or name that is not in the fact you were given, and never embellish or soften it.",
  "Return only the middle fragment. It is dropped into this fixed sentence: \"Hi <First>, <FRAGMENT>. Would love to connect.\" So the fragment must start lower case, be a single clause, and carry no closing punctuation. Stay within that person's maxChars, and shorter is better than longer.",
  "Hard style rules. British English. No em dashes, ever. No exclamation marks. No pitch, no offer, no link, and no mention of a report, a diagnostic, a score or a call, because this touch is only a connect opener. No flattery and no adjectives like exciting, impressive, amazing or fantastic. Plain and peer to peer, the way one business owner writes to another.",
  "If the fact is a routine administrative event with no achievement in it, such as a filing or a director appointment with no coverage, do not congratulate it. Either reference it flatly or return an empty fragment for that person.",
  "Good fragments read like: \"saw the new Leeds site opened last month\", \"noticed the Series A closed in June\", \"saw the team has doubled since the acquisition\".",
  "Reply with JSON only, no prose: {\"notes\":[{\"i\":<index>,\"frag\":\"<fragment or empty string>\"}]}. One entry per person, same indexes you were given.",
].join("\n");

async function claudeFragments(batch) {
  const people = batch.map((b, idx) => ({
    i: idx,
    first: firstNameOf(b.row),
    company: b.row.company || "",
    maxChars: fragmentBudget(b.row),
    fact: b.row.trigger,
  }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: NOTE_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify({ people }) }],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      "Anthropic " + res.status + " " +
      String((json.error && json.error.message) || "").slice(0, 140)
    );
  }
  const text = (json.content || []).map((c) => c.text || "").join("");
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error("Anthropic returned no JSON object");
  const parsed = JSON.parse(m[0]);
  const out = new Map();
  for (const n of parsed.notes || []) {
    if (typeof n.i === "number") {
      // Belt and braces on the one rule a reader would actually notice.
      out.set(n.i, String(n.frag || "").replace(/—/g, ",").trim());
    }
  }
  return out;
}

// Fills row.note on the slotted rows only, so a week of requests costs one or
// two model calls rather than ten. A cached note against the same fact is
// free; the rest are written under a time budget, and anyone not reached goes
// out blank and is written on the next load.
async function attachNotes(picked) {
  const stats = {
    slots: NOTE_SLOTS,
    written: 0,
    cached: 0,
    blank: 0,
    noFact: 0,
    pending: 0,
    errors: [],
  };

  // The slots go to the highest-ranked people who actually have a researched
  // fact. Rank order already puts repliers and repeat clickers first, so the
  // scarce notes land on the warmest contacts rather than whoever happens to
  // sit at the top of the alphabet. Everyone else is blank by design.
  const slotted = new Set();
  for (const row of picked) {
    if (slotted.size >= NOTE_SLOTS) break;
    if (row.trigger) slotted.add(row.personKey);
  }

  const todo = [];
  let cache = [];
  try {
    const keys = picked.map((r) => NOTE_CACHE_PREFIX + r.personKey);
    cache = keys.length ? await kv.mget(...keys) : [];
  } catch (err) {
    cache = [];
  }

  picked.forEach((row, idx) => {
    row.note = "";
    if (!slotted.has(row.personKey)) {
      row.noteSource = row.trigger ? "blank" : "blank-no-fact";
      if (row.trigger) stats.blank++;
      else stats.noFact++;
      return;
    }
    const hit = cache[idx];
    if (hit && hit.trigger === row.trigger && hit.frag !== undefined) {
      row.note = assembleNote(row, hit.frag);
      row.noteSource = row.note ? "written" : "blank";
      stats.cached++;
      return;
    }
    row.noteSource = "pending";
    todo.push({ row, key: NOTE_CACHE_PREFIX + row.personKey });
  });

  if (!todo.length) return stats;
  if (!ANTHROPIC_KEY) {
    stats.pending = todo.length;
    stats.errors.push("ANTHROPIC_API_KEY is not set on this project, so no notes can be written");
    return stats;
  }

  const batches = [];
  for (let i = 0; i < todo.length; i += NOTE_BATCH) batches.push(todo.slice(i, i + NOTE_BATCH));

  const deadline = Date.now() + NOTE_BUDGET_MS;
  let next = 0;
  async function worker() {
    for (;;) {
      const mine = batches[next++];
      if (!mine) return;
      if (Date.now() > deadline) {
        stats.pending += mine.length;
        continue;
      }
      try {
        const frags = await claudeFragments(mine);
        const writes = {};
        mine.forEach((item, idx) => {
          const frag = frags.get(idx);
          if (frag === undefined) {
            stats.pending++;
            return;
          }
          item.row.note = assembleNote(item.row, frag);
          item.row.noteSource = item.row.note ? "written" : "blank";
          if (item.row.note) stats.written++;
          else stats.blank++;
          writes[item.key] = { trigger: item.row.trigger, frag, at: new Date().toISOString() };
        });
        if (Object.keys(writes).length) {
          try {
            await kv.mset(writes);
          } catch (err) {
            // A cache miss next time is cheaper than failing the page.
          }
        }
      } catch (err) {
        stats.pending += mine.length;
        if (stats.errors.length < 3) stats.errors.push(String(err.message || err).slice(0, 160));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(NOTE_CONCURRENCY, batches.length) }, worker));
  return stats;
}

// ---------------------------------------------------------- Day 7 follow-up
//
// This is where the researched fact actually earns its keep. A connection note
// gets a 3.0% reply rate and falling across Expandi's 13.2M sample; a message
// sent after connecting gets 10.4% and stable. Same fact, one step later, no
// character cap and no monthly quota.
//
// Cadence-faithful: Day 7 in no-phone-cadence-copy-v1.md is a VOICE NOTE, the
// async substitute for the phone call that Phase 1 dropped, and it is the
// first touch allowed to name the report. So what this produces is a spoken
// script, not a paste-and-send message, and the page says so.
const FOLLOWUP_SYSTEM = [
  "You write a short spoken script for Marina Nicholas, a UK growth consultant, to record as a LinkedIn voice note. It goes to someone who has just accepted her connection request after receiving one cold email from her.",
  "You are given one fact about their company that was already researched, sourced and approved. Open by referencing it naturally. Never add a fact, figure, date or name that was not given to you.",
  "The script must: sound spoken and slightly imperfect rather than read, run about 30 to 40 seconds which is roughly 70 to 90 words, mention that she sent an email a few days ago, offer the free Growth Gap Report as something they can have whether or not they ever speak, and close with no pressure.",
  "Hard style rules. British English. No em dashes. No hype, no flattery, no adjectives like exciting or impressive. No hard sell and no urgency. Peer to peer, the way one business owner speaks to another.",
  "Reply with JSON only, no prose: {\"notes\":[{\"i\":<index>,\"frag\":\"<script>\"}]}. One entry per person, same indexes you were given.",
].join("\n");

async function claudeFollowups(batch) {
  const people = batch.map((b, idx) => ({
    i: idx,
    first: firstNameOf(b.row),
    company: b.row.company || "",
    fact: b.row.trigger,
  }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: FOLLOWUP_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify({ people }) }],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      "Anthropic " + res.status + " " +
      String((json.error && json.error.message) || "").slice(0, 140)
    );
  }
  const text = (json.content || []).map((c) => c.text || "").join("");
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error("Anthropic returned no JSON object");
  const out = new Map();
  for (const n of JSON.parse(m[0]).notes || []) {
    if (typeof n.i === "number") out.set(n.i, String(n.frag || "").replace(/—/g, ",").trim());
  }
  return out;
}

// Who is due a Day 7 touch: anyone whose request was marked sent between
// FOLLOWUP_MIN_DAYS and FOLLOWUP_MAX_DAYS ago. Acceptance is not tracked
// anywhere, so this is a prompt to check rather than a claim that they
// accepted, and the page is explicit about that.
async function buildFollowups(roster, requested) {
  const byKey = new Map(roster.rows.map((r) => [r.personKey, r]));
  const due = [];
  for (const key of Object.keys(requested || {})) {
    const sentAt = requested[key];
    if (!sentAt) continue;
    const age = daysSince(sentAt);
    if (!(age >= FOLLOWUP_MIN_DAYS && age <= FOLLOWUP_MAX_DAYS)) continue;
    const row = byKey.get(key);
    if (!row || !row.trigger) continue;
    due.push(Object.assign({}, row, { sentAt, daysSince: Math.floor(age) }));
  }
  due.sort((a, b) => b.daysSince - a.daysSince || a.name.localeCompare(b.name));

  const stats = { due: due.length, written: 0, cached: 0, pending: 0, errors: [] };
  if (!due.length) return { due, stats };

  let cache = [];
  try {
    cache = await kv.mget(...due.map((r) => FOLLOWUP_CACHE_PREFIX + r.personKey));
  } catch (err) {
    cache = [];
  }

  const todo = [];
  due.forEach((row, idx) => {
    const hit = cache[idx];
    if (hit && hit.trigger === row.trigger && hit.frag) {
      row.script = hit.frag;
      stats.cached++;
      return;
    }
    row.script = "";
    todo.push({ row, key: FOLLOWUP_CACHE_PREFIX + row.personKey });
  });

  if (todo.length && !ANTHROPIC_KEY) {
    stats.pending = todo.length;
    stats.errors.push("ANTHROPIC_API_KEY is not set on this project");
    return { due, stats };
  }

  const batches = [];
  for (let i = 0; i < todo.length; i += NOTE_BATCH) batches.push(todo.slice(i, i + NOTE_BATCH));
  const deadline = Date.now() + NOTE_BUDGET_MS;
  let next = 0;
  async function worker() {
    for (;;) {
      const mine = batches[next++];
      if (!mine) return;
      if (Date.now() > deadline) {
        stats.pending += mine.length;
        continue;
      }
      try {
        const frags = await claudeFollowups(mine);
        const writes = {};
        mine.forEach((item, idx) => {
          const frag = frags.get(idx);
          if (!frag) {
            stats.pending++;
            return;
          }
          item.row.script = frag;
          stats.written++;
          writes[item.key] = { trigger: item.row.trigger, frag, at: new Date().toISOString() };
        });
        if (Object.keys(writes).length) {
          try {
            await kv.mset(writes);
          } catch (err) {
            // Cache miss next time beats failing the page.
          }
        }
      } catch (err) {
        stats.pending += mine.length;
        if (stats.errors.length < 3) stats.errors.push(String(err.message || err).slice(0, 160));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(NOTE_CONCURRENCY, batches.length) }, worker));
  return { due, stats };
}

function renderFollowupPage(due, stats, key) {
  const rows = due.map(function (r) {
    const meta = [r.title, r.company].filter(Boolean).map(esc).join(" &middot; ");
    return '<li class="row" data-k="' + esc(r.personKey) + '">' +
      '<div class="rank">' + r.daysSince + "d</div>" +
      '<div class="who"><div class="nm">' + esc(r.name) + "</div>" +
      '<div class="meta">' + (meta || "&mdash;") + "</div></div>" +
      '<div class="score"></div>' +
      '<div class="actions">' +
      '<a class="btn open" target="_blank" rel="noopener" href="' + esc(r.linkedinUrl) +
      '">Open profile</a></div>' +
      '<div class="note"><span class="blanklabel slot">Day 7 voice note &middot; record, do not read</span>' +
      '<textarea class="notetext" rows="4" spellcheck="false">' + esc(r.script || "") + "</textarea>" +
      '<div class="noterow"><span class="cnt">' + (r.script || "").length + " chars</span>" +
      '<button class="btn copy" type="button">Copy script</button></div></div></li>';
  }).join("");
  return "<!doctype html><html lang='en'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>Day 7 follow-ups</title><style>" + PAGE_CSS + "</style></head>" +
    "<body data-key='" + esc(key) + "' data-total='" + due.length + "'>" +
    "<header><div class='wrap'><h1>Day 7 follow-ups</h1>" +
    "<p class='sub'>" + due.length + " due &middot; requests sent " + FOLLOWUP_MIN_DAYS +
    " to " + FOLLOWUP_MAX_DAYS + " days ago</p>" +
    "<div class='bar'><span id='prog' style='width:0%'></span></div>" +
    "</div></header><ul id='list'>" + rows + "</ul><footer>" +
    "<p><b>Check they actually accepted before sending.</b> Acceptance is not tracked anywhere, so this list is everyone whose request went out " +
    FOLLOWUP_MIN_DAYS + " to " + FOLLOWUP_MAX_DAYS +
    " days ago and who has a researched fact on file. Skip anyone still pending.</p>" +
    "<p>This is the touch the research is worth most on. A connection note replies at about 3% and falling; a message after connecting replies at about 10% and holding. It is also the first touch in the cadence allowed to name the Growth Gap Report.</p>" +
    "<p>Record it, do not read it. The whole point of this touch is that it does not sound like the rest of the sequence.</p>" +
    (stats.errors && stats.errors.length
      ? "<p><b>Script writing hit an error:</b> " + esc(stats.errors.join(" | ")) + "</p>"
      : "") +
    "</footer><script>" + PAGE_JS + "</scr" + "ipt></body></html>";
}

function renderNote(r) {
  const n = r.note || "";
  if (!n) {
    // Not an empty state. "Send blank" is the instruction, and the reason is
    // shown so it does not read as something that failed to load.
    const why =
      r.noteSource === "pending"
        ? "note not written yet, reload the page"
        : r.noteSource === "blank-no-fact"
        ? "no researched fact on file, and a filler note performs worse than none"
        : "note slots are spent on higher-ranked contacts this month";
    return '<div class="note blank"><span class="blanklabel">Send without a note</span>' +
      '<span class="warn">' + esc(why) + "</span></div>";
  }
  return '<div class="note">' +
    '<span class="blanklabel slot">Note slot &middot; send with this</span>' +
    '<textarea class="notetext" rows="2" spellcheck="false">' + esc(n) + "</textarea>" +
    '<div class="noterow"><span class="cnt' + (n.length > NOTE_LIMIT ? " over" : "") + '">' +
    n.length + "/" + NOTE_LIMIT + "</span>" +
    '<button class="btn copy" type="button">Copy note</button></div></div>';
}

function renderRow(r, i, done) {
  const meta = [r.title, r.company].filter(Boolean).map(esc).join(" &middot; ");
  const chips = r.reasons.slice(0, 3).map(function (x) {
    return '<span class="chip">' + esc(x) + "</span>";
  }).join("");
  return '<li class="row' + (done ? " done" : "") + '" data-k="' + esc(r.personKey) + '">' +
    '<div class="rank">' + (i + 1) + "</div>" +
    '<div class="who"><div class="nm">' + esc(r.name) + "</div>" +
    '<div class="meta">' + (meta || "&mdash;") + "</div>" +
    '<div class="chips">' + chips + "</div></div>" +
    '<div class="score">' + r.score + "</div>" +
    '<div class="actions">' +
    '<a class="btn open" target="_blank" rel="noopener" href="' + esc(r.linkedinUrl) + '">Open profile</a>' +
    '<button class="btn mark" type="button">' + (done ? "Sent" : "Mark sent") + "</button>" +
    "</div>" + renderNote(r) + "</li>";
}

function renderPage(roster, picked, sentAllTime, key, noteStats) {
  const ns = noteStats ||
    { slots: NOTE_SLOTS, written: 0, cached: 0, blank: 0, noFact: 0, pending: 0, errors: [] };
  const rows = picked.map(function (r, i) {
    return renderRow(r, i, false);
  }).join("");
  const t = roster.totals;
  return "<!doctype html><html lang='en'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>LinkedIn requests</title><style>" + PAGE_CSS + "</style></head>" +
    "<body data-key='" + esc(key) + "' data-total='" + picked.length + "'>" +
    "<header><div class='wrap'><h1>LinkedIn requests &mdash; cohort " +
    esc(roster.activeCohort || "unknown") + "</h1>" +
    "<p class='sub'><b id='count'>0</b> of " + picked.length + " sent today &middot; " +
    (roster.cohortDay ? "day " + roster.cohortDay + " of this cohort &middot; " : "") +
    sentAllTime + " requested all time &middot; built " +
    esc(roster.builtAt.slice(0, 16).replace("T", " ")) + " UTC</p>" +
    "<div class='bar'><span id='prog' style='width:0%'></span></div>" +
    "</div></header><ul id='list'>" + rows + "</ul><footer>" +
    "<p>Open the profile, send the request, hit Mark sent. Progress is saved, so you can stop and come back. " +
    "<b>Most of these go out blank</b>, which is deliberate, not an oversight.</p>" +
    "<p><b>Why almost none of them carry a note.</b> A free LinkedIn account can only send about five personalised invitations a month, and blank ones are unlimited up to the weekly cap. " +
    "The evidence points the same way: across the public datasets a note does not reliably lift acceptance at all. Belkins, on 20M+ requests, found 26.42% with a note against 26.37% without, and Waalaxy, on ~10M, found full notes actively worse. " +
    "What every dataset does agree on is that a generic note is the worst of the three options, below a blank request and below a specific one, so there is no filler note here any more. " +
    "The " + ns.slots + " slots go to the highest-ranked people who have a real researched fact behind them.</p>" +
    "<p>This run: " + (ns.written + ns.cached) + " written, " + (ns.blank + ns.noFact) + " going out blank" +
    (ns.pending ? ", " + ns.pending + " not written this run, reload to finish them" : "") + ". " +
    (roster.totals.withTrigger || 0) + " of " + roster.totals.emailed +
    " emailed contacts have a researched fact on file overall. " +
    "If you move to Premium the monthly note cap disappears and this becomes a real question worth testing, 40 noted against 40 blank on one cohort.</p>" +
    "<p><b>The research pays better at Day 7.</b> Connection notes reply at about 3% and falling; a message after connecting replies at about 10% and holding. " +
    "Add <code>&amp;mode=followups</code> to this URL a few days after sending to get the Day 7 voice-note scripts, built from the same facts.</p>" +
    (ns.errors && ns.errors.length
      ? "<p><b>Note writing hit an error:</b> " + esc(ns.errors.join(" | ")) + "</p>"
      : "") +
    "<p>Ranked on fit, not engagement. Email opens and clicks are switched off for deliverability, and this batch went out before per-lead click tracking existed. " +
    t.replied + " replied and " + t.clicked +
    " have a tracked landing-page click; those sort to the top. Everyone else is ordered by seniority, team size and revenue from Apollo.</p>" +
    "<p>" + t.inActiveCohort + " are in this cohort and " + t.backfillPool +
    " sit in the backfill pool from earlier cohorts, used only once the active one runs out. " +
    t.excluded + " of " + t.emailed +
    " were held back: no LinkedIn URL, a bounce, an opt-out, under 5 people, or a recovery sequence still running.</p>" +
    "<p>Marking someone sent removes them for good, so reloading next week gives you the next batch rather than this one again.</p>" +
    "</footer><script>" + PAGE_JS + "</scr" + "ipt></body></html>";
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // /api/health used to be its own function. Vercel Hobby caps a deployment at
  // 12 of them and the project was already at exactly 12, so it lives here now
  // and vercel.json rewrites the old path onto it. Unguarded, like it was: it
  // reports whether each key is SET, never what any of them are.
  if (req.query.health === "1") {
    return res.status(200).json({
      ok: true,
      service: "mn-automation-hub",
      checks: {
        apolloKeySet: !!process.env.APOLLO_API_KEY,
        pipedriveTokenSet: !!process.env.PIPEDRIVE_API_TOKEN,
        instantlyKeySet: !!process.env.INSTANTLY_API_KEY,
        instantlyCampaignSet: !!process.env.INSTANTLY_CAMPAIGN_ID,
        resendKeySet: !!process.env.RESEND_API_KEY,
        anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
        kvConfigured: !!process.env.KV_REST_API_URL,
      },
      timestamp: new Date().toISOString(),
    });
  }

  if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });

  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const personKey = String(body.personKey || "");
      if (!personKey) return res.status(400).json({ ok: false, error: "personKey is required" });
      if (body.done) {
        const patch = {};
        patch[personKey] = new Date().toISOString();
        await kv.hset(REQUESTED_KEY, patch);
      } else {
        await kv.hdel(REQUESTED_KEY, personKey);
      }
      return res.status(200).json({ ok: true });
    }

    const cap = Math.min(Number(req.query.cap || 80), 500);
    const roster = await getRoster(req.query.refresh === "1");

    if (String(req.query.mode || "") === "inspect") {
      const exclusions = {};
      for (const r of roster.rows) {
        if (r.excluded) exclusions[r.excluded] = (exclusions[r.excluded] || 0) + 1;
      }
      // Counts per score, eligible people only. This is what shows whether the
      // cut at 80 is a real ranking or an arbitrary slice through a tie.
      const scoreHistogram = {};
      for (const r of roster.rows) {
        if (r.excluded) continue;
        scoreHistogram[r.score] = (scoreHistogram[r.score] || 0) + 1;
      }
      const sample = roster.rows[0] || {};
      const shape = {};
      for (const k of Object.keys(sample)) shape[k] = sample[k] === null ? null : typeof sample[k];
      return res.status(200).json({
        ok: true,
        builtAt: roster.builtAt,
        activeCohort: roster.activeCohort,
        cohortDay: roster.cohortDay,
        cohorts: roster.cohorts,
        totals: roster.totals,
        exclusions,
        scoreHistogram,
        apolloShape: roster.apolloShape || null,
        sampleShape: shape,
      });
    }

    // Already-requested people leave the pool entirely rather than sitting at
    // the top greyed out, so next week's list is the NEXT 80 rather than the
    // same 80 again.
    const requested = (await kv.hgetall(REQUESTED_KEY)) || {};

    // Day 7 view: the same researched fact, one touch later, where it earns
    // roughly three times the reply rate it does in a connection note.
    if (String(req.query.mode || "") === "followups") {
      const { due, stats } = await buildFollowups(roster, requested);
      if (String(req.query.format || "html") === "html") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).send(renderFollowupPage(due, stats, req.query.key));
      }
      return res.status(200).json({
        ok: true,
        stats,
        due: due.map((r) => ({
          name: r.name,
          company: r.company,
          daysSince: r.daysSince,
          linkedinUrl: r.linkedinUrl,
          script: r.script,
        })),
      });
    }

    const eligible = roster.rows.filter((r) => !r.excluded && !requested[r.personKey]);
    const picked = eligible.slice(0, cap);

    // After the cut, deliberately: only the people actually being contacted
    // this week are worth drafting a note for.
    const noteStats = await attachNotes(picked);

    // Writing the score back is what makes the ranking visible in the CRM as a
    // sortable filter, rather than only in this response.
    let written = 0;
    const writeErrors = [];
    if (req.query.live === "1") {
      const batch = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < picked.length; i++) {
        const r = picked[i];
        if (!r.dealId) continue;
        try {
          await updateDeal(r.dealId, {
            "Lane2 Score": r.score,
            "LinkedIn Batch": batch,
            "LinkedIn Rank": i + 1,
          });
          written++;
        } catch (err) {
          writeErrors.push({ dealId: r.dealId, error: String(err.message || err).slice(0, 120) });
        }
      }
    }

    if (String(req.query.mode || "") === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res
        .status(200)
        .send(renderPage(roster, picked, Object.keys(requested).length, req.query.key, noteStats));
    }

    return res.status(200).json({
      ok: true,
      builtAt: roster.builtAt,
      totals: roster.totals,
      eligible: eligible.length,
      cap,
      written,
      writeErrors: writeErrors.slice(0, 10),
      notes: noteStats,
      picked: picked.map((r, i) => ({
        rank: i + 1,
        name: r.name,
        title: r.title,
        company: r.company,
        linkedinUrl: r.linkedinUrl,
        employees: r.employees,
        revenue: r.revenue,
        score: r.score,
        reasons: r.reasons,
        trigger: r.trigger,
        note: r.note,
        noteSource: r.noteSource,
        dealUrl: r.dealUrl,
      })),
    });
  } catch (err) {
    console.error("linkedin/shortlist failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
