// Mints a per-lead token for each row of a send list and returns the tracked
// landing-page URL to paste into the Instantly CSV.
//
// Run this once per cohort, at CSV-build time, BEFORE the batch goes out.
// A cohort sent without tokens can never be segmented afterwards - there is
// no way to work out retroactively which anonymous visit belonged to whom,
// and that is by design.
//
// Guarded by FUNNEL_CRON_KEY because the request body carries prospect email
// addresses. It returns them too, so it must never be callable by anyone but
// us. Nothing here is exposed on the public dashboard.

import { mintToken, putLead } from "../../lib/leads.js";
import { normaliseCohortId } from "../../lib/cohort.js";

const LANDING = process.env.LANDING_PAGE_URL || "https://growth.marinanicholas.com";

function authorised(req) {
  const expected = process.env.FUNNEL_CRON_KEY;
  if (!expected) return false; // Fail closed: no key set means no access.
  const given = req.query.key || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return given === expected;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const cohort = normaliseCohortId(body.cohort);
  const touch = String(body.touch || "day2").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const leads = Array.isArray(body.leads) ? body.leads : [];

  if (!cohort) return res.status(400).json({ ok: false, error: "cohort is required, e.g. c20260915" });
  if (!leads.length) return res.status(400).json({ ok: false, error: "leads[] is required" });
  if (leads.length > 2000) return res.status(400).json({ ok: false, error: "batch too large, split it" });

  const out = [];
  const skipped = [];
  for (const raw of leads) {
    const email = String(raw.email || "").trim().toLowerCase();
    if (!email.includes("@")) {
      skipped.push({ row: raw, reason: "no usable email" });
      continue;
    }
    const lid = mintToken();
    await putLead(lid, {
      email,
      firstName: raw.firstName || raw.first_name || "",
      company: raw.company || raw.company_name || "",
      cohort,
    });
    const url = new URL(LANDING);
    url.searchParams.set("utm_source", "instantly");
    url.searchParams.set("utm_medium", "email");
    url.searchParams.set("utm_campaign", `${cohort}-${touch}`);
    url.searchParams.set("lid", lid);
    out.push({ email, lid, reportLink: url.toString() });
  }

  return res.status(200).json({ ok: true, cohort, touch, minted: out.length, skipped, leads: out });
}
