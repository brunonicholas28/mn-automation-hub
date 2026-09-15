// Regression tests for the assertions added on 2026-09-15.
//
// The first two reproduce the exact failure: the no-hook campaign did not
// exist, importLeads returned a "skipped" string, and the old code answered
// ok:true. If either of these ever passes again, a cohort can half-load and
// report success.
//
// Run: node scripts/test_cohort_build_checks.mjs
import { checker, assertImported, collectVariants } from "../api/cohort/build.js";

let failures = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log("  ok   " + name);
  } catch (err) {
    failures += 1;
    console.log("  FAIL " + name + " - " + err.message);
  }
};
const eq = (a, b, what) => {
  if (a !== b) throw new Error((what || "") + " expected " + JSON.stringify(b) + ", got " + JSON.stringify(a));
};

console.log("2026-09-15 regression");

t("a skipped half fails the run", () => {
  const c = checker(false);
  assertImported(c, "noHook", { skipped: "the no-hook campaign does not exist yet" }, 131);
  eq(c.failures().length, 1, "failures");
});

t("a half that loads nothing when it had work fails", () => {
  const c = checker(false);
  assertImported(c, "noHook", { imported: 0, skippedAlreadyInCampaign: 0 }, 131);
  eq(c.failures().length, 1, "failures");
});

t("a fully loaded half passes", () => {
  const c = checker(false);
  assertImported(c, "hook", { imported: 115, skippedAlreadyInCampaign: 0, failed: 0 }, 115);
  eq(c.failures().length, 0, "failures");
});

t("a re-run that finds everyone already there passes", () => {
  const c = checker(false);
  assertImported(c, "hook", { imported: 0, skippedAlreadyInCampaign: 115, failed: 0 }, 115);
  eq(c.failures().length, 0, "failures");
});

t("a short load fails even when nothing errored", () => {
  const c = checker(false);
  assertImported(c, "hook", { imported: 110, skippedAlreadyInCampaign: 0, failed: 0 }, 115);
  eq(c.failures().length, 1, "failures");
});

t("leads Instantly rejected fail the run", () => {
  const c = checker(false);
  assertImported(c, "hook", { imported: 113, skippedAlreadyInCampaign: 0, failed: 2, failureSample: ["bad address"] }, 115);
  if (c.failures().length < 1) throw new Error("expected at least one failure");
});

t("an empty half is not a failure", () => {
  const c = checker(false);
  assertImported(c, "noHook", { skipped: "no campaign" }, 0);
  eq(c.failures().length, 0, "failures");
});

console.log("severity");

t("a warn passes normally and fails under strict", () => {
  const loose = checker(false);
  loose.warn("leads.company", false, "265 blank");
  eq(loose.failures().length, 0, "loose");

  const tight = checker(true);
  tight.warn("leads.company", false, "265 blank");
  eq(tight.failures().length, 1, "strict");
});

console.log("template health");

t("the empty first step in TEMPLATE - Day 2 no hook is visible", () => {
  // The shape found in Instantly on 2026-09-15: step 1 blank, steps 2 and 3
  // carrying copy.
  const sequences = [{ steps: [
    { variants: [{ subject: "", body: "" }] },
    { variants: [{ subject: "{6 out of 10}", body: "Hi {{firstName}}, ..." }] },
    { variants: [{ subject: "{closing the loop}", body: "... {{companyName}} ..." }] },
  ] }];
  const variants = collectVariants(sequences);
  const blank = variants.filter((v) => !v.body).length;
  eq(variants.length, 3, "variants found");
  eq(blank, 1, "blank steps");
});

t("merge fields are pulled out of whatever shape the steps arrive in", () => {
  const sequences = [{ steps: [{ variants: [{ subject: "hi {{firstName}}", body: "{{hook}} {{reportLink}} {{Company Name}}" }] }] }];
  const used = new Set();
  for (const v of collectVariants(sequences)) {
    for (const m of (v.subject + " " + v.body).matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) used.add(m[1]);
  }
  eq(used.has("firstName"), true, "firstName");
  eq(used.has("hook"), true, "hook");
  eq(used.has("reportLink"), true, "reportLink");
  // "{{Company Name}}" has a space, so it is not a variable Instantly resolves
  // and must not be mistaken for companyName.
  eq(used.has("companyName"), false, "companyName");
});

t("a healthy template reports no blank steps", () => {
  const sequences = [{ steps: [
    { variants: [{ subject: "a", body: "Hi {{firstName}}" }] },
    { variants: [{ subject: "b", body: "Here is {{reportLink}}" }] },
  ] }];
  eq(collectVariants(sequences).filter((v) => !v.body).length, 0, "blank steps");
});

console.log(failures ? "\n" + failures + " test(s) failed" : "\nall tests passed");
process.exit(failures ? 1 : 0);
