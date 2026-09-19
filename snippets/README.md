# Snippets

**These files are mirrors of live configuration, not the source of truth.**

Nothing in this folder is deployed by pushing it. Each file is pasted by hand
into a third-party dashboard, and the copy in that dashboard is what actually
runs. This folder exists so the code is reviewable and recoverable — not so it
can be deployed.

Every file here was exported from the live dashboard on 2026-09-14 and is
byte-identical to what was running at that moment. Before this, all three files
that existed had drifted from live, in ways that would have broken things if
pasted back. See "Why this matters" below.

## Where each file lives

| File | Lives in | Snippet name there | Insert |
|---|---|---|---|
| `netlify-visit-beacon.html` | Netlify → growth.marinanicholas.com | Cohort visit beacon v3 (lid + utm_content) | before `</body>` |
| `netlify-inline-form-embed.html` | Netlify → growth.marinanicholas.com | Inline Growth Gap form embed (v8 - utm_content) | before `</body>` |
| `netlify-cta-host-swap.html` | Netlify → growth.marinanicholas.com | CTA host swap v2 (carries lid) | before `</body>` |
| `netlify-hero-cta-microcopy.html` | Netlify → growth.marinanicholas.com | Hero CTA microcopy update (2026-08-27) | before `</body>` |
| `netlify-ensure-rid.html` | Netlify → growth.marinanicholas.com | Ensure rid before inline embed (v1) | before `</head>` |
| `fillout-form-beacon.html` | Fillout → Growth Gap Report → Settings → Custom code | (single custom-code block) | n/a |
| `netlify-report-preview-mobile-fix.html` | **NOT DEPLOYED** | — | would be before `</body>` |

Netlify path: Project configuration → Build & deploy → Post processing →
Snippet injection. Netlify snippets cannot be edited in place — changing one
means Remove then Add, so the name changes on every revision. That is why the
version number lives in the snippet name rather than in the file.

## The rule

Change one, change both, in the same sitting. A file here that has drifted from
live is worse than no file at all, because it looks authoritative.

When you change a snippet in a dashboard, re-export it into this folder
verbatim — no added comment headers, no reformatting. The files must stay
paste-back-ready, so that anyone can copy one into the dashboard without
having to think about what to strip.

## Why this matters — three real traps, all found on 2026-09-14

1. **`netlify-visit-beacon.html` had diverged.** The live version reads
   `p.get('utm_' + 'campaign')`, splitting the parameter name with string
   concatenation. The repo version used a plain `p.get('utm_campaign')`. The
   reason for the concatenation is not recorded anywhere and was not
   established — but it is in the version that demonstrably works, so **do not
   "tidy" it away** without first proving the plain form still fires.

2. **`fillout-form-beacon.html` was completely wrong.** The live custom code
   contains `if (window.self !== window.top) return;` — it deliberately does
   **nothing** inside an iframe, which is always, since the form went inline.
   The "started" event is reported by the landing page's inline-embed snippet
   instead. The old repo version had no such guard, so pasting it in would have
   started **double-counting every report start**.

3. **`netlify-inline-form-embed.html` did not exist here at all**, despite
   being the snippet that renders the form and reports `stage=started`. It was
   referenced in `landing-page-inline-form-embed-spec.md` under a filename that
   was never committed.

## One file here is not live

`netlify-report-preview-mobile-fix.html` fixes the hero report preview on
phones (the frame is squeezed below the content's ~395px reflow floor, so the
preview crops mid-word and the CTA lands on a half-visible row). It is written
and tested but **has not been added to Netlify**. Add it as a *new* snippet —
it replaces nothing.

## How these were exported

Read out of each dashboard's own DOM and downloaded as a file, rather than
retyped. Worth doing the same way next time: the Netlify snippet bodies are
1–8 KB and hand-transcription is exactly how drift gets introduced.
