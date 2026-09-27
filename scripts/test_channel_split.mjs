// Tests for splitting a cohort's visits between channels by utm_source.
//
// The bug this pins down: c20260922 is both an Instantly send batch and the
// utm_campaign on the LinkedIn ad set, and the old rule ("has sends, so it is
// cold") filed every paid click under cold outreach. The LinkedIn panel then
// summed only cohorts with no sends, which were all legacy test rows, and
// reported 273 visits that had nothing to do with the live ad set.
process.env.UPSTASH_REDIS_REST_URL ||= "https://example.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "stub";

const { splitVisitsBySource, isLinkedInSource } = await import("../lib/cohort.js");

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) pass += 1;
  else fails.push(name + (detail ? " -> " + detail : ""));
}

// Source vocabulary actually in use in the stack.
ok("linkedin is a LinkedIn source", isLinkedInSource("linkedin"));
ok("case and space tolerant", isLinkedInSource("  LinkedIn "));
ok("instantly is not", !isLinkedInSource("instantly"));
ok("email is not", !isLinkedInSource("email"));
ok("page default is not", !isLinkedInSource("growth-gap-session-page"));
ok("session-recovery is not", !isLinkedInSource("session-recovery"));
ok("empty is not", !isLinkedInSource(""));

// The real shape: one cohort, both channels.
{
  const s = splitVisitsBySource(35, { linkedin: 22, instantly: 13 });
  ok("dual: LinkedIn credited", s.linkedin === 22, String(s.linkedin));
  ok("dual: remainder is cold", s.other === 13, String(s.other));
}

// The hash can undercount the counter, because it started being written after
// some traffic had landed. The counter wins; the unexplained visits stay cold
// so LinkedIn is never flattered.
{
  const s = splitVisitsBySource(35, { linkedin: 10 });
  ok("undercount: LinkedIn is what the hash says", s.linkedin === 10, String(s.linkedin));
  ok("undercount: rest stays cold", s.other === 25, String(s.other));
}

// A stale or over-counted hash must never exceed the counter.
{
  const s = splitVisitsBySource(35, { linkedin: 99 });
  ok("overrun: clamped to counter", s.linkedin === 35, String(s.linkedin));
  ok("overrun: no negative remainder", s.other === 0, String(s.other));
}

// No hash at all degrades to the old behaviour rather than throwing.
{
  const s = splitVisitsBySource(10, null);
  ok("no hash: nothing credited to LinkedIn", s.linkedin === 0);
  ok("no hash: all visits remain", s.other === 10, String(s.other));
}

// Junk values in the hash are ignored, not coerced into visits.
{
  const s = splitVisitsBySource(5, { linkedin: "3", instantly: "x", bogus: -2 });
  ok("junk: numeric string counted", s.linkedin === 3, String(s.linkedin));
  ok("junk: NaN and negatives ignored", s.other === 2, String(s.other));
}

// Zero visits must not produce a phantom split.
{
  const s = splitVisitsBySource(0, { linkedin: 4 });
  ok("zero visits: nothing credited", s.linkedin === 0 && s.other === 0, JSON.stringify(s));
}

// The classification itself, against the shapes actually in the store.
const { channelOf, visitsByChannel } = await import("../api/metrics.js");

// The cohort that exposed the bug: a send batch that is also an ad set.
{
  const c = { cohort: "c20260922", sent: 231, visits: 35, _sources: { linkedin: 22, instantly: 13 } };
  ok("dual cohort is both", channelOf(c) === "both", channelOf(c));
  const v = visitsByChannel(c);
  ok("dual cohort credits LinkedIn", v.linkedin === 22, JSON.stringify(v));
  ok("dual cohort keeps cold share", v.cold === 13, JSON.stringify(v));
}

// Rows that predate the :sources hash must not move out of the LinkedIn panel.
{
  const c = { cohort: "d53593248-ebl5", sent: 0, visits: 129, _sources: {} };
  ok("sendless row stays LinkedIn", channelOf(c) === "linkedin", channelOf(c));
  ok("sendless row keeps all visits", visitsByChannel(c).linkedin === 129);
}

// A pure send cohort is unchanged.
{
  const c = { cohort: "c20260908", sent: 267, visits: 40, _sources: { instantly: 40 } };
  ok("send-only row is cold", channelOf(c) === "cold", channelOf(c));
  ok("send-only row credits no LinkedIn", visitsByChannel(c).linkedin === 0);
}

// An empty row claims neither channel.
{
  const c = { cohort: "b", sent: 0, visits: 0, _sources: {} };
  ok("empty row is unknown", channelOf(c) === "unknown", channelOf(c));
}

console.log(pass + " passed, " + fails.length + " failed");
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length ? 1 : 0);
