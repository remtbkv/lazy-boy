#!/usr/bin/env python3
"""Roll up the store meter's log (~/lazyboy-sqld/querylog/*.jsonl): exact rows read/written per
UTC day and per query, plus a 30-day projection against Turso's free plan.

    python3 ~/lazyboy-sqld/meter-report.py            # every logged day
    python3 ~/lazyboy-sqld/meter-report.py 2026-10-13 # one day, with its top queries
"""
import glob, json, os, sys
from collections import defaultdict

LOG_DIR = os.path.expanduser("~/lazyboy-sqld/querylog")
FREE_READS, FREE_WRITES = 500_000_000, 10_000_000


def load(day):
    per_q = defaultdict(lambda: [0, 0, 0, ""])  # fp -> [calls, rows_read, rows_written, sql]
    reqs = errors = 0
    for line in open(os.path.join(LOG_DIR, f"{day}.jsonl"), errors="replace"):
        # The Zenbook's 3 AM reboot can leave a run of NUL bytes where unflushed lines were.
        try:
            e = json.loads(line)
        except ValueError:
            errors += 1
            continue
        reqs += 1
        errors += "meterError" in e
        for s in e.get("stmts", []):
            q = per_q[s["fp"]]
            q[0] += 1; q[1] += s["rr"]; q[2] += s["rw"]; q[3] = s["sql"]
    return per_q, reqs, errors


days = sorted(os.path.basename(p)[:10] for p in glob.glob(os.path.join(LOG_DIR, "*.jsonl")))
if len(sys.argv) > 1:
    days = [d for d in days if d in sys.argv[1:]]

for day in days:
    per_q, reqs, errors = load(day)
    rr = sum(q[1] for q in per_q.values()); rw = sum(q[2] for q in per_q.values())
    print(f"{day}  requests={reqs}  rows_read={rr:,}  rows_written={rw:,}  meter_errors={errors}")
    if len(sys.argv) > 1:
        for fp, (calls, r, w, sql) in sorted(per_q.items(), key=lambda kv: -kv[1][1])[:15]:
            print(f"   read {r:>11,}  write {w:>8,}  calls {calls:>6}  {sql[:90]}")
        print("   -- top writers --")
        for fp, (calls, r, w, sql) in sorted(per_q.items(), key=lambda kv: -kv[1][2])[:8]:
            print(f"   write {w:>8,}  calls {calls:>6}  {sql[:90]}")

# Projection from complete days only (the newest file is usually today, still filling).
full = days[:-1] if len(days) > 1 else []
if full:
    tot = [load(d)[0] for d in full]
    rr = sum(sum(q[1] for q in t.values()) for t in tot) / len(full) * 30
    rw = sum(sum(q[2] for q in t.values()) for t in tot) / len(full) * 30
    print(f"\n30-day projection from {len(full)} complete day(s): reads {rr:,.0f} "
          f"({rr / FREE_READS:.0%} of Turso free), writes {rw:,.0f} ({rw / FREE_WRITES:.0%})")
