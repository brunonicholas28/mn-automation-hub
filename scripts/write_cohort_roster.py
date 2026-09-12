#!/usr/bin/env python3
"""Turn the hook-io export into the roster file a research session reads.

Kept as a script rather than inline jq so the safety check has somewhere to
live: this re-verifies, on the way to disk, that nothing resembling a person
is about to be committed to a public repo."""
import json
import os
import re
import sys

src, dest = sys.argv[1], sys.argv[2]
d = json.load(open(src))
if not d.get("ok"):
    raise SystemExit("export failed: %s" % d.get("error"))

ALLOWED = {"dealId", "company", "domain", "researched"}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

rows = []
for r in d.get("rows", []):
    extra = set(r) - ALLOWED
    if extra:
        raise SystemExit("unexpected fields in export, refusing to write: %s" % sorted(extra))
    blob = " ".join(str(v) for v in r.values())
    if EMAIL.search(blob):
        raise SystemExit("an address reached the roster for deal %s, refusing to write" % r.get("dealId"))
    rows.append({k: r.get(k, "") for k in ("dealId", "company", "domain", "researched")})

rows.sort(key=lambda r: int(r["dealId"]) if str(r["dealId"]).isdigit() else 0)

os.makedirs(os.path.dirname(dest), exist_ok=True)
with open(dest, "w") as f:
    json.dump({"cohort": d.get("cohort"), "count": len(rows), "rows": rows}, f, indent=1)
    f.write("\n")

todo = sum(1 for r in rows if not r["researched"])
print("%s: %d leads, %d still to research" % (dest, len(rows), todo))
