#!/usr/bin/env python3
"""Fail before spending a request, rather than after.

A malformed hooks file posted blind comes back as a 400 that says nothing
useful about which row was wrong. This says it here, in the log, next to the
filename."""
import json
import sys

path = sys.argv[1]
rows = json.load(open(path))

if not isinstance(rows, list) or not rows:
    raise SystemExit("%s: expected a non-empty JSON array" % path)

seen = set()
for i, r in enumerate(rows):
    if not isinstance(r, dict):
        raise SystemExit("%s row %d: expected an object" % (path, i))
    if "dealId" not in r or "verdict" not in r:
        raise SystemExit("%s row %d: every row needs dealId and verdict" % (path, i))
    did = str(r["dealId"])
    if did in seen:
        raise SystemExit("%s row %d: dealId %s appears twice" % (path, i, did))
    seen.add(did)

print("%s: %d rows, well formed" % (path, len(rows)))
