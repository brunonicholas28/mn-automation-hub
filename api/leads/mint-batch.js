// Mints a tracked link for every lead in the next send batch, straight from
// Pipedrive, and writes that link back onto the deal.
//
// This exists because the manual route - export a CSV, POST it to
// /api/leads/import, paste the result back - is a step someone will forget
// exactly once, and a cohort sent without tokens can never be segmented
// afterwards. Sourcing from Pipedrive also means the prospect list never has
// to travel through a repo, a chat window or a spreadsheet to get here.
//
// Writing the link onto the deal is what makes the LinkedIn rail work. The
// LinkedIn touches are sent from Pipedrive, not from Instantly, so without
// this they would send an untokened link and a LinkedIn click would look like
// anonymous traffic - the lead would never enter the recovery sweep.
//
// Idempotent: a deal that already carries a Report Link is skipped, so a
// re-run tops up new deals rather than reminting tokens for everyone.
//
// It also skips anyone already sitting in the main Instantly campaign. Deals
// do not leave stage 20 (New Lead) just because they were emailed, so the
// stage alone would have handed a "new" cohort the entire previously-sent
// list - 288 deals in New Lead on 2026-09-09, of which 267 had already had
// the c20260908 batch. Minting those as c20260915 would have re-emailed them
// under a cohort tag that claimed they were new.

import { mintToken, putLead } from "../../lib/leads.js";
import { normaliseCohortId } from "../../lib/cohort.js";
import { listCampaignLeads } from "../../lib/instantly.js";
import {
  ENROLMENT_PIPELINE_ID,
  ENROLMENT_STAGES,
  listDealsByPipelineStage,
  getPersonById,
  getDealFieldsMap,
  ensureDealField,
  updateDeal,
} from "../../lib/pipedrive.js";

const LANDING = process.env.LANDING_PAGE_URL || "https://growth.marinanicholas.com";

function authorised(req) {
  const expected = process.env.FUNNEL_CRON_KEY;
  if (!expected) return false; // Fail closed: this endpoint returns email addresses.
  const given = req.query.key || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return given === expected;
}

const firstNameOf = (name) => String(name || "").trim().split(/\s+/)[0] || "";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });

  const cohort = normaliseCohortId(req.query.cohort);
  const touch = String(req.query.touch || "day2").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const live = req.query.live === "1";
  const limit = Math.min(Number(req.query.limit || 500), 1000);

  if (!cohort) {
    return res.status(400).json({ ok: false, error: "cohort is required, e.g. ?cohort=c20260915" });
  }

  try {
    await ensureDealField("Report Link", { field_type: "varchar" });
    await ensureDealField("Lead Token", { field_type: "varchar" });
    const fields = await getDealFieldsMap({ forceRefresh: true });
    const reportLinkKey = fields["Report Link"]?.key;
    const leadTokenKey = fields["Lead Token"]?.key;
    if (!reportLinkKey || !leadTokenKey) {
      return res.status(500).json({ ok: false, error: "Pipedrive deal fields could not be resolved" });
    }

    const deals = await listDealsByPipelineStage(ENROLMENT_PIPELINE_ID, ENROLMENT_STAGES.newLead);

    // Already-contacted addresses, read from Instantly rather than inferred
    // from Pipedrive. If this cannot be read the run aborts: sending a whole
    // previously-contacted list a second time under a fresh cohort tag is a
    // worse outcome than minting nothing.
    const sourceCampaign = process.env.INSTANTLY_CAMPAIGN_ID;
    if (!sourceCampaign) {
      return res.status(503).json({
        ok: false,
        error: "INSTANTLY_CAMPAIGN_ID is not set - cannot tell which leads have already been contacted, so nothing was minted",
      });
    }
    let alreadySent;
    try {
      const existing = await listCampaignLeads(sourceCampaign);
      alreadySent = new Set(existing.map((l) => l.email).filter(Boolean));
    } catch (err) {
      return res.status(503).json({
        ok: false,
        error: "Instantly campaign leads could not be read - aborting rather than risk re-contacting a previously sent list",
        detail: String(err.message || err).slice(0, 200),
      });
    }

    const minted = [];
    const skipped = {};
    const bump = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };

    for (const deal of deals) {
      if (minted.length >= limit) { bump("over the batch limit"); continue; }
      if (deal[reportLinkKey]) { bump("already has a tracked link"); continue; }

      const personId = deal.person_id?.value || deal.person_id;
      if (!personId) { bump("no person on the deal"); continue; }

      const person = await getPersonById(personId);
      const email = (person?.email?.[0]?.value || person?.email || "").trim().toLowerCase();
      if (!email.includes("@")) { bump("no usable email"); continue; }
      if (alreadySent.has(email)) { bump("already contacted in a previous batch"); continue; }

      const lid = mintToken();
      const url = new URL(LANDING);
      url.searchParams.set("utm_source", "instantly");
      url.searchParams.set("utm_medium", "email");
      url.searchParams.set("utm_campaign", `${cohort}-${touch}`);
      url.searchParams.set("lid", lid);
      const reportLink = url.toString();

      if (live) {
        await putLead(lid, {
          email,
          firstName: firstNameOf(person?.name),
          company: person?.org_id?.name || "",
          cohort,
          dealId: deal.id,
        });
        await updateDeal(deal.id, { "Report Link": reportLink, "Lead Token": lid });
      }

      minted.push({
        dealId: deal.id,
        email,
        firstName: firstNameOf(person?.name),
        company: person?.org_id?.name || "",
        reportLink,
      });
    }

    return res.status(200).json({
      ok: true,
      live,
      cohort,
      touch,
      dealsInNewLead: deals.length,
      alreadyContacted: alreadySent.size,
      minted: minted.length,
      skipped,
      leads: live ? minted : minted.slice(0, 3),
      note: live
        ? "Tokens are stored and written onto the deals. Use reportLink as the {{reportLink}} column in the Instantly CSV."
        : "Dry run - nothing was stored and no deal was changed. Only the first 3 sample rows are shown. Add ?live=1 to mint.",
    });
  } catch (err) {
    console.error("mint-batch failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
