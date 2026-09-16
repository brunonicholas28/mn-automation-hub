// What a rendered email must never contain.
//
// This exists because of 2026-09-15 and 2026-09-16. Both sends went out with
// the subject line rendered literally:
//
//   {quick one, Thomas|before the year closes out, Thomas}
//   {6 out of 10|most won't say this out loud}
//
// 412 emails across two cohorts. **Instantly substitutes {{variables}} at send
// time but does not expand spintax on this account** - it sends the braces and
// the pipe verbatim. Every check we had looked at configuration and passed,
// because the template was exactly what we meant it to be. Nothing looked at
// what arrived.
//
// One definition of "broken", used by both the pre-send gate (against the
// template, where {{variables}} are legitimate) and the post-send audit
// (against what Instantly actually sent, where they are not).

const SPINTAX = /\{[^{}]*\|[^{}]*\}/g;
const VARIABLE = /\{\{[^{}]*\}\}/g;
const PLACEHOLDER = /\[\s*INSERT[^\]]*\]/gi;

// Strip {{variables}} before looking for spintax, so {{firstName}} inside a
// spintax block does not hide the block from the scan - which is exactly the
// shape that shipped on 2026-09-15.
function withoutVariables(text) {
  return String(text || "").replace(VARIABLE, " ");
}

function sample(match) {
  const s = String(match).replace(/\s+/g, " ").trim();
  return s.length > 70 ? s.slice(0, 67) + "..." : s;
}

// allowVariables: true when scanning a template (a {{variable}} there is the
// point), false when scanning a sent email (one there means it never resolved).
export function renderFaults(text, { allowVariables = false } = {}) {
  const raw = String(text || "");
  const faults = [];

  for (const m of withoutVariables(raw).matchAll(SPINTAX)) {
    faults.push({ kind: "spintax", sample: sample(m[0]) });
  }
  for (const m of raw.matchAll(PLACEHOLDER)) {
    faults.push({ kind: "placeholder", sample: sample(m[0]) });
  }
  if (!allowVariables) {
    for (const m of raw.matchAll(VARIABLE)) {
      faults.push({ kind: "unresolved-variable", sample: sample(m[0]) });
    }
  }
  return faults;
}

// Convenience for a subject+body pair.
export function renderFaultsIn({ subject, body }, opts) {
  return [
    ...renderFaults(subject, opts).map((f) => ({ ...f, where: "subject" })),
    ...renderFaults(body, opts).map((f) => ({ ...f, where: "body" })),
  ];
}

export function describeFaults(faults, limit = 3) {
  if (!faults.length) return "no template syntax left unrendered";
  const shown = faults
    .slice(0, limit)
    .map((f) => (f.where ? f.where + " " : "") + f.kind + ' "' + f.sample + '"');
  const more = faults.length > limit ? " (+" + (faults.length - limit) + " more)" : "";
  return shown.join("; ") + more;
}
