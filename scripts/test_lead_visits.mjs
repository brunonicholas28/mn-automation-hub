// Tests for the visit-forensics maths. The bot-vs-human call is a business
// decision about whether to rewrite the landing page, so the arithmetic under
// it gets asserted rather than eyeballed.
process.env.UPSTASH_REDIS_REST_URL ||= "https://example.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "stub";

const { analyse, readEvidence } = await import("../api/lead-visits.js");

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) pass += 1;
  else fails.push(name + (detail ? " -> " + detail : ""));
}

const OPTS = { bucketMs: 60000, burstMin: 3 };
const lead = (n, over = {}) => ({ lid: "tok" + n, createdAt: "2026-09-15T08:00:00.000Z", ...over });

// A scanner: twelve different leads, first visit inside the same minute.
const scanner = Array.from({ length: 12 }, (_, i) =>
  lead(i, { visitedAt: `2026-09-15T09:31:${String(i * 4).padStart(2, "0")}.000Z`, visitCount: "1" })
);
{
  const a = analyse(scanner, OPTS);
  ok("scanner: all 12 counted as visited", a.counts.visited === 12, String(a.counts.visited));
  ok("scanner: one bucket", a.simultaneity.distinctBuckets === 1, String(a.simultaneity.distinctBuckets));
  ok("scanner: all 12 in burst", a.simultaneity.leadsInBurstBuckets === 12);
  ok("scanner: 100% share", a.simultaneity.shareOfVisitorsInBursts === 100);
  ok("scanner: largest bucket named", a.simultaneity.largestBucket?.at === "2026-09-15T09:31:00Z", JSON.stringify(a.simultaneity.largestBucket));
}

// Humans: six leads spread over three days, none sharing a minute.
const humans = [
  lead(100, { visitedAt: "2026-09-15T09:44:10.000Z", visitCount: "1" }),
  lead(101, { visitedAt: "2026-09-15T13:02:00.000Z", visitCount: "1" }),
  lead(102, { visitedAt: "2026-09-15T21:18:00.000Z", visitCount: "1" }),
  lead(103, { visitedAt: "2026-09-16T07:55:00.000Z", visitCount: "1" }),
  lead(104, { visitedAt: "2026-09-16T19:40:00.000Z", visitCount: "1" }),
  lead(105, { visitedAt: "2026-09-17T08:05:00.000Z", visitCount: "1" }),
];
{
  const a = analyse(humans, OPTS);
  ok("humans: no bursts", a.simultaneity.leadsInBurstBuckets === 0, String(a.simultaneity.leadsInBurstBuckets));
  ok("humans: share is 0", a.simultaneity.shareOfVisitorsInBursts === 0);
  ok("humans: six buckets", a.simultaneity.distinctBuckets === 6);
  ok("humans: hours spread", Object.keys(a.spread.byHourUtc).length === 6, JSON.stringify(a.spread.byHourUtc));
}

// Two leads in a minute must NOT trip a threshold of three.
{
  const a = analyse(
    [lead(200, { visitedAt: "2026-09-15T10:00:01.000Z", visitCount: "1" }), lead(201, { visitedAt: "2026-09-15T10:00:50.000Z", visitCount: "1" })],
    OPTS
  );
  ok("pair below threshold is not a burst", a.simultaneity.leadsInBurstBuckets === 0, String(a.simultaneity.leadsInBurstBuckets));
}

// Re-fetch inside the first bucket vs a genuine return two days later.
{
  const a = analyse(
    [
      lead(300, { visitedAt: "2026-09-15T10:00:00.000Z", lastVisitAt: "2026-09-15T10:00:30.000Z", visitCount: "3" }),
      lead(301, { visitedAt: "2026-09-15T10:05:00.000Z", lastVisitAt: "2026-09-17T11:00:00.000Z", visitCount: "2" }),
    ],
    OPTS
  );
  ok("instant repeat detected", a.repeats.instantRepeats === 1, String(a.repeats.instantRepeats));
  ok("human-shaped return detected", a.repeats.humanShapedReturns === 1, String(a.repeats.humanShapedReturns));
  ok("return gap in seconds", a.repeats.medianReturnGapSeconds === 176100, String(a.repeats.medianReturnGapSeconds));
  ok("identified visits sum visitCount", a.counts.identifiedVisits === 5, String(a.counts.identifiedVisits));
}

// A single visit is never a burst, and visitCount 1 is never an instant repeat.
{
  const a = analyse([lead(400, { visitedAt: "2026-09-15T10:00:00.000Z", lastVisitAt: "2026-09-15T10:00:00.000Z", visitCount: "1" })], OPTS);
  ok("single visit: no burst", a.simultaneity.leadsInBurstBuckets === 0);
  ok("single visit: no instant repeat", a.repeats.instantRepeats === 0);
  ok("single visit: span null", a.spread.firstToLastVisitSeconds === null);
}

// Stage counting and the never-started figure.
{
  const a = analyse(
    [
      lead(500, { visitedAt: "2026-09-15T10:00:00.000Z", visitCount: "1", startedAt: "2026-09-15T10:02:00.000Z" }),
      lead(501, { visitedAt: "2026-09-15T12:00:00.000Z", visitCount: "1" }),
      lead(502, { visitedAt: "2026-09-15T14:00:00.000Z", visitCount: "1", startedAt: "2026-09-15T14:01:00.000Z", completedAt: "2026-09-15T14:09:00.000Z" }),
      lead(503, {}),
    ],
    OPTS
  );
  ok("tokens counted including never-visited", a.counts.leadsWithTokens === 4);
  ok("visited excludes never-visited", a.counts.visited === 3);
  ok("started counted", a.counts.started === 2);
  ok("completed counted", a.counts.completed === 1);
  ok("visitedNeverStarted", a.counts.visitedNeverStarted === 1, String(a.counts.visitedNeverStarted));
}

// Empty cohort must say "no tokens", never a confident zero.
{
  const a = analyse([], OPTS);
  const ev = readEvidence(a, { visits: 0 });
  ok("no tokens: refuses to report a zero", /not a zero/.test(ev.join(" ")), ev.join(" | "));
  ok("no tokens: share is null not 0", a.simultaneity.shareOfVisitorsInBursts === null);
}

// Evidence must split anonymous from identified traffic correctly.
{
  const a = analyse(scanner, OPTS);
  const ev = readEvidence(a, { visits: 34 });
  ok("evidence names the anonymous remainder", /34 tagged visits\. 12 of those carried a lead token; 22 did not/.test(ev.join(" ")), ev.join(" | "));
  ok("evidence refuses to convict the copy with no human sample", /has not actually been tested/.test(ev.join(" ")), ev.join(" | "));
}

// A real human sample that did not start SHOULD point at the page.
{
  const many = Array.from({ length: 25 }, (_, i) =>
    lead(600 + i, { visitedAt: new Date(Date.parse("2026-09-15T09:00:00Z") + i * 7 * 60000).toISOString(), visitCount: "1" })
  );
  const a = analyse(many, OPTS);
  const ev = readEvidence(a, { visits: 25 });
  ok("25 spread visits, no starts -> large enough to take seriously", /large enough to take seriously/.test(ev.join(" ")), ev.join(" | "));
}

// Bucket size must actually change the answer. Six-hourly still separates
// these six clicks; a day-wide bucket folds the first three onto 15 Sep and
// is enough to trip a burst - which is exactly why the bucket has to stay
// tight. "Three people clicked on the same day" is not simultaneity.
{
  const six = analyse(humans, { bucketMs: 6 * 60 * 60 * 1000, burstMin: 3 });
  ok("6h buckets still separate six human clicks", six.simultaneity.distinctBuckets === 6, String(six.simultaneity.distinctBuckets));
  ok("6h buckets raise no burst", six.simultaneity.leadsInBurstBuckets === 0, String(six.simultaneity.leadsInBurstBuckets));

  const day = analyse(humans, { bucketMs: 24 * 60 * 60 * 1000, burstMin: 3 });
  ok("day buckets collapse to three days", day.simultaneity.distinctBuckets === 3, String(day.simultaneity.distinctBuckets));
  ok("day buckets would misread a day as a burst", day.simultaneity.leadsInBurstBuckets === 3, String(day.simultaneity.leadsInBurstBuckets));
}

// The hidden-cohort rule, which now gates /api/metrics, /api/fillout-stats
// and this endpoint from one definition. The four ctest-beacon partials sat
// in the "started" number for a week because only one of those three applied it.
{
  const { isHiddenCohort } = await import("../lib/cohort.js");
  for (const id of ["ctest-beacon3", "ctest-beacon4", "ctest-beacon6", "ctest-beacon7", "ctest_x", "watchdog-e2e2", "c19700101", "xxxxx", "no-phone-cadence---cold-outreach-v1untitled-camp"])
    ok("hidden: " + id, isHiddenCohort(id) === true);
  for (const id of ["c20260908", "c20260915", "c20261013", "untagged", "linkedin-v1"])
    ok("visible: " + id, isHiddenCohort(id) === false);
  ok("hidden: null is not hidden", isHiddenCohort(null) === false);
  ok("hidden: a real cohort containing the letters ctest is not matched mid-string", isHiddenCohort("c20260915-ctest") === false);
}

console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length ? 1 : 0);
