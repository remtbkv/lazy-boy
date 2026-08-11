# BRIDGE.md — the self-hosted DB bridge (2026-08-08 → Sep 1)

Turso's free org is read-blocked for the rest of August (`Operation was blocked: SQL read
operations are forbidden`), so production could not render anything. This is the bridge that
brings it back at $0 until the calendar month resets: **the store moves to a `sqld` (libSQL
server) instance on the Zenbook, reached from Vercel through a Cloudflare quick tunnel.** It
is a three-week measure, not a new architecture — Sep 1 reverts to Turso, and the revert
procedure is written down below *before* it is needed.

> **2026-08-10: the path in changed.** The Cloudflare quick tunnel and its rotation updater
> are retired — production now reaches `sqld` over a **Tailscale Funnel** at a permanent
> hostname, `https://ubuntu.tail026729.ts.net`. Read "The tunnel and the rotation updater"
> and "Latency" as history; the live setup is under **"Funnel cutover"** near the end.

> **2026-08-11: the embedded replica is gone from the code.** Where this document says
> `LAZYBOY_NO_REPLICA=1` "stays set in production", read it as history: the flag and the whole
> replica path were deleted from `src/lib/db.ts` (the configuration it described is now the
> only behaviour, so setting or unsetting the variable does nothing). The measurements taken
> "with `LAZYBOY_NO_REPLICA=1`" below are still measurements of what production runs. Nothing
> else in this document changed.

## Architecture

```
Vercel (lazy-boy, production)
  @libsql/client  ──HTTPS/Hrana──►  https://ubuntu.tail026729.ts.net   (permanent)
                                        │  Tailscale Funnel
                                        ▼
                                   Zenbook  tailscaled  ──►  127.0.0.1:8090
                                                                  sqld 0.24.32
                                                                  ~/lazyboy-sqld/data
```

- The app is unchanged. `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` are just pointed somewhere
  else; `@libsql/client` speaks the same Hrana-over-HTTP protocol to `sqld` that it speaks to
  Turso.
- **Auth is a JWT**, not a Turso token. `sqld` runs with `--auth-jwt-key-file` holding an
  Ed25519 *public* key; the token in `TURSO_AUTH_TOKEN` is an `EdDSA`-signed JWT minted on the
  Zenbook (`~/lazyboy-sqld/mint-jwt.mjs`, valid 12 months). An unauthenticated request gets
  401, so the tunnel being world-reachable is not the same as the database being open.
- `sqld` listens on **127.0.0.1 only**. The tunnel is the sole path in.
- `LAZYBOY_NO_REPLICA=1` stays set in production. The embedded replica would pull the whole
  store over Rem's home upstream on every cold instance; every read goes to the bridge
  directly, which is cheap here because rows are not metered.

## What is on the bridge, and how it got there

Seeded from `data/replica.db` on the Mac (the embedded replica, synced 2026-08-08 03:11 —
the freshest complete copy of the primary that exists while reads are blocked), snapshotted
with `sqlite3 .backup` and shipped by `scp` (sha256 verified equal on both ends), then dropped
in as `~/lazyboy-sqld/data/dbs/default/data`. `sqld` logged `replication log not found,
recovering from database file` and adopted it. Row counts matched the source exactly:

| table | source copy | bridge after import |
|---|---|---|
| plays | 7330 | 7330 |
| tracks | 15024 | 15024 |
| playlists | 180 | 180 |
| playlist_tracks | 15328 | 15328 |
| meta | 372 | 372 |
| contexts | 74 | 74 |
| saved_tracks | 29 | 29 |
| api_log | 7594 | 7594 |

The copy stopped at `played_at = 2026-08-07T19:29:49.568Z`. The gap since was repaired from
the Zenbook backstop recorder with `scripts/backfill-from-backstop.mjs`: 277 captured rows,
**112 inserted**, and a second run inserted **0** (the script is idempotent). Every one of the
recorder's 277 rows is present in the bridge, and the bridge's play count in the recorder's
window is exactly 277 — no duplicates, nothing dropped.

### Writes during the bridge

**Writes land on the Zenbook, not on Turso.** Everything the app records between now and the
revert — plays, playlist syncs, tokens, `write_seq` — lives only in `~/lazyboy-sqld/data`
until it is replayed back into Turso on Sep 1.

That is survivable because **the plays are never solely on the bridge**: `lazyboy-recorder`
(`~/lazyboy-recorder`, `lazyboy-recorder.timer`, every 15 min) keeps its own independent
capture of Spotify's recently-played into its own SQLite file, and it does not touch Turso or
the bridge. If the Zenbook's bridge data were lost outright, the irreplaceable part — the
listen history — is re-derivable from the recorder with the same backfill script. The
derived/cached parts (playlist track caches, `alltime_stats`, context names) rebuild from
Spotify on the next sync.

### The Spotify token rows were left alone — deliberately

The plan called for deleting a stale `spotify_tokens` row so production would mint fresh
tokens on first login. Checking first changed the answer, so it was not deleted:

- Production reads/writes **`spotify_tokens`**; dev uses **`spotify_tokens_dev`**
  (`src/lib/db.ts`, `NODE_ENV === "production" ? ... : ...`).
- The recorder owns *neither* key — it keeps its chain in `~/lazyboy-recorder/tokens.json`.
- The recorder's current refresh token is **byte-identical** to the one in the seeded
  `spotify_tokens_dev` row (compared by tail). This app's refresh flow is client-secret Basic
  auth, which does not rotate the refresh token, so an app-side refresh cannot orphan the
  recorder's chain — the rotation hazard in GOTCHAS applies to the PKCE flow, not this one.

So both rows were kept. Keeping `spotify_tokens` is also what let production come back
without a manual re-login: the stored refresh token is the newest of its chain (nothing has
been able to use it since reads were blocked).

## The tunnel and the rotation updater

A Cloudflare **quick** tunnel needs no account and costs nothing, and in exchange the hostname
is re-randomised **every time `cloudflared` restarts** (crash, reboot, network drop). So the
URL is not a constant and nothing may hard-code it.

`~/lazyboy-tunnel/run.sh` pipes `cloudflared`'s own output through a reader that pulls the
assigned `https://….trycloudflare.com` hostname out of it (ignoring `api.trycloudflare.com`,
which is cloudflared's control plane), writes it to `~/lazyboy-tunnel/current-url`, and — only
when it *differs* from the previous one — calls `~/lazyboy-tunnel/on-rotate.sh`, which:

1. `PATCH`es the `TURSO_DATABASE_URL` project env var **in place** (same env-var id, so its
   `production`/`preview` targets are preserved — a remove+add would silently drop `preview`);
2. finds the newest READY production deployment and **redeploys** it, because a Vercel env
   change does not reach a deployment that is already running;
3. appends a line to `~/lazyboy-tunnel/rotations.log`.

It is gated on a sentinel file, `~/lazyboy-tunnel/ARMED`. Without that file the new URL is
recorded and logged (`action=recorded-only (not ARMED)`) and production is left untouched —
which is how the tunnel was brought up and tested before cutover. Delete the sentinel and the
tunnel keeps running without ever touching production again.

**This is the one place something automated deploys to production.** It is deliberate and
narrow: it fires only on a hostname change, and without it a `cloudflared` restart silently
breaks production until someone notices.

It was exercised rather than assumed — `systemctl --user restart lazyboy-tunnel` on
2026-08-08, which is exactly the event it exists for:

```
20:33:24Z url=https://knives-…-appreciated.trycloudflare.com
         prev=https://staff-…-dosage.trycloudflare.com
         env-patch=200 redeploy=200 id=dpl_pYKRjsnTCnoGN5Jr3PFmh6VtWAtD
```

The redeploy went READY in ~70 s, `lazy-spotify.vercel.app` re-aliased to it, and the new
hostname serves authenticated queries (401 without the JWT). Restarting `lazyboy-sqld` on its
own does **not** rotate the URL — the tunnel keeps its hostname, and the store came back with
the same row count.

**One race to know about: pushing to `main` deploys this project** (auto-deploy is on for
`lazy-boy`, unlike diveloop's web project). A push whose build starts *before* a rotation's env
patch but finishes *after* the rotation's redeploy would become the newest production
deployment while carrying the previous URL — Vercel snapshots project env at build time. It is
a narrow window, and the fix is the same as any stale-env deployment: redeploy. If production
ever looks dead right after a push, check `rotations.log` for a rotation in the same minute.

## Files and units created

On the **Zenbook** (all additive, all `lazyboy-*`; nothing `diveloop-*` was touched):

| path | what |
|---|---|
| `~/lazyboy-sqld/bin/sqld` | libSQL server 0.24.32, official `x86_64-unknown-linux-gnu` release, sha256 verified against the published `.sha256` |
| `~/lazyboy-sqld/data/` | the store (`dbs/default/data` is the SQLite file) |
| `~/lazyboy-sqld/mint-jwt.mjs` | Ed25519 keypair + JWT minter (re-runnable; reuses the existing private key) |
| `~/lazyboy-sqld/jwt-private.pem` | signing key, `0600` — never leaves the Zenbook |
| `~/lazyboy-sqld/jwt-public.pem` | what `sqld` verifies against |
| `~/lazyboy-sqld/jwt-token.txt` | the token production uses, `0600`, expires 2027-08-03 |
| `~/lazyboy-tunnel/cloudflared` | official `cloudflared` 2026.7.3 linux-amd64 |
| `~/lazyboy-tunnel/run.sh` | tunnel supervisor + URL change detector |
| `~/lazyboy-tunnel/on-rotate.sh` | Vercel env patch + production redeploy |
| `~/lazyboy-tunnel/env` | `0600` — Vercel token, project/team ids, env-var ids |
| `~/lazyboy-tunnel/current-url` | the live bridge URL |
| `~/lazyboy-tunnel/rotations.log` | one line per URL change |
| `~/lazyboy-tunnel/ARMED` | sentinel: present = the updater may touch production |
| `~/.config/systemd/user/lazyboy-sqld.service` | `Restart=always`, user unit, lingering already on |
| `~/.config/systemd/user/lazyboy-tunnel.service` | `Restart=always`, `After=lazyboy-sqld.service` |

No secret in this table has its value written into this repo — the repo is public.

## Latency

Read paths, measured with the repo's own harness (`scripts/bench-reads.mjs main`,
medians of n=15) from the **Mac through the tunnel**, next to the Turso-primary figures the
docs already carry (`docs/GOTCHAS.md`, `docs/READ_QUOTA.md`, measured 2026-08-05):

| path | Turso primary (documented) | bridge, via tunnel |
|---|---|---|
| `SELECT 1` round trip | ~47 ms | 55–71 ms |
| all-time list | 705 ms | 102 ms |
| history search | 344 ms | 83 ms |
| daily-stats scan | 705–903 ms | 81–132 ms |

Provenance: the last run in `scripts/bench-reads-results.json` (`startedAt`
`2026-08-08T20:18:29.995Z`). The harness labels whatever `TURSO_DATABASE_URL` points at
"primary", so that run's `primary` block is the **bridge**, not Turso — the give-away is
`rowCounts.plays.primary = 7447` against a `localCopy` of 7330.

The bridge is *faster* on everything that scans, despite an extra hop: the tunnel adds fixed
round-trip cost, and in exchange the query runs against a local SQLite file on the Zenbook
instead of Turso's remote row-metered engine.

A whole authed **Home render** against the bridge, server-rendered, cache-busted so nothing is
served from Next's data cache: **median 184 ms** (159–285, n=7), against 21 ms for `/login`,
which renders the same shell and touches no database. Measured on the Mac's dev server with
`LAZYBOY_NO_REPLICA=1` — the same replica-off configuration production runs.

What none of this measures is **Vercel's** latency to the tunnel. These numbers are from the
Mac; production reaches the Zenbook over Rem's home upstream, and that leg is unmeasured. The
tunnel hostname does resolve to Cloudflare anycast (`104.16.230.132`, AS13335), so the
verified path already leaves the LAN and crosses the public edge — but the figure a Vercel
function would see is not in evidence, and the first real Home render in production should be
timed and written here.

## What the cutover verified, and what it could not

Cutover, 2026-08-08 ~4:20 PM ET: both env vars patched to the bridge (HTTP 200 each), a fresh
production deployment `dpl_6R7PX8KiJAkkxvynP5ZQ5s77cdZM` built clean and went READY, and
`lazy-spotify.vercel.app` serves `/`, `/login` and `/api/build` at 200.

**Not verified: a logged-in production page render.** The automation browser's Spotify session
had expired, so "Connect Spotify" landed on Spotify's credential form rather than the two-click
consent, and entering Rem's credentials is out of bounds. The fallback check — driving
`/api/cron/sync` — is also unavailable: production's `CRON_SECRET` does not match the one in
`.env.local` (that request returns 401), and the value cannot be read back out of Vercel.

So the last unproven link is narrow and specific: **a Vercel function actually reaching the
tunnel.** Everything on either side of it is verified — the same URL, the same JWT and the same
`@libsql/client` serve the whole app correctly from another machine over the public Cloudflare
edge, and production is configured with exactly those values. Rem opening the site logged in is
the one-step confirmation.

**Separately: `/api/cron/sync` was already returning 401 every ~5 minutes before the bridge
existed** — the external pinger's bearer does not match production's `CRON_SECRET`. That is not
a quota problem and the bridge does not fix it; scheduled app-closed syncing has simply not been
running. Repairing it needs the secret re-set on both sides (Vercel env + the cron-job.org job),
which needs credentials only Rem can read.

## Funnel cutover (2026-08-10) — what the quick tunnel actually cost

The quick tunnel took production down for a day and a half, exactly the way the rotation
updater was built to prevent.

**What happened.** `cloudflared` re-randomises its hostname on every restart, and it restarts
about daily — 2026-08-09 04:03 ET and 2026-08-10 04:03 ET, both logged in `rotations.log`.
Both times `on-rotate.sh` tried to patch `TURSO_DATABASE_URL` and got
`403 {"invalidToken":true}`, so production stayed pinned to the 2026-08-08 hostname
(`knives-…`), which by then did not resolve. `/login` and `/api/build` kept serving 200 —
neither touches the store — so the only visible symptom was that every authed page threw
"An error occurred in the Server Components render". That is what Rem saw.

**Root cause of the 403.** `~/lazyboy-tunnel/env` held a *copy* of the Mac's Vercel CLI
credential. That value is a short-lived OAuth **access** token: the CLI silently swaps it for
a new one using its `refreshToken` whenever a `vercel` command runs (`auth.json` carries
`expiresAt`), so the Mac never noticed. The Zenbook's frozen copy simply expired. A copied
access token cannot survive on a second machine — the earlier note in "Failure modes" blamed
`vercel logout`, which was the wrong diagnosis.

**The fix is to stop needing any of it.** Tailscale Funnel gives a hostname that never
changes, so nothing has to patch Vercel and nothing has to hold a Vercel token:

```bash
# on the Zenbook, once
sudo tailscale set --operator=$USER
sudo tailscale funnel --bg 8090          # serves 443 → 127.0.0.1:8090, persists across reboots
```

Funnel had to be enabled once for the tailnet from the admin console (Rem did this). The first
`https://` request failed the TLS handshake while Let's Encrypt validated the DNS-01 challenge;
`sudo tailscale cert ubuntu.tail026729.ts.net` on the third try logged `got cert`, and
tailscaled renews it from then on.

Then `TURSO_DATABASE_URL` (env id `MYq6jff96jW0aPcS`) was patched to
`https://ubuntu.tail026729.ts.net` (200) and production redeployed
(`dpl_4jZScm4irZb9J1otQK7cgxSGMC7N`, READY in ~50 s). `TURSO_AUTH_TOKEN` is unchanged — same
`sqld`, same JWT.

**Verified after cutover:**

| check | result |
|---|---|
| public path, forced to the Funnel anycast IP (`curl --resolve …:443:199.38.181.54`) | 200 |
| authed Hrana query `select count(*) from plays` through the Funnel | 200, **7464** rows |
| same query with no `Authorization` header | 401 (`AuthHeaderNotFound` in sqld's log) |
| fetched from a third-party network, off the tailnet entirely | 200, `Hello, this is HTTP API v2 (Hrana over HTTP)` |
| `lazy-spotify.vercel.app` `/login`, `/api/build`, `/api/now-playing` | 200 |

**The quick tunnel is retired, not deleted.** `~/lazyboy-tunnel/ARMED` is removed and
`lazyboy-tunnel.service` is `disable --now`, so nothing can patch production again; the files
and units stay on disk. `lazyboy-sqld` and `lazyboy-recorder` are untouched and active.

**The last unproven leg is now proven.** Rotating `CRON_SECRET` (below) made
`/api/cron/sync` callable, and a Vercel function ran the full stored-token sync against the
Funnel: `{"ok":true,"added":50,"library":"synced"}`, after which the bridge's `plays` went
7464 → 7514 and `playlists` 180 → 181. Vercel reaches the Zenbook, reads and writes.

## The cron sync pinger (2026-08-10)

`/api/cron/sync` had been answering 401 to its external pinger since before the bridge — the
bearer configured at cron-job.org did not match production's `CRON_SECRET`, so closed-app
history sync had simply not been running. Neither value was readable (`CRON_SECRET` is
`sensitive` on Vercel, i.e. write-only, and so are `CRONJOB_API_KEY`/`CRONJOB_JOB_ID`), so the
mismatch could not be diagnosed from either end — only replaced.

`CRON_SECRET` (env id `NmuaggzYwOZqASsu`) was rotated to a fresh 24-byte value, written to
`.env.local` as well, and production redeployed (`dpl_5MiS3MBnioLdLJb5kdyNoj9m4w5R`). The
pinger now runs on the **Zenbook** instead of cron-job.org — the box is already always-on for
`lazyboy-recorder`, and this drops a third-party dependency whose credential nobody could
read:

| path | what |
|---|---|
| `~/lazyboy-cron/ping.sh` | curls `/api/cron/sync` with the bearer, appends the reply to `ping.log` (trimmed to 2000 lines), exits non-zero on any non-200 |
| `~/lazyboy-cron/env` | `0600` — `CRON_SECRET` + `SYNC_URL` |
| `~/.config/systemd/user/lazyboy-cron-sync.{service,timer}` | every 2 min, `Persistent=true`, `OnBootSec=3min` |

**The interval is 2 minutes because staleness is the point, not because rows are free.** It
started at 5 min on the reasoning that Spotify's recently-played returns the last 50 plays, so
a longer gap cannot *lose* a play. Rem overruled it: a 2-minute tick is a bit less than one
song, so with the app closed the history is never more than about a track behind, and 5 min is
visibly stale. First timed run logged `http=200 {"ok":true,"added":0,"library":"fresh"}`.

The cost is real and lands on **Sep 1**, when the store goes back to Turso's metered reads:
`READ_QUOTA.md` models a steady tick at ~14.25K rows, so 720 ticks/day (2 min) is ~10.3M
rows/day against ~4.1M at 5 min. Sync ticks were the dominant traffic in the quota forensic.
Nothing about the interval needs changing before the revert — but the revert should not be
done without deciding how that 10.3M/day fits the quota, or `unresolvedContextUris()`'s
`SCAN plays` (the ~14.1K of the 14.25K) needs an index first.

**The cron-job.org jobs are now redundant and still hold the old secret**, so they keep
401ing, and the daily Vercel cron's watchdog (`ensureCronJobEnabled`) keeps re-enabling the
sync job after cron-job.org disables it for failures. Two ways to settle it, both needing
Rem's cron-job.org account: delete the job, or paste the new `CRON_SECRET` (in `.env.local`)
into its Authorization header and keep it as a second pinger for whenever the Zenbook is
down. The second is only worth it after Sep 1 — while the bridge is up, a Zenbook that is
down means there is no database to sync into anyway.

## Posture change (2026-08-10): the bridge is the architecture

Rem's call, after the Funnel cutover made the path stable: **stay self-hosted past Sep 1.**
The bridge is no longer a three-week measure, and the revert below becomes a *fallback
procedure* rather than a scheduled event.

What decided it:

- Rows are not metered on the Zenbook, and the workload that broke Turso is already fixed in
  code anyway — `6b8b1e6` took the sync tick from ~14.25K rows to **159 measured**
  (`read-costs.ts`), and `ec8cd0f` stopped the hourly playlist full-rewrite.
- Every scanning read is 5–8× faster against a local SQLite file than against the remote
  metered engine (the latency table above: all-time list 102 ms vs 705 ms).
- The failure that actually hurt was never the Zenbook — it was the quick tunnel's rotating
  hostname, and that is gone.

**A live Turso standby is not buildable, and was not built.** libSQL replication only flows
*out of* a primary into embedded replicas; Turso Cloud cannot follow a self-hosted `sqld`
primary, so "reads on the Zenbook, Turso hot for uptime" has no mechanism to stay in sync.
The direction that does exist meters `bytes_synced`, which is the *other* dimension in breach
this month (76% used against 32% of the month elapsed). So durability is a backup problem,
not a replication problem.

### The nightly snapshot (what replaces Turso as the safety net)

`~/lazyboy-backup/backup.py`, `lazyboy-backup.timer`, daily at **04:40 America/New_York**
(the box's own timezone), `Persistent=true`:

1. SQLite's **online backup API** against the live file — `sqld` keeps serving throughout, no
   stop, no lock held over the copy.
2. `PRAGMA integrity_check`, then a per-table row-count comparison against the live store. The
   copy may trail by a play or two (writes continue during the backup) but may not be missing
   rows wholesale.
3. Only then gzip and `rclone copy` to `onedrive-backup:lazyboy-db`. **A snapshot that fails
   either check is kept locally and never uploaded**, so a bad copy cannot overwrite good ones
   offsite. Retention: 14 days local, 60 days remote.

First run, 2026-08-10 22:16 UTC: `7972KB plays=7522`, uploaded. Verified as a *restore*, not
just as an upload — the file was pulled back down from OneDrive, decompressed, and opened:
`integrity ok`, plays 7522, tracks 15036, playlists 181, latest play `2026-08-10T22:12:26Z`.

Three copies of the listen history now exist and none of them is Turso: the live store, the
nightly offsite snapshot, and `lazyboy-recorder`'s independent capture.

### So why keep Turso at all

For durability, we do not — the snapshot covers that. What the free Turso database still buys
is a **pre-built serving endpoint**: it speaks the protocol the app already uses, so if the
Zenbook is lost, production comes back with one env patch instead of standing up a host. Even
that is replaceable — a fresh Turso DB can be created from a dump in minutes — so the account
is worth keeping only because it costs nothing and its quota resets Sep 1. No nightly import
into Turso is built; a restore into it would be a one-shot, done on the day it is needed.

## The revert (now the fallback procedure, not a Sep 1 event)

Written down before the switch was made. Every step is one command. Run this if the Zenbook is
lost or self-hosting stops being worth it — not on a date.

**1. Point production back at Turso.** The old values are not readable back out of Vercel
(both vars are `sensitive`, i.e. write-only), so the source of truth for the revert is
`~/projects/lazyboy/.env.local`, which was verified on 2026-08-08 to still authenticate
against Turso (HTTP 200 with a `BLOCKED` *quota* error, versus HTTP 400 for a deliberately
bad token — so the credential is live, only the quota is not).

```bash
cd ~/projects/lazyboy && set -a && . ./.env.local && set +a && \
VT=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/com.vercel.cli/auth.json')))['token'])") && \
for pair in "MYq6jff96jW0aPcS:$TURSO_DATABASE_URL" "N5D1ouIKdJ5Hhg32:$TURSO_AUTH_TOKEN"; do \
  curl -s -o /dev/null -w "%{http_code}\n" -X PATCH \
    "https://api.vercel.com/v9/projects/prj_UA3749Btv0RiQPwuymee4MdZZ7HA/env/${pair%%:*}?teamId=team_omHOXItW1PXTC6XJ6WBBv16M" \
    -H "Authorization: Bearer $VT" -H 'content-type: application/json' \
    -d "{\"value\":\"${pair#*:}\"}"; done
```

(`MYq6jff96jW0aPcS` = `TURSO_DATABASE_URL`, `N5D1ouIKdJ5Hhg32` = `TURSO_AUTH_TOKEN`. Patching
by env-var id keeps both `production` and `preview` targets attached.)

**2. Disarm the rotation updater first**, or the next tunnel restart will patch the URL
straight back to the bridge:

```bash
ssh ubuntu 'rm -f ~/lazyboy-tunnel/ARMED'
```

(Already done on 2026-08-10, along with `systemctl --user disable --now lazyboy-tunnel`. The
Funnel replaces it and needs no teardown step here beyond step 5's
`sudo tailscale funnel --https=443 off`.)

**3. Redeploy production** so the reverted env reaches the running functions:

```bash
cd ~/projects/lazyboy && vercel redeploy "$(vercel ls lazy-boy --prod --json 2>/dev/null | head -1)" --prod
```

or, equivalently, push any commit to `main`.

**4. Replay everything the bridge recorded back into Turso.** The listen history is the part
that must not be lost, and the recorder's capture is the authority for it:

```bash
ssh ubuntu 'python3 -c "
import sqlite3
c=sqlite3.connect(\"/home/remtbkv/lazyboy-recorder/backstop.db\")
[print(r[0]) for r in c.execute(\"select raw from plays\")]"' > /tmp/backstop.jsonl && \
cd ~/projects/lazyboy && node --env-file=.env.local scripts/backfill-from-backstop.mjs /tmp/backstop.jsonl
```

The script is idempotent (inserts only what is missing), so running it twice is safe and the
second run must report `0 inserted`. The playlist/track caches and `alltime_stats` do not need
replaying — they rebuild from Spotify on the next sync. Note the recorder's window: it keeps
every play it has ever captured, so this covers the whole bridge period, but confirm
`min(played_at)` in `backstop.db` still predates the cutover before relying on it.

**5. Tear the bridge down** once step 4 has been verified against real Turso row counts:

```bash
ssh ubuntu 'systemctl --user disable --now lazyboy-tunnel.service lazyboy-sqld.service && \
  systemctl --user daemon-reload'
```

Keep `~/lazyboy-sqld/data` until the Turso side has been checked — it is the only copy of any
non-play state written during the bridge. Delete it, `~/lazyboy-tunnel`, and the two unit
files when satisfied. **Do not stop `lazyboy-recorder`** — it predates the bridge and is the
standing insurance for the listen history.

## Failure modes worth knowing

- **Zenbook offline / asleep → production has no database.** The app degrades the way it does
  against any unreachable primary. The recorder still captures, so nothing is permanently
  lost, but the site is down for the duration. This is the real cost of the $0 route.
- ~~**`cloudflared` restarts → new hostname.**~~ Gone with the Funnel cutover: the hostname is
  permanent, nothing patches Vercel, and no Vercel credential lives on the Zenbook. It cost a
  day and a half of production downtime before it was fixed — see "Funnel cutover" above.
- **The Funnel's hostname is only as reachable as `tailscaled`.** Same shape of dependency as
  before, minus the rotation: if the node drops off the tailnet, production has no database.
- **A copied Vercel CLI token expires within days.** `auth.json`'s `token` is a short-lived
  OAuth access token that the CLI refreshes in place; a copy on another machine dies quietly
  and every API call comes back `403 invalidToken`. If anything on the Zenbook ever needs the
  Vercel API again, mint a named token in the dashboard — the API refuses to mint one from a
  CLI OAuth session.
- **`/api/cron/sync` was already returning 401** before any of this — the external pinger's
  bearer does not match `CRON_SECRET`, so scheduled syncs have not been running at all. That
  is a separate breakage from the quota block and it survives the bridge; the in-app 2-minute
  sync still works while a tab is open.
