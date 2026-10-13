#!/bin/bash
# Append sqld's exact cumulative read/write counters (libsql's own counting, the metric
# Turso bills on) to readmeter.jsonl, so the real daily rate is a subtraction.
S="$HOME/lazyboy-sqld/data/dbs/default/stats.json"
python3 - "$S" >> "$HOME/lazyboy-sqld/readmeter.jsonl" <<'PY'
import json, sys, datetime
s = json.load(open(sys.argv[1]))
print(json.dumps({"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                  "rows_read": s["rows_read"], "rows_written": s["rows_written"]}))
PY
