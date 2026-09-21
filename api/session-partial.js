// Capture for people who complete step 2 of the Growth Gap Session booking
// form and then never pick a slot.
//
// These are the most qualified people the LinkedIn ads will produce and, until
// this existed, the only ones we could never see: the page used the email
// purely to prefill the Calendly iframe URL, so if they closed the tab at the
// calendar it never left their browser.
//
// Deliberately NOT /api/track. That endpoint is a pure counter that stores no
// IP, no cookie and no identifier, and that is precisely what keeps the report
// landing page free of a consent banner. This one stores a person's details,
// so it lives apart: different contract, different lawful basis (the step-2
// consent line on the form), different blast radius if it breaks.
//
// Fire-and-forget from the browser. It always answers 200, because a capture
// failure must never surface to a prospect who is mid-booking.

import { Redis } from "@upstash/redis";
import {
  findOrCreatePerson,
  findDealsByPersonId,
  createDeal,
  createNote,
  ENROLMENT_PIPELINE_ID,
  ENROLMENT_STAGES,
} from "../lib/pipedrive.js";

const kv = Redis.fromEnv();

const COUNTER_KEY = "session:partials";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return {};
  }
}

const clean = (v, max = 300) => String(v == null ? "" : v).trim().slice(0, max);

// Not RFC-complete, and not trying to be. This only has to reject the blank
// and the obviously-mistyped before we spend a Pipedrive call on it.
function plausibleEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

// The four qualification answers arrive as short codes to keep the Calendly
// tracking parameter under its 255-character ceiling. Expand them here so a
// human reading the Pipedrive note sees words.
const LABELS = {
  role: { own: "Owner / Founder", ceo: "MD or CEO", mp: "Managing Partner", dir: "Director" },
  rev: {},
  team: {},
  tried: {},
};
const expand = (group, code) => LABELS[group]?.[code] || code || "-";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const body = readBody(req);

    const email = clean(body.email, 200).toLowerCase();
    if (!plausibleEmail(email)) {
      return res.status(200).json({ ok: true, captured: false, reason: "no usable email" });
    }

    const first = clean(body.firstName, 80);
    const last = clean(body.lastName, 80);
    const name = [first, last].filter(Boolean).join(" ") || email;
    const company = clean(body.company, 160);
    const site = clean(body.site, 200);
    const problem = clean(body.problem, 2000);
    const source = clean(body.source, 60) || "growth-gap-session-page";
    const campaign = clean(body.campaign, 60);
    const answers = body.answers && typeof body.answers === "object" ? body.answers : {};

    await kv.hincrby(COUNTER_KEY, "reached_step2", 1);

    const person = await findOrCreatePerson({ name, email });
    if (!person?.id) {
      return res.status(200).json({ ok: false, captured: false, reason: "person failed" });
    }

    // Someone who edits a field and clicks Continue again, or who comes back
    // to the page a week later, must not mint a second deal. Real CRM state
    // decides this rather than a cache, so it stays correct even if KV is
    // flushed or the endpoint is replayed.
    const existing = await findDealsByPersonId(person.id);
    const openInPipeline = (existing || []).find(
      (d) => Number(d.pipeline_id) === ENROLMENT_PIPELINE_ID
    );

    const note = [
      "<b>Growth Gap Session &mdash; booking form completed, slot NOT chosen.</b>",
      "",
      `Role: ${expand("role", answers.role)}`,
      `Revenue: ${expand("rev", answers.rev)}`,
      `Team size: ${expand("team", answers.team)}`,
      `Already tried: ${expand("tried", answers.tried)}`,
      "",
      company ? `Company: ${company}` : null,
      site ? `Site: ${site}` : null,
      "",
      problem ? `<b>In their words:</b><br>${problem}` : null,
      "",
      `Source: ${source}${campaign ? ` / ${campaign}` : ""}`,
      `Captured: ${new Date().toISOString()}`,
    ]
      .filter((l) => l !== null)
      .join("<br>");

    let dealId = openInPipeline?.id || null;

    if (!dealId) {
      // Stage 20 (New Lead) rather than a stage of its own. This person has
      // not started a report and has not booked a call, so neither 21 nor 23
      // is true of them; inventing a stage would also mean every existing
      // funnel count had to learn about it. The UTM Source field and the
      // pinned note are what separate them from a cold-email lead.
      const deal = await createDeal({
        title: `${company || name} - Growth Gap Session (no slot chosen)`,
        personId: person.id,
        pipelineId: ENROLMENT_PIPELINE_ID,
        stageId: ENROLMENT_STAGES.newLead,
        customFieldsByName: {
          "UTM Source": source,
          ...(campaign ? { Cohort: campaign } : {}),
        },
      });
      dealId = deal?.id || null;
      await kv.hincrby(COUNTER_KEY, "deals_created", 1);
    } else {
      await kv.hincrby(COUNTER_KEY, "deals_matched", 1);
    }

    if (dealId) {
      // Pinned, because the point of this record is that a human reads the
      // four answers and their own description before deciding whether to
      // chase, and an unpinned note is invisible behind the activity feed.
      await createNote(dealId, note, { pinned: true });
    }

    // Keyed by deal so the recovery sweep can tell "captured and still not
    // booked" from "captured, then booked an hour later". The Calendly
    // webhook clears it. Ninety days is long enough for any sane follow-up
    // window and short enough that this never becomes a shadow database.
    await kv.set(
      `session:partial:${email}`,
      { dealId, email, first, company, source, campaign, at: Date.now(), booked: false },
      { ex: 90 * 24 * 60 * 60 }
    );

    return res.status(200).json({ ok: true, captured: true, dealId });
  } catch (err) {
    // Same rule as the visit beacon: a tracking or CRM failure is our problem,
    // never the prospect's. Log it and answer 200 so the booking continues.
    console.error("session-partial failed:", err);
    return res.status(200).json({ ok: false, captured: false });
  }
}
