// Live cold-outreach funnel dashboard.
//
// Served from this project rather than as a Claude artifact on purpose: a
// published artifact is CSP-blocked from fetching external URLs, so it can
// never live-update. Here the page reads its own API same-origin.
//
// Design notes: no charts. One cohort with double-digit numbers does not earn
// a chart - a KPI row and a table say more and lie less. Colour is used only
// for status, always paired with a word, never carrying meaning alone.
// Palette values are the validated reference instance.

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Funnel — MN Cold Outreach</title>
<style>
  :root {
    color-scheme: light;
    --page: #f9f9f7;
    --surface: #fcfcfb;
    --surface-2: #f1f0ec;
    --border: rgba(11,11,11,0.10);
    --ink: #0b0b0b;
    --ink-2: #52514e;
    --muted: #898781;
    --rule: #e1e0d9;
    --accent: #2a78d6;
    --good: #0ca30c;
    --warning: #fab219;
    --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --page: #0d0d0d;
      --surface: #1a1a19;
      --surface-2: #232322;
      --border: rgba(255,255,255,0.10);
      --ink: #ffffff;
      --ink-2: #c3c2b7;
      --muted: #898781;
      --rule: #2c2c2a;
      --accent: #3987e5;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--page); color: var(--ink);
    font: 15px/1.5 "Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 36px 24px 72px; }
  h1 { font-size: 26px; font-weight: 800; letter-spacing: -0.01em; margin: 0; }
  h2 { font-size: 17px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
  .mono { font-family: "IBM Plex Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px;
         flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 26px; }
  .eyebrow { font-family: "IBM Plex Mono", monospace; font-size: 11.5px; letter-spacing: 0.08em;
             text-transform: uppercase; color: var(--accent); margin-bottom: 6px; }
  .top .meta { text-align: right; font-size: 12.5px; color: var(--muted); }
  section { margin-bottom: 34px; }
  .sec-head { display: flex; justify-content: space-between; align-items: baseline; gap: 14px;
              margin-bottom: 12px; flex-wrap: wrap; }
  .sec-head .note { font-size: 12.5px; color: var(--muted); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  @media (max-width: 860px) { .kpis { grid-template-columns: repeat(2, 1fr); } }
  .kpi { padding: 16px 16px 14px; display: flex; flex-direction: column; gap: 6px; }
  .kpi .label { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em;
                color: var(--muted); font-weight: 700; }
  .kpi .value { font-family: "IBM Plex Mono", monospace; font-size: 27px; font-weight: 600; letter-spacing: -0.01em; }
  .kpi .sub { font-size: 12.5px; color: var(--ink-2); }
  .na .value { color: var(--muted); font-size: 20px; }
  table { border-collapse: collapse; width: 100%; min-width: 720px; font-size: 13.5px; }
  .tw { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
  th, td { text-align: right; padding: 10px 13px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted);
       font-weight: 700; background: var(--surface-2); }
  td { font-family: "IBM Plex Mono", monospace; color: var(--ink-2); }
  td:first-child { font-family: inherit; color: var(--ink); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px 3px 7px;
          border-radius: 999px; font-size: 12px; font-weight: 700; }
  .pill .dot { width: 7px; height: 7px; border-radius: 50%; }
  .pill.warn { background: rgba(250,178,25,0.16); color: #7a5400; }
  .pill.warn .dot { background: var(--warning); }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .pill.warn { color: var(--warning); } }
  .notes { padding: 16px 18px; font-size: 13px; color: var(--ink-2); }
  .notes ul { margin: 8px 0 0; padding-left: 18px; }
  .notes li { margin-bottom: 6px; }
  .err { padding: 16px 18px; color: var(--critical); font-size: 13.5px; }
  .funnel-bar { height: 6px; border-radius: 3px; background: var(--accent); min-width: 2px; display: block; }
  .funnel-track { background: var(--rule); border-radius: 3px; height: 6px; width: 120px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <div class="eyebrow">MN Consulting &middot; Cold Outreach</div>
      <h1>Funnel</h1>
    </div>
    <div class="meta">
      <div>Refreshes every 60s</div>
      <div class="mono" id="stamp">loading&hellip;</div>
    </div>
  </div>

  <section>
    <div class="sec-head"><h2>Latest cohort</h2><span class="note" id="cohort-note"></span></div>
    <div class="kpis" id="kpis"></div>
  </section>

  <section>
    <div class="sec-head">
      <h2>End to end, by cohort</h2>
      <span class="note">Every stage of one send batch, in funnel order</span>
    </div>
    <div class="tw" id="funnel"></div>
  </section>

  <section>
    <div class="sec-head">
      <h2>Growth Gap Report form</h2>
      <span class="note">Live from Fillout &middot; internal QA submissions excluded</span>
    </div>
    <div class="kpis" id="fillout"></div>
  </section>

  <section>
    <div class="sec-head"><h2>Read this before trusting a number</h2></div>
    <div class="card notes" id="caveats"></div>
  </section>
</div>

<script>
(function () {
  "use strict";
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var n = function (v) { return (v == null ? 0 : v).toLocaleString("en-GB"); };
  var pct = function (v) { return v === null || v === undefined ? "&mdash;" : v + "%"; };

  function tile(label, value, sub, opts) {
    opts = opts || {};
    return '<div class="card kpi' + (opts.na ? " na" : "") + '">' +
      '<div class="label">' + esc(label) + "</div>" +
      '<div class="value mono">' + value + "</div>" +
      (opts.pill ? '<span class="pill warn"><span class="dot"></span>' + esc(opts.pill) + "</span>" : "") +
      '<div class="sub">' + sub + "</div></div>";
  }

  function renderCohorts(m) {
    var rows = m.cohorts || [];
    var latest = rows[0] || null;

    document.getElementById("cohort-note").innerHTML = latest
      ? esc(latest.cohort) + " &middot; first seen " + esc((latest.firstSeenAt || "").slice(0, 10))
      : "";

    document.getElementById("kpis").innerHTML = latest
      ? tile("Emails sent", n(latest.sent), "delivered by Instantly") +
        tile("Replies", n(latest.replied), pct(latest.rates.reply) + " of sent &middot; read the Unibox, not the count") +
        tile("Landing page visits", n(latest.visits), pct(latest.rates.clickThrough) + " of sent &middot; stands in for click-through") +
        tile("Calls booked", n(latest.booked), "end to end " + pct(latest.rates.endToEnd),
             latest.thin ? { pill: "Sample too small to compare" } : {})
      : '<div class="card notes" style="grid-column:1/-1">No cohort has been recorded yet.</div>';

    var stages = [
      ["Sent", "sent", null],
      ["Bounced", "bounced", "bounce"],
      ["Replied", "replied", "reply"],
      ["Landing visits", "visits", "clickThrough"],
      ["Reports started", "started", "reportStart"],
      ["Reports completed", "completed", "formCompletion"],
      ["Calls booked", "booked", "reportToCall"]
    ];

    if (!rows.length) { document.getElementById("funnel").innerHTML = ""; return; }

    var head = "<tr><th>Stage</th>" + rows.map(function (r) {
      return "<th>" + esc(r.cohort) + "</th>";
    }).join("") + "<th>Rate</th><th></th></tr>";

    var body = stages.map(function (s) {
      var cells = rows.map(function (r) { return "<td>" + n(r[s[1]]) + "</td>"; }).join("");
      var rate = s[2] ? pct(rows[0].rates[s[2]]) : "&mdash;";
      var top = rows[0].sent || 1;
      var w = Math.max(2, Math.round(((rows[0][s[1]] || 0) / top) * 120));
      var bar = '<div class="funnel-track"><span class="funnel-bar" style="width:' + w + 'px"></span></div>';
      return "<tr><td>" + s[0] + "</td>" + cells + "<td>" + rate + "</td><td>" + bar + "</td></tr>";
    }).join("");

    document.getElementById("funnel").innerHTML = "<table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>";
  }

  function renderFillout(f) {
    var el = document.getElementById("fillout");
    if (!f || !f.ok) {
      el.innerHTML = '<div class="card err" style="grid-column:1/-1">Fillout is not reporting: ' +
        esc((f && f.error) || "no response") + "</div>";
      return;
    }
    var t = f.totals || {};
    var denom = (t.finished || 0) + (t.inProgress || 0);
    // A rate off one submission reads as a triumphant 100%. Withhold it until
    // there is enough behind it to mean anything.
    var MIN = 10;
    var rate = denom >= MIN ? Math.round(((t.finished || 0) / denom) * 1000) / 10 + "%" : "&mdash;";
    var rateSub = denom >= MIN
      ? "finished &divide; (finished + in progress)"
      : "withheld until " + MIN + " submissions &mdash; " + denom + " so far";
    var secs = f.medianSecondsToComplete;
    var time = secs == null ? "&mdash;"
      : Math.floor(secs / 60) + "m " + String(Math.round(secs % 60)).padStart(2, "0") + "s";

    el.innerHTML =
      tile("Reports finished", n(t.finished), t.internalTestSubmissions + " internal test submissions excluded") +
      tile("In progress", n(t.inProgress), "only counts partials Fillout kept as resumable") +
      tile("Completion rate", rate, rateSub, { na: denom < MIN }) +
      tile("Median time to complete", time,
           f.durationSampleSize ? "from " + f.durationSampleSize + " real submission" + (f.durationSampleSize === 1 ? "" : "s") : "no sample yet") +
      tile("Unique visitors", "Not in the API", "Fillout shows it in Results &rsaquo; Analytics only", { na: true }) +
      tile("Per-page drop-off", "Not in the API", "Analytics tab only, and not filterable per cohort there", { na: true });
  }

  function renderCaveats(m, f) {
    var items = (m && m.caveats ? m.caveats.slice() : []);
    if (f && f.caveat) items.push(f.caveat);
    if (m && m.unattributed) {
      var u = m.unattributed;
      items.push("Pipedrive holds " + u.completed + " completed report(s) and " + u.booked +
        " booked call(s) that carry no cohort tag, across " + u.deals +
        " deals. They are counted here but cannot be assigned to a batch.");
    }
    document.getElementById("caveats").innerHTML =
      "<strong>Known limits of what is above.</strong><ul>" +
      items.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul>";
  }

  function load() {
    Promise.all([
      fetch("/api/metrics", { cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch("/api/fillout-stats", { cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return null; })
    ]).then(function (res) {
      var m = res[0], f = res[1];
      document.getElementById("stamp").textContent = new Date().toLocaleTimeString("en-GB");
      if (m && m.ok) { renderCohorts(m); } 
      renderFillout(f);
      renderCaveats(m, f);
    });
  }

  load();
  setInterval(load, 60000);
})();
</script>
</body>
</html>`;

export default function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(PAGE);
}
