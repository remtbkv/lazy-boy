# The two-user rehearsal

Lane 1945_lb_mu_28_rehearsal, Oct 17, 2026, branch `mu/rv-rehearsal` cut from `mu/s-p4a` (3b81ae4). It replaces the
canary account (RULINGS Oct 15 9:27 PM): the code that will deploy, as a production build, with two synthetic friends
and an admin standing in for Rem, through the scripted stand-ins, proving FASTPATH §2.4's list and Rem's daily cycle
(Oct 16 1:19 AM). Nothing touches Spotify, Turso, Vercel, the Zenbook or anyone's data.

## Re-run it

```bash
node tests/rehearsal/run.mjs --dir <an empty directory>      # --skip-build, --only 1,3,..., --port 3128
```

It runs `npm run build`, then the setup and checks 1, 3, 2, 4, 5, 6, 8, 9, 7 in that order (9 needs B, 7 deletes B),
and exits 0 when every check passes. Evidence: `<dir>/evidence.json`, each server's log and its call record
(`calls-*.jsonl`). It makes its own throwaway secrets (a mode-600 file in the directory, deleted at the end), waits on
`coord.wait_for_ram(4)` before the build and each server, and stops every server and the browser by pid. It needs
handy's Playwright (`REHEARSAL_PLAYWRIGHT` overrides the path), `python3`, and ports 3128-3143 and 4128-4143.
The last full run (`0baf1c7` built, Oct 17 1:45-1:56 AM) took 10.5 minutes, the build included: all nine pass.
Beside it, lane 1947's authorization map at its targets (`AUTHZ_TARGET=1 npx vitest run tests/isolation/authz-`):
842 of 842, so no pin is left for P1-P4a or L07 and every friend cell is `allow-own` or `deny`.

## What it runs

- **The build as deployed.** `next start` on 127.0.0.1 with `VERCEL_ENV=production`, `https://` store URLs and the
  production variable names, preloaded with `tests/rehearsal/preload.mjs`, which answers api.spotify.com,
  accounts.spotify.com and Turso's Platform API from `standin.mjs` (authz-harness's grammar: `code-<WHO>`,
  `at-<WHO>-…`, `rt-<WHO>-…`, `<WHO>-only-` names; plus each person's library, Liked, recently-played and real token
  lifetimes), opens every store URL `https://<db>.rehearsal.invalid` as a throwaway file (`libsql-shim.mjs`), refuses
  every other connection at fetch, DNS and socket, answers the scripts' Keychain read with a throwaway token, and
  shifts `Date` and `performance.timeOrigin` by an offset the harness sets. Every outbound call is recorded with the
  person its token belongs to. The guard is shown failing a planted call to a real host first (fetch, socket, DNS and a
  store URL, each refused and recorded) before anything else runs.
- **The people.** An admin (Rem's stand-in, synthetic), A and B; C and D join in check 9. Everything each owns
  carries its tag (`FRIENDA-only-song-3`, `FRIENDAxpl1`, …), so a foreign id is one string match. The admin's
  stores come from `phase2-app-db.mjs` and the user schema; each friend asks at `/join` in headless Chromium, is
  approved by `scripts/invite.mjs --approve` against the throwaway stores, opens the printed join link and connects
  (Spotify's authorize page answered with a redirect carrying a stand-in code), so sign-in runs the real Auth.js
  callback, claim and identity read.
- **Plants.** Each check runs first against an environment plant and must fail there: a stand-in that answers B's
  bearer with A's library, a refresh of B answered with A's token, a restored store that kept its epoch, a cache
  entry rewritten under B's key, A's payload under an unkeyed storage name, a purge that fails, a clock left unmoved
  (check 8's is its own first half: A served before the freeze). Plants that write run on a copy of the build and
  stores, so none reaches the real run. No plant needed a rebuild.

## The checks

Results and evidence from that run (`evidence.json`); "plant" is the run that must fail first.

1. **`cache()` in route handlers: a pass-through there, per request in pages, never across requests (PLAN §16's
   open row).** Every route handler read the identity row twice a request (its `jwt` and `session` callbacks call
   `identityFor` with the same arguments) and twice the token row where the handler reads the token after `auth()`;
   `/home`, whose layout and page call `auth()` four times (eight `identityFor` calls), read it once, plus
   `readCapture`'s direct read. A disabled between two requests on one cookie was refused at once (`/home` 307 to
   `/login`, the search routes 401) and served again once re-enabled. A and B together on each of the 8 route
   handlers, 20 rounds: no foreign id; each payload held its own. Plant (B's bearer answered with A's library): B's
   payload showed `FRIENDA-only-playlist-1..3`. Every box takes the uid as its argument, so the pass-through costs
   reads, not isolation.
2. **The Data Cache across environments: keyed apart.** Preview (`VERCEL_ENV=preview`, its own `AUTH_SECRET` and
   stores, the same build and `.next/cache`) opened no store; across every census entry, the cron routes and the probe
   it served no user data and wrote one entry, the probe's forged `{probe:true}` under a fresh nonce (its
   `CRON_SECRET` was the Zenbook's). Then a server given its own stores (the same uids, its own `store_epoch`,
   every name marked) beside P on one cache directory, the admin, A and B on both at once, 10 rounds: neither served
   the other's entry, and it served its own 60 times. Plant (a copy that kept P's epochs): its first answers were P's
   entries (6 detections).
3. **One instance serving two users.** 246 requests each, shuffled, 8 at a time, over T3's census (8 pages and RSC
   payloads, 8 route handlers, 25 server actions; Log out is check 5): no foreign id in any body, header or redirect;
   own data seen on 25 entry points. ETags carry their own uid and epoch at equal versions
   (`lib-v1-<uidA>-…-14-…` / `lib-v1-<uidB>-…-14-…`); B sending A's ETag got 200 and B's body. B with A's identifiers:
   A's task 404; A's playlist page and tracks route no A data (the tracks route answered B's own 10-a-minute bound).
   Each `/home` names its own uid, from which every storage name is built.
4. **Two token refreshes in one tick.** Both friends' tokens expired (the app's rows and the stand-in), one tick with
   `CRON_SECRET`: one refresh each, each with its own refresh token; each row decrypts under its own uid to the token
   issued for that person and opens under no other uid; every call after carried that token; `api_log` matched the
   stand-in's record per uid. Then B's refresh answered `invalid_grant` while A's succeeded: B `needs_reconnect` with
   one `invalid-grant` event; A's row, sync state and users row untouched. B's next visit landed on `/reconnect` and
   signed in again. Plant (B's refresh answered with A's token): B's row held a `FRIENDA` token.
5. **The shared device.** One profile: A used Home (60 of A's song names in IndexedDB), pressed Log out (the page:
   "logged out of Lazy Boy on every browser, and it has stopped recording your listening history … To start again,
   sign in"; A's token row gone), B signed in and used Home, `/playlists` and a playlist: B's pages, cookies,
   localStorage, sessionStorage, IndexedDB and Cache Storage held none of A's ids, names or uid, and 59 of B's own;
   B logged out, A signed in: none of B's. Plant (a copy of A's stored payload under a storage name the uid helper
   never built, which no clear removes; the profile handed over): B's profile held A's names. On this stack a
   profile handed over without Log out also keeps A's IndexedDB copy until someone logs out there; lane 21's
   `6486132` clears it at `/login` too.
6. **The probe's e-mail.** The probe route refused no secret and `CRON_SECRET_EXT` (401). Forged under B's key
   stamped with A, read back: `{"ok":true,"events":1}`, one `cache-stamp` event for B. `/api/cron/health` (as
   cron-job.org calls it) answered 500 `["isolation", …]` and recorded `health_red:<ms>` = `isolation,…`; the next
   call was green. On a real read path, B's library entries rewritten to A's value stamped A: B got B's own library,
   read from B's store, and one more `cache-stamp` event. Plant (the same entry stamped B): B was served A's
   albums.
7. **Deletion reaching backups.** B, signed in afresh, pressed Disconnect: the export (B's data, none of anyone
   else's), the typed word, `/disconnected`; the job finished 53 s later: B's database destroyed; the users row
   `deleted` with `spotify_id` '' and `db_name` `deleted:<uid>`; token, sync state, locks and request gone; B's
   `api_log`, `client_metrics` and `cpu_meter` rows 0; one lifecycle line. `user.mjs --remove` again: nothing
   changed. A minute later the meter's flush wrote 8 of B's `cpu_meter` rows back; the next day's chores ("telemetry
   again 1") left 0 (defects 1 and 2 below). `backup.py` over copies of the stores with a copy of B's database
   planted, dated five days back, here and on "OneDrive": with OneDrive's purge failing it exited 1 with `FAIL check`
   and the copy kept there (the plant); then exit 0, B's copy deleted before any dump, only `lazyboy` and
   `lazyboy-app` dumped (A's database never), the app copy holding the admin's rows alone, telemetry the admin's
   uid alone, no file naming a friend's database, the admin's older copies byte-identical. A's database and rows
   unchanged throughout.
8. **The freeze.** Before: A served and ticked. `SIGNUPS=owner` and a restart: A's request 401, A's browser sent to
   `/login`, the admin served; the next tick claimed the admin alone and made no friend's Spotify call. Back to
   `invite`: A's browser served again with the same cookie, and the tick claimed A.
9. **The daily cycle, fast-forwarded** (2 simulated days at a tick every 2 minutes, then an hour a tick to day
   14.6; 1,769 ticks). Refreshes: 24 a day for the admin, A and B, each issued for the person whose refresh token
   asked and landing encrypted under its own uid; `api_log` equal to the stand-in's record per user (2,633 and 2,602
   calls). The chores ran once a UTC day for 14 days: on day 1 a tick ran them at 08:32 (`daily_at` stale) and
   Vercel's cron at 09:00 ran nothing; from day 2 the cron ran them; a second delivery on day 3 ran nothing
   (defect 3). The brake's quota day turned at the first call after 14:51 UTC with its count back to 1, every day,
   as the stand-in's record says. C, revoked at 21:07, was still `revoked` at the runs 1.5 and 2.5 days on and
   deleted at 3.5 (its database destroyed, the row swept 5 days later); D's unclaimed invite stood at
   13.0 days and was withdrawn at 14.0 with its database; the orphan token, queue and lock rows went at the first
   run. The budget record: one write a day, no user column, both friends in the meter on all 15 days. Cache: the
   hour-long entries re-requested an hour on were rewritten; each friend's day-long library entry was not, and was
   rewritten a day on; history entries moved to new keys with each play; every entry stamped with its own uid and
   nothing foreign. `backup.py` two days on pruned the 13-day local and 59-day OneDrive copies and kept the 11- and
   57-day ones; with the clock unmoved it kept all four (the plant).

## What a local run cannot show

- **Vercel's Data Cache.** Locally both servers share one `.next/cache` (the worst case); whether Vercel's Data Cache
  is shared across Preview and Production, its eviction, and its regional copies are not observable. What stands
  behind it in production: Preview has no store (`appDatabaseUrl` refuses any app database under
  `VERCEL_ENV=preview`, so it can write no user entry), every key carries the uid and the store epoch, and every entry
  carries its owner, checked on each read; a mismatch is a `cache-stamp` isolation event, which turns the hourly health
  check red and e-mails Rem (check 6).
- **Fluid compute.** One `next start` process served both friends (check 3); Vercel may run several instances and
  route a user between them. The per-request state is keyed by uid (checks 1, 3), which holds for any instance count.
- **The store transport.** Stores are files; Hrana over HTTPS, `makeStoreFetch`'s retries and Next's patched fetch on
  store calls are not exercised. The URL-to-database rule, the owner check and every statement are.
- **The real clocks** the daily cycle depends on stay unproven: the Zenbook's 3 AM reboot, when Vercel's 09:00 UTC
  cron actually fires (Hobby: anywhere in the hour) and whether it ever delivers twice, Spotify's real access-token
  lifetime (the stand-in issues 3,600 s), Spotify's quota reset (14:51 UTC is the observed anchor brake.ts uses),
  rclone's clock on OneDrive, and cron-job.org sending the failure e-mail (the rehearsal stops at the 500 and the
  recorded red verdict).
- **A real Spotify account**: the scopes, `account_id` arriving, the allowlist's 403, a real revocation.

## Defects found, each fixed with a test shown failing first

Each is its own commit on `mu/rv-rehearsal`, prefixed with the phase whose code it fixes, gated (tsc, lint, `npm test`,
build) at that commit.

| # | commit | defect | how it showed | fix | failing first |
|---|---|---|---|---|---|
| 1 | `49f91a8` P4a | The deletion job deleted `api_log` and `client_metrics` but not the meter's `cpu_meter`, which carries the uid and which /privacy lists among the diagnostic logs Disconnect deletes. | check 7: B's `cpu_meter` row survived the job. | One list, `TELEMETRY_USER_TABLES`, walked by the runtime and `user.mjs --remove`. | t11-deletion seeds a `cpu_meter` row per user: 2 cases red. |
| 2 | `0baf1c7` P4a | With that fixed, B's `cpu_meter` rows came back a minute after the job: each instance's request meter holds a minute of counts (the Disconnect request's own among them, recorded in `after()`) and writes them at its next flush. | check 7: rows reappeared at the next flush. | The daily chores delete a `deleted` friend's telemetry again each day the row is kept (five days). | daily-4a "deletes again the telemetry of every deleted friend": red. |
| 3 | `9a4964c` P3 | `/api/cron/daily` ran the chores on every call: twice in one UTC day when a tick had found `daily_at` stale before 09:00 (06:32 first run, tick at 08:32, cron at 09:00), and again on a second delivery of the cron. | check 9: 2026-10-19 and 2026-10-21 each ran twice. | The route skips when `daily_at` is already in the current UTC day and runs under the tick's `lock:daily`. | cron-routes: 2 cases red. The authz harness's seed moved `daily_at` 25 h back (inside the tick's 26 h) so the route's cells still run; AUTHZ.md regenerated. |
| – | `5392198` P4a | Not a defect: `backup.py` had no clock to set, which check 9 needs. | — | `LAZYBOY_BACKUP_NOW` (epoch seconds) for the age prunes, file names and log; the fake rclone reads it for `--min-age`. Unset on the Zenbook. | test_backup "the age prunes read the clock they are given": red. |

For lane 35, folding: defect 1 is the same fix as lane 20's `4179966` (the same `TELEMETRY_USER_TABLES`) and lane
21's `e237b3f` (tables found at run time); defect 2 is the telemetry half of lane 21's `11e01f9` (which also purges
the Data Cache by tag). Keep one of each; the rehearsal passes with either. `5392198` edits `backup.py`,
`fake_rclone.py` and `test_backup.py`, which lane 20's `414a641` also edits. Defect 3 is this lane's alone.

## Observed, not changed

- **Records that name a deleted friend's random uid outlive the five-day row**: their `events` rows (an
  `invalid-grant`, a `cache-stamp`) and the one `lifecycle_log` line. They hold no data, and nothing links the uid to
  a person once the `deleted` row is swept (day 5); PLAN §12.3 step 3 and §13.6 keep them on purpose. /privacy's
  "keeps only your Spotify account ID with a note that the account was deleted, and when, for five days" does not
  mention them.
- **A wrongly stamped entry raises an event on every read until it expires** (check 6 restores its tampered entries
  for that reason). In production a real collision would alarm every hour and serve each read uncached: it fails
  safe.
- **Preview holding the Zenbook's `CRON_SECRET`** could write the probe's forged entry into a shared cache (a
  constant value under a fresh nonce, which no read asks for). Production's Preview has its own variables; worth
  confirming `CRON_SECRET` is not set for Preview.
- **On 127.0.0.1 only**, Auth.js sees the OAuth callback as `localhost`, so it drops `redirectTo`: Disconnect's fresh
  sign-in lands on `/home` instead of back on `/disconnect` (the harness goes back itself). Production's single host
  is not affected; a dev sign-in is.
- **A freeze keeps friends' cookies**: under `SIGNUPS=owner` a friend's requests are refused and their sync stops,
  and lifting it lets the same cookie in again without a new sign-in (check 8). That matches PLAN §13.6's "unfreeze";
  a freeze for a suspected exposure that must end sessions needs a `session_epoch` bump as well.
