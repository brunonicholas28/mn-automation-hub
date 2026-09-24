// Read or set monthly ad spend - the one number this dashboard cannot poll.
//
// GET  /api/spend                -> the current month
// GET  /api/spend?month=2026-09  -> a specific month
// POST /api/spend                -> set it; body { month?, linkedin?, cold? }
//
// Writing is guarded by CRON_SECRET, the same shared secret the cron
// dispatcher uses, passed as ?secret= or an Authorization: Bearer header.
// Reading is open, because the dashboard is open and the figure is already
// on it.

import { readSpend, writeSpend, currentMonth } from "../lib/spend.js";

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
      const month = String(req.query?.month || currentMonth()).slice(0, 7);
      return res.status(200).json({ ok: true, spend: await readSpend(month) });
    }

    if (req.method === "POST") {
      if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      const saved = await writeSpend({
        month: body?.month ? String(body.month).slice(0, 7) : undefined,
        linkedin: body?.linkedin,
        cold: body?.cold,
      });
      return res.status(200).json({ ok: true, spend: saved });
    }

    return res.status(405).json({ ok: false, error: "GET or POST only" });
  } catch (err) {
    console.error("spend failed:", err);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
}
