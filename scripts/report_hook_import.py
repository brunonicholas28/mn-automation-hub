#!/usr/bin/env python3
"""Turn the import response into one readable line in the run summary."""
import json
import sys

d = json.load(open(sys.argv[1]))
if not d.get("ok"):
    raise SystemExit("FAILED: %s" % d.get("error"))

a = d.get("applied", {})
print("IMPORTED " + json.dumps({
    "cohort": d.get("cohort"),
    "received": d.get("received"),
    "leads": d.get("leadsInCohort"),
    "draft": a.get("DRAFT"),
    "noTrigger": a.get("NO-TRIGGER"),
    "exclude": a.get("EXCLUDE"),
    "rejected": a.get("REJECT"),
    "unmatched": a.get("unmatched"),
    "hookRate": d.get("hookRate"),
}))

# A rejected row means research came back in a shape the quality bar refuses.
# An unmatched row means it was aimed at a lead that is not in this cohort.
# Neither is fatal; both are worth seeing rather than discovering on send day.
if a.get("REJECT") or a.get("unmatched"):
    print("")
    print("WARNING: %s rejected, %s unmatched. See problems[] in the response above."
          % (a.get("REJECT"), a.get("unmatched")))
