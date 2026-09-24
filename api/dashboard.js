// Live campaign dashboard - both channels, no manual entry.
//
// Served from this project rather than as a Claude artifact on purpose: a
// published artifact is CSP-blocked from fetching external URLs, so it can
// never live-update. Here the page reads its own API same-origin.
//
// Two channels, told apart without any new plumbing: a cohort that has sends
// came from Instantly and is cold outreach; a cohort with visits but no sends
// is paid traffic to the Growth Gap Session page. The ad campaigns are named
// on the same cYYYYMMDD scheme, so they land as their own rows already.
//
// Charts are per-channel small multiples, never one chart across both: emails
// sent runs in the thousands and LinkedIn visits in the dozens, and putting
// those on one axis would flatten the smaller channel into nothing. Each
// funnel is drawn against its own top-of-funnel and direct-labelled with the
// absolute number, so a bar is never read as a rate it is not.
//
// Palette: categorical slots 1 (blue, cold outreach) and 2 (orange, LinkedIn)
// from the validated reference instance. Verified with the dataviz validator
// in both modes - worst adjacent CVD dE 24.7 light / 26.8 dark against an >=8
// target - and every series is direct-labelled as well as coloured, so
// identity never rests on colour alone.

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Campaign — Marina Nicholas</title>
<style>
  :root {
    color-scheme: light;
    --page:#f9f9f7; --surface:#fcfcfb; --surface-2:#f1f0ec;
    --border:rgba(11,11,11,0.10); --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
    --rule:#e1e0d9; --accent:#2a78d6;
    --good:#0ca30c; --warning:#fab219; --critical:#d03b3b;
    --cold:#2a78d6; --linkedin:#eb6834;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --page:#0d0d0d; --surface:#1a1a19; --surface-2:#232322;
      --border:rgba(255,255,255,0.10); --ink:#fff; --ink-2:#c3c2b7; --muted:#898781;
      --rule:#2c2c2a; --accent:#3987e5;
      --cold:#3987e5; --linkedin:#d95926;
    }
  }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; }
  body { background:var(--page); color:var(--ink);
    font:15px/1.5 "Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1100px; margin:0 auto; padding:36px 24px 72px; }
  h1 { font-size:26px; font-weight:800; letter-spacing:-0.01em; margin:0; }
  h2 { font-size:15px; font-weight:700; margin:0; letter-spacing:-0.01em; }
  .mono { font-family:"IBM Plex Mono", ui-monospace, monospace; font-variant-numeric:tabular-nums; }
  .top { display:flex; justify-content:space-between; align-items:flex-end; gap:20px;
    flex-wrap:wrap; border-bottom:1px solid var(--border); padding-bottom:20px; margin-bottom:24px; }
  .sub { color:var(--muted); font-size:13px; margin-top:6px; }

  .banner { border:1px solid var(--border); border-left:3px solid var(--warning);
    background:var(--surface); border-radius:10px; padding:12px 16px; margin-bottom:22px;
    font-size:13.5px; color:var(--ink-2); }
  .banner b { color:var(--ink); }

  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:26px; }
  .kpi { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px 16px;
    display:flex; flex-direction:column; }
  /* Reserve two lines so a label that wraps does not shunt its number down
     and stagger the whole row. */
  .kpi .lab { font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted);
    min-height:2.9em; }
  .kpi .val { font-size:26px; font-weight:800; letter-spacing:-0.02em; margin-top:6px; }
  .kpi .note { font-size:12px; color:var(--muted); margin-top:2px; }
  .kpi.cold { border-top:2px solid var(--cold); }
  .kpi.li { border-top:2px solid var(--linkedin); }

  .cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:26px; }
  @media (max-width:820px){ .cols { grid-template-columns:1fr; } }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:18px 20px 20px; }
  .card .head { display:flex; align-items:center; gap:9px; margin-bottom:4px; }
  .dot { width:10px; height:10px; border-radius:3px; flex:none; }
  .card .cap { font-size:12.5px; color:var(--muted); margin-bottom:16px; }

  .stage { margin-bottom:11px; }
  .stage .row { display:flex; justify-content:space-between; align-items:baseline; gap:10px; font-size:13px; }
  .stage .name { color:var(--ink-2); }
  .stage .num { font-weight:700; }
  .stage .pct { color:var(--muted); font-size:12px; font-weight:400; margin-left:6px; }
  .bar { height:9px; background:var(--surface-2); border-radius:0 4px 4px 0; margin-top:5px; overflow:hidden; }
  .bar span { display:block; height:100%; border-radius:0 4px 4px 0; min-width:2px; }

  .costs { border-top:1px solid var(--rule); margin-top:16px; padding-top:14px;
    display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
  .costs div .lab { font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); }
  .costs div .v { font-size:17px; font-weight:700; margin-top:3px; }

  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:right; padding:9px 10px; border-bottom:1px solid var(--rule); white-space:nowrap; }
  th:first-child, td:first-child { text-align:left; }
  th { font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); font-weight:600; }
  .tag { display:inline-block; font-size:10.5px; padding:1px 7px; border-radius:999px;
    border:1px solid var(--border); color:var(--ink-2); margin-left:7px; vertical-align:1px; }
  .tag.cold { border-color:var(--cold); color:var(--cold); }
  .tag.li { border-color:var(--linkedin); color:var(--linkedin); }
  .thin { color:var(--muted); }
  .tablewrap { background:var(--surface); border:1px solid var(--border); border-radius:12px;
    padding:18px 20px; margin-bottom:24px; overflow-x:auto; }
  .caveats { font-size:12.5px; color:var(--muted); line-height:1.7; }
  .caveats li { margin-bottom:3px; }
  .err { color:var(--critical); }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <h1>Campaign</h1>
      <div class="sub" id="sub">Loading…</div>
    </div>
    <div class="sub mono" id="stamp"></div>
  </div>

  <div id="banner"></div>
  <div class="kpis" id="kpis"></div>
  <div class="cols" id="cols"></div>
  <div class="tablewrap"><h2 style="margin-bottom:14px">Every campaign</h2><div id="table"></div></div>
  <h2 style="margin-bottom:10px">Read this before trusting a number</h2>
  <ul class="caveats" id="caveats"></ul>
</div>

<script>
(function(){
  var CHANNELS = [
    { key:"cold", label:"Cold outreach", colour:"var(--cold)", cls:"cold",
      cap:"Instantly sends into the Growth Gap Report.", top:"sent", topLabel:"Emails sent" },
    { key:"linkedin", label:"LinkedIn ads", colour:"var(--linkedin)", cls:"li",
      cap:"Paid traffic into the Growth Gap Session page.", top:"visits", topLabel:"Page visits" }
  ];

  function n(v){ return (v===null||v===undefined) ? "—" : Number(v).toLocaleString("en-GB"); }
  function money(v){ return (v===null||v===undefined) ? "—" : "£" + Number(v).toLocaleString("en-GB",{maximumFractionDigits:2}); }
  function pct(v){ return (v===null||v===undefined) ? "" : v + "%"; }
  function esc(s){ return String(s===null||s===undefined?"":s).replace(/[&<>"]/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]; }); }

  function stages(ch, d){
    // Each channel is drawn against its own top-of-funnel, never a shared
    // axis - emails run in the thousands and ad visits in the dozens.
    var rows = ch.key === "cold"
      ? [["Emails sent","sent"],["Replies","replied"],["Page visits","visits"],
         ["Reports completed","completed"],["Calls booked","booked"],["Calls held","held"],["Sales","sold"]]
      : [["Page visits","visits"],["Reports completed","completed"],
         ["Calls booked","booked"],["Calls held","held"],["Sales","sold"]];
    var top = Math.max(1, d[ch.top] || 0);
    var out = "";
    for (var i=0;i<rows.length;i++){
      var label = rows[i][0], key = rows[i][1];
      var v = d[key] || 0;
      var share = Math.min(100, (v / top) * 100);
      var rate = (key === ch.top) ? null : Math.round((v/top)*1000)/10;
      out += '<div class="stage" title="' + esc(label) + ': ' + n(v) +
             (rate===null ? "" : " (" + rate + "% of " + esc(ch.topLabel).toLowerCase() + ")") + '">' +
             '<div class="row"><span class="name">' + esc(label) + '</span>' +
             '<span class="num mono">' + n(v) +
             (rate===null ? "" : '<span class="pct">' + rate + '%</span>') + '</span></div>' +
             '<div class="bar"><span style="width:' + share + '%;background:' + ch.colour + '"></span></div>' +
             '</div>';
    }
    return out;
  }

  // Says plainly that the figure costs are divided by is spend so far, not
  // the whole committed budget - otherwise a reader mid-flight would assume
  // the worse number and conclude the channel costs far more than it does.
  function spendLine(c){
    if (c.budget === null || c.budget === undefined) return 'Budget not set — cost figures stay blank.';
    var line = money(c.spentToDate) + ' spent of ' + money(c.budget);
    if (c.to) {
      var to = new Date(c.to + 'T00:00:00Z');
      line += ' to ' + to.toLocaleDateString('en-GB', { day:'numeric', month:'short', timeZone:'UTC' });
    }
    if (c.daysLeft !== null && c.daysLeft !== undefined) {
      line += ' · ' + c.daysLeft + (c.daysLeft === 1 ? ' day left' : ' days left');
    }
    return line + '. Costs use spend so far, not the full budget.';
  }

  function card(ch, d, spendSet){
    var c = d.cost || {};
    return '<div class="card">' +
      '<div class="head"><span class="dot" style="background:' + ch.colour + '"></span>' +
      '<h2>' + esc(ch.label) + '</h2></div>' +
      '<div class="cap">' + esc(ch.cap) + '</div>' +
      stages(ch, d) +
      '<div class="costs">' +
        '<div><div class="lab">Cost / click</div><div class="v mono">' + money(c.costPerClick) + '</div></div>' +
        '<div><div class="lab">Cost / call</div><div class="v mono">' + money(c.costPerCall) + '</div></div>' +
        '<div><div class="lab">Cost / sale</div><div class="v mono">' + money(c.costPerSale) + '</div></div>' +
      '</div>' +
      '<div class="cap" style="margin:10px 0 0">' + spendLine(c) + '</div>' +
    '</div>';
  }

  function kpis(data){
    var cold = data.channels.cold, li = data.channels.linkedin;
    var t = [
      ["Emails sent", n(cold.sent), "cold outreach", "cold"],
      ["Reports completed", n(cold.completed + li.completed), "both channels", ""],
      ["Calls booked", n(cold.booked), "from cold email", "cold"],
      ["LinkedIn visits", n(li.visits), "paid traffic", "li"],
      ["Calls booked", n(li.booked), "from LinkedIn", "li"],
      ["Sales", n(cold.sold + li.sold), "both channels", ""]
    ];
    var out = "";
    for (var i=0;i<t.length;i++){
      out += '<div class="kpi ' + t[i][3] + '"><div class="lab">' + esc(t[i][0]) + '</div>' +
             '<div class="val mono">' + t[i][1] + '</div>' +
             '<div class="note">' + esc(t[i][2]) + '</div></div>';
    }
    return out;
  }

  function table(rows){
    var head = ["Campaign","Sent","Replies","Visits","Reports","Booked","Held","Sold"];
    var out = '<table><thead><tr>';
    for (var i=0;i<head.length;i++) out += '<th>' + head[i] + '</th>';
    out += '</tr></thead><tbody>';
    for (var r=0;r<rows.length;r++){
      var c = rows[r];
      var tag = c.channel === "cold" ? '<span class="tag cold">cold</span>'
              : c.channel === "linkedin" ? '<span class="tag li">LinkedIn</span>' : "";
      out += '<tr' + (c.thin ? ' class="thin"' : '') + '><td>' + esc(c.cohort) + tag + '</td>' +
        '<td class="mono">' + n(c.sent) + '</td><td class="mono">' + n(c.replied) + '</td>' +
        '<td class="mono">' + n(c.visits) + '</td><td class="mono">' + n(c.completed) + '</td>' +
        '<td class="mono">' + n(c.booked) + '</td><td class="mono">' + n(c.held) + '</td>' +
        '<td class="mono">' + n(c.sold) + '</td></tr>';
    }
    out += '</tbody></table>';
    return out;
  }

  function render(data){
    var b = data.budgets || {};
    var spendSet = (b.cold && b.cold.budget !== null && b.cold.budget !== undefined) ||
                   (b.linkedin && b.linkedin.budget !== null && b.linkedin.budget !== undefined);
    document.getElementById("sub").textContent =
      "Every number here is polled automatically. Nothing on this page is typed in.";
    document.getElementById("stamp").textContent =
      "updated " + new Date(data.generatedAt).toLocaleString("en-GB");

    document.getElementById("banner").innerHTML = spendSet ? "" :
      '<div class="banner"><b>No ad budget is set.</b> ' +
      'Cost per click, per call and per sale show a dash until one is — they are deliberately ' +
      'not shown as £0, which would read as free rather than unknown.</div>';

    document.getElementById("kpis").innerHTML = kpis(data);

    var cols = "";
    for (var i=0;i<CHANNELS.length;i++) cols += card(CHANNELS[i], data.channels[CHANNELS[i].key], spendSet);
    document.getElementById("cols").innerHTML = cols;

    document.getElementById("table").innerHTML = table(data.cohorts || []);

    var cav = "";
    for (var j=0;j<(data.caveats||[]).length;j++) cav += "<li>" + esc(data.caveats[j]) + "</li>";
    if (data.unattributed && data.unattributed.deals) {
      cav += "<li>" + n(data.unattributed.deals) + " Pipedrive deals carry no campaign tag and are not in any row above.</li>";
    }
    document.getElementById("caveats").innerHTML = cav;
  }

  function load(){
    fetch("/api/metrics", { cache: "no-store" })
      .then(function(r){ return r.json(); })
      .then(function(d){ if (!d.ok) throw new Error(d.error || "metrics failed"); render(d); })
      .catch(function(e){
        document.getElementById("sub").innerHTML = '<span class="err">Could not load: ' + esc(e.message) + '</span>';
      });
  }
  load();
  setInterval(load, 60000);
})();
</script>
</body>
</html>
`;

export default function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(PAGE);
}
