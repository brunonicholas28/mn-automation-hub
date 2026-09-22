// LinkedIn Conversions API — server-side conversion events.
//
// Why this exists: the Insight Tag can no longer tell us anything useful.
// The client-side `lintrk('track')` hook was removed on 2026-09-17 after it
// turned out to fire on Fillout's embed-init message rather than on any real
// engagement, which made the conversion count track page loads. Since then
// the base tag has been running with no conversion firing at all, so the ad
// account has had no conversion signal whatsoever.
//
// The booking is a server-side event — Calendly posts it to us — so that is
// where it should be measured from. No browser, no cookie, no consent
// surface, and nothing that can be broken by an iframe changing its
// postMessage vocabulary.
//
// Access note: this uses the *Direct API* token an advertiser generates in
// Campaign Manager (Data > Signals Manager > Direct API), NOT an OAuth token
// from a Developer Portal app. It does not expire, which is deliberate —
// a refresh flow is one more thing to silently stop working mid-flight.
//
// Docs: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api
//
// NOTE: this file is deliberately duplicated in the phoenix repo
// (lib/linkedinCapi.js). Same logic, different module syntax — phoenix's
// webhook handlers are CommonJS, this repo is ESM. The two conversions fire
// from different apps, so a shared package would be the only alternative and
// that is not worth a private registry for 150 lines. If you change the
// payload shape here, change it there too.

import crypto from "crypto";

const API_URL = "https://api.linkedin.com/rest/conversionEvents";

// Pinned, not derived from the current date. LinkedIn versions are dated
// (yyyymm) and roll monthly; deriving this would silently move us onto an
// unreleased version at every month boundary.
const LINKEDIN_VERSION = "202608";

// SHA256 of the lowercased, trimmed address, hex encoded. LinkedIn matches on
// exactly this — any stray whitespace or capital letter produces a hash that
// matches nothing, and it fails silently as a simple non-match.
function sha256Email(email) {
  return crypto
    .createHash("sha256")
    .update(String(email).trim().toLowerCase())
    .digest("hex");
}

/**
 * Send one conversion event. Never throws, never blocks: a measurement
 * failure must not be able to cost us a booking. Returns a small result
 * object purely so the caller can log it.
 */
async function sendConversion({
  conversionId,
  email,
  liFatId,
  happenedAt = Date.now(),
  eventId,
  firstName,
  lastName,
  companyName,
  countryCode = "GB",
}) {
  const token = process.env.LINKEDIN_CAPI_TOKEN;

  // Absent config degrades to no measurement, never to a broken booking.
  if (!token) return { skipped: true, reason: "no LINKEDIN_CAPI_TOKEN" };
  if (!conversionId) return { skipped: true, reason: "no conversionId" };
  if (!email && !liFatId) return { skipped: true, reason: "nothing to match on" };

  // LinkedIn rejects anything older than 90 days outright. Nothing here should
  // ever be near that, but a clock problem or a replayed webhook shouldn't
  // produce a 400 we then have to go and read the logs to understand.
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
  if (Date.now() - happenedAt > NINETY_DAYS) {
    return { skipped: true, reason: "older than the 90-day window" };
  }

  const userIds = [];
  if (email) userIds.push({ idType: "SHA256_EMAIL", idValue: sha256Email(email) });
  // The click ID is what takes match rate from roughly 40-60% to 95%+.
  // Email alone works, but B2B people routinely sign up with an address that
  // is not the one on their LinkedIn profile, which is exactly the population
  // we are advertising to.
  if (liFatId) {
    userIds.push({
      idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID",
      idValue: String(liFatId).slice(0, 200),
    });
  }

  const userInfo = { countryCode };
  if (firstName) userInfo.firstName = String(firstName).toLowerCase().slice(0, 80);
  if (lastName) userInfo.lastName = String(lastName).toLowerCase().slice(0, 80);
  if (companyName) userInfo.companyName = String(companyName).toLowerCase().slice(0, 120);

  const body = {
    conversion: `urn:lla:llaPartnerConversion:${conversionId}`,
    conversionHappenedAt: Math.round(happenedAt),
    // Stable per real-world event, so Calendly's webhook retries cannot
    // inflate the count. Without this a retried delivery is a second
    // conversion, which quietly flatters cost-per-booking.
    ...(eventId ? { eventId: String(eventId).slice(0, 250) } : {}),
    user: { userIds, userInfo },
  };

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Restli-Protocol-Version": "2.0.0",
        "LinkedIn-Version": LINKEDIN_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn("[linkedin-capi] %s %s", res.status, detail.slice(0, 400));
      return { ok: false, status: res.status };
    }
    console.log(
      "[linkedin-capi] sent conversion %s (ids: %s)",
      conversionId,
      userIds.map((u) => u.idType).join("+")
    );
    return { ok: true, status: res.status };
  } catch (err) {
    console.warn("[linkedin-capi] request threw (non-fatal):", err?.message);
    return { ok: false, error: err?.message };
  }
}

/**
 * Should this booking be reported to LinkedIn at all?
 *
 * Not every booking comes from an ad — cold email produces them too. Sending
 * those would not corrupt attribution (LinkedIn only attributes what it can
 * match) but it would inflate the conversion rule's raw count, and a number
 * that looks like ad performance but isn't is worse than no number.
 *
 * So: a click ID is proof, and utm_source=linkedin is the fallback for
 * someone who clicked an ad in a context where the click ID did not survive.
 */
function looksLinkedInSourced({ liFatId, utmSource }) {
  if (liFatId) return true;
  return String(utmSource || "").toLowerCase() === "linkedin";
}

// Calendly gives us one display name; LinkedIn wants the parts. Naive on
// purpose — this is a matching hint, not a record we are storing.
function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: null, lastName: null };
  return { firstName: parts[0], lastName: parts.length > 1 ? parts[parts.length - 1] : null };
}

export { sendConversion, looksLinkedInSourced, splitName, sha256Email };
