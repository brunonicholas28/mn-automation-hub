// One serverless function that runs all four scheduled jobs.
//
// Vercel Hobby allows 12 serverless functions per deployment and every file
// under api/ counts as one. Four separate cron endpoints used four slots for
// what is really one concern, so the job bodies now live in lib/jobs/ (files
// under lib/ are not functions) and this file dispatches to them by name.
//
// Call it as /api/cron/run?job=<name>. The four old URLs
// (/api/cron/apollo-sync and friends) are preserved by rewrites in
// vercel.json, so Vercel Cron, the GitHub Actions workflows and anything
// else that already points at them keeps working unchanged. Rewrites pass
// the query string through, so ?key= and ?live= still reach the job.

import apolloSync from "../../lib/jobs/apollo-sync.js";
import linkedinScore from "../../lib/jobs/linkedin-score.js";
import pollFunnel from "../../lib/jobs/poll-funnel.js";
import recoveryClicked from "../../lib/jobs/recovery-clicked.js";

export const config = { maxDuration: 60 };

const JOBS = {
  "apollo-sync": apolloSync,
  "linkedin-score": linkedinScore,
  "poll-funnel": pollFunnel,
  "recovery-clicked": recoveryClicked,
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const job = String(req.query.job || "").trim();
  const run = Object.prototype.hasOwnProperty.call(JOBS, job) ? JOBS[job] : null;

  if (!run) {
    return res.status(404).json({
      ok: false,
      error: job ? "unknown job: " + job : "job is required",
      knownJobs: Object.keys(JOBS),
    });
  }

  return run(req, res);
}
