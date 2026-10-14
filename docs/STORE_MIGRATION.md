# Store migration: the app's data to Turso, the logs stay on the Zenbook

Status: **planned 2026-10-13, not started; nothing runs before 2026-10-15 8:00 PM** (Rem, Oct 13
8:16 PM: "do it in 2 days, don't do it tonight"; lanes 1901 and 1907 carry `not_before=2026-10-15T20:00`
and every other lane waits on them). Rem asked for it on 2026-10-12/13 after a 20-second Home load and
a search that sat on "Searching…" for 49 seconds. The work runs as headless lanes on the enterprise
seats, after STAT 139 work (section 7). This file is the contract every lane works from;
a lane that finds a premise here wrong stops and says so (its outcome log, section 12) rather than
working around it.

## 1. Why

Production's store is `sqld` on the Zenbook, reached from Vercel (iad1, AWS us-east-1) through a
Tailscale Funnel (quota-forensic/BRIDGE.md). Every request pays that path at least once: `auth()`
reads the Spotify token row from `meta` before anything renders.

- **Stalls.** The Zenbook's Windows host stalls several times a day. Its two Windows-side per-minute
  monitors (`netwatchdog.log`, `netlog.log`) show 103 gaps over 100 s from 2026-09-14 to 2026-10-12,
  five of them on Oct 12. One of them, from 7:55:24 to 7:55:44 PM on Oct 12, coincided with the open
  that took 18.4 s to first paint (`client_metrics` pv:3fqcm30m: fcp 18,385 ms, data-rendered 20,040 ms,
  history-ready 49,429 ms). Nothing in the app can make a query fast while the host serving it is
  frozen.
- **The Funnel's own cost.** `SELECT 1` from the Mac: 0.8 ms on the Zenbook's loopback (p90 1.4 ms,
  n=20), but 40-210 ms median and 58-840 ms p90 through the Funnel (n=30 per run, four runs on Oct 12
  between 7:58 and 8:31 PM), with ping at 13 ms. The overhead grows with the Zenbook's load.
- A normal (no stall) Home open on Oct 12 1:00 AM: data-rendered 3,310 ms, history-ready 5,755 ms.

## 2. Requirements (each is checked by a named lane)

| id | requirement | measured by |
|---|---|---|
| R1 | A store round trip from the production function (`SELECT 1`, n=30, three runs at different hours): p50 ≤ ⅓ of L2's Zenbook baseline p50 and p95 ≤ 100 ms. Target: p50 ≤ 15 ms, p95 ≤ 50 ms | `/api/cron/store-bench` (phase A), L2 baseline vs L3 after |
| R2 | When the Zenbook is down or frozen, no user-visible request gets slower by more than 50 ms or fails | fault injection in L3: the meter frozen with SIGSTOP (connections hang, as in a host stall), timed on the bench and cron routes as proxies (Home and search need a Spotify session a lane does not have) + unit tests in phase A |
| R3 | Search is usable within 300 ms of Home's first paint on any repeat visit, and within 2 s on a first visit | `lb:index-idb` / `lb:history-ready` marks on /usage, L8 |
| R4 | Turso stays inside its free plan with room, projected from a **heavy** day (the ledger's busiest `sync_tick_landed` day), not an average one: ≤ 50% of 500M rows read and ≤ 10% of 10M rows written per month | the daily usage record (phase A item 7) + `turso plan show`, L4 and L8 |
| R5 | No data lost or changed by the move: every core table's row count equal at the snapshot; `verify-derived.mjs` green against Turso; every play the Zenbook's backstop recorder captured during the freeze present in Turso after the first sync; Rem stays signed in (the Spotify token rows on Turso are the newest) | L3 |
| R6 | No new alerting mechanism, and nothing that bills | all lanes |

If R1 is not met once the data is on Turso, the lane does not tune its way around it: it records the
numbers in its outcome log and stops the chain before the browser-cache phase, because the plan's
premise failed.

## 3. Measured facts this plan rests on (2026-10-12/13)

- **Reads are small.** The store meter (READ_QUOTA.md, "Measured reads") logged 1,430,580 rows read by
  production traffic from 9 PM Oct 12 to 6 PM Oct 13 (meter log hours 01-21 UTC), about 50-60M a month;
  its hourly totals match sqld's own cumulative counter within ~100 rows. sqld's counter read 246.8M
  total on Oct 12 (~115M/month if it dates from the Aug 8 move). Turso's free plan allows 500M.
- **Writes are small and mostly logs.** 11,136 rows written on Oct 13 UTC; `INSERT INTO api_log` was
  8,072 of them (72%). ~330K/month against 10M.
- **One query dominates reads**: the history payload's plays scan (~50,500 rows read per run), rebuilt
  after every sync that lands a play: 23 runs, 1.16M of the day's 1.94M. It is bounded by the slow
  marker (published at most every 10 min), so its ceiling is 144 runs a day, ~7.3M, ~220M a month
  at today's size; a long listening day with Home open gets near that. With the orphan passes below,
  a heavy month is ~280M (56%): that is why R4 projects from a heavy day and why lanes 1910-1911 run.
- The meter cannot attribute statements sent as one `sequence` (the cold-start `executeMultiple` of
  `CREATE TABLE IF NOT EXISTS`); they read a handful of schema rows each and are not in its totals.
- **The largest variable read did not run that day**: the unscoped orphan-flag pass
  (`recomputeOrphanFlags()` with no scope, run when the library's playlist id set changes) reads
  **5,102,733 rows** at 21,950 plays (its WHERE clause as a `SELECT count(*)` through the meter,
  Oct 13). The read ledger shows about three a week, so ~65M a month, growing with history. With it
  the month projects to ~120M (24% of the free plan); lanes 1910-1911 scope it to the playlists that
  changed.
- **Turso org `remtbkv`**: plan `starter` (free), overages disabled, quota resets at the start of each
  month (UTC). One database, `lazy-boy`, group `default`, primary `aws-us-east-1` (the same AWS region
  as Vercel's iad1), not blocked, holding the August 8 state. `turso` CLI v1.0.26 at `~/.turso/turso`,
  not logged in; it works with `TURSO_API_TOKEN="$TURSO_PLATFORM_TOKEN"` from `.env.local`.
- **Vercel**: production deploys on every push to `main` (git-connected; something pushes `main` at
  about 7 AM: `git reflog show origin/main`). Production env holds `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`
  (Production + Preview), `TURSO_PLATFORM_TOKEN`, `TURSO_ORG`, `CRON_SECRET`, `CRONJOB_API_KEY`,
  `CRONJOB_JOB_ID`. Preview deployments use the production store.
- **Pingers**: the Zenbook's `lazyboy-cron-sync.timer` hits `/api/cron/sync` every 2 min (Vercel's
  log showed one hit per 2 min, matching the timer, on Oct 12). The route's daily block, keyed on an
  `x-vercel-cron` header Vercel does not send (QUEUE.md C2), **has never run**: `client_metrics` still
  holds rows from Aug 11 and `api_log` from Aug 9 despite 30-day retention, so the daily heal, the
  prunes and the cron-job.org watchdog are all dead. Whether a cron-job.org job fires at all is
  unverified. The comment at `route.ts:49` mentions a second external pinger; nobody has identified it.
- **The quota guard is dead too**: `/api/cron/usage-check` writes a `usage_check` ledger row per call,
  and the last one is from 2026-08-10. Nothing watches Turso's usage today.
- Vercel's runtime logs age out within about an hour (`src/instrumentation.ts`), so "the last N days
  of `vercel logs`" is never available; history lives in the ledger and `client_metrics`.
- **The Zenbook reboots at about 3:00 AM daily** (`uptime -s` = 03:01 on Oct 12 and Oct 13).
- **@libsql/client** maps `libsql://` to `wss://` unless told to prefer HTTP; the app's fetch override
  (store-fetch.ts) only applies to HTTP. Use the `https://` form of the Turso URL.
- The Zenbook's sqld JWT (`TURSO_AUTH_TOKEN` today) was minted about Aug 8 for 12 months.
- The Funnel's certificate for `ubuntu.tail026729.ts.net` expires **2026-11-08 19:57 UTC** and has
  failed every renewal since Oct 10 (ACME 409 `alreadyReplaced`, tailscale 1.102.2; 1.104.1 available).

## 4. Decisions

- **Core data to Turso's free plan, in a new database `lazyboy` in group `default` (aws-us-east-1).**
  Zero cost, same libSQL protocol the app already speaks, same AWS region as the functions. The old
  `lazy-boy` database is left untouched (deleting it is Rem's call, section 12).
- **Telemetry stays on the Zenbook** (Rem, Oct 13: "Other stuff should be kept in the Zenbook"):
  `api_log`, `client_metrics`, `usage_ledger`. They are written constantly, read only by /usage and
  diagnostics, and none of them feeds a decision on a user path (checked: `api_log` is read by
  `getApiLogSummary` for a log line, `getRecentlyPlayedQuotaWindows` and `getSpotifyCallBreakdown` for
  /usage only). Moving them off Turso keeps ~75% of writes and the /usage reads off the free quota, and
  keeps their history where it already is. The cost: /usage and the logs depend on the Zenbook and the
  Funnel (and so on the certificate fix, phase F), and phase A's split code plus its review round.
  **Open question to Rem (2026-10-13):** the plan review (an unprimed Fable read) argued for moving the
  three log tables to Turso too. They are ~3% of the free write limit and a sliver of the reads, and
  moving them would drop phase A's split, lanes 1902's review round and 1909, the second backup, and the
  app's last dependency on the laptop and its certificate. The lanes follow Rem's instruction until he
  answers; if he says "move the logs too", the director rewrites this section and removes those lanes
  before 1901 starts.
- Rejected: AWS (EC2 ~$125/yr, Lightsail ~$60/yr; Rem: not worth it for this app); stopping a server
  at night (Lightsail bills stopped instances; EC2 still bills the IP and disk); a Cloudflare quick
  tunnel (66-69 ms median vs the Funnel's 40-43 ms in an A/B on Oct 12); splitting reads by path inside
  the core data (the background jobs write what search reads, so they must share a store).

## 5. Target

```
Vercel functions (iad1)
  ├─ core client ──HTTPS──► Turso `lazyboy` (aws-us-east-1)
  │     tracks, plays, contexts, meta, playlists, playlist_tracks, saved_tracks
  └─ telemetry client ──HTTPS──► https://ubuntu.tail026729.ts.net (Funnel) ─► lazyboy-meter :8090 ─► sqld :8092
        api_log, client_metrics, usage_ledger            (never awaited on a user path)
Zenbook: sqld (telemetry + the frozen pre-cutover core copy for 7 days), backstop recorder,
         nightly backups of BOTH stores, the 2-min cron pinger, the meter
```

Env (Production, Preview and `.env.local`):

| var | value |
|---|---|
| `TURSO_DATABASE_URL` | `https://lazyboy-remtbkv.aws-us-east-1.turso.io` (confirm the hostname with `turso db show lazyboy`) |
| `TURSO_AUTH_TOKEN` | `turso db tokens create lazyboy` (full access, no expiry) |
| `TURSO_DATABASE_NAME` | `lazyboy` (Production only; the usage-check guard reads it) |
| `TELEMETRY_DATABASE_URL` | `https://ubuntu.tail026729.ts.net` |
| `TELEMETRY_AUTH_TOKEN` | the Zenbook sqld JWT (today's `TURSO_AUTH_TOKEN` value) |

With `TELEMETRY_DATABASE_URL` unset, or equal to `TURSO_DATABASE_URL`, telemetry uses the core client:
tests, dev and today's single-store setup behave exactly as now.

## 6. Phase A: the code split (lane L1, reviewed by L2)

All in `src/lib/db.ts` unless named. Branch `store-split` in a worktree.

1. **Two clients.** Keep `getClient()` for core. Add `getTelemetryClient()`: when
   `TELEMETRY_DATABASE_URL` is set and differs from the core URL, its own client (same `createClient`
   options) with a store fetch of **one attempt and a 4 s timeout**; otherwise it returns `getClient()`.
   Add the options to `makeStoreFetch` (`{ attempts, attemptTimeoutMs }`), defaults unchanged (3, 15 s),
   with tests in `tests/store-fetch.test.ts`.
2. **Split `init()`** into a core init (core tables, their migrations and indexes) and a telemetry init
   (the three telemetry tables, `idx_api_log_*`, `idx_client_metrics_ts`, the `api_log.source`
   migration). Same client → run both, as today. A separate telemetry client never creates core tables
   and the core client never creates telemetry tables.
3. **Route every telemetry function to the telemetry client**: `logSpotifyRequest` (and its prune),
   `getSpotifyCallBreakdown`, `getRecentlyPlayedQuotaWindows`, `pruneApiLog`, `pruneClientMetrics`,
   `getApiLogSummary`, `ledgerAdd`, `ledgerSet`, `readLedger`, `ledgerDayModeledTotal`,
   `recordClientMetrics`, `getClientLoadSpeed`. Grep proof required in the commit message: no SQL that
   names `api_log`, `client_metrics` or `usage_ledger` runs on `getClient()`, and no SQL on the
   telemetry client names a core table. No batch mixes the two.
4. **No user path waits on telemetry.** `/api/metrics` validates, returns 204, and records in Next's
   `after()`. Existing `void …catch(() => {})` call sites stay as they are. `instrumentation.ts` keeps its
   await (errors only) but now rides the 4 s single attempt.
5. **The bench route** `src/app/api/cron/store-bench/route.ts`: `CRON_SECRET`-gated exactly like
   `/api/cron/sync` (401 otherwise; reuse that route's comparison, don't write a fourth copy if a shared
   one is easy). `?store=core` (the default): `SELECT 1` ×30 serial, one-key `meta` read ×10, and
   `getHistoryIndex(null)` ×2 (uncached). `?store=telemetry`: `SELECT 1` ×10 on the telemetry client,
   each under its 4 s timeout. Returns JSON: per probe n, p50, p95, max (ms) and failures, plus
   `VERCEL_REGION`, the store hostname (never a token) and whether the instance was cold. Reads only.
6. **/usage survives a dead telemetry store.** `usage/page.tsx` loads core and telemetry reads in one
   `Promise.all`; make the telemetry half `Promise.allSettled` with an empty state per section, so a
   frozen Zenbook costs that page its log sections after 4 s, not the whole page.
7. **The daily chores run again (QUEUE.md C2, spec in `~/.claude/burn/20261003/lazyboy-review.md`
   § C2).** Give them their own route, `/api/cron/daily`, in `vercel.json` at the existing `0 7 * * *`,
   `CRON_SECRET`-gated, so no header sniffing is needed, and remove the dead `x-vercel-cron` branch from
   `/api/cron/sync`. The daily route also runs the usage-check reconciliation (the logic in
   `src/app/api/cron/usage-check/route.ts`, imported rather than copied) so Turso's real month-to-date
   usage lands in the ledger every day and shows on /usage. It does not notify anyone (R6). The first run
   prunes ~80K old `api_log` rows on the telemetry store: one indexed DELETE, fine.
8. **The meter's core fence** (`ops/zenbook-meter/meter-proxy.mjs`): while the file
   `~/lazyboy-sqld/FENCE_CORE` exists, the meter answers HTTP 503 to any request carrying a statement
   that names a core table after `FROM`, `JOIN`, `INTO`, `UPDATE`, `TABLE`, `ON` or `table_info(`
   (case-insensitive, stored SQL resolved as the meter already does). Telemetry statements pass (mind
   `client_metrics.meta`, a column, not the table). Off by default. Lane 1903 turns it on the moment
   production runs on Turso: any old deployment a pinned tab still talks to, a dev server on the old
   `.env.local`, or a forgotten script then fails loudly instead of writing plays, or a rotated Spotify
   token, into a store nobody reads. A `node:test` suite next to it pins the classifier on every SQL
   string in `src/lib/db.ts` (grep them out): every core statement fenced, every telemetry statement
   passed.
9. **Tests** (vitest, the simulated environment in `tests/`): telemetry rows land in a second file
   store and core rows in the first; with the telemetry store unreachable (a fetch that never resolves,
   and one that rejects) a sync and the Home payload read finish within their normal time and succeed;
   with `TELEMETRY_DATABASE_URL` unset every existing suite passes unchanged; the bench and daily routes
   answer 401 without the secret, and the daily route runs each chore once (spies). Fix the two date
   time-bomb tests first (QUEUE.md T1) so the suite starts green.
10. **Docs in the same branch**: db.ts header (the "ONE client" rule becomes "two clients: core for the
   app's data, telemetry for the three log tables; a core path never awaits telemetry"), CLAUDE.md,
   docs/ARCHITECTURE.md, docs/GOTCHAS.md (the daily route, the fence), `.env.example`,
   `ops/zenbook-meter/` (README lines in BRIDGE.md).

## 7. The program

Lanes live in `~/.claude/broke/wavequeue/rem/` (enterprise only: never the personal seat) and are
numbered 19xx so they sort after STAT lanes. Each starts with
`python3 ~/.claude/broke/scratch/lazyboy_store/gate.py <its file> <flags>`; exit 3 means it re-queued
itself and must end at once. `--stat-first` defers while a STAT 139 controller has lanes running or
waiting, or a due STAT lane is queued (Rem, Oct 13: STAT first; this runs on what is left). Markers are
in `~/.claude/broke/scratch/lazyboy_store/markers/`: `<lane>.done` means its pass condition held,
`<lane>.blocked` that it stopped (one line of why). Outcomes go to
`~/.claude/broke/scratch/lazyboy_store/OUTCOMES.md`; the standing rules for every lane are in
`~/.claude/broke/scratch/lazyboy_store/RULES.md`.

| lane | does | effort | after | gate flags |
|---|---|---|---|---|
| 1901 L1 | phase A build | high | `stat_idle` (written by the watcher below) | --stat-first |
| 1902 L2 | adversarial review of L1, deploy, telemetry env, R1 baseline | xhigh | L1 | --stat-first |
| 1907 L7 | Funnel certificate (phase F); not behind STAT: a Nov 8 deadline that breaks production | high | – | --night 45 --quiet-app |
| 1903 L3 | cutover (phase C), fault injection | high | L2, L7 | --night 120 --quiet-app |
| 1904 L4 | aftercare (phase D) | medium | L3 | --stat-first |
| 1905 L5 | browser search cache (phase E) | high | L3 | --stat-first |
| 1906 L6 | adversarial review of L5, deploy | xhigh | L5 | --stat-first |
| 1908 L8 | outcome check after 3 days of real use | medium | L6 | --stat-first --age 1906.done 72 |
| 1909 L9 | archive and drop the Zenbook's stale core tables | medium | L4 | --stat-first --age 1903.done 168 |
| 1910 L10 | scope the orphan-flag pass to changed playlists (R4 headroom) | high | L3 | --stat-first |
| 1911 L11 | adversarial review of L10, deploy | xhigh | L10 | --stat-first |

A LaunchAgent on the Mac, `com.remtbkv.lazyboy-statwatch`, runs `gate.py --mark-idle` every 10
minutes and writes `markers/stat_idle` the first time STAT has nothing running, waiting or due, so
the chain's first lane waits on a file instead of being spawned and deferred all evening; lane 1904
removes the agent. All lanes are queued at once; the `after=` markers and the gate order them. 1907 and the 1901-1902
pair run independently; 1904, 1905 and 1910 run in parallel after the cutover. Their code is disjoint;
their docs overlap, so each rebases onto `origin/main` before it pushes (RULES 5) and merges both
sides of a doc conflict.

## 8. Phase C: cutover runbook (L3)

The whole run fits 120 min (the gate's `--night 120`); the freeze, step 2 to step 12, is at most 45
min. Abort at any step before 9 = re-enable the pingers, change nothing in Vercel, write the reason in
the outcome log. All times local. Vercel commands run with `--cwd /Users/remtbkv/projects/lazyboy`
(the project link, `.vercel/`, is gitignored and exists only in the shared checkout). Store reads on the
Zenbook during and after the fence go to sqld directly (`127.0.0.1:8092`, over `ssh ubuntu`), never
through the meter. Comparison work uses a small script in the lane's scratch with its own
`npm i @libsql/client@0.17.3` there; `CRON_SECRET` comes from `.env.local`.

1. **Preconditions**: the 1902 and 1907 markers exist, and 1902's says the fence-capable meter is
   deployed; the gate passed; `broke --list` shows no other lazyboy lane running.
2. **Pingers off**: `ssh ubuntu systemctl --user disable --now lazyboy-cron-sync.timer` (disable, so the
   3 AM reboot cannot bring it back). Then watch `vercel logs --since 10m --json` for 6 minutes: any
   `/api/cron/sync` hit now comes from another pinger. If there is one, try to identify and pause it
   (cron-job.org: `vercel env pull --environment production <scratch file>` for `CRONJOB_API_KEY`; a
   sensitive variable does not pull, and then the lane cannot pause it). An unpaused pinger does not
   abort the run: writes it lands on the Zenbook between steps 4 and 10 are plays the next sync re-reads
   from Spotify and `meta` values the app recomputes; the tokens are handled in step 10. Record it.
3. **Quiet**: the meter log shows no statement with `rw > 0` for 6 consecutive minutes (at most 15 min
   of waiting; with a live second pinger, take the snapshot between two of its ticks). Record `T_snap`.
4. **Snapshot** on the Zenbook with SQLite's backup API from `~/lazyboy-sqld/data/dbs/default/data` (as
   `~/lazyboy-backup/backup.py` does) into `~/lazyboy-migrate/core-<stamp>.db`; `PRAGMA integrity_check`
   = ok; record per-table counts for the seven core tables and `max(played_at)`.
5. **Strip**: on the copy, `DROP TABLE api_log; DROP TABLE client_metrics; DROP TABLE usage_ledger;
   PRAGMA journal_mode=DELETE; VACUUM;` then `integrity_check` and the seven counts again. List
   `sqlite_master` and note anything unexpected (an sqld-internal table) before importing. Copy the file
   to the lane's scratch on the Mac.
6. **Import**: `TURSO_API_TOKEN=… ~/.turso/turso db create lazyboy --from-file core.db --group default
   --wait`. If the CLI refuses the file, use `--from-dump` with `sqlite3 core.db .dump`. Never touch
   `lazy-boy`. Read the hostname from `turso db show lazyboy`.
7. **Verify on Turso** (R5): the seven counts and `max(played_at)` equal step 4; 20 random `plays` rows
   and 20 random `tracks` rows equal column by column against the snapshot file; the `meta` key set
   equal; `scripts/verify-derived.mjs` green with `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` set to Turso
   for that one command. **Never `--demo` against a real store.**
8. **Tokens for the store**: `turso db tokens create lazyboy` (the app's) and `--read-only` (backups,
   lane 1904), straight into mode-600 files in scratch.
9. **Flip** Production and Preview: `TURSO_DATABASE_URL` (the `https://` form), `TURSO_AUTH_TOKEN`; and
   Production `TURSO_DATABASE_NAME=lazyboy`. `vercel env add <NAME> <environment> --force`, value on
   stdin (not on the command line, where `ps` shows it). Then `vercel redeploy <url> --target production`
   with `<url>` from `vercel ls lazy-boy --prod` (not `vercel --prod`, which uploads a working tree).
   Wait for Ready; record the new deployment url.
10. **Fence and tokens**, at once: `ssh ubuntu touch ~/lazyboy-sqld/FENCE_CORE`. From here every
    statement naming a core table that reaches the Zenbook through the Funnel gets a 503, so an old
    deployment can no longer write a play or rotate a token there. Then compare `meta.spotify_tokens` and
    `meta.spotify_tokens_dev` between the Zenbook (read on sqld directly) and Turso, on `refreshToken`
    and `expiresAt`. If the Zenbook's row differs and its `expiresAt` is later, write its value to Turso;
    if Turso's is later, keep Turso's. Repeat this compare after step 12 and as your last action. A dead
    refresh token on Turso is what logs Rem out (`auth.ts`, `clearTokensIfStale`).
11. **Smoke**: three bench runs (R1: numbers, `VERCEL_REGION`, core host = Turso); one `/api/cron/sync`
    with the secret answers ok and Turso's `meta.last_sync` moved; the meter log shows the fence's 503s
    (old deployments, a dev server) and their sources; watch them stop over 30 minutes rather than chase
    each one (pinned tabs reload to the new build through build-skew).
12. **Pingers on**: `systemctl --user enable --now lazyboy-cron-sync.timer`; resume anything you paused
    in step 2. Three ticks answer 200 and Turso's `meta.last_sync` moves with each.
13. **Missed plays** (R5): compare the backstop recorder's plays (`~/lazyboy-recorder/backstop.db`) from
    `T_snap - 10 min` to now with Turso's. Spotify's recently-played covers the last 50 plays, so the
    first sync should already have them; if any are missing, read the script's known issue (QUEUE.md D3)
    and replay with `scripts/backfill-from-backstop.mjs --db <turso url>` and Turso's token.
14. **Fault injection** (R2): first time three `/api/cron/sync` calls, a minute apart, as the normal
    spread (that route waits on Spotify, so its own time varies). Then find the meter's pid
    (`systemctl --user show -p MainPID lazyboy-meter`) and `kill -STOP <pid>`: its socket stays open and
    requests hang, as in a host stall. Within the next 3 minutes: the core bench's p50 is within 50 ms
    of step 11's, and three `/api/cron/sync` calls succeed inside the spread you just measured. The
    `?store=telemetry` bench shows the 4 s failures, which is the point. `kill -CONT <pid>` and confirm
    telemetry rows arrive again.
15. **Dev**: keep a mode-600 copy of `.env.local` in scratch, then point `.env.local` at the new layout
    (section 5) so dev reads and writes production's data again.
16. Final token compare (step 10's rule). Record every step's evidence in the outcome log; write the
    marker.

**Rollback.** Before step 12: remove `FENCE_CORE`, flip the env back, redeploy; the Zenbook's core
tables are untouched since `T_snap`. After step 12 the Zenbook copy is stale: dump Turso's core tables
(`turso db shell lazyboy .dump`), `systemctl --user stop lazyboy-sqld`, load the dump into a copy of the
Zenbook file, swap it in, `systemctl --user start lazyboy-sqld`, remove `FENCE_CORE`, then flip back.
Write down which way the data went.

## 9. Phase D: aftercare (L4)

- **Backups**: `~/lazyboy-backup/backup.py` backs up both stores nightly: Turso's core (a dump with the
  read-only token, loaded into SQLite, `integrity_check`, counts equal to Turso's, gzip, rclone as today)
  and the Zenbook file (telemetry). It also deletes the `-wal`/`-shm` files it leaves next to snapshots
  (98 MB of them on Oct 13). Test one restore end to end.
- **Quota visibility**: `TURSO_DATABASE_NAME=lazyboy` in Production; call `/api/cron/usage-check` once
  and check it reports `lazyboy`'s real usage; confirm the daily route (phase A item 7) wrote today's
  usage row to the ledger after 07:00 UTC. The cron-job.org job that used to call the guard has not run
  since 2026-08-10 (the last `usage_check` ledger row): if `CRONJOB_API_KEY` pulls, read the account's
  jobs and record whether the usage-check job exists and is enabled. Do not create or re-enable any job
  (R6); if it is dead, add one line for Rem to NEEDS_REM.md.
- **Docs**: BRIDGE.md (the Zenbook is the telemetry store, backstop and backups; core moved),
  READ_QUOTA.md (the meter now sees telemetry only; Turso's usage comes from the guard and
  `turso plan show`), GOTCHAS.md, CLAUDE.md.
- **The 7-day cleanup** is lane 1909, already queued and gated on the L3 marker's age: it archives
  the Zenbook's stale core tables (snapshot, gz, rclone) and then drops them from sqld so nothing can
  read a week-old copy by mistake.

## 10. Phase E: search from the browser's copy (L5, reviewed by L6)

Search already matches in the browser once both payloads are in memory (18 ms per query in `lb-perf`);
the wait is the download on every visit, which the history half repeats after any new play.

- Keep the last good `/api/search/library` and `/api/search/history` bodies in IndexedDB, keyed by the
  payload shapes (`LIBRARY_INDEX_SHAPE`, `HISTORY_INDEX_SHAPE`) and the signed-in user's id. On Home
  mount, before the network, read them and build `entries` at once; mark `lb:index-idb`. Then fetch as
  today (the browser revalidates with the ETag) and swap in the fresh pair when it lands; store it.
- Same validators as the network path (`fetchPayload` checks); a stored body that fails them is deleted.
  A different user id, or sign-out, clears the store. Storage failures (private mode, quota) fall back to
  today's behaviour silently.
- The day list also derives from the history payload: a stored copy may be minutes old until the fresh
  one lands. Today stays the server's (`initialTracks`), so check that a stored payload never replaces a
  fresher day the page already holds.
- Add `index-idb` to `SUMMARY_EVENTS` so /usage shows it. Unit-test the cache module behind a small
  storage interface (no new dependency); there is no Spotify login for a headless check, so real use is
  the end-to-end test (L8).

## 11. Phase F: the Funnel certificate (L7)

Deadline 2026-11-08 19:57 UTC. Telemetry needs the Funnel after the move; until the move, everything
does. At night (gate), on the Zenbook: back up `/var/lib/tailscale/certs/`, upgrade tailscale
(`sudo apt-get install --only-upgrade tailscale`), and watch the journal for a successful renewal. If it
still fails with `alreadyReplaced`, move the cached `ubuntu.tail026729.ts.net.crt` and `.key` aside and
run `sudo tailscale cert ubuntu.tail026729.ts.net` to order a fresh certificate. Pass: `openssl s_client`
shows `notAfter` later than 2026-11-08 and a store query through the Funnel succeeds. A failure restores
the backup and stops with the evidence in the outcome log. The L7 marker means "finished, Funnel untouched
now", whatever the outcome, so the cutover never runs while the Funnel is being changed.

## 12. Outcomes and open items

(Lanes log to `~/.claude/broke/scratch/lazyboy_store/OUTCOMES.md` as they finish; lanes 1904 and
1908 fold that log in here: what ran, the numbers against R1-R6, anything held and why.)

Open for Rem, not for a lane:
- Delete the old Turso database `lazy-boy` (August state, 0 B counted)? Nothing reads it after the move.
- The Vercel log capture on the Zenbook has been dead since Aug 9 (invalid token): renew or retire.
