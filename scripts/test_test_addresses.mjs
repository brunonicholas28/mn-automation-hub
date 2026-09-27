// Unit tests for lib/testAddresses.js — no network, no Redis.
//   node scripts/test_test_addresses.mjs

import assert from "node:assert/strict";

process.env.SESSION_TEST_EMAILS = "owner@example-real.co.uk, Bruno.Nicholas28@GMAIL.com";
process.env.SESSION_TEST_DOMAINS = "mn-internal.test";

const { isTestAddress, normaliseEmail, testDomains, testEmails } = await import("../lib/testAddresses.js");

let n = 0;
const ok = (cond, label) => { n++; assert.ok(cond, label); };
const eq = (a, b, label) => { n++; assert.equal(a, b, label); };

// --- normalisation -------------------------------------------------------
eq(normaliseEmail("Bruno.Nicholas28+attr@Gmail.com"), "brunonicholas28@gmail.com", "gmail: dots and plus tag both stripped");
eq(normaliseEmail("brunonicholas28@googlemail.com"), "brunonicholas28@gmail.com", "googlemail folds to gmail");
eq(normaliseEmail("first.last+tag@company.co.uk"), "first.last@company.co.uk", "non-gmail keeps dots, drops tag");
eq(normaliseEmail("  MiXeD@Case.COM  "), "mixed@case.com", "trimmed and lowercased");
eq(normaliseEmail(""), "", "empty is empty");
eq(normaliseEmail("not-an-email"), "not-an-email", "no @ passes through untouched");
eq(normaliseEmail("@nolocal.com"), "@nolocal.com", "missing local part is not mangled");

// --- the addresses that caused this --------------------------------------
for (const tag of ["attr", "stamp", "creative", "badge", "cal", "clean", "test", "capitest260926"]) {
  ok(isTestAddress(`brunonicholas28+${tag}@gmail.com`), `+${tag} is suppressed`);
}
ok(isTestAddress("brunonicholas28@gmail.com"), "the bare configured address is suppressed too");
ok(isTestAddress("BRUNONICHOLAS28+Attr@Gmail.Com"), "case is irrelevant");

// --- junk domains --------------------------------------------------------
for (const d of ["example.com", "example.org", "test", "invalid", "localhost", "mn-internal.test"]) {
  ok(isTestAddress(`someone@${d}`), `${d} is a test domain`);
}
ok(testDomains().includes("example.com"), "defaults survive a configured SESSION_TEST_DOMAINS");
ok(testDomains().includes("mn-internal.test"), "configured domains are added");

// --- real prospects must NOT be caught ------------------------------------
const real = [
  "sarah@heaford.co.uk",
  "t.myers@ecoproviders.co.uk",
  "someone+newsletter@realcompany.com",   // a real person's own plus tag
  "brunonicholas28@outlook.com",          // same local part, different provider
  "notbrunonicholas28@gmail.com",         // substring, not a match
  "bruno@marinanicholas.com",
];
for (const e of real) ok(!isTestAddress(e), `${e} is NOT suppressed`);

// --- degenerate input -----------------------------------------------------
for (const e of ["", "   ", null, undefined, "@", "nope"]) {
  ok(!isTestAddress(e), `${JSON.stringify(e)} is not a test address`);
}

eq(testEmails().length, 2, "both configured emails parsed");
ok(testEmails().includes("brunonicholas28@gmail.com"), "configured email is stored normalised");

console.log(`ok — ${n} assertions passed`);
