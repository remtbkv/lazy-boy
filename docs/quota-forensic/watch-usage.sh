#!/bin/zsh
# Interim Mac-side Turso usage poller (the durable one is the Zenbook lazyboy-usagepoll
# unit). Appends one JSON line per minute to usage-watch-mac.jsonl. Timeout-tolerant:
# failures are recorded as data.
set -a; source "$(dirname "$0")/../../.env.local" 2>/dev/null; set +a
OUT="$(dirname "$0")/usage-watch-mac.jsonl"
while true; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  body=$(curl -s --max-time 50 -H "Authorization: Bearer $TURSO_PLATFORM_TOKEN" \
    "https://api.turso.tech/v1/organizations/remtbkv/usage")
  if [ -n "$body" ]; then
    echo "$body" | python3 -c "
import json,sys
ts='$ts'
try:
    d=json.load(sys.stdin); o=d['organization']; u=o['usage']
    insts=[{'uuid':i.get('uuid','')[:8],'rows_read':i.get('usage',{}).get('rows_read')}
           for db in o.get('databases',[]) for i in db.get('instances',[])]
    print(json.dumps({'ts':ts,'ok':True,'rows_read':u.get('rows_read'),
        'rows_written':u.get('rows_written'),'bytes_synced':u.get('bytes_synced'),
        'storage':u.get('storage_bytes'),'instances':insts}))
except Exception as e:
    print(json.dumps({'ts':ts,'ok':False,'error':str(e)[:120]}))
" >> "$OUT"
  else
    blocked=$(curl -s --max-time 10 -H "Authorization: Bearer $TURSO_PLATFORM_TOKEN" \
      "https://api.turso.tech/v1/organizations/remtbkv" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['organization']['blocked_reads'])
except Exception: print('unknown')")
    echo "{\"ts\":\"$ts\",\"ok\":false,\"error\":\"usage endpoint timeout\",\"blocked_reads\":\"$blocked\"}" >> "$OUT"
  fi
  sleep 60
done
