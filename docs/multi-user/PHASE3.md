# Multi-user Phase 3, built ahead of its turn

Lane 1945_lb_mu_04_p3_build, Oct 15-16, 2026, branch `mu/phase3`, cut from `mu/phase2` at `a90104d` (lane 03's
reviewed head). Nothing here is merged, pushed or deployed. Nothing touched production data, Spotify, the
Zenbook, Vercel, Turso or the Keychain: every test runs against local database files and a scripted Spotify.

Status: built (lane 04), reviewed (lane 05), replayed onto Phase 2's base (lane 31, §9) and wired by Phase 3's
turn (lane 17, `mu/phase3-turn`, §10). §2 is what landed, §3 what proves it, §4 what the turn wired and why each
waited, §5 the Zenbook at deploy (superseded by §11, lane 23's steps), §6 the choices made where PLAN left one open,
§7 how to review.

## 1. What this branch is

PLAN.md §13.4 lets a lane build a phase early in new files and files no queued lane edits; this lane's brief
narrowed that to new files and the files `mu/phase1` and `mu/phase2` changed. So the branch edits, of those,
`src/lib/app-db.ts`, `src/lib/token-core.ts`, `src/lib/auth.ts` (one export), `src/lib/spotify/resources.ts`
(one method) and the isolation suite's static checks, planted bugs and token-core test. Everything else is
new. The cron route, `/api/sync`, `db.ts`, `client.ts`, `store-diff.ts`, `history-actions.ts`,
`sync/history.ts` and `sync/library.ts` are untouched: §4 says what each needs.

The rulings it follows: decision 28 as ruled at 1:17 PM (two-minute updates for everyone, so PLAN §7.2's
five-minute idle step for three or more users is gone; the brake only as the safety valve), decisions 15
and 26 as approved at 6:21 PM, decision 18 (no Vercel Pro: the tick replies within 20 s and does its work in
one invocation a minute whatever N is).

## 2. What is built

- **The probe and the harvest policy** (§7.3-7.4), pure, in `src/lib/harvest-policy.ts` beside
  `harvest-gate.ts`:
  - `observe(prev, obs, now)`: what a `/me/player` answer counts as a track change (a different track id;
    the same track with progress more than 10 s below where it would be had it played on since the last
    write, a repeat; playback stopped, paused or gone), and whether the user's `meta.probe` needs writing
    (only when the track or the play state changes, scale 8). `ProbeState` keeps the last track, its
    progress and when, when playback stopped, the changes since the last harvest, a pending session tail,
    and the tail's retry time.
  - `decideHarvest(input)`: the trigger, in this order: `tail` (the first probe that finds playback
    stopped); `completeness` (25 changes, whatever the brake says); `change` (any change, or one batch per
    15 or 30 minutes under the brake); `tail-retry` (once, ~5 minutes after the tail); `backstop` (a
    parameter: hourly in Phase 3, 2 hours from Phase 4a; also the 30-minute harvest for users active in
    the last 3 hours when the probe cannot run, §7.8); `open-app` (a load or return to the tab with a
    change the brake held back, at least 60 s after the last harvest). The recently-played cooldown holds
    them all. `afterHarvest` clears the counted changes and books the tail's one retry.
  - Cadence (decision 28 as ruled): every user every 2 minutes whatever N. `nextDue` keeps each user on a
    2-minute lattice offset by an FNV hash of the uid, so with both pingers (a tick a minute) users split
    across even and odd minutes and each is probed every 2 minutes, and with either pinger alone it is
    still every 2 minutes; due 30 s early. `backoffMs`: 2, 4, 8 … 60 minutes.
- **The fair-share brake** (§7.5), pure, in `src/lib/brake.ts`: the quota day from 14:51 UTC (the anchor
  `getRecentlyPlayedQuotaWindows` uses) and its next reset, the share 426 / N, `normal` / `share` (15-minute
  batches for that user) / `all` (30 for everyone at 426), and `BRAKE_ON = false`, the one constant Phase
  4a flips (the tick's `PHASE3_TICK.brakeOn` reads it; lane 04 had a separate `false` there, which lane 05's
  review wired to it). It counts in Phase 3: every harvest increments `sync_state.rp_calls` for the quota day, awaited
  before the call.
- **The Liked change** (§7.7), pure, in `src/lib/liked-diff.ts`: `likedDiff` keys Liked Songs by track and
  ignores position, so one like writes one row; `likedHead` reads from the newest page until a stored
  `(track, added_at)` appears and answers `more`, `diff` (upserts and deletes) or `refetch` when the count
  still disagrees (an unlike the head cannot see).
- **The sync queue's statements** (§7.2, §7.5-7.8), in `app-db.ts` beside its others:
  - `readOwnerAlarm`: the admin's status and token row, and the users whose token failed to decrypt since
    the last tick's stamp.
  - `stampTick(now, windowMs)`: `tick_at` as a compare-and-set, inserted if absent, the window a parameter.
  - `claimDueUsers`: one write batch, one round trip. It gives every active user without a queue row one
    (due now), leases every due `active` user (the admin alone under `SIGNUPS=owner`) for 50 s, returns them
    joined to `db_name` and their token row, and reads the tick's view: the quota day's total, N, `daily_at`,
    every `cooldown:<bucket>`, at most one `needs_reconnect` user due their confirmation, and the users whose
    last step succeeded within 10 minutes. It mints the leased uids (S2 lists `app-db.ts` as the claim's
    minter).
  - `claimUser`: one user's lease for the open app, with the same view.
  - `releaseLease`: a compare-and-set on `lease_owner` and a live `lease_until`, so a step that outlived its
    lease writes nothing, taken or not.
  - `countRpCall`, `extendCooldown` (only ever later), `claimRescan` / `scheduleRescan`,
    `startGrantConfirm` / `finishGrantConfirm`, `grantFailuresSince`.
  - The alarm read, the stamp and the claim ride one attempt with a 5-second timeout per request
    (`oneAttemptFetch` under `makeStoreFetch`, so the gzip pin and the Request rebuild stay), including the
    schema check a cold process makes before them. A local file (dev, tests) uses the process's client.
- **The tick's token read** (§5.4 step 1): `tokenForTick` in `token-core.ts` shares the row, the lock and the
  in-flight map with `getValidAccessToken`, but throws every failure to the step and never clears a dead
  grant, so the blob stays for the confirmation. `auth.ts` exports it for the route.
- **The probe call**: `playerState()` in `resources.ts`, `/me/player` alone, null on a 204.
- **The step** (§7.2 step 3, §6.2 layer 4), `src/lib/sync/step.ts`: its Uid, its `StepStore` (the part of
  Phase 1's `UserStore` the step uses: `readProbe`, `writeProbe`, `recordHarvest`, `rescanLibrary`), a
  token getter bound to its uid, its deadline, and its own row of the queue (last harvest, the quota day's
  count, the counter bound to its uid). It reads the token first, probes unless the player bucket is
  cooling down, writes the probe state on change, asks the brake and the policy, counts, harvests through a
  client tagged `harvest:<trigger>`, records into its own store, and returns an outcome; it never writes the
  schedule. Failures map to codes: `no-token`, `invalid-grant`, `decrypt` (a blob or key the deployment
  cannot read), `token-error`, `not-registered` (a 403 in either of Spotify's wordings), `spotify-error`
  (5xx, network, timeout), `rate-limited`, `quota` (a QUOTA_EXCEEDED, which cools that bucket until the
  observed reset, at most 30 minutes), `store-error`, `timeout`.
- **The tick** (§7.2), `src/lib/sync/tick.ts`, `runTick(deps, authorization)` with every dependency injected
  (`TickDeps`: the clock, the caller, the queue, `storeFor`, `tokenFor`, `after`, the daily chores, the
  config; `PHASE3_TICK` holds 45 s, hourly, the brake as `BRAKE_ON` says (off), 15 s, 20 s, 10 s):
  0. The caller from its secret (`cron-auth.ts`). The Zenbook's caller reads the owner alarm first and gets
     503 when the admin is missing, not `active`, has no token row, or when two or more users or the admin
     failed to decrypt in the last tick or this one. cron-job.org's caller gets `{"ok":true}` in every case.
  1. The stamp; 2. the claim (a failure ends the tick, 200 `skipped: store`);
  3. steps under `Promise.allSettled`, 15 s each, each released from its outcome (`ok`, `quota`,
     `rate-limited`, `no-token` keep the 2-minute cadence; `decrypt` writes nothing and the lease lapses;
     `invalid-grant` moves the user to `needs_reconnect` with an `invalid-grant` event; the rest back off);
  4. at most one rescan, for the most overdue user whose step succeeded, with 10 s of the 20 left, then due
     again in 30 minutes if active or 150 if idle (10 on failure);
  5. the reply by 20 s, `after()` for the rest, per-user codes and counts for the Zenbook (`pending` for a
     step still running);
  6. the daily chores in `after()` when `daily_at` is over 26 hours old, under `lock:daily`, stamping
     `daily_at` when they finish.
  Then: a 403 "not registered" marks a friend `removed` only at their second refusal in a row, and only when
  another user's calls worked after the first (in this tick, or a success stamped since); never the admin;
  when everyone fails that way, on one tick or on their own minutes, everyone backs off. §5.4 step 2:
  one confirming refresh for at most one user 10 minutes after their `invalid_grant`, which returns them to
  `active` or records `invalid_grant:confirmed`; step 3: two or more users, or the admin, hit within 24
  hours records a `grant-wide` event.
- **The open app** (§7.6): `runOpenApp(deps, { uid, load })`, the same step under the same lease. A load or a
  return to the tab leases the user whether or not they are due, keeps their due time, and harvests a change
  the brake held back (`open-app`); the tab's 2-minute timer runs a step only when no tick has stamped in 5
  minutes.

## 3. The tests, and what each proves

All in the simulated environment. 118 new tests in seven new files and three changed ones (vitest: 830
against `mu/phase2`'s 712). Every new check was shown failing first, as the last column says: against a
missing module or export, against the first draft, or against a mutant of the real code (one line changed,
the suite run, the line restored). 29 mutants in all; none survived.

Gates at `d110dee`, the last code commit (this document is the one after it), Oct 16, 12:28 AM: `tsc
--noEmit` and lint clean; `npm run build` passes with no store variables; the three node suites pass; vitest
828 of 830, the two failures being the date tests `mu/phase2` inherited from `main` at `6577f4b`
(`store-plays.test.ts` "daily stats agree…", `sync-history.test.ts` "harvests, resolves context names…").
With their fix, `ca44438` on `main`, applied to the worktree for one run and restored after: 830 of 830. The
turn's rebase brings the fix.

| file | what it proves | shown failing against |
|---|---|---|
| `tests/harvest-policy.test.ts` | the probe's change rules and when it writes; each trigger and its order; completeness and the tail in every brake mode; the tail's retry once at ~5 min; the backstop as a parameter; open-app catch-ups at 60 s; the cooldown; the blind 30-minute rule; a 5-track session probe by probe (one harvest per change, the tail, its retry, the hourly backstop, 7 writes); 2-minute cadence with a tick a minute, every 2 minutes, a late tick, after an outage; backoff | the missing module; 6 mutants (tail precedence, completeness at `>`, the retry's 30 s, the paused anchor, the retry kept, the lattice) |
| `tests/brake.test.ts` | the quota day and its reset at 14:51 UTC; 426/N; `share` and `all`; off in Phase 3; completeness, tail, retry, backstop and open-app firing in `share` and `all` | the missing module; 3 mutants |
| `tests/liked-diff.test.ts` | one like writes one row; unlike, re-like; the first page meeting the store; a head longer than a page; an unlike (with and without a like) forcing a refetch; an empty store read to the end | the missing module; 3 mutants |
| `tests/isolation/sync-queue.test.ts` | the stamp's window, as a parameter and under a burst; the claim's lease, join and view, SIGNUPS=owner, only due active unpaused users, a lapsed lease due again, the queue row a first tick creates; T6's claim half (a leased user is not due to a second tick or a tab); the release's compare-and-set; the counter across quota days; cooldowns; the rescan claim; the confirmation's due time and once-only claim; the 24-hour count; the owner alarm's read; one attempt per request and the 5-second abort, through the store fetch | Phase 2's `app-db.ts`; 5 mutants (no owner check, no due check, no SIGNUPS, no live-lease check, a second attempt) |
| `tests/isolation/t4-tick.test.ts` | **T4**: two users, each user's calls with their own bearer and plays in their own store; A failing while B stays `ok`, eight ways: a dead grant (stop and keep, an event, then the confirmation bringing A back, or confirmed dead once), both users dead (`grant-wide`), no token row, a 5xx (backoff), a token that does not decrypt (nothing written), a bare 403 (backoff), a 403 "not registered" (A removed at its second refusal, the admin untouched), everyone refused that way (nobody removed, also after both had been working and when the refusals begin on different minutes), the admin refused that way while a friend works (never removed); A's Spotify hanging (A abandoned at 15 s, the reply inside 20 s, real timers); a reply sent before a step finishes (`pending`, the rest in `after()`); one rescan a tick and none with under 10 s left; the daily chores once, under the lock; the open app's catch-up; the tab's timer standing in only after 5 minutes | the first draft (it caught "the user may not be registered" not being read as not-registered); 5 mutants (removal without another user working, invalid_grant not moving the status, a decrypt failure written, the count skipped, no-token backed off) |
| `tests/isolation/t13-tick-callers.test.ts` | **T13**: no secret, wrong secrets and near misses refused before anything runs; the Zenbook gets codes and counts with no track, name or token; cron-job.org gets `{"ok":true}` after the same work; the owner alarm 503 to the Zenbook only (admin not active, no token row even on a skipped tick, two decrypt failures from the other pinger's tick, the admin's own in this tick; one friend's is not the alarm); a burst of seven calls doing one tick's work; 45 s lets pingers a minute apart both tick and 90 s every other; cron-job.org's body bare when the tick worked, skipped, met a store outage or an alarm; the store down at the claim ending the tick with no Spotify call | 4 mutants (ext answered like the Zenbook, the stamp ignored, the alarm never read, this tick's decrypts ignored) |
| `tests/isolation/step-quota.test.ts` | a rate-limit 429 backs nobody off; QUOTA_EXCEEDED cools `cooldown:recently-played` to min(reset, 30 min) and the next tick does not ask it | 3 mutants |
| `tests/isolation/token-core.test.ts` (3 added) | `tokenForTick`: fresh, refreshed, null; invalid_grant throws terminal and clears nothing; a failed read throws | the core before `tokenForTick` |
| `tests/isolation/planted-bugs.test.ts` (2 added) | **planted**: a tick that hands every step the first user's store; a release without its owner check. Each caught; each check passes over the real code | the planted bugs themselves |
| `tests/isolation/static.test.ts` (changed) | S2 lists the claim as a minter; S3's snapshot takes the new exports | S2 and S3 failed until updated |

The harness is `tests/isolation/tick-harness.ts`: a Spotify scripted per bearer (a track, a 204, a status, a
hang that honours the abort), a memory store per user that records every play it was handed, `tickDeps`
over the real app database.

## 4. What Phase 3's turn wires (lane 17), and why each waits

Each sits in a file queued lanes edit, or needs `forUser` (Phase 1's turn) or the daily route (lane 1901).

1. **`/api/cron/sync` becomes the tick** (queued: the cron route). Roughly:
   ```ts
   export const maxDuration = 60;
   export async function GET(req: Request) {
     const r = await runTick(
       {
         now: Date.now, caller: cronCaller, queue: appQueue, tokenFor: tokenForTick, after,
         storeFor: (u) => stepStoreOf(forUser(u.uid, u.dbName)), dailyChores: runDailyChores,
         config: { ...PHASE3_TICK, signups: signupsMode() },
       },
       req.headers.get("authorization"),
     );
     return Response.json(r.body, { status: r.status });
   }
   ```
   `stepStoreOf` adapts Phase 1's `UserStore`: `readProbe`/`writeProbe` are `meta.probe` as JSON;
   `recordHarvest` is today's `syncRecentPlays` after its Spotify call (record the plays, resolve contexts
   with the client passed in, rebuild the Home payload), returning `added`; `rescanLibrary` is `syncLibrary`
   with `paceMs` and the deadline (item 7). The route's `x-vercel-cron` block, `maybeSyncLibrary`, the
   harvest gate and `getSpotifyTokens` go: the daily block moves to `/api/cron/daily` (lane 1901), which
   `runDailyChores` calls; the interim pinger's 90-second guard (lane 07) becomes `PHASE3_TICK`'s 45. If the
   interim route already names its callers with `cron-auth.ts`, keep it.
2. **`/api/sync`'s open-app rules** (queued: the route). The session's uid into
   `runOpenApp(deps, { uid, load })`: `load` true on a load or a return to the tab, false on the 2-minute
   timer; `sync-on-load.tsx` says which. Its debounce (`STALE_MS`, harvesting whenever the last harvest is a
   minute old, playing or not) goes. The browser's zone is written only when it changes (item 6).
3. **`refreshHistoryAction` off Spotify** (decision 15; queued: `history-actions.ts`). It stops calling
   `syncRecentPlays` and only re-reads the user's store; the provisional row covers the moment a track ends,
   and the stored row arrives with the next tick, up to ~2 minutes later.
4. **`client.ts`'s per-bucket cooldowns and the 429 `reason`**. Today a long ban sets one module-wide
   `cooldownUntil` and one persisted `spotify_cooldown_until`, so a recently-played QUOTA_EXCEEDED stops
   every user's probe and rescans for up to 30 minutes (`step-quota.test.ts` notes it). The turn keys both by
   bucket (`cooldown:recently-played`, `cooldown:player`, `cooldown:library` in `app_meta`, which the claim
   already reads and the step already honours), keeps a rate-limit 429 app-wide and seconds long, and logs
   the body's `reason` into `api_log`. Also there: **paced background pages** (`getAll` sleeps between
   pages and takes a resumable cursor in place of the throw at page 501, §6.6, §7.7), and the security R15
   check at Phase 4a (after the first refusal of a quota day, one other user's next harvest goes through
   first: refused too, the cooldown goes app-wide; accepted, it stays that user's).
5. **`db.ts`'s telemetry**: `api_log` gains the uid (the source already carries `harvest:<trigger>` and
   `cron-probe` from this branch); the `handoff` beacon sends a track id, not "artist — title"; each harvest
   records its plays' lag for the daily `lag_p50_s` / `lag_p95_s` roll-up (§7.8).
6. **`user_tz`** (§4.3): an IANA zone in the user's `meta`, written by `/api/sync` only when it changes,
   replacing `user_tz_offset` and `HOME_TZ` in the Home payload's day bucketing.
7. **The rescan changes** (§7.7; `sync/library.ts`, `db.ts`, `store-diff.ts` is lane 1910's): no `/me` call
   (the Spotify id is on the users row); every playlist's snapshot in one statement over `plsnap:` keys;
   `storeSavedTracks` diffing with `likedDiff` and the scan reading Liked with `likedHead`; `/me` and
   recently-played calls counted with `countRpCall` before they are made. `rescanLibrary`'s deadline stops it
   between playlists.
8. **`sync_state` as capture health**: `getCaptureHealth()` and the banner read `last_ok_at` and
   `last_harvest_at` (the identity read already returns them) instead of `meta.last_sync` and the plaintext
   token row; the health check's owner-capture rule becomes "the admin is active and his last successful
   tick is over 30 minutes old" (§7.10), and it reads unreported `events` rows, which now include
   `invalid-grant` and `grant-wide` (PHASE2.md §4 item 8).
9. **The request path's dead grant** (`token-core.ts` `getValidAccessToken`, used by the jwt callback):
   it still clears the row on invalid_grant, the single-user behaviour. For the admin that is today's
   "signed out" and the owner alarm; for a friend §5.4 wants stop-and-keep, so Phase 4a moves the request
   path onto the same rule before anyone else signs in. Also there: §5.4's "a 401 on a token the store
   believes fresh zeroes that user's `expires_at`".
10. **CLAUDE.md, ARCHITECTURE.md, GOTCHAS.md**: the cron's shape (a claim, per-user steps, the stamp, two
    pingers), the recorder hourly, the harvest triggers. Left to the turn because queued lanes edit those
    files; this branch adds only this document.
11. **What the Zenbook's reply carries, before Phase 4a** (lane 05's review; a recommendation, not built).
    PLAN §7.2 step 5 gives the Zenbook's caller one outcome per user, and `ping.sh` appends every reply to
    `ping.log`, so from the first friend that file holds each friend's uid with a `change` or `tail`
    trigger and a count, minute by minute: when they listen. RULES 11 keeps agents off a friend's
    telemetry in any log, and agents read `ping.log` to debug capture. Either the body names the admin's
    step alone and counts the rest by outcome code, or `ping.sh` stops keeping bodies. Also: the claim's
    token join goes unused (each step re-reads its row through `tokenFor`, one more app-database read per
    user per tick); handing the claimed blob to the token core saves it.

What does not wait on a decision: everything above. Decisions 15, 26 and 28 are ruled (§1).

## 5. The Zenbook at deploy (lane 23), under DiveLoop's change lock (RULES 16)

- `lazyboy-cron-sync.timer`: `OnCalendar=*:0/2` in place of `OnUnitActiveSec=2min`, so the Zenbook's ticks
  land on even minutes and cron-job.org's (lane 11's job, every 2 minutes) on odd ones; with both alive the
  app ticks every minute and each user is still probed every 2 minutes (§2's cadence). `daemon-reload` and
  restart the timer; `ping.log` should show 200s with `steps`. Set `AccuracySec=1s` beside it: systemd's
  default of a minute places each run at a fixed, host-chosen second inside that minute, and anywhere past
  :15 puts cron-job.org's odd-minute tick less than 45 s after the Zenbook's, so every one of them is
  skipped by the stamp and the app ticks every 2 minutes, not every minute (each user is still probed every
  2 minutes, and either pinger alone still keeps it; lane 05's review).
- `lazyboy-recorder.timer`: hourly instead of every 15 minutes (decision 26): 24 scarce calls a day instead
  of 96, which `APP_DAILY_BUDGET` (450 less 24) already assumes.
- Afterwards, PLAN §13.1's exit checks: a week with Rem's harvests near ~150 a day (read from the
  `harvest:<trigger>` sources), every tick inside 20 s, the open app harvesting only catch-ups, no play
  first stored by a backstop while Rem was listening, the recorder diff empty, the second pinger proven by
  stopping the Zenbook timer for ten minutes, the fault injection re-run. Rollback: the stamp window back to
  90 s (`PHASE3_TICK.stampWindowMs`), then §13.5.

## 6. Choices made where PLAN left one open

- **The step's inputs.** PLAN names four (Uid, store, token getter, deadline). The step also gets its own
  queue row, read by the claim, with the brake's counter bound to its uid: the count must be awaited before
  the call and the policy needs the last harvest time. It never gets another user's row, and it never writes
  the schedule; the tick releases from its outcome.
- **A repeat** is the same track more than 10 s below where it would be had it played on since the last
  write. A pause shorter than a probe interval also reads as one, which costs one harvest.
- **Paused counts as stopped** for the tail, as the single-user gate's `isPlaying` does (audit T1.2).
- **The tail stays pending until a harvest lands**, and so do counted changes, so a failed or cooled-down
  harvest is retried instead of lost. Any later harvest covers a pending retry.
- **The retry fires at the first probe at or past 4.5 minutes** after the tail: with 2-minute probes, 6
  minutes, inside the p95 of 300 s to stored.
- **The probe refused** (a player-bucket quota): the 30-minute rule is tagged `backstop`, since §7.4's six
  tags have no seventh.
- **The cadence lattice** (§2): due times anchored on the time served, not the step's end, so a step's own
  duration never stretches the cadence.
- **"Every user failed the same way in one tick"** is read as "no other user's calls worked after this
  friend's previous refusal", and removal waits for a second refusal in a row (2 minutes later, by when every
  other user has been served). The uid offsets mean a tick often serves a subset, so a single tick cannot
  show that everyone failed; and a success from before the onset proves nothing. Lane 04's first reading
  ("no other user's calls worked in this tick or the last 10 minutes") counted those earlier successes,
  including the failing users' own, so it removed a friend whenever the admin and the friend were refused
  in one tick after working minutes before (lane 05's review, `t4-tick.test.ts`).
- **`no-token` keeps the 2-minute cadence** (one app-database read, no Spotify call) so capture resumes
  within 2 minutes of a sign-in; `decrypt` writes nothing and lets the 50-s lease lapse.
- **`invalid_grant` bookkeeping** lives in `sync_state.last_error` (`invalid_grant` → `confirming` →
  `confirmed`, or cleared) and in `events` (`invalid-grant` per hit, `grant-wide` at two users or the admin),
  so the health check e-mails each. The status move and the event follow the lease's release, and only
  when it landed: written before it (lane 04's order), a release refused after a slow store left the user
  `needs_reconnect` with no `invalid_grant` for the confirmation to find (lane 05's review). Steps 4-5
  (expiry or `revoked`, deletion on day 4) are Phase 4a's.
- **QUOTA_EXCEEDED** cools its bucket to min(the next 14:51 UTC reset, 30 minutes), the client's re-probe cap.
- **The daily lock** is 15 minutes; chores that throw keep it until then, so a failing chore retries every
  15 minutes, not every tick.
- **Rescans** every 30 minutes for an active user, 150 idle (PLAN: 2-3 hours), 10 after a failed attempt.
- **The claim creates the queue row** for an active user without one, so a user is never stranded by a
  provisioning step that forgot it.

What I am unsure of: `after()`'s handoff at 20 s is tested with an injected `after`, not on Vercel; the
`/me/player` probe's bucket (whether a player quota exists at all) is unmeasured, so the player cooldown path
has a known answer but no production evidence; the 10-s repeat slack is a judgment, which Phase 3's soak
checks through the `harvest:change` count against plays.

## 7. How to review the branch

```bash
git worktree add ~/projects/lazyboy-wt/<yours> mu/phase3 && cd ~/projects/lazyboy-wt/<yours> && npm ci
git log --oneline mu/phase2..mu/phase3
npx vitest run tests/harvest-policy.test.ts tests/brake.test.ts tests/liked-diff.test.ts tests/isolation
npm test && npx tsc --noEmit && npm run lint && npm run build
```

Read in this order: `harvest-policy.ts` and `brake.ts` (pure); the Phase 3 section of `app-db.ts` (every
statement in one sitting, the claim's batch first); `sync/step.ts`; `sync/tick.ts`; then `t4-tick.test.ts`,
`t13-tick-callers.test.ts` and the two planted bugs. A cross-user path would most likely hide in: the claim's
batch (a lease or a view that reaches past the leased uids), `storeFor` and the token getter (bound per
uid in `toServe`), the not-registered rule (who may be removed), and `releaseLease`'s compare-and-set.

When Phase 3's turn comes, cut `mu/phase3-turn` and replay this branch's commits onto production's code
(DISPATCH §3), then wire §4.

## 8. Lane 05's review (Oct 16)

An adversarial review of `c368f1b` in a fresh context (PLAN §6.2-6.6, §7 and RULINGS read first, then the whole
diff against `mu/phase2`). Five commits on this branch, each red first as its message says:

- `b3adb5e`, a defect against §7.8: the not-registered rule counted as "working" every user with a success in the
  last 10 minutes, read at the claim, so users refused in the very tick still counted from their success two
  minutes before, and so did successes from before the refusals began on other minutes. The admin and a friend
  refused together removed the friend. Now removal needs the friend's second refusal in a row and another user's
  calls working since the first (§6's bullet).
- `9891b2b`, two test gaps: counting a harvest after its call, and releasing a lease with the tick's start time,
  both survived every Phase 3 test; T4 now catches each.
- `dd9713a`, a defect against §5.4 step 2: the status move and the event came before the release, so a release
  refused after a slow store stranded the user in `needs_reconnect` with nothing for the confirmation to find.
- `f5134ce`, a defect against §7.5: `BRAKE_ON` was read by nothing; the tick carried its own `false`.
- `1e894c8`, docs: §5's `AccuracySec=1s` and §4 item 11.

Mutants: 22 one-line or few-line changes to the real source (the five the brief names, a step reading a shared
map in two forms, a token getter bound to the first user, each of this review's fixes reverted, and the brake,
policy, caller and deadline rules), each run against the Phase 3 test files and restored; all caught at the
reviewed head. Tests: vitest 837 (lane 04's 830 and 7 from this review).

## 9. Replayed onto Phase 2's base: `mu/p3-base` (lane 1945_lb_mu_31_stack, Oct 16, 2026)

Lane 31 replayed this branch's 15 commits once onto `mu/p2-base` (Phase 2's commits on Phase 1's turn; PHASE2.md
§6), so lanes 17 and 19 start from the same commits (DISPATCH §3). `git range-diff a90104d..f754f72
mu/p2-base..mu/p3-base` shows all 15; two patches changed:

- `6fd8bb7` (`auth.ts`): Phase 1's turn deleted the owner shim this commit's export sat beside and made
  `getValidAccessTokenFor` return an `OwnedToken`; `tokenForTick` is added after it unchanged. `AUTHZ.md`
  regenerated in the same commit, since the gates it cites in `auth.ts` moved down six lines.
- `6c7abe9` (`sync/step.ts`, `sync/tick.ts`): Phase 1's turn made the Spotify client a user's
  (`spotifyClient(owner, token, …)`), refusing a token that names anyone else (`TokenOwnerError`, a `token-owner`
  event). The step's and the rescan's clients are made for the step's uid, and the tick's bound token getter
  hands them `{ uid, accessToken }` in place of the bare string; its own owner check stays. Red before: `tsc`,
  three TS2345 at the three `spotifyClient` calls. `planted-bugs.test.ts`'s imports keep both phases' helpers.

No resolution needed new behaviour. What this base changes in §4's list, for lane 17:

- **Item 1**: the store for a claimed user is `forUserAt(u.uid, u.dbName)` on this base (Phase 1's turn's db.ts;
  `forUser(uid)` takes no db_name), and S2 pins who may import it. `/api/cron/daily` exists here (the store split),
  so `runDailyChores` has its route. The cron route on this base runs Phase 1's single-owner tick
  (`phase1Owner()` through `forUser`, `cronAuthorized()`/`cronCaller()` both in `cron-auth.ts`); lane 07's
  interim pinger is not on it and meets this at the stitch (lane 34).
- **Item 5**: `api_log` already carries the uid (Phase 1's turn: the client tags each row with its owner);
  the `harvest:<trigger>` and `cron-probe` sources ride it.
- **Item 8**: Phase 1's turn's health check (`/api/cron/health`, `lib/health.ts`) is what the owner-capture rule
  replaces; it reads isolation events from telemetry, and PHASE2.md §6 says what Phase 2's wiring changes there.
- PHASE2.md §6's logout finding carries into this base: today's cron route (`getValidAccessTokenFor`) and the
  tick's `tokenForTick` both read `user_tokens`, which Log out leaves in place, so a user who logs out keeps being
  harvested until lane 15 wires Log out onto that row.

## 10. Phase 3's turn: `mu/phase3-turn` (lane 1945_lb_mu_17_p3_turn, Oct 16, 2026)

Cut from `mu/p3-base` at `2a5e950`, no rebase. Nothing pushed or deployed; no store, Spotify, Vercel, Turso or
Zenbook state touched (the Zenbook's unit files were read for §11). Each commit's message says how its tests
were shown failing first.

| §4 item | what landed | commit |
|---|---|---|
| 1, the cron route | `/api/cron/sync` is `runTick` over `liveTickDeps` (`src/lib/sync/tick-deps.ts`): `cronCaller`, `appQueue`, `forUserAt(uid, the claim's db_name)`, `tokenForTick`, `after()`, the daily chores (`src/lib/daily-chores.ts`, shared with `/api/cron/daily`), `PHASE3_TICK` with `SIGNUPS`; `maxDuration = 60`. cron-job.org hears `{"ok":true}` before any work and its whole tick runs in `after()` (lane 08's fix, carried into the tick). `daily_at` is `app_meta`'s, stamped by the daily route and the tick, read by the health check. The harvest gate, its two `meta` stamps, `library_scan_attempt_at` and the single-user route go. `tests/cron-pinger.test.ts` replaces main's (lane 07/08) case for case on this route, plus a transient refresh failure | `32bbd70` |
| 2, probe and policy | the step's store: `meta.probe` (`readProbe`/`writeProbe`), `recordRecentPlays` (the harvest's record half), each harvest's ledger row as before; `harvest:<trigger>` in `api_log.source` (the step's client); the uid on every telemetry row (Phase 1's turn); the handoff beacon names the track by id (`handoffBeaconMeta`) | `32bbd70`, `4d5b76f` |
| 3 (§4 item 8), capture health | the banner, `/usage` and the health check read `sync_state` and `user_tokens` (`src/lib/capture-read.ts`): red without a usable grant or when the last successful step is over 30 minutes old | `7ab2b69` |
| 4 (§4 items 2 and 6), the open app | `/api/sync` runs `runOpenApp` (`x-sync: load` on a load or a return, `timer` every 2 min); its debounce goes. `user_tz` (the IANA zone, `tzname` cookie) and `user_tz_offset` written only when they change; the Home payload buckets in `user_tz` with the DST check against it | `2b67b60` |
| 5 (§4 item 3), decision 15 | `refreshHistoryAction` re-reads the store and calls nobody; `syncRecentPlays` goes | `dfa6494` |
| 6 (§4 item 7), the rescan | no `/me` (the claim carries `users.spotify_id`; other scans use the stored `me_id`); every `plsnap:` in one statement; `storeSavedTracks` on `likedDiff`, the scan reading Liked from the top with `likedHead` (`storeSavedDiff`); `getAll` follows its cursor with no 500-page cap, background pages paced | `66c9998` |
| 7 (§4 item 4), cooldowns | the rate limit stays app-wide and seconds long; a long ban (`QUOTA_EXCEEDED`, or Retry-After past 120 s) cools its bucket alone (recently-played with `/me`, player, library), module-scoped and persisted to `app_meta` `cooldown:<bucket>`; the 429's `reason` in `api_log.reason`; the tick's rescan skips while the library bucket cools. db.ts's admin-database cooldown goes | `975ad4c` |
| 8, the brake's count | the step counts each harvest (lane 04); the client counts every `/me` call for its owner, awaited, before it is sent; `BRAKE_ON` stays false | `66c9998` |
| 9, T4 and T13 | `tests/isolation/tick-route.test.ts`: the real route with app.db and two users' own databases, encrypted tokens, the real token core; T3's census unchanged (no entry point added) | `87cc05b` |
| 10, docs | this section, §11, CLAUDE.md, ARCHITECTURE.md, GOTCHAS.md | (this commit) |
| 11, the Zenbook's reply | the admin's step in full, a friend's by its code alone; a friend's rescan is not named. The tests read the full detail from `TickReply.detail`, which is never sent | `32bbd70` |

**Choices where a choice was open** (PLAN's recommendation where it has one):

- cron-job.org's tick runs entirely in `after()`, not after a 20-s wait: lane 08's finding on main (its reply's
  timing said whether someone listened), which PLAN §7.2 step 5 predates.
- The Zenbook's reply keeps one entry per user (PLAN §7.2 step 5) but names only the admin's trigger and count;
  `ping.sh` keeps writing bodies. That was lane 05's open item 11.
- `daily_at` moved from the admin's `meta` to `app_meta` (the claim reads it there); the chores still run for the
  admin alone (`phase1Owner()`), as Phases 1-3 serve nobody else. Their per-user loop is Phase 4a's.
- A long ban is any 429 with `reason` `QUOTA_EXCEEDED` or Retry-After over 120 s (the client's old hard-ban line);
  its bucket's cooldown is Retry-After capped at 30 minutes, the whole 30 when there is no Retry-After. The step's
  own `quota` cooldown (min(next reset, 30 min)) is unchanged; both only ever extend the same row.
- `/me` is counted in the client because every caller of it is outside the step; recently-played stays counted in
  the step (lane 04's bound counter), so each call is counted once.
- `getAll` lost its page cap; a cursor already read ends it with the 508, which covers the self-referencing link
  the cap was for. `page()` is the resumable primitive; the Liked head read uses it page by page.
- `/api/sync`'s `x-sync` header (not a body or query): the authz harness invokes `POST()` with no request, and a
  header read through `headers()` keeps the route's signature.
- `user_tz` follows design C §3.3: `user_tz_offset` stays as the cookie-less fallback; the payload's zone is
  `user_tz ?? "America/New_York"`. An unknown zone is never stored.

**Not done, and why:**

- The per-harvest lag roll-up (`lag_p50_s`, `lag_p95_s`, §7.8, PHASE3 §4 item 5): not in this lane's brief or
  §13.1's Phase 3 row; it needs a column or table and a `/usage` reader.
- The claim's token join is still unused (each step reads its row through `tokenForTick`, one more app-database
  read per user per tick); handing the claimed blob to the token core touches the token core's read path, which
  lane 15 is changing.
- The request path's dead grant and §5.4 steps 4-5, the R15 check, and the daily chores per user: Phase 4a's.
- The health check's `events` read: PHASE2.md §4 item 8 (lane 15).

**For lane 34 (the stitch), the shared files this branch touched** (RULES 8): `src/app/api/cron/sync/route.ts`
(whole file: main's interim pinger route, lane 07/08, is what it replaces), `src/app/api/sync/route.ts`,
`src/app/api/cron/daily/route.ts`, `src/app/api/cron/health/route.ts`, `src/lib/db.ts` (probe and zone functions,
`storeSavedTracks`/`storeSavedDiff`/`readSavedRows`/`getPlaylistSnapshots`, `api_log.reason`, removed:
`getCaptureHealth`, the harvest gate, `library_scan_attempt_at`, `get/setSpotifyCooldownUntil`, `adminDb`, the
`diffKeyed` import), `src/lib/app-db.ts` (`ClaimedUser.spotifyId`, `extendCooldown` floors),
`src/lib/spotify/client.ts`, `resources.ts`, `service.ts`, `src/lib/sync/{tick,history,library}.ts`,
`src/lib/playlists-sync.ts`, `src/app/(app)/history-actions.ts`, `home/page.tsx`, `home/den-home.tsx` (one line),
`usage/page.tsx`, `src/components/{sync-on-load,timezone-cookie}.tsx`, `src/lib/{capture-health,health,handoff,
harvest-policy}.ts`, the harness (`tests/isolation/authz-harness.ts`: a fresh `daily_at` in the seeded app
database; `authz-registry.ts`, `authz-redteam.test.ts`, `static.test.ts`, `user-store.test.ts`), AUTHZ.md
(regenerated), CLAUDE.md, ARCHITECTURE.md, GOTCHAS.md. Meeting points: `tests/cron-pinger.test.ts` is an add/add
with main's, take this one; `cron-auth.ts` is untouched (lane 33's reconciliation stands); lane 1910's scoped
orphan pass (blocked at 5:07 AM, no branch yet) meets `storePlaylists` and `store-diff.ts` unchanged here, and
db.ts's `storeSavedTracks` no longer calls `diffKeyed`; Phase 2's wiring (lane 15) meets this branch in the health
route (its `events` read beside `readCapture`), in Log out's `user_tokens` clear (which stops the tick for that
user), and in `getCaptureHealth`'s removal (lane 15's item 1 rewrote it; `readCapture` replaces it).

Read from lane 15's `mu/phase2-turn` at `1343eeb` (Oct 16, ~7:30 AM), the stitch's concrete meeting points:
- **`forUser(uid)` resolves the db_name the last identity read or claim named** (lane 15's db.ts), and
  `adminStore()` (identity-read.ts) is the admin's store for the session-less paths. This branch still calls
  `forUser(phase1Owner())` in three places that must become `adminStore()`: the tick's `dailyChores` in
  `src/app/api/cron/sync/route.ts`, `src/app/api/cron/daily/route.ts`, and `src/app/api/cron/health/route.ts`
  (where it only reads the health marks). The tick's own stores are already `forUserAt(uid, the claim's
  db_name)`, which names them for `forUser`; `/api/sync`'s `forUser(user.uid)` is named by the request's
  identity read. This branch's tests open the owner at `forUserAt(OWNER, "lazyboy")`, which reads on both.
- **The health marks**: lane 15 drops `isolation_seen` (events carry `alarmed`), this branch drops `daily_at`
  (now `app_meta`'s): together `HealthMark` is `quota_pace` alone, and the health route reads `daily_at` with
  `getAppMeta`, owner capture with `readCapture`, events with lane 15's `unreportedEvents`.
- **`getCaptureHealth`**: lane 15 points it at `readTokenRow`; this branch deletes it for `readCapture`. Take
  the deletion; lane 15's `tests/capture-health.test.ts` hunks give way to this branch's rewrite.
- **The cron route**: lane 15's version (one admin via `adminStore()`, `readTokenRow` for the no-token alarm)
  is superseded whole by `runTick`, whose owner alarm already reads the admin's `user_tokens` row.

## 11. Deploy steps for lane 23

After Phase 2's V3 (DISPATCH §4), from the stitched and reviewed `mu/f-p3`. No new environment variables:
`CRON_SECRET_EXT` (lane 11), `APP_DATABASE_URL` and `TOKEN_KEYS` (Phase 2) are in place; `SIGNUPS` stays unset
(`owner`).

1. **Push and wait for Ready** (RULES 10). The telemetry store gains `api_log.reason` on the first telemetry write
   after the deploy (an additive `ALTER TABLE`, `migrateTelemetry`).
2. **Run one tick at once**: `ssh ubuntu '~/lazyboy-cron/ping.sh; tail -1 ~/lazyboy-cron/ping.log'` (the
   script holds the secret; nothing prints it). Until the admin's first step his `sync_state` row has no
   `last_ok_at`, so the banner and the hourly health check read capture as stale. Expect `http=200` with `steps`
   holding his `uid`, `outcome: "ok"` and a `backstop` harvest (no harvest yet in `sync_state`). The tick also finds
   no `app_meta.daily_at` and runs the daily chores in `after()`; `daily_at` then reads a fresh stamp.
3. **The Zenbook's timers**, under DiveLoop's change lock (RULES 16), in `~/.config/systemd/user/` of the account
   that runs them today (`remtbkv`):

   ```bash
   cd ~/.config/systemd/user
   cp -n lazyboy-cron-sync.timer lazyboy-cron-sync.timer.pre-mu23
   cp -n lazyboy-recorder.timer lazyboy-recorder.timer.pre-mu23
   cat > lazyboy-cron-sync.timer <<'UNIT'
   [Unit]
   Description=Ping Lazy Boy /api/cron/sync on even minutes (cron-job.org takes the odd ones)

   [Timer]
   OnCalendar=*:0/2
   AccuracySec=1s
   Persistent=true

   [Install]
   WantedBy=timers.target
   UNIT
   cat > lazyboy-recorder.timer <<'UNIT'
   [Unit]
   Description=Run lazyboy backstop recorder hourly

   [Timer]
   OnCalendar=hourly
   Persistent=true
   RandomizedDelaySec=30

   [Install]
   WantedBy=timers.target
   UNIT
   systemctl --user daemon-reload
   systemctl --user restart lazyboy-cron-sync.timer lazyboy-recorder.timer
   systemctl --user list-timers --all | grep lazyboy
   ```

   Read Oct 16 7:16 AM: the sync timer is `OnBootSec=3min`, `OnUnitActiveSec=2min`, `AccuracySec=30s`,
   `Persistent=true`; the recorder's `OnCalendar=*:0/15`, `Persistent=true`, `RandomizedDelaySec=30`. The services
   are unchanged (`ping.sh`, `curl -m 60`, appends each reply to `ping.log`). Expect the sync timer's next run on an
   even minute within a second of :00, and the recorder's at the top of the hour; then `ping.log` lines with
   `{"ok":true,"steps":[…]}` every 2 minutes (the admin's step named, `skipped: "recent tick"` when cron-job.org's
   odd-minute tick ran under 45 s before, which it should not once both are aligned).
4. **cron-job.org's job** (Rem's, `rem_pinger_job`): it should run on odd minutes (1, 3, … 59); on even ones both
   pingers collide and the app ticks every 2 minutes (each user's cadence is unchanged, the redundancy within the
   minute is lost). Its execution history should show 200 and `{"ok":true}` in well under a second.
5. **The checks** are DISPATCH §4's V4, then PLAN §13.1's Phase 3 exit checks.

**Rollback.** The Zenbook first, then the app:

```bash
cd ~/.config/systemd/user
cp lazyboy-cron-sync.timer.pre-mu23 lazyboy-cron-sync.timer
cp lazyboy-recorder.timer.pre-mu23 lazyboy-recorder.timer
systemctl --user daemon-reload
systemctl --user restart lazyboy-cron-sync.timer lazyboy-recorder.timer
```

then PLAN §13.5: revert Phase 3's merge on `main` and push. The build before it has the interim pinger's route as
lane 33 stitched it (`lock:tick`, a 90-s window), which both pingers keep calling; it reads the `meta` stamps this branch
stopped writing (`player_last_active`, `rp_last_harvest`, `library_scan_attempt_at`), so its first tick harvests
on the backstop and carries on. PLAN's first rollback step, the window back to 90 s, is `PHASE3_TICK.stampWindowMs`
(`src/lib/sync/tick.ts`), a one-line commit, for a tick that misbehaves only with both pingers. Nothing this branch
writes needs undoing: `app_meta` `tick_at`, `daily_at`, `cooldown:*`, `sync_state` rows and each user's
`meta.probe` and `user_tz` are ignored by the older build.

## 12. Stitched onto Phase 2's turn: `mu/s-p3` (lane 1945_lb_mu_34_stitch, Oct 16, 2026)

`mu/s-p3` is this phase's slice, `4505d5d..0bc8c2f` (lane 31's replay of the build-ahead commits and lane 17's
turn), replayed with `git rebase --onto mu/s-p2`, where it meets lane 15's turn, the meter and Phase 1 as stitched
onto `main` (lanes 1905, 1910, 11). `git range-diff 4505d5d..0bc8c2f mu/s-p2..mu/s-p3` (`--creation-factor=100`),
this section's commit aside: 19 patches unchanged, 9 changed, 7 new. Each changed commit's message ends with a "Stitched onto mu/s-p2"
paragraph; the meeting points are §10's last two paragraphs, taken as lane 17 wrote them.

- `e4a5a94`, `a45fbc0`: `app-db.ts` and `auth.ts` keep both sides' additions (lane 15's events statements and
  `signOutTokens`).
- `32bbd70`: `/api/cron/sync` is `runTick` whole, over the interim pinger and lane 15's lookup; the tick's daily
  chores and `/api/cron/daily` run on `adminStore()`; the health route reads `adminStore()`, `events` and the
  meter's inputs; `HealthMark` is `quota_pace` alone; S2's `forUserAt` importers are exactly `identity-read.ts`
  and `tick-deps.ts`. `tests/cron-pinger.test.ts` is this phase's suite.
- `7ab2b69`: `getCaptureHealth` goes for `readCapture` (lane 15 had pointed it at `user_tokens`); T15's healthy
  owner moves to `sync_state` and `app_meta.daily_at`; health.test.ts keeps the meter row and lane 15's
  plaintext-copy case.
- `2b67b60`: `/api/sync` and SyncOnLoad are this phase's whole; the meter's hooks land again in a stitch commit.
- `975ad4c`: the cooldown and `adminDb()` go; `adminDb()` stays one commit for the budget mode.
- `66c9998`, `6bf99e6`: `storeSavedDiff` takes `likedDiff` and keeps lane 1910's scoped orphan pass (the renamed
  identities among the incoming tracks go to `recomputeOrphanFlags` after the write).
- `f6c38aa`: ARCHITECTURE and GOTCHAS take the tick's account; "The budget" section stays.

New commits:

- `stitch: the budget mode moves to app_meta with the cooldowns`: `budget_mode` is app-wide state (PLAN §4.2), so
  it moves from the admin's `meta` to `app_meta`; `adminDb()` and db.ts's `phase1Owner` import go. At this phase's
  deploy the stored mode is not carried: until the next daily chores it reads as never written (normal on the hot
  paths, `unchecked` in the health check). Lane 23 can run `/api/cron/daily` once after the deploy.
- `stitch: tick-route's raw client opens the app database app-db.ts opens`: lane 15's `useUserFiles()` points
  `APP_DATABASE_URL` at its own file, so `tick-route.test.ts` seeded a file the route never read (8/8 red).
- `tests: step-quota's QUOTA_EXCEEDED case holds the wall clock on the tick's instant`: a date bomb, failing on
  `0bc8c2f` itself since 18:00 UTC Oct 16.
- `stitch: the tick's rescan follows the budget mode`: `TickDeps.budgetMode`; freeze claims no rescan, economy
  schedules the next at least 2 hours on, normal is the tick's own cadence.
- `stitch: the daily budget record runs with the daily chores`: `runBudgetChore` in `daily-chores.ts`, so the
  daily route and an overdue tick both record it.
- `stitch: the open app's sync follows the budget mode`: `/api/sync` answers freeze before its writes and adds
  `intervalMs`; SyncLoop sends `x-sync: load` on start and focus, `timer` on its interval.
- `stitch: the tick's pinger suite keeps s-p1's and s-p2's cases`: no admin row (503 `no-admin`), and the owner
  alarm on the token of record, in the tick's codes.

Gates at the slice head: `tsc`, lint, `npm test`, build green; `AUTHZ_TARGET=1 … authz-` fails only the three P4a
pins. Lane 34's NOTES and OUTCOMES entry have the full range-diff.

## 13. Lane 18's review of the stitched slice: `mu/rv-p3` (lane 1945_lb_mu_18_p3_turn_review, Oct 16-17, 2026)

An adversarial review, in a fresh context, of `git diff mu/s-p2...mu/s-p3` (`3c99bca..f7f09ee`), the slice as it
will deploy. The branch `mu/rv-p3` is cut from `f7f09ee`; lane 35 folds it in. Each commit's message says how its
test was shown failing first; lb_18/NOTES.md has the evidence for every point of the brief.

| commit | what was wrong | what it does now |
|---|---|---|
| `55df834` | A `/me/player` probe that failed on its own (a 5xx, a network error, a bare 403) ended the step before the harvest decision. The user backed off to hourly steps, each failing the same way, so for as long as the player endpoint failed nothing was harvested: a friend listening past 50 plays lost them. The single-user route swallowed a failed player check and kept its hourly backstop. | Such a probe leaves the policy blind, as a player refusal already did: the backstop and §7.8's 30-minute rule still harvest. The outcome keeps the probe's code, so the user still backs off; the release records the harvest. |
| `fc15ff8` | Only `open-app` had PLAN §7.6's 60-s gap. With the brake off, a change seen by a load's probe fires as `change` first, so a load seconds after the cron's harvest harvested again, and the cron's step right after a load's harvest did too. Both were tagged `change`, where V4's "only catch-up harvests from the open app" cannot see them. | `decideHarvest` returns nothing within 60 s of the last harvest, whatever fired; the change or the tail stays pending and the next step takes it, at most two minutes on. |
| `a58b2ac` | The brake counted one send per request, but the client re-sends a 403 once, a rate limit up to three times and a network error up to three times. Each re-send may reach Spotify, and the 426 budget is measured in sends (§7.5 item 1). | Every `/me` send, and every re-send of a harvest, is counted before it goes; the step still counts a harvest's first send. |
| `5364b85`, `4de334d` | The rescan checked its deadline between playlists and before Liked Songs, but the Liked read itself (the head's pages, and the full refetch an unlike forces) ran on regardless. In the 60-s invocation, a long refetch is killed; the kill skips `scheduleRescan`, so `claimRescan`'s 10-minute retry starts it again from the top, indefinitely. | The head read stops between pages at the deadline, and the refetch carries the deadline into `getAll` (`DeadlineError`). Nothing of Liked is written, the scan is not stamped, and the next rescan is due at its normal distance. |
| `d0f0371` | A test gap: setting `PHASE3_TICK.brakeOn` to true by hand survived every Phase 3 test. | T4 runs the tick's own numbers with a user past the app's budget, and a new track is still harvested at once. |

What this leaves for later:

- **A resumable Liked refetch** (PLAN §7.7's "`getAll` takes a resumable cursor"). `getAll` no longer throws at
  page 501, but nothing carries a read across ticks. A refetch that does not fit what is left of the tick's 20 s
  (estimate: roughly a thousand likes or more) now waits for the client's own scan (`/api/playlists/sync`, no
  deadline, 300 s), which runs when a stale library is opened. Rem's 48 likes fit one page. Phase 4a must decide
  this before a friend with thousands of likes: a cursor and the rows seen so far kept between ticks, or the
  refetch left to the 300-s path.
- **A probe that hangs** past the step's 15-s deadline (a 10-s fetch timeout, four attempts) still gets no
  harvest: the abandoned step reaches the decision after its deadline. A 5xx is the common failure, and it is
  fixed; the hang needs a budget for the probe inside the deadline.
- **A single playlist read** is not bounded by the rescan's deadline either. Rem's playlists are known; bounding
  it would stop the tick from syncing a playlist it can sync today inside the 60 s, so it is left alone.
- **An already-liked song's rename** no longer reaches `tracks` through the Liked path: `likedDiff` writes new
  and moved likes only, where the old full refetch rewrote every row. It still arrives with a play or a playlist
  write, and the orphan flags still equal a full pass over what is stored.
- **`harvest:<trigger>` tags context lookups too**: `recordRecentPlays` resolves context names with the step's
  client. V4's harvest count must filter `api_log` by path (`/me/player/recently-played`), not by source alone.
- **A return to the tab probes every time** in normal mode (the ambient gap is 0). It costs one player call per
  focus and nothing scarce, since the 60-s floor holds the harvest.

Mutants: 16, each one exact replacement in the source, run against the 11 Phase 3 test files, restored after
(lb_18/mutants.py, mutants.log). They covered the brief's five (a release without its owner check, the tail
retry dropped, completeness at 50, the open app harvesting on every load, the count after the call), the 45-s
stamp ignored, cron-job.org answered like the Zenbook, a claim that ignores a live lease, a 500-s lease, no 20-s
reply, the brake on in Phase 3, and each of this review's fixes reverted. Two survived (the brake on in Phase 3,
the head read's deadline check), and each now has a test that catches it. `AUTHZ_TARGET=1 npx vitest run
tests/isolation/authz-` fails only the three P4a pins, both at `mu/s-p3` and at this branch's head (718 of 721).

Gates at `d0f0371`, the last code commit (this section is the commit after it), Oct 17, 12:09 AM: `tsc --noEmit`, lint,
`npm test` (vitest 91 files, 1,902 tests; the node suites pass) and `npm run build` all green.
