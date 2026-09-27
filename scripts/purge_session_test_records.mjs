// Remove test records from the Growth Gap Session recovery funnel.
//
//   node scripts/purge_session_test_records.mjs            # dry run
//   node scripts/purge_session_test_records.mjs --apply    # actually delete
//
// Needs the same env as the hub: UPSTASH_REDIS_REST_URL / _TOKEN, plus
// SESSION_TEST_EMAILS so it knows what counts as a test. Pull them with
// `vercel env pull .env.local` and run with `node --env-file=.env.local`.
//
// Deletes ONLY the Redis side: the session:partial:<email> record and its
// entry in session:partials:index. Pipedrive is left alone on purpose -
// api/session-partial.js creates OR MATCHES a deal, so a "test" email that
// matched a real person would take a real deal down with it. The script
// prints the deal and person ids instead; deleting those is a human decision.

import { Redis } from "@upstash/redis";
import { isTestAddress, testEmails, testDomains } from "../lib/testAddresses.js";

const APPLY = process.argv.includes("--apply");
const INDEX = "session:partials:index";
const COUNTER = "session:partials";

const kv = Redis.fromEnv();

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const main = async () => {
  const configured = testEmails();
  if (!configured.length) {
    fail(
      "SESSION_TEST_EMAILS is not set, so only junk domains would match and\n" +
      "  your plus-tagged gmail tests would survive. Set it first."
    );
  }

  console.log(`mode         : ${APPLY ? "APPLY (destructive)" : "dry run"}`);
  console.log(`test emails  : ${configured.join(", ")}`);
  console.log(`test domains : ${testDomains().join(", ")}\n`);

  const indexed = (await kv.smembers(INDEX)) || [];
  const hits = indexed.filter(isTestAddress);
  const keep = indexed.length - hits.length;

  if (!hits.length) {
    console.log(`Nothing to purge. ${indexed.length} address(es) in the index, none of them tests.`);
    return;
  }

  console.log(`${hits.length} test record(s) of ${indexed.length} indexed. ${keep} real one(s) will be untouched.\n`);

  const pipedrive = [];
  for (const email of hits) {
    const record = await kv.get(`session:partial:${email}`);
    const sent = record?.sent ? Object.keys(record.sent).join(",") : "none";
    console.log(
      `  ${email}\n` +
      `      name=${record?.first ?? "?"}  campaign=${record?.campaign ?? "-"}  touches_sent=${sent}\n` +
      `      dealId=${record?.dealId ?? "-"}  personId=${record?.personId ?? "-"}`
    );
    if (record?.dealId) pipedrive.push({ email, dealId: record.dealId, personId: record.personId });

    if (APPLY) {
      await kv.del(`session:partial:${email}`);
      await kv.srem(INDEX, email);
    }
  }

  if (APPLY) {
    console.log(`\nDeleted ${hits.length} record(s) and index entrie(s).`);
  } else {
    console.log(`\nDry run - nothing deleted. Re-run with --apply.`);
  }

  const counters = (await kv.hgetall(COUNTER)) || {};
  console.log(`\nsession:partials counters: ${JSON.stringify(counters)}`);
  console.log(
    "reached_step2 still includes every test captured BEFORE the suppression\n" +
    "guard shipped. This script does not rewrite it - a counter that goes\n" +
    "backwards is worse than one with a known offset. Subtract the tests above\n" +
    "when reading it, and trust test_reached_step2 from here on."
  );

  if (pipedrive.length) {
    console.log(`\nPipedrive - DELETE BY HAND, and check each one is not a real person first:`);
    for (const p of pipedrive) console.log(`  deal ${p.dealId}  person ${p.personId}  (${p.email})`);
  }
};

main().catch((err) => fail(`failed: ${err.message}`));
