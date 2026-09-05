# MN Automation Hub

Replaces two Zapier-billed flows with scheduled Vercel functions:

1. **`/api/cron/apollo-sync`** — replaces the "Apollo to Pipedrive - New Lead" Zap. Polls Apollo for contacts in the Cold stage and creates the matching Pipedrive person + deal for any not already synced. Auto-tags each deal with a rolling Cohort (A/B/C/D by week) and Cohort Start Date — previously a manual tagging step.
2. **`/api/cron/linkedin-score`** — builds the automation that was still just a plan (Phase 2 of the LinkedIn gameplan doc). Polls Instantly for open/reply engagement, computes the Lane 2 score per contact once their cohort hits day 5-6, writes the score back to Pipedrive, and emails a ranked/capped shortlist.

Both run once/day (Vercel's free Hobby cron tier only allows daily; that's plenty here — see the project's build-plan doc for why).

## One-time setup

1. **Create a new GitHub repo** (e.g. `mn-automation-hub`), empty — no README/gitignore/license (this folder already has its own).
2. **Push this folder to it:**
   ```
   cd mn-automation-hub
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<you>/mn-automation-hub.git
   git push -u origin main
   ```
   Run each line on its own — don't add trailing `#` comments if you're in zsh, it isn't treated as a comment marker there.
3. **In the Vercel dashboard:** Add New Project → Import the GitHub repo you just pushed. Before the first deploy, open Settings → Environment Variables and add every value from `.env.example` (Apollo key, Pipedrive token, Instantly key + campaign ID, Resend key, a random string for `CRON_SECRET`, and your Pipedrive subdomain). Then deploy.
4. **Connect Vercel KV:** Storage tab → Create Database → KV → connect it to this project. This auto-fills `KV_REST_API_URL` / `KV_REST_API_TOKEN` — no manual copying needed.
5. **Verify:** open `https://<your-project>.vercel.app/api/health` — every check should read `true`. If Pipedrive/Instantly/Apollo are false, the matching env var didn't save.
6. **Test each cron on demand** before trusting the daily schedule: Vercel dashboard → Cron Jobs tab → find the job → "..." menu → Run. Check the response and check Pipedrive/your inbox.
7. Once both have run cleanly for a few days, disable the old "Apollo to Pipedrive - New Lead" Zap in Zapier so it stops double-creating deals.

From here on, changes are a normal edit + `git push` — Vercel redeploys automatically. No more zip files, no more `~/Downloads` folder confusion.

## Two things this build could not decide on its own — need Marina/Bruno's call

These are flagged inline in `api/cron/linkedin-score.js` too:

1. **Deal-value scoring input (score component 3).** The scoring spec wants a "Tier-3-shaped severity" flag once a Growth Gap Report exists, worth 10 points, vs. 5 points for an Apollo revenue/team-size proxy before a report exists. The gameplan doc itself flagged this as needing Marina's input on which to use and how "Tier-3-shaped" gets represented as data. Current code awards the 5-point proxy score whenever a `Revenue Band` value exists and no report yet, and does not yet award the 10-point tier — that half needs a real definition before it's wired up.
2. **Network proximity (1st/2nd-degree LinkedIn connections).** No automated data source was ever identified for this. The build adds a `Network Proximity` Yes/No field on each Pipedrive deal for Marina to set by hand when she recognizes a name; it defaults to No and the fast-track bypass only fires once she flips it.

Also not yet wired: the per-contact `{{Trigger}}` fact used for the 15-point trigger bonus isn't currently synced from Apollo into Pipedrive, so that component always scores 0 for now. Worth adding once there's an agreed field for it.

## Files

```
api/
  health.js               - GET, no auth, quick env-var sanity check
  cron/
    apollo-sync.js         - daily Apollo -> Pipedrive sync
    linkedin-score.js      - daily Lane 2 scoring + shortlist digest
lib/
  apollo.js                - Apollo contacts search
  pipedrive.js              - Pipedrive v1 client (persons, deals, custom fields, notes)
  instantly.js              - Instantly v2 leads/engagement
  scoring.js                - the Lane 2 score formula + weekly cutoff logic
  email.js                  - shortlist digest via Resend
  kv.js                     - small state helper (sync cursor, cached field-key map)
```
