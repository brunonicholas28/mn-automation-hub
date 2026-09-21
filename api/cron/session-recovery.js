// Hourly sweep that sends the Growth Gap Session recovery touches.
//
// Why a cron and not QStash-at-capture (which is how phoenix schedules its
// report-funnel touches): the capture endpoint runs inside a prospect's
// booking flow and must never do anything that can fail slowly. Scheduling
// three delayed messages there adds three network calls and three ways to
// half-succeed at the worst possible moment. A sweep reads state it already
// has, and a missed run costs an hour rather than a sequence.
//
// Hourly resolution means "+1 hour" is really "+1 to +2 hours". That is fine
// for this and not worth a scheduler to improve.
//
// Self-cancels off the deal's REAL stage in Pipedrive, never off a flag
// written at capture time. If they booked - through the page, a link, or
// Marina picking up the phone - the deal has moved to Call Booked or beyond
// and the sequence stops. A cached "booked" boolean is precisely the thing
// that goes stale without anyone noticing.

import { Redis } from "@upstash/redis";
import { findDealsByPersonId, ENROLMENT_PIPELINE_ID, ENROLMENT_STAGES } from "../../lib/pipedrive.js";
import { SCHEDULE, sendTouch } from "../../lib/sessionRecovery.js";

const kv = Redis.fromEnv();
const INDEX = "session:partials:index";
const HOUR = 60 * 60 * 1000;

// Anything older than this is not chased, whatever its send state. Stops a
// backlog after an outage turning into a burst of very late emails.
const MAX_AGE_HOURS = 24 * 10;

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // Same posture as the other hub crons.
  const header = req.headers.authorization || "";
  return header === `Bearer ${secret}`;
}

async function hasBooked(record) {
  if (!record.personId) return false;
  try {
    const deals = await findDealsByPersonId(record.personId);
    return (deals || []).some(
      (d) =>
        Number(d.pipeline_id) === ENROLMENT_PIPELINE_ID &&
        Number(d.stage_id) >= ENROLMENT_STAGES.callBooked
    );
  } catch (err) {
    // A Pipedrive wobble must not cause an email. Failing closed here means
    // someone who booked never gets chased; failing open means they might.
    console.error("[session-recovery] stage check failed, skipping:", record.email, err.message);
    return true;
  }
}

export default async function handler(req, res) {
  if (!authorised(req)) return res.status(401).json({ error: "unauthorized" });

  const out = { scanned: 0, sent: [], skipped: 0, pruned: 0, errors: [] };

  try {
    const emails = (await kv.smembers(INDEX)) || [];
    const now = Date.now();

    for (const email of emails) {
      out.scanned++;
      const key = `session:partial:${email}`;
      const record = await kv.get(key);

      if (!record) {
        // The record's 90-day TTL has expired; the index entry is litter.
        await kv.srem(INDEX, email);
        out.pruned++;
        continue;
      }

      const ageHours = (now - Number(record.at || 0)) / HOUR;
      if (ageHours > MAX_AGE_HOURS) {
        await kv.srem(INDEX, email);
        out.pruned++;
        continue;
      }

      const sent = record.sent || {};
      const due = Object.entries(SCHEDULE)
        .filter(([touch, afterHours]) => !sent[touch] && ageHours >= afterHours)
        .map(([touch]) => touch);

      if (!due.length) {
        out.skipped++;
        continue;
      }

      // One per run, in order. If somebody has been sitting unswept for a
      // week, they get e1 this hour and e2 next - never three emails in one
      // minute, which is what a naive catch-up loop would do.
      const touch = due.sort((a, b) => SCHEDULE[a] - SCHEDULE[b])[0];

      if (await hasBooked(record)) {
        await kv.srem(INDEX, email);
        out.pruned++;
        continue;
      }

      try {
        const result = await sendTouch(touch, record);
        if (result?.sent) {
          record.sent = { ...sent, [touch]: now };
          // Preserve whatever TTL the key already has rather than resetting
          // the 90-day window on every touch.
          const ttl = await kv.ttl(key);
          await kv.set(key, record, ttl > 0 ? { ex: ttl } : undefined);
          out.sent.push(`${touch}:${email}`);
          if (touch === "e3") await kv.srem(INDEX, email);
        } else {
          out.skipped++;
        }
      } catch (err) {
        out.errors.push(`${email}: ${err.message}`);
      }
    }

    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    console.error("[session-recovery] sweep failed:", err);
    return res.status(500).json({ ok: false, error: err.message, ...out });
  }
}
