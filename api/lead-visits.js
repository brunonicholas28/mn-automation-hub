// Per-lead visit forensics: is the landing-page traffic people, or machines?
//
// The anonymous beacon in /api/track counts a tagged visit and stores nothing
// else, by design. That is the right default for the public page, but it
// cannot answer the only question that matters when visits are up and starts
// are zero: were those visits real prospects who read the page and walked
// away, or link scanners walking the send batch?
//
// The per-lead token answers it. Every c20260915 report link carries
// ?lid=<token>, and markLeadStage() has been recording visitedAt (first),
// lastVisitAt and visitCount against each lead since the cohort was minted.
// Nothing read it until now. This endpoint does.
//
// The discriminator is simultaneity. Two hundred people who each open a cold
// email when they happen to open their mail do not click within the same
// second as each other; a scanner handed a batch of messages fetches every
// link in one pass. So we bucket each lead's FIRST visit by minute and ask
// how many distinct leads share a bucket. A bucket holding one or two leads
// is what human traffic looks like. A bucket holding twelve is a machine.
//
// What this cannot do: cohorts minted before per-lead tokens existed
// (c20260908 and earlier) have no tokens at all, so they report as
// "no tokens issued" rather than as zero traffic. A confident zero there
// would be a lie.
//
// GET /api/lead-visits?key=<FUNNEL_CRON_KEY>&cohort=c20260915
//   &bucket=60     seconds per simultaneity bucket (default 60)
//   &burst=3       distinct leads in one bucket before it counts as a burst
//   &detail=1      include per-lead rows (token prefix + timestamps, no PII)

import { listLeadTokens, readLeads } from "../lib/leads.js";
import { readCohort, listCohortIds, cohortKey, normaliseCohortId } from "../lib/cohort.js";
import { Redis } from "@upstash/redis";

const kv = Redis.fromEnv();

function authorised(req) {
  const expected = process.env.FUNNEL_CRON_KEY;
  // Fail closed. Per-lead timings are not counts; they are behaviour of named
  // people, even with the names stripped.
  if (!expected) return false;
  const given = req.query.key || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return given === expected;
}

const num = (v) => Number(v || 0) || 0;
const ms = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : null;
};

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Floor a timestamp to the start of its bucket, as an ISO minute so the
// output is readable without converting anything by hand.
function bucketOf(t, bucketMs) {
  return new Date(Math.floor(t / bucketMs) * bucketMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function analyse(leads, { bucketMs, burstMin }) {
  const visited = leads.filter((l) => l.visitedAt);
  const started = leads.filter((l) => l.startedAt);
  const completed = leads.filter((l) => l.completedAt);

  // First visit per lead, bucketed. One lead contributes to exactly one
  // bucket, so a big bucket means many different people, not one reloader.
  const buckets = new Map();
  for (const l of visited) {
    const t = ms(l.visitedAt);
    if (t === null) continue;
    const b = bucketOf(t, bucketMs);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(l);
  }

  const bucketRows = [...buckets.entries()]
    .map(([at, ls]) => ({ at, leads: ls.length, burst: ls.length >= burstMin }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  const inBurst = bucketRows.filter((r) => r.burst).reduce((n, r) => n + r.leads, 0);

  // Hour-of-day, UTC. Scanner traffic sits inside the send window; human
  // clicks bleed into evenings and the following days.
  const byHourUtc = {};
  for (const l of visited) {
    const t = ms(l.visitedAt);
    if (t === null) continue;
    const h = String(new Date(t).getUTCHours()).padStart(2, "0") + ":00";
    byHourUtc[h] = (byHourUtc[h] || 0) + 1;
  }

  // A second machine tell: more than one hit, all of it inside the same
  // bucket as the first. A human who comes back does so minutes or days later.
  let instantRepeats = 0;
  const returnGaps = [];
  for (const l of visited) {
    const first = ms(l.visitedAt);
    const last = ms(l.lastVisitAt) ?? first;
    if (num(l.visitCount) > 1) {
      if (last !== null && first !== null && last - first < bucketMs) instantRepeats += 1;
      else if (last !== null && first !== null) returnGaps.push(Math.round((last - first) / 1000));
    }
  }

  const identifiedVisits = leads.reduce((n, l) => n + num(l.visitCount), 0);
  const spanSeconds = (() => {
    const times = visited.map((l) => ms(l.visitedAt)).filter((t) => t !== null);
    if (times.length < 2) return null;
    return Math.round((Math.max(...times) - Math.min(...times)) / 1000);
  })();

  return {
    counts: {
      leadsWithTokens: leads.length,
      visited: visited.length,
      started: started.length,
      completed: completed.length,
      visitedNeverStarted: visited.length - started.length,
      identifiedVisits,
    },
    simultaneity: {
      bucketSeconds: bucketMs / 1000,
      burstThresholdLeads: burstMin,
      distinctBuckets: bucketRows.length,
      leadsInBurstBuckets: inBurst,
      shareOfVisitorsInBursts: visited.length ? Math.round((inBurst / visited.length) * 1000) / 10 : null,
      largestBucket: bucketRows.reduce((a, r) => (!a || r.leads > a.leads ? r : a), null),
      buckets: bucketRows,
    },
    repeats: {
      instantRepeats,
      humanShapedReturns: returnGaps.length,
      medianReturnGapSeconds: median(returnGaps),
    },
    spread: { firstToLastVisitSeconds: spanSeconds, byHourUtc },
  };
}

// Evidence, not a verdict dressed up as one. Each line names the number it
// rests on so it can be argued with.
export function readEvidence(a, cohortCounters) {
  const out = [];
  const c = a.counts;
  const s = a.simultaneity;

  if (!c.leadsWithTokens) {
    out.push("No per-lead tokens were issued for this cohort, so nothing here can be said about who visited. This is not a zero.");
    return out;
  }
  if (!c.visited) {
    out.push(`None of the ${c.leadsWithTokens} tokened leads registered a visit. Either the links were not clicked, or the lid parameter is being stripped before it reaches /api/track.`);
  }

  const anon = cohortCounters.visits - c.identifiedVisits;
  if (cohortCounters.visits) {
    out.push(`The cohort counter holds ${cohortCounters.visits} tagged visits. ${c.identifiedVisits} of those carried a lead token; ${anon} did not.`);
    if (anon > c.identifiedVisits && c.identifiedVisits >= 0) {
      out.push("Most tagged traffic arrived without a token. Our own emails always carry one, so that traffic came from something rewriting or truncating the link, or from a different source using the same tag.");
    }
  }

  if (s.shareOfVisitorsInBursts !== null) {
    out.push(`${s.leadsInBurstBuckets} of ${c.visited} first visits landed in a ${s.bucketSeconds}-second window shared with at least ${s.burstThresholdLeads - 1} other lead(s) - ${s.shareOfVisitorsInBursts}%. Independent human clicks do not cluster like that.`);
  }
  if (s.largestBucket) {
    out.push(`The densest window was ${s.largestBucket.at}, with ${s.largestBucket.leads} different leads' first visit inside ${s.bucketSeconds} seconds.`);
  }
  if (a.repeats.instantRepeats) {
    out.push(`${a.repeats.instantRepeats} lead(s) recorded more than one hit entirely inside their first ${s.bucketSeconds} seconds - a re-fetch, not a re-read.`);
  }

  if (c.visited && !c.started) {
    const human = c.visited - s.leadsInBurstBuckets;
    out.push(
      human > 0
        ? `Setting the clustered traffic aside leaves ${human} visit(s) that look human, and none of them started the form. That is the sample the landing page has to be judged on, and it is ${human < 20 ? "too small to convict the copy" : "large enough to take seriously"}.`
        : "Every visit is accounted for by clustered traffic. There is no human sample yet, so the landing page has not actually been tested."
    );
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorised(req)) {
    return res.status(401).json({
      ok: false,
      error: process.env.FUNNEL_CRON_KEY ? "unauthorised" : "FUNNEL_CRON_KEY is not set; this endpoint fails closed",
    });
  }

  const bucketMs = Math.max(1, Math.min(3600, Number(req.query.bucket) || 60)) * 1000;
  const burstMin = Math.max(2, Math.min(50, Number(req.query.burst) || 3));
  const detail = req.query.detail === "1";

  try {
    const ids = req.query.cohort
      ? [normaliseCohortId(req.query.cohort)].filter(Boolean)
      : (await listCohortIds()).filter((id) => /^c\d{8}$/.test(id));

    const cohorts = [];
    for (const id of ids) {
      const [tokens, counters, variants, sources, touches] = await Promise.all([
        listLeadTokens(id),
        readCohort(id),
        kv.hgetall(`${cohortKey(id)}:variants`).catch(() => null),
        kv.hgetall(`${cohortKey(id)}:sources`).catch(() => null),
        kv.hgetall(`${cohortKey(id)}:touches`).catch(() => null),
      ]);

      const leads = tokens.length ? await readLeads(tokens) : [];
      const a = analyse(leads, { bucketMs, burstMin });

      cohorts.push({
        cohort: id,
        cohortCounters: { sent: counters.sent, visits: counters.visits, started: counters.started, completed: counters.completed },
        ...a,
        tags: { variants: variants || {}, sources: sources || {}, touches: touches || {} },
        evidence: readEvidence(a, counters),
        leadRows: detail
          ? leads
              .filter((l) => l.visitedAt)
              .map((l) => ({
                lid: String(l.lid).slice(0, 4) + "...",
                visitedAt: l.visitedAt,
                lastVisitAt: l.lastVisitAt || null,
                visitCount: num(l.visitCount),
                started: Boolean(l.startedAt),
                completed: Boolean(l.completedAt),
              }))
              .sort((x, y) => (x.visitedAt < y.visitedAt ? -1 : 1))
          : undefined,
      });
    }

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      method:
        "First visit per lead, bucketed by minute. A bucket shared by several leads is simultaneous traffic across different recipients, which is a machine. Repeat hits inside the first bucket are re-fetches. Neither test can see traffic that arrived without a lead token.",
      cohorts,
    });
  } catch (err) {
    console.error("lead-visits failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
