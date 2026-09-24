// Read or set monthly ad spend - the one number this dashboard cannot poll.
//
// GET  /api/spend   -> both channels' budgets, with spend to date
// POST /api/spend   -> set one; body { channel, budget, from, to }
//
// A budget is a committed figure over a flight ("2090 from 2026-09-22 to
// 2026-10-15"), not a monthly total - see lib/spend.js for why that matters.
//
// Writing is guarded by CRON_SECRET, the same shared secret the cron
// dispatcher uses, passed as ?secret= or an Authorization: Bearer header.
// Reading is open, because the dashboard is open and the figure is already
// on it.

import { readBudget, writeBudget } from "../lib/spend.js";

function authorised(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  const supplied = String(req.query?.secret || header || "");
  if (supplied.length !== expected.length) return false;
  // Length-matched compare; not timing-safe, but this guards a spend figure
  // that is displayed publicly on the dashboard anyway.
  return supplied === expected;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "GET") {
      const [cold, linkedin] = await Promise.all([readBudget("cold"), readBudget("linkedin")]);
      return res.status(200).json({ ok: true, budgets: { cold, linkedin } });
    }

    if (req.method === "POST") {
      if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      const channel = String(body?.channel || "").toLowerCase();
      if (channel !== "cold" && channel !== "linkedin") {
        return res.status(400).json({ ok: false, error: "channel must be cold or linkedin" });
      }
      const saved = await writeBudget(channel, {
        budget: body?.budget,
        from: body?.from,
        to: body?.to,
      });
      return res.status(200).json({ ok: true, channel, budget: saved });
    }

    return res.status(405).json({ ok: false, error: "GET or POST only" });
  } catch (err) {
    console.error("spend failed:", err);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
}
