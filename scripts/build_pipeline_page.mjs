// Rebuilds lib/jobs/organic-pipeline-page.js from its HTML source.
// Edit lib/jobs/organic-pipeline-page.src.html, then run:
//   node scripts/build_pipeline_page.mjs
import { readFileSync, writeFileSync } from "node:fs";
const src = new URL("../lib/jobs/organic-pipeline-page.src.html", import.meta.url);
const out = new URL("../lib/jobs/organic-pipeline-page.js", import.meta.url);
const html = readFileSync(src, "utf8");
writeFileSync(out,
  "// The /pipeline page for lib/jobs/organic-pipeline.js, kept as a string so it\n" +
  "// ships inside the one cron/run function. Generated from\n" +
  "// organic-pipeline-page.src.html by scripts/build_pipeline_page.mjs.\n" +
  "export const PIPELINE_HTML = " + JSON.stringify(html) + ";\n");
console.log("wrote", out.pathname, html.length, "chars");
