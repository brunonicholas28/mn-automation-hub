// Sends the weekly LinkedIn shortlist digest via Resend - reusing the same
// service and verified sending domain (hello@marinanicholas.com) already set
// up for the Growth Gap Report pipeline's booking-confirmation emails.
//
// Env vars required: RESEND_API_KEY
// Env vars optional: DIGEST_FROM_EMAIL (default hello@marinanicholas.com),
//                     DIGEST_TO_EMAIL (who receives the weekly shortlist)

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.DIGEST_FROM_EMAIL || "hello@marinanicholas.com";
const TO = process.env.DIGEST_TO_EMAIL;

export async function sendShortlistDigest({ cohortLetter, fastTrack, ranked }) {
  if (!RESEND_API_KEY || !TO) {
    console.warn("RESEND_API_KEY or DIGEST_TO_EMAIL not set - skipping digest email");
    return { skipped: true };
  }

  const row = (c) =>
    `<tr><td>${c.name}</td><td>${c.email}</td><td>${c.score}</td><td>${c.dealUrl ? `<a href="${c.dealUrl}">deal</a>` : ""}</td></tr>`;

  const html = `
    <h2>Cohort ${cohortLetter} — Week's LinkedIn shortlist</h2>
    <h3>Fast-track (network proximity, ${fastTrack.length})</h3>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th>Name</th><th>Email</th><th>Score</th><th>Deal</th></tr>
      ${fastTrack.map(row).join("")}
    </table>
    <h3>Ranked (${ranked.length})</h3>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th>Name</th><th>Email</th><th>Score</th><th>Deal</th></tr>
      ${ranked.map(row).join("")}
    </table>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: TO,
      subject: `LinkedIn shortlist — Cohort ${cohortLetter} (${fastTrack.length + ranked.length} contacts)`,
      html,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend send failed: ${res.status} ${text}`);
  }
  return { skipped: false };
}
