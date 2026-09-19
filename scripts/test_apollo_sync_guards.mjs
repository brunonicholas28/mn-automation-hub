// The Pipedrive budget guard and the synced-contact digest.
//
// These two decide whether the week's lead supply keeps flowing. When the
// budget was exhausted on 17-19 Sep the whole cohort died downstream and
// nothing alerted, so the guard that replaces that failure mode is tested
// rather than trusted.
process.env.UPSTASH_REDIS_REST_URL ||= "https://example.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "stub";

const { wouldExceedBudget, emailDigest } = await import("../lib/jobs/apollo-sync.js");

let pass = 0; const fails = [];
const ok = (n, c, d) => (c ? pass++ : fails.push(n + (d ? " -> " + d : "")));

// --- budget guard -------------------------------------------------------
// Signature: (spentToday, callsThisRun, budget, perContact)
ok("fresh day, plenty of budget", wouldExceedBudget(0, 0, 1200, 3) === false);
ok("mid-run, still fine", wouldExceedBudget(600, 300, 1200, 3) === false);

// Exactly at the boundary: 1197 spent + 3 more = 1200, which is NOT over.
ok("exactly on budget is allowed", wouldExceedBudget(1197, 0, 1200, 3) === false);
ok("one past the boundary stops", wouldExceedBudget(1198, 0, 1200, 3) === true);
ok("boundary counts this run too", wouldExceedBudget(1000, 197, 1200, 3) === false);
ok("boundary trips on this run's spend", wouldExceedBudget(1000, 198, 1200, 3) === true);

// A day that is already blown stops immediately rather than adding to it.
ok("already over budget stops at once", wouldExceedBudget(5000, 0, 1200, 3) === true);

// Defensive: nulls must not read as NaN and silently disable the guard.
ok("null spent is treated as zero", wouldExceedBudget(null, 0, 1200, 3) === false);
ok("undefined calls treated as zero", wouldExceedBudget(0, undefined, 1200, 3) === false);
ok("nulls do not disable the guard", wouldExceedBudget(null, 1199, 1200, 3) === true);

// A budget of zero must stop everything, not let everything through.
ok("zero budget stops everything", wouldExceedBudget(0, 0, 0, 3) === true);

// --- email digest -------------------------------------------------------
const a = emailDigest("Someone@Example.COM");
const b = emailDigest("  someone@example.com  ");
ok("digest is case and whitespace insensitive", a === b, `${a} vs ${b}`);
ok("digest is short", a.length === 12, String(a.length));
ok("digest is url-safe", /^[A-Za-z0-9_-]+$/.test(a), a);
ok("different emails differ", emailDigest("a@b.com") !== emailDigest("c@d.com"));
ok("digest is stable across calls", emailDigest("a@b.com") === emailDigest("a@b.com"));
// It must not be reversible to an address - it is stored in a shared KV.
ok("digest does not contain the address", !a.includes("someone") && !a.includes("example"));

console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length ? 1 : 0);
