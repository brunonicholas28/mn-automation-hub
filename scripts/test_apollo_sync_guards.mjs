// The Pipedrive budget guard and the synced-contact digest.
//
// These two decide whether the week's lead supply keeps flowing. When the
// budget was exhausted on 17-19 Sep the whole cohort died downstream and
// nothing alerted, so the guard that replaces that failure mode is tested
// rather than trusted.
process.env.UPSTASH_REDIS_REST_URL ||= "https://example.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "stub";

const { wouldExceedBudget, emailDigest, hasSweptQueue } = await import("../lib/jobs/apollo-sync.js");
const { PIPEDRIVE_DAILY_BUDGET } = await import("../lib/pipedrive.js");

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

// --- cursor advance guard, added 2026-09-19 after the Vercel 504 ---------
// Advancing the cursor after an early stop is silent: every later run then
// stops at the first contact it looks at and reports a clean "nothing to do"
// while the queue sits untouched.
ok("reaching the cursor counts as a full sweep",
  hasSweptQueue({ reachedCursor: true, pagesExhausted: false, budgetStopped: false, timeStopped: false }) === true);
ok("running out of pages counts as a full sweep",
  hasSweptQueue({ reachedCursor: false, pagesExhausted: true, budgetStopped: false, timeStopped: false }) === true);
ok("a time-stopped run has not swept the queue",
  hasSweptQueue({ reachedCursor: false, pagesExhausted: false, budgetStopped: false, timeStopped: true }) === false);
ok("a budget-stopped run has not swept the queue",
  hasSweptQueue({ reachedCursor: false, pagesExhausted: false, budgetStopped: true, timeStopped: false }) === false);
ok("an early stop overrides a sweep flag set earlier in the run",
  hasSweptQueue({ reachedCursor: true, pagesExhausted: false, budgetStopped: false, timeStopped: true }) === false);
ok("the budget guard overrides both sweep flags",
  hasSweptQueue({ reachedCursor: true, pagesExhausted: true, budgetStopped: true, timeStopped: false }) === false);
ok("a run that did neither has not swept the queue",
  hasSweptQueue({ reachedCursor: false, pagesExhausted: false, budgetStopped: false, timeStopped: false }) === false);
ok("missing flags do not imply a sweep", hasSweptQueue({}) === false);


// --- the shared ceiling, added 2026-09-19 after run #6 ------------------
// Pipedrive refused us at 1106 calls while apollo-sync's own tally read 1080
// of its private 1200. The ceiling must sit below what we have actually seen
// refused, with room for the other jobs on the same token.
ok("the default ceiling is below the observed refusal point",
  PIPEDRIVE_DAILY_BUDGET < 1106, String(PIPEDRIVE_DAILY_BUDGET));
ok("the default ceiling leaves real headroom, not a token margin",
  PIPEDRIVE_DAILY_BUDGET <= 1000, String(PIPEDRIVE_DAILY_BUDGET));
ok("the guard uses that shared ceiling by default",
  wouldExceedBudget(PIPEDRIVE_DAILY_BUDGET - 2, 0) === true);
ok("and still lets work through well under it",
  wouldExceedBudget(0, 0) === false);


console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length ? 1 : 0);
