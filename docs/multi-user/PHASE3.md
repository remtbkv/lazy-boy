# Multi-user Phase 3, built ahead of its turn

Lane 1945_lb_mu_04_p3_build, Oct 15-16, 2026, branch `mu/phase3`, cut from `mu/phase2` at `a90104d` (lane 03's
reviewed head). Nothing here is merged, pushed or deployed. Nothing touched production data, Spotify, the
Zenbook, Vercel, Turso or the Keychain: every test runs against local database files and a scripted Spotify.

Status: complete for this lane. §2 is what landed, §3 what proves it, §4 what the turn (lane 17) wires and
why each waits, §5 the Zenbook at deploy, §6 the choices made where PLAN left one open, §7 how to review.

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
  4a flips. It counts in Phase 3: every harvest increments `sync_state.rp_calls` for the quota day, awaited
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
  config; `PHASE3_TICK` holds 45 s, hourly, brake off, 15 s, 20 s, 10 s):
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

What does not wait on a decision: everything above. Decisions 15, 26 and 28 are ruled (§1).

## 5. The Zenbook at deploy (lane 23), under DiveLoop's change lock (RULES 16)

- `lazyboy-cron-sync.timer`: `OnCalendar=*:0/2` in place of `OnUnitActiveSec=2min`, so the Zenbook's ticks
  land on even minutes and cron-job.org's (lane 11's job, every 2 minutes) on odd ones; with both alive the
  app ticks every minute and each user is still probed every 2 minutes (§2's cadence). `daemon-reload` and
  restart the timer; `ping.log` should show 200s with `steps`.
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
  so the health check e-mails each. Steps 4-5 (expiry or `revoked`, deletion on day 4) are Phase 4a's.
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
