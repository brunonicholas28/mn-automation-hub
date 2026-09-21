// The three recovery emails for someone who completed step 2 of the Growth
// Gap Session booking form and never picked a slot.
//
// These are not the report funnel's recovery touches and must not be
// confused with them. That sequence chases someone who read a report; this
// one chases someone who got as far as the calendar. They are further along,
// so the copy is shorter, more direct, and never sends them to the
// diagnostic - a questionnaire is a downgrade for someone who was one click
// from a booking.
//
// Plain formatting on purpose. These read as personal notes from Marina, and
// a designed template with a header image and a button would undo that.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.SESSION_FROM_EMAIL || process.env.DIGEST_FROM_EMAIL || "hello@marinanicholas.com";
const REPLY_TO = process.env.SESSION_REPLY_TO || FROM;
const BOOKING_URL =
  process.env.SESSION_BOOKING_URL ||
  "https://calendly.com/marina8/book-a-free-discovery-call";

// Hours after capture. E1 lands the same session while the decision is still
// warm; E2 answers the objection that actually stops people; E3 names the
// real reason they are hesitating and then stops.
export const SCHEDULE = { e1: 1, e2: 48, e3: 144 };

function link(touch) {
  const u = new URL(BOOKING_URL);
  u.searchParams.set("utm_source", "session-recovery");
  u.searchParams.set("utm_medium", "email");
  u.searchParams.set("utm_campaign", "growth-gap-session");
  u.searchParams.set("utm_content", touch);
  return u.toString();
}

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function wrap(paragraphs, href, linkLabel) {
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 16px;">${p}</p>`)
    .join("");
  return [
    '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:16px;line-height:1.65;color:#16324F;max-width:560px;">',
    body,
    href
      ? `<p style="margin:0 0 16px;"><a href="${esc(href)}" style="color:#2EA8BE;">${esc(linkLabel)}</a></p>`
      : "",
    '<p style="margin:0;">Marina</p>',
    '<p style="margin:26px 0 0;font-size:12px;color:#8195A6;">You gave us this address when you started booking a Growth Gap Session. Reply STOP and you will not hear from us again.</p>',
    "</div>",
  ].join("");
}

export const TEMPLATES = {
  e1: (r) => ({
    subject: "the last step",
    html: wrap(
      [
        `${esc(r.first || "Hello")} &mdash;`,
        "You got as far as the calendar and stopped. That is usually one of two things: the diary genuinely did not have forty-five minutes in it this week, or something about the call itself gave you pause.",
        "If it is the first, here is the link again. Next week is open.",
        "If it is the second, reply and tell me which part. I would rather answer it than have you book something you are unsure about.",
      ],
      link("recover1"),
      "Pick a time"
    ),
  }),
  e2: (r) => ({
    subject: "what actually happens on it",
    html: wrap(
      [
        `${esc(r.first || "Hello")} &mdash;`,
        "Most people who hesitate here have sat through a &ldquo;free strategy session&rdquo; before and found it was a sales call with a diagnosis bolted on the front.",
        "So, plainly. Forty-five minutes. You describe what is happening; I tell you what I think is causing it. You leave with the three things holding it in place and what to do about them, in writing, within twenty-four hours &mdash; whether or not we ever speak again.",
        "If at the end it is obvious I can help, I will say so and we will talk about how. If it is not, I will say that too. That is the whole commercial arrangement.",
      ],
      link("recover2"),
      "Book the session"
    ),
  }),
  e3: (r) => ({
    subject: "last one from me",
    html: wrap(
      [
        `${esc(r.first || "Hello")} &mdash;`,
        "I will leave this alone after today.",
        "The thing I would say, having done this with a hundred-odd businesses: the ones who wait are almost never waiting because they do not know something is wrong. They wait because they think they ought to be able to work it out themselves, and asking feels like conceding they cannot.",
        "It is not. Nobody sees their own business from outside it. That is the entire reason this takes forty-five minutes rather than four months.",
        "And if the answer is no, that is genuinely fine.",
      ],
      link("recover3"),
      "Book the session"
    ),
  }),
};

export async function sendTouch(touch, record) {
  if (!RESEND_API_KEY) {
    console.warn("[session-recovery] RESEND_API_KEY not set - skipping", touch, record.email);
    return { skipped: true };
  }
  const built = TEMPLATES[touch](record);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      reply_to: REPLY_TO,
      to: record.email,
      subject: built.subject,
      html: built.html,
      headers: { "List-Unsubscribe": `<mailto:${REPLY_TO}?subject=STOP>` },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${text.slice(0, 200)}`);
  }
  return { sent: true };
}
