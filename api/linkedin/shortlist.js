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
//      &refresh=1            rebuild rather than serve the 10-minute cache
//      &live=1               also write Lane2 Score + LinkedIn Batch to Pipedrive
//
// Key-guarded and fails closed, because it returns names, emails and LinkedIn
// URLs. Same rule as /api/leads/import.

import { Redis } from "@upstash/redis";
import { listCampaignLeads, listBlocklist, isBlocked } from "../../lib/instantly.js";
import { listCohortIds } from "../../lib/cohort.js";
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

const CACHE_KEY = "linkedin:shortlist:roster";
const CACHE_TTL_SECONDS = 600;

function authorised(req) {
  const expected = process.env.FUNNEL_CRON_KEY;
  if (!expected) return false; // Fail closed: this endpoint returns email addresses.
  const given = req.query.key || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return given === expected;
}

const lower = (v) => String(v || "").trim().toLowerCase();

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
    const contacts = json.contacts || [];
    out.push(...contacts);
    const totalPages = (json.pagination && json.pagination.total_pages) || 1;
    if (page >= totalPages || contacts.length === 0) break;
  }
  return out;
}

// Apollo puts the company under 'account' for a saved contact and
// 'organization' for a raw person, and not every record carries both.
function orgOf(c) {
  return (c && (c.organization || c.account)) || {};
}
function employeesOf(c) {
  const o = orgOf(c);
  const n = Number(o.estimated_num_employees || o.employee_count || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function revenueOf(c) {
  const o = orgOf(c);
  const n = Number(o.annual_revenue || o.organization_revenue || 0);
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

  const emp = row.employees;
  if (emp === null) {
    score += 6;
    reasons.push("team size unknown");
  } else if (emp >= 5 && emp <= 250) {
    score += 25;
    reasons.push(emp + " people, core ICP band");
  } else if (emp <= 1000) {
    score += 14;
    reasons.push(emp + " people, above the usual band");
  } else {
    score += 4;
    reasons.push(emp + " people, drifting into enterprise");
  }

  const rev = row.revenue;
  if (rev === null) {
    score += 6;
    reasons.push("revenue unknown");
  } else if (rev >= 1e6) {
    score += 25;
    reasons.push("~$" + Math.round(rev / 1e6) + "m revenue");
  } else {
    reasons.push("under the $1m floor on Apollo's estimate");
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
  if (IB_ADVISORY.test(row.company || "") || IB_ADVISORY.test(row.title || "")) {
    return "investment banking or M&A advisory";
  }
  return null;
}

async function buildRoster() {
  if (!SOURCE_CAMPAIGN) throw new Error("INSTANTLY_CAMPAIGN_ID is not set");

  // Campaign membership is the definition of "people we emailed". Using the
  // Pipedrive stage instead would sweep in deals that were never sent to.
  const [campaignLeads, blocklist, persons, deals, apollo] = await Promise.all([
    listCampaignLeads(SOURCE_CAMPAIGN),
    listBlocklist(),
    listAllPersons(),
    listPipelineDeals(),
    listApolloContacts().catch(() => []),
  ]);

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

  const apolloByEmail = new Map();
  for (const c of apollo) {
    const addr = lower(c.email);
    if (addr && !apolloByEmail.has(addr)) apolloByEmail.set(addr, c);
  }

  // Per-lead landing clicks, where tokens exist. c20260908 has none - that
  // batch predates lids - so this stays empty for the current 267 and starts
  // contributing from c20260915 on.
  const visitedByEmail = new Map();
  try {
    for (const cohort of await listCohortIds()) {
      const tokens = await listLeadTokens(cohort);
      if (!tokens.length) continue;
      for (const lead of await readLeads(tokens)) {
        if (lead.visitedAt && lead.email) visitedByEmail.set(lower(lead.email), lead.visitedAt);
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
      replied: lead.replyCount > 0,
      bounced: lead.bounceCount > 0,
      blocked: isBlocked(email, blocklist.entries),
      visitedAt: visitedByEmail.get(email) || null,
      personId: (person && person.id) || null,
      dealId: (deal && deal.id) || null,
      dealUrl: deal && PD_DOMAIN ? "https://" + PD_DOMAIN + ".pipedrive.com/deal/" + deal.id : null,
    };

    row.excluded = excludeReason(row);
    const scored = scoreOf(row);
    row.score = scored.score;
    row.reasons = scored.reasons;
    rows.push(row);
  }

  // Deterministic all the way down, so two runs give the same order and
  // "number 41" means the same person tomorrow as it does today.
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      (b.employees || 0) - (a.employees || 0) ||
      a.name.localeCompare(b.name)
  );

  return {
    builtAt: new Date().toISOString(),
    totals: {
      emailed: rows.length,
      withLinkedIn: rows.filter((r) => r.linkedinUrl).length,
      withApolloTitle: rows.filter((r) => r.title).length,
      withEmployees: rows.filter((r) => r.employees !== null).length,
      withRevenue: rows.filter((r) => r.revenue !== null).length,
      withDeal: rows.filter((r) => r.dealId).length,
      replied: rows.filter((r) => r.replied).length,
      clicked: rows.filter((r) => r.visitedAt).length,
      excluded: rows.filter((r) => r.excluded).length,
      blocklistSize: blocklist.entries.length,
    },
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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });

  try {
    const cap = Math.min(Number(req.query.cap || 80), 500);
    const roster = await getRoster(req.query.refresh === "1");

    if (String(req.query.mode || "") === "inspect") {
      const exclusions = {};
      for (const r of roster.rows) {
        if (r.excluded) exclusions[r.excluded] = (exclusions[r.excluded] || 0) + 1;
      }
      const sample = roster.rows[0] || {};
      const shape = {};
      for (const k of Object.keys(sample)) shape[k] = sample[k] === null ? null : typeof sample[k];
      return res.status(200).json({
        ok: true,
        builtAt: roster.builtAt,
        totals: roster.totals,
        exclusions,
        sampleShape: shape,
      });
    }

    const eligible = roster.rows.filter((r) => !r.excluded);
    const picked = eligible.slice(0, cap);

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

    return res.status(200).json({
      ok: true,
      builtAt: roster.builtAt,
      totals: roster.totals,
      eligible: eligible.length,
      cap,
      written,
      writeErrors: writeErrors.slice(0, 10),
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
        dealUrl: r.dealUrl,
      })),
    });
  } catch (err) {
    console.error("linkedin/shortlist failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
