// Regression tests for the assertions added on 2026-09-15.
//
// The first two reproduce the exact failure: the no-hook campaign did not
// exist, importLeads returned a "skipped" string, and the old code answered
// ok:true. If either of these ever passes again, a cohort can half-load and
// report success.
//
// Run: node scripts/test_cohort_build_checks.mjs
import { checker, assertImported, collectVariants, launchBlockers } from "../api/cohort/build.js";
import { renderFaults, renderFaultsIn } from "../lib/render-check.js";
import { campaignStatusName, CAMPAIGN_STATUS_ACTIVE } from "../lib/instantly.js";

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

console.log("\n2026-09-15 / 09-16 regression: spintax reached the inbox");

// What actually landed in 412 inboxes. Instantly substituted the variables and
// sent the braces and the pipe verbatim.
t("the subject that shipped on 15 Sep is caught", () => {
  const subject = "{quick one, {{firstName}}|before the year closes out, {{firstName}}}";
  eq(renderFaults(subject, { allowVariables: true }).length, 1, "faults");
});

t("the subject that shipped on 16 Sep is caught", () => {
  const subject = "{6 out of 10|most won't say this out loud}";
  eq(renderFaults(subject, { allowVariables: true }).length, 1, "faults");
});

t("the subject Bruno chose passes", () => {
  eq(renderFaults("the 6 out of 10 number", { allowVariables: true }).length, 0, "faults");
  eq(renderFaults("closing the loop", { allowVariables: true }).length, 0, "faults");
});

t("a template variable is fine in a template and a fault in a sent email", () => {
  eq(renderFaults("Hi {{firstName}},", { allowVariables: true }).length, 0, "template");
  eq(renderFaults("Hi {{firstName}},", { allowVariables: false }).length, 1, "sent");
});

t("spintax anywhere in a sequence is found, subject or body", () => {
  const sequences = [{ steps: [
    { variants: [{ subject: "clean", body: "Hi {{firstName}}" }] },
    { variants: [{ subject: "also clean", body: "pick {one|the other}" }] },
  ] }];
  const faults = collectVariants(sequences).flatMap((v) => renderFaultsIn(v, { allowVariables: true }));
  eq(faults.length, 1, "faults");
  eq(faults[0].where, "body", "where");
});

t("the placeholder from the 267 stale drafts is still caught", () => {
  eq(renderFaults("[INSERT THIS CONTACT'S GROWTH GAP REPORT LINK]", { allowVariables: true }).length, 1, "faults");
});

t("ordinary prose with a brace is not a false positive", () => {
  eq(renderFaults("we scored 9/10 {see attached}", { allowVariables: true }).length, 0, "faults");
  eq(renderFaults("a | b in a table row", { allowVariables: true }).length, 0, "faults");
});

console.log("\n2026-09-22 launch gate");

t("a clean cohort launches", () => {
  const c = checker(false);
  c.fail("campaign.hook.leadCount", true, "98 in the campaign, 98 expected");
  c.fail("campaign.hook.rendersClean", true, "no template syntax left unrendered");
  eq(launchBlockers(c.checks).length, 0, "blockers");
});

// The reason this gate is not just strict=1. Every healthy cohort screens
// somebody out, and strict calls that a failure.
t("the ICP screen rejecting leads does not block a launch", () => {
  const c = checker(true);
  c.warn("leads.screenedOut", false, "4 lead(s) dropped: EXCLUDE on the ICP check");
  c.warn("deals.closedDropped", false, "2 lead(s) dropped: their deal is no longer open");
  c.warn("leads.company", false, "3 of 231 lead(s) have no company");
  eq(c.failures().length, 3, "strict would have blocked all three");
  eq(launchBlockers(c.checks).length, 0, "blockers");
});

t("spintax in the built campaign blocks the launch", () => {
  const c = checker(false);
  c.fail("campaign.hook.rendersClean", false, "spintax in subject");
  eq(launchBlockers(c.checks).length, 1, "blockers");
});

t("a short campaign blocks the launch", () => {
  const c = checker(false);
  c.fail("campaign.noHook.leadCount", false, "104 in the campaign, 133 expected");
  eq(launchBlockers(c.checks).length, 1, "blockers");
});

// Capacity is a warn, and it must still block: Instantly does not error when a
// cohort outgrows its mailboxes, it spills the remainder into the next days.
t("not enough sending capacity blocks the launch", () => {
  const c = checker(false);
  c.warn("campaign.hook.capacity", false, "90 sends/day across 3 warm mailbox(es) for 231 lead(s)");
  eq(c.failures().length, 0, "not a failure to a non-strict reader");
  eq(launchBlockers(c.checks).length, 1, "blockers");
});

t("campaign status names", () => {
  eq(campaignStatusName(0), "draft", "0");
  eq(campaignStatusName(CAMPAIGN_STATUS_ACTIVE), "active", "1");
  eq(campaignStatusName(2), "paused", "2");
  eq(campaignStatusName(9), "unknown(9)", "9");
});

console.log(failures ? "\n" + failures + " test(s) failed" : "\nall tests passed");
process.exit(failures ? 1 : 0);
