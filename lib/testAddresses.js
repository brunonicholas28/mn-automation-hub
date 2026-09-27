// Addresses that must never be enrolled in a prospect sequence.
//
// Every end-to-end test of the Growth Gap Session booking form creates a real
// partial record - it has to, or it would not be testing anything - and that
// record enrols a real person in the three-touch recovery sequence. Seven test
// walks between 24 and 26 Sep 2026 put seven fake prospects into the live
// funnel and sent Bruno a dozen-odd emails addressed to "Attr", "Stamp",
// "Badge" and friends. They also inflated `session:partials.reached_step2`,
// which is the one counter that answers "has a real ad visitor converted yet?"
// - so the tests corrupted the exact number the flight exists to measure.
//
// Matching is on a NORMALISED address, so one entry catches every variant:
// brunonicholas28+attr@gmail.com, bruno.nicholas28@gmail.com and
// BrunoNicholas28@googlemail.com all collapse to the same base.
//
// Configure with SESSION_TEST_EMAILS (comma-separated). Nothing is hardcoded:
// this repo is public and a real address does not belong in it.

const DEFAULT_TEST_DOMAINS = [
  "example.com",
  "example.org",
  "example.net",
  "test",
  "invalid",
  "localhost",
];

// Gmail ignores dots and everything after a +, so two addresses that look
// different are one mailbox. Other providers are left alone apart from the
// plus tag, which is near-universal and is how anyone tags a test.
export function normaliseEmail(raw) {
  const e = String(raw == null ? "" : raw).trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return e;

  let local = e.slice(0, at);
  const domain = e.slice(at + 1);

  const plus = local.indexOf("+");
  if (plus > -1) local = local.slice(0, plus);

  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.replace(/\./g, "")}@gmail.com`;
  }
  return `${local}@${domain}`;
}

function listFromEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Configured domains EXTEND the defaults rather than replacing them. There is
// no situation in which someone wants example.com to start receiving chase
// emails, and a half-written env var should not be able to re-enable it.
export function testDomains() {
  return [...new Set([...DEFAULT_TEST_DOMAINS, ...listFromEnv("SESSION_TEST_DOMAINS")])];
}

export function testEmails() {
  return [...new Set(listFromEnv("SESSION_TEST_EMAILS").map(normaliseEmail))];
}

export function isTestAddress(raw) {
  const e = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!e) return false;

  const at = e.lastIndexOf("@");
  if (at < 1) return false;

  if (testDomains().includes(e.slice(at + 1))) return true;
  return testEmails().includes(normaliseEmail(e));
}

export default isTestAddress;
