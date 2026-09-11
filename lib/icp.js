// The ICP screen.
//
// Read icp-master-unified-profile.md before changing anything here. The short
// version, because it is the part that keeps getting relearned the hard way:
//
// On 5 Sep 2026 an automated screen disqualified 142 of 160 prospects using a
// "who do they sell to" test. That test is void. Enterprise-only vendors,
// funds and fund managers, wealth managers, public-sector suppliers, staffing
// firms and management consultancies are all IN SCOPE, and so is a prospect
// whose site could not be read. Sector, geography and the leader's age must
// not filter anything either.
//
// So this screen is built to let people through. It returns "out" only on
// things a field can actually prove, "review" when something looks worth a
// human glance, and "in" for everything else including everything unknown.
// When it is unsure it includes. That is the rule, not a default.
//
// It is also advisory. Nothing here removes a prospect from a batch on its
// own - apollo-sync records the verdict and carries on. Making it blocking is
// a decision for after a few weeks of reading what it actually flags.

// Revenue and decision authority are the two rules that matter most and
// neither is in the data. Apollo's revenue estimate is usually absent and is
// an estimate when present; decision authority has no field at all. Both are
// therefore left to the diagnostic call and are deliberately not modelled.

const MIN_HEADCOUNT = 5;

// The prospect's OWN company being an investment bank, M&A advisory or
// business brokerage is an exclusion. A fund or a fund manager is not.
const IB_ADVISORY =
  /\b(investment bank(ing)?|m&a advisor|merger(s)? and acquisition|business broker(age)?|corporate finance advisor)\b/i;

// A fund is fine, and "capital" or "partners" in a name is not evidence of
// anything, so this is here to be explicitly spared rather than caught.
const FUND_LIKE = /\b(fund|capital|ventures|partners|equity|asset manage)/i;

const SENIOR_TITLE =
  /\b(ceo|chief executive|managing director|founder|co-founder|owner|president|managing partner|director|head of|vp|vice president|chief)\b/i;

function reasonsFor(row) {
  const out = [];
  const review = [];

  const company = String(row.company || "");
  const title = String(row.title || "");
  const employees =
    row.employees === null || row.employees === undefined ? null : Number(row.employees);

  // Provable, from a field, and the whole reason this is safe to run.
  if (employees !== null && Number.isFinite(employees) && employees < MIN_HEADCOUNT) {
    out.push("under " + MIN_HEADCOUNT + " people on the record, below the ICP floor");
  }
  if (row.publiclyTraded) {
    out.push("publicly listed, outside the ICP");
  }
  if (IB_ADVISORY.test(company) || IB_ADVISORY.test(title)) {
    out.push("investment banking, M&A advisory or brokerage, the one business-model exclusion");
  }

  // Worth a human glance, never an exclusion on its own.
  //
  // Headcount is deliberately NOT flagged when it is missing. Apollo returns
  // no headcount for essentially every row - the account objects simply do
  // not carry the field - so flagging its absence would mark the entire list
  // for review and the queue would say nothing. A flag that fires on
  // everything is the same as no flag at all.
  const foundedYear = Number(row.foundedYear) || null;
  const thisYear = new Date().getUTCFullYear();
  if (foundedYear && foundedYear >= thisYear - 1) {
    review.push("founded within the last year or so, which is where pre-revenue usually sits");
  }
  if (!title) {
    review.push("no job title, so seniority is unknown");
  } else if (!SENIOR_TITLE.test(title)) {
    review.push("title does not read as a decision maker");
  }
  if (!row.company) {
    review.push("no company name on the record");
  }

  return { out, review };
}

// row: { company, title, employees, publiclyTraded, foundedYear }
export function screenProspect(row) {
  const { out, review } = reasonsFor(row || {});

  if (out.length) {
    return { verdict: "out", reasons: out, review };
  }
  if (review.length) {
    return { verdict: "review", reasons: [], review };
  }
  return { verdict: "in", reasons: [], review: [] };
}

// A fund is not an exclusion. Exported so the rule is testable and so nobody
// re-adds it by pattern-matching on a company name.
export function looksLikeFund(company) {
  return FUND_LIKE.test(String(company || ""));
}

export const ICP_RULES = {
  minHeadcount: MIN_HEADCOUNT,
  excludes: [
    "headcount below the floor, when a headcount is actually on the record",
    "publicly listed",
    "the prospect's own company is an investment bank, M&A advisory or business brokerage",
  ],
  neverFilterOn: [
    "sector or vertical",
    "geography",
    "the leader's age",
    "who the prospect sells to",
    "whether the company website could be read",
  ],
  leftToTheCall: ["annual revenue", "decision authority", "lifecycle stage"],
};
