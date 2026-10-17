# Who may call what: the authorization map

Generated from `tests/isolation/authz-registry.ts` and the code by `tests/isolation/authz-doc.ts`; do not edit by hand. `npm test` fails when this file is stale; `AUTHZ_WRITE=1 npx vitest run tests/isolation/authz-map.test.ts` rewrites it. Every cell below is a test (`tests/isolation/authz-{route,auth,action,page}.test.ts`) that runs the entry point through the real Auth.js (a real cookie, src/lib/auth.ts's own callbacks) against a throwaway store seeded with Rem's rows and the scripted Spotify.

67 entry points × 12 principals = 804 cells: 293 allow, 433 deny, 78 isolated. 0 cells are not at their target in today's single-user code; each is pinned to what it does today and names the phase that moves it. 11 findings (cells with no explicit rule), 26 red-team checks (0 pinned).

`AUTHZ_TARGET=1 npx vitest run tests/isolation/authz-` runs every pinned cell and check against its target instead: what fails is what the phases still owe.

## 1. Principals, verdicts, phases

- `anon`: no session
- `rem`: Rem (owner)
- `friendA`: friend A
- `friendB`: friend B
- `revoked`: friend whose access was revoked
- `vercelCron`: Vercel cron (CRON_SECRET, no x-vercel-cron header)
- `zenbookPinger`: Zenbook pinger (CRON_SECRET)
- `zenbookRecorder`: Zenbook recorder (its own Spotify token, no app secret)
- `cronjobOrg`: cron-job.org (CRON_SECRET_EXT)
- `staleSecret`: cookie signed before the AUTH_SECRET rotation
- `staleLogout`: Rem's cookie replayed after Log out
- `forged`: cookie forged without AUTH_SECRET

Verdicts: **A** allow (Rem's own entry points: it must reach Rem's data, rows or Spotify grant; public ones: not refused). **D** deny (refused, and nothing of Rem's read into the answer, written, or called on Spotify). **I** isolated (a friend: never Rem's data, rows or grant; refused until Phase 4a, their own data after). `D ←A P1` = target D, today A (it reaches Rem's data), Phase 1 moves it; `a` = today it answers without touching anything of Rem's.

Phases: P1 Phase 1's turn (lane 12: requireUser and the uid's identity check, forUser, userCache, uid in ETags and bodies, /usage admin-only, /api/metrics' uid, auth_time); P2 Phase 2's turn (lane 15: the identity read's status and session_epoch, per-user tokens); P3 Phase 3's turn (lane 17: the per-user tick, daily chores on daily_at); P4a Phase 4a's turn (lane 19: Log out bumps session_epoch, the invite claim, the bounds); L07 the interim pinger (lane 07: CRON_SECRET_EXT).

## 2. The matrix

| entry point | anon | rem | friendA | friendB | revoked | vercelCron | zenbookPinger | zenbookRecorder | cronjobOrg | staleSecret | staleLogout | forged |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| GET /api/build | A | A | A | A | A | A | A | A | A | A | A | A |
| GET /api/now-playing | D | A | I | I | D | D | D | D | D | D | D | D |
| POST /api/sync | D | A | I | I | D | D | D | D | D | D | D | D |
| POST /api/metrics | D | A | I | I | D | D | D | D | D | D | D | D |
| GET /api/search/library | D | A | I | I | D | D | D | D | D | D | D | D |
| GET /api/search/history | D | A | I | I | D | D | D | D | D | D | D | D |
| GET /api/tasks/[id] | D | A | I | I | D | D | D | D | D | D | D | D |
| POST /api/playlists/[id]/tracks | D | A | I | I | D | D | D | D | D | D | D | D |
| POST /api/playlists/sync | D | A | I | I | D | D | D | D | D | D | D | D |
| GET /api/cron/sync | D | D | D | D | D | A | A | D | A | D | D | D |
| GET /api/cron/usage-check | D | D | D | D | D | A | A | D | D | D | D | D |
| GET /api/cron/daily | D | D | D | D | D | A | A | D | D | D | D | D |
| GET /api/cron/store-bench | D | D | D | D | D | A | A | D | D | D | D | D |
| GET /api/cron/health | D | D | D | D | D | A | A | D | A | D | D | D |
| POST /api/cron/probe | D | D | D | D | D | A | A | D | D | D | D | D |
| POST /api/join | A | A | A | A | A | A | A | A | A | A | A | A |
| GET /api/join/link | A | A | A | A | A | A | A | A | A | A | A | A |
| GET /api/auth/session | D | A | I | I | D | D | D | D | D | D | D | D |
| GET /api/auth/csrf | A | A | A | A | A | A | A | A | A | A | A | A |
| GET /api/auth/providers | A | A | A | A | A | A | A | A | A | A | A | A |
| POST /api/auth/signin/spotify | A | A | A | A | A | A | A | A | A | A | A | A |
| GET /api/auth/callback/spotify | D | A | I | I | D | D | D | D | D | D | D | D |
| POST /api/auth/signout | A | A | A | A | A | A | A | A | A | A | A | A |
| action login | A | A | A | A | A | A | A | A | A | A | A | A |
| action logout | D | A | I | I | D | D | D | D | D | D | D | D |
| action disconnectAction | D | D | I | I | D | D | D | D | D | D | D | D |
| action reauthForDisconnect | A | A | A | A | A | A | A | A | A | A | A | A |
| action mergeAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action saveQueueAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action subtractPreviewAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action saveCompareDiffAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action addToQueueAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action playTrackAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action playFromPlaylistAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action playPlaylistAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action saveToLikedAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action removeFromPlaylistAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action playerSetPlayingAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action playPlaylistTrackAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action resumePlaylistAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action startCleanAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action deletePlaylistAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action trackMenuAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action dockDataAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action dayTracksAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action dailyStatsAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action allTimePlaysAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action searchPlaysAction | D | A | I | I | D | D | D | D | D | D | D | D |
| action refreshHistoryAction | D | A | I | I | D | D | D | D | D | D | D | D |
| page /home | D | A | I | I | D | D | D | D | D | D | D | D |
| page /playlists | D | A | I | I | D | D | D | D | D | D | D | D |
| page /playlists/[id] | D | A | I | I | D | D | D | D | D | D | D | D |
| page /usage | D | A | D | D | D | D | D | D | D | D | D | D |
| page /disconnect | D | A | I | I | D | D | D | D | D | D | D | D |
| page /friends | A | A | A | A | A | A | A | A | A | A | A | A |
| layout (app) | D | A | I | I | D | D | D | D | D | D | D | D |
| page / | A | A | A | A | A | A | A | A | A | A | A | A |
| page /login | A | A | A | A | A | A | A | A | A | A | A | A |
| page /join | A | A | A | A | A | A | A | A | A | A | A | A |
| page /signed-out | A | A | A | A | A | A | A | A | A | A | A | A |
| page /disconnected | A | A | A | A | A | A | A | A | A | A | A | A |
| page /reconnect | A | A | A | A | A | A | A | A | A | A | A | A |
| page /privacy | A | A | A | A | A | A | A | A | A | A | A | A |
| page /terms | A | A | A | A | A | A | A | A | A | A | A | A |
| layout (legal) | A | A | A | A | A | A | A | A | A | A | A | A |
| layout (root) | A | A | A | A | A | A | A | A | A | A | A | A |
| page /kbtest | D | D | D | D | D | D | D | D | D | D | D | D |

## 3. Each entry point

### GET /api/build

- File: `src/app/api/build/route.ts`. Gate today: none (public).
- Does, when allowed: returns this deployment's build id; no store, no session.
- Calls (from the source): via `meterRequest`, `meterStart`.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public by design: a git sha already public in every asset URL (route comment, GOTCHAS)

### GET /api/now-playing

- File: `src/app/api/now-playing/route.ts`. Gate today: `src/app/api/now-playing/route.ts:33`.
- Does, when allowed: reads Spotify's player state (/me/player) with Rem's grant; reads and writes the context-name cache (contexts).
- Calls (from the source): store `forUser`; Spotify `currentlyPlaying`, `contextName`; via `spotifyAccessTokenFor`, `requireUser`, `spotifyClient`, `spotifyCooldownMs`, `currentMode`, `meteredBody`, `memoizedNowPlaying`, `rememberNowPlaying`.
- `anon`: D — requireUser refused → 200 {playing:null} with no store read (deliberately not 401: polled every 6 s)
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### POST /api/sync

- File: `src/app/api/sync/route.ts`. Gate today: `src/app/api/sync/route.ts:22`.
- Does, when allowed: the cron's step for the session's user under the cron's lease (PLAN §7.6): /me/player with their grant, a recently-played harvest into their plays when the policy says so; meta user_tz_offset and user_tz from the cookies, only when they change.
- Calls (from the source): store `forUser`; via `currentMode`, `requireRouteUser`, `runOpenApp`, `liveTickDeps`, `allowUserCall`.
- `anon`: D — requireRouteUser: no session → 401 with the signed-out marker before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### POST /api/metrics

- File: `src/app/api/metrics/route.ts`. Gate today: `src/app/api/metrics/route.ts:24`.
- Does, when allowed: appends client timing rows to client_metrics under the session's uid (shown on /usage); drops server-only event names.
- Calls (from the source): store `recordClientMetrics (w)`; via `requireRouteUser`.
- `anon`: D — requireRouteUser: no session → 401 with the signed-out marker before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### GET /api/search/library

- File: `src/app/api/search/library/route.ts`. Gate today: `src/app/api/search/library/route.ts:25`.
- Does, when allowed: returns every track in a playlist or Liked Songs (the library index), ETag'd with the uid, private, no-store.
- Calls (from the source): store `forUser`; via `requireRouteUser`, `meteredBody`.
- `anon`: D — requireRouteUser: no session → 401 with the signed-out marker before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### GET /api/search/history

- File: `src/app/api/search/history/route.ts`. Gate today: `src/app/api/search/history/route.ts:16`.
- Does, when allowed: returns every played track and every play (the history index), ETag'd with the uid, private, no-store.
- Calls (from the source): store `forUser`; via `requireRouteUser`, `meteredBody`.
- `anon`: D — requireRouteUser: no session → 401 with the signed-out marker before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### GET /api/tasks/[id]

- File: `src/app/api/tasks/[id]/route.ts`. Gate today: `src/app/api/tasks/[id]/route.ts:9`.
- Does, when allowed: returns one background task's progress and result from the in-process registry, to its owner only (getTaskFor).
- Calls (from the source): via `requireRouteUser`, `getTaskFor`.
- `anon`: D — requireRouteUser: no session → 401 with the signed-out marker before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### POST /api/playlists/[id]/tracks

- File: `src/app/api/playlists/[id]/tracks/route.ts`. Gate today: `src/app/api/playlists/[id]/tracks/route.ts:13`.
- Does, when allowed: reads one playlist's snapshot from Spotify with Rem's grant; re-fetches and rewrites its cached tracks when changed.
- Calls (from the source): store `forUser`; Spotify `playlist`, `playlistTracks`; via `spotifyAccessTokenFor`, `requireRouteUser`, `spotifyClient`, `allowUserCall`.
- `anon`: D — requireRouteUser: no session → 401 with the signed-out marker before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### POST /api/playlists/sync

- File: `src/app/api/playlists/sync/route.ts`. Gate today: `src/app/api/playlists/sync/route.ts:10`.
- Does, when allowed: starts a full library scan with Rem's grant as a background task; rewrites playlists, playlist_tracks, saved_tracks.
- Calls (from the source): via `startLibrarySync`, `requireRouteUser`, `taskDone`.
- `anon`: D — requireRouteUser: no session → 401 with the signed-out marker before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### GET /api/cron/sync

- File: `src/app/api/cron/sync/route.ts`. Gate today: `src/lib/sync/tick.ts:367`.
- Does, when allowed: the tick, at most one per 45 s whoever calls (app_meta.tick_at): the claim of every due user, each one's /me/player probe and, when the policy says so, a recently-played harvest with that user's own grant into their own plays; one library rescan; the daily chores when daily_at is over 26 h old.
- Calls (from the source): via `runDailyChores`, `adminStore`, `runTick`, `liveTickDeps`.
- `anon`: D — cronCaller() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET` (the Zenbook) or `Bearer $CRON_SECRET_EXT` (cron-job.org), timing-safe, an unset secret matching nobody; a cookie is not a secret; no header → 401
- `rem`: D — cronCaller() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET` (the Zenbook) or `Bearer $CRON_SECRET_EXT` (cron-job.org), timing-safe, an unset secret matching nobody; a cookie is not a secret; Rem's cookie → 401
- `friendA`, `friendB`, `revoked`, `staleSecret`, `staleLogout`, `forged`: D — cronCaller() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET` (the Zenbook) or `Bearer $CRON_SECRET_EXT` (cron-job.org), timing-safe, an unset secret matching nobody; a cookie is not a secret; a cookie → 401
- `vercelCron`: A — Bearer $CRON_SECRET → the tick (vercel.json, 07:00 UTC)
- `zenbookPinger`: A — Bearer $CRON_SECRET
- `zenbookRecorder`: D — cronCaller() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET` (the Zenbook) or `Bearer $CRON_SECRET_EXT` (cron-job.org), timing-safe, an unset secret matching nobody; a cookie is not a secret; a Spotify bearer is not the secret → 401
- `cronjobOrg`: A — Bearer $CRON_SECRET_EXT → the tick, after the reply; the reply is a bare {"ok":true}, never the outcome or the owner alarm (PLAN §7.2 step 0) [F10]

### GET /api/cron/usage-check

- File: `src/app/api/cron/usage-check/route.ts`. Gate today: `src/app/api/cron/usage-check/route.ts:9`.
- Does, when allowed: runUsageCheck: Turso's org usage with TURSO_PLATFORM_TOKEN and yesterday's reconciliation into the read-cost ledger (no per-user data).
- Calls (from the source): via `cronAuthorized`, `runUsageCheck`.
- `anon`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; no header → 401
- `rem`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; Rem's cookie → 401
- `friendA`, `friendB`, `revoked`, `staleSecret`, `staleLogout`, `forged`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; a cookie → 401
- `vercelCron`, `zenbookPinger`: A — Bearer $CRON_SECRET
- `zenbookRecorder`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; a Spotify bearer is not the secret → 401
- `cronjobOrg`: D — CRON_SECRET_EXT is unknown to cronAuthorized() → 401; PLAN §5.5 keeps it out of every cron route but sync and health [F7]

### GET /api/cron/daily

- File: `src/app/api/cron/daily/route.ts`. Gate today: `src/app/api/cron/daily/route.ts:22`.
- Does, when allowed: the daily chores (daily-chores.ts): recompute all-time totals, rebuild the Home payload, prune api_log and client_metrics, the played_at check, the usage check; Phase 4a's deletion retries, day 4 of revoked, the invite expiry, the sweeps, the cron-job.org jobs.
- Calls (from the source): via `acquireAppLock`, `getAppMeta`, `releaseAppLock`, `setAppMeta`, `cronAuthorized`, `runDailyChores`, `adminStore`.
- `anon`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; no header → 401
- `rem`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; Rem's cookie → 401
- `friendA`, `friendB`, `revoked`, `staleSecret`, `staleLogout`, `forged`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; a cookie → 401
- `vercelCron`: A — Bearer $CRON_SECRET → the chores (vercel.json, 09:00 UTC)
- `zenbookPinger`: A — Bearer $CRON_SECRET
- `zenbookRecorder`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; a Spotify bearer is not the secret → 401
- `cronjobOrg`: D — CRON_SECRET_EXT is unknown to cronAuthorized() → 401; PLAN §5.5 keeps it out of every cron route but sync and health [F7]

### GET /api/cron/store-bench

- File: `src/app/api/cron/store-bench/route.ts`. Gate today: `src/app/api/cron/store-bench/route.ts:11`.
- Does, when allowed: timed reads of the core or telemetry store; the reply names the store's host, never a token.
- Calls (from the source): via `cronAuthorized`, `adminStore`.
- `anon`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; no header → 401
- `rem`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; Rem's cookie → 401
- `friendA`, `friendB`, `revoked`, `staleSecret`, `staleLogout`, `forged`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; a cookie → 401
- `vercelCron`, `zenbookPinger`: A — Bearer $CRON_SECRET
- `zenbookRecorder`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; a Spotify bearer is not the secret → 401
- `cronjobOrg`: D — CRON_SECRET_EXT is unknown to cronAuthorized() → 401; PLAN §5.5 keeps it out of every cron route but sync and health [F7]

### GET /api/cron/health

- File: `src/app/api/cron/health/route.ts`. Gate today: `src/app/api/cron/health/route.ts:20`.
- Does, when allowed: the hourly health check: the owner's capture health, the daily stamp, the pace verdict, isolation events; replies ok/reasons/unchecked and nothing about anyone's listening.
- Calls (from the source): store `getBudgetMode`, `readBudgetDay`, `readMeter`; via `readHealth`, `recordHealthRed`, `readCapture`, `worstMode`, `cronCaller`, `healthVerdict`, `isolationCount`, `adminStore`.
- `anon`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; no header → 401
- `rem`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; Rem's cookie → 401
- `friendA`, `friendB`, `revoked`, `staleSecret`, `staleLogout`, `forged`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; a cookie → 401
- `vercelCron`, `zenbookPinger`: A — cronCaller(): Bearer $CRON_SECRET (src/lib/cron-auth.ts)
- `zenbookRecorder`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; a Spotify bearer is not the secret → 401
- `cronjobOrg`: A — cronCaller(): Bearer $CRON_SECRET_EXT opens this route and /api/cron/sync only (PLAN §5.5)

### POST /api/cron/probe

- File: `src/app/api/cron/probe/route.ts`. Gate today: `src/app/api/cron/probe/route.ts:27`.
- Does, when allowed: the planted probe: forges one cache entry under a uid's key stamped with another uid, then reads it back so exactly one isolation event results; reads no user data.
- Calls (from the source): via `countEvents`, `cronCaller`, `isUidShape`, `forgeProbeEntry`, `readProbeEntry`.
- `anon`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; no header → 401
- `rem`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; Rem's cookie → 401
- `friendA`, `friendB`, `revoked`, `staleSecret`, `staleLogout`, `forged`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; a cookie → 401
- `vercelCron`: A — cronCaller(): Bearer $CRON_SECRET (the Zenbook's secret, which Vercel's cron also carries)
- `zenbookPinger`: A — cronCaller(): Bearer $CRON_SECRET
- `zenbookRecorder`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; a Spotify bearer is not the secret → 401
- `cronjobOrg`: D — CRON_SECRET_EXT may tick and ask for health, never raise an alarm: cronCaller() answers ext → 401

### POST /api/join

- File: `src/app/api/join/route.ts`. Gate today: none (public).
- Does, when allowed: the request form's POST: stores one request (e-mail, name, terms version) in the app database through createJoinRequest and sets the signed request cookie; 303 back to /join.
- Calls (from the source): via `createJoinRequest`, `requestCookieHeader`.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: a friend's first visit, no session; createJoinRequest bounds it in SQL and SIGNUPS=owner shuts it; it creates no database and reads no user data

### GET /api/join/link

- File: `src/app/api/join/link/route.ts`. Gate today: none (public).
- Does, when allowed: the join link: a token whose hash opens one approved, unclaimed, live invite sets the request cookie; anything else goes back to /join; reads no user data.
- Calls (from the source): via `requestForJoinToken`, `joinTokenHash`, `requestCookieHeader`.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: the token is the capability (only its hash is stored); an unknown one is sent back to /join with nothing set

### GET /api/auth/session

- File: `src/app/api/auth/[...nextauth]/route.ts`. Gate today: `src/lib/auth.ts:270`.
- Does, when allowed: answers the cookie's own session (name, email, expiry, error; never a token) and re-issues the cookie with a fresh 30 days.
- Calls (from the source): via `Auth.js`.
- `anon`: D — no cookie → null
- `rem`: A — the cookie decodes; the session callback adds `uid`, `admin` and `error` (tokens stay off the session, SECURITY.md)
- `friendA`, `friendB`: I — the jwt callback's identity check refuses a uid that is not OWNER_UID → no session (null)
- `revoked`: D — the jwt callback's identity check refuses a uid that is not OWNER_UID → no session (null)
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch, so the jwt callback's identity read refuses the copy (ep 0) and Auth.js clears it: no session (F3 closed in P4a) [F3]

### GET /api/auth/csrf

- File: `src/app/api/auth/[...nextauth]/route.ts`. Gate today: none (public).
- Does, when allowed: issues Auth.js's CSRF token and cookie.
- Calls (from the source): via `Auth.js`.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: Auth.js's double-submit token

### GET /api/auth/providers

- File: `src/app/api/auth/[...nextauth]/route.ts`. Gate today: none (public).
- Does, when allowed: lists the configured provider (Spotify).
- Calls (from the source): via `Auth.js`.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: provider metadata

### POST /api/auth/signin/spotify

- File: `src/app/api/auth/[...nextauth]/route.ts`. Gate today: none (public).
- Does, when allowed: starts OAuth: state and PKCE cookies, a redirect to accounts.spotify.com.
- Calls (from the source): via `Auth.js`.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: anyone may start a sign-in; the callback decides

### GET /api/auth/callback/spotify

- File: `src/app/api/auth/[...nextauth]/route.ts`. Gate today: `src/lib/auth.ts:181`.
- Does, when allowed: finishes OAuth: exchanges the code, reads /v1/me uncached-by-design, runs signIn (the app database by account_id, under SIGNUPS), writes the token row, sets the session cookie.
- Calls (from the source): via `Auth.js`.
- `anon`: D — a stranger off the dev-mode allowlist: /v1/me 403 → /login?error=SpotifyNotRegistered, nothing written
- `rem`: A — his account_id names the admin row → the token row is written and a cookie set
- `friendA`, `friendB`: I — resolveSignIn: no row for this account_id and no request cookie → AccessDenied before the token write; with an approved request's cookie and SIGNUPS=invite, the claim gives them their own uid and row (claim-signin.test.ts)
- `revoked`: D — resolveSignIn: no row for this account_id → AccessDenied; a disabled row is refused with 'ask Rem'
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — a callback with no state or PKCE cookie → Auth.js InvalidCheck → /login?error=
- `staleSecret`, `staleLogout`, `forged`: D — a replayed callback URL with Rem's code but no state cookie → InvalidCheck

### POST /api/auth/signout

- File: `src/app/api/auth/[...nextauth]/route.ts`. Gate today: none (public).
- Does, when allowed: deletes this browser's session cookie (CSRF-checked); touches no store row.
- Calls (from the source): via `Auth.js`.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: only clears the caller's own cookie

### action login

- File: `src/app/(app)/actions.ts`. Gate today: none (public).
- Does, when allowed: starts OAuth (signIn('spotify')): a redirect to accounts.spotify.com.
- Calls (from the source): via `signIn`.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: starting a sign-in reads and writes nothing

### action logout

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:66`.
- Does, when allowed: bumps the gated user's session_epoch and deletes their token row (account.ts, awaited), then this browser's cookie; /signed-out.
- Calls (from the source): via `logOutFrom`, `signOut`, `gateFromSession`.
- `anon`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `forged`: D — the session gate refuses → logOutFrom ends nothing; only this browser's cookie is cleared (→ /signed-out)
- `rem`: A — the owner logging out: every session ended (epoch + 1) and his token row deleted, which stops capture (RULINGS Oct 15 1:33 PM)
- `friendA`, `friendB`: I — the session gate refuses → logOutFrom ends nothing; only this browser's cookie is cleared (→ /signed-out)
- `staleLogout`: D — the identity read refuses the copy (its epoch moved at the first Log out); nothing left to end

### action disconnectAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:76`.
- Does, when allowed: removes the gated user's account through the deletion job (account.ts disconnect): the typed word, a sign-in within 10 minutes, never the admin.
- Calls (from the source): via `disconnect`, `signOut`, `deleteAccount`, `gateFromSession`.
- `anon`: D — the session gate refuses → { ok: false } before anything is read
- `rem`: D — decision 21 as ruled: nothing deletes Rem's data; disconnect() refuses the admin before the deletion job, with the word typed and a fresh sign-in
- `friendA`, `friendB`: I — a friend's own account only (the job refuses any row but `lb-u-<uid>` for the caller's uid); no row in the harness, so refused
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action reauthForDisconnect

- File: `src/app/(app)/actions.ts`. Gate today: none (public).
- Does, when allowed: starts OAuth (signIn('spotify')) back to /disconnect: the fresh sign-in Disconnect asks for.
- Calls (from the source): via `signIn`.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: starting a sign-in reads and writes nothing

### action mergeAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: creates a playlist from several on Rem's account; records it in playlists.
- Calls (from the source): store `forUser`; Spotify `mergePlaylists`; via `requireActionUser`, `getSpotify`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action saveQueueAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: reads Rem's queue and saves it as a new playlist; records it.
- Calls (from the source): store `forUser`; Spotify `saveQueue`; via `requireActionUser`, `getSpotify`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action subtractPreviewAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: reads cached (or live) tracks of the named playlists; returns the set difference.
- Calls (from the source): store `forUser`; Spotify `playlistTracks`; via `requireActionUser`, `getSpotify`, `intersect`, `keyOf`, `subtract`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action saveCompareDiffAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: creates a playlist on Rem's account from the given uris; records it.
- Calls (from the source): store `forUser`; Spotify `createFromUris`; via `requireActionUser`, `getSpotify`, `allowUserCall`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action addToQueueAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: adds a track to Rem's playback queue.
- Calls (from the source): Spotify `addToQueue`; via `requireActionUser`, `getSpotify`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action playTrackAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: starts a track on Rem's active device.
- Calls (from the source): Spotify `playTracks`; via `requireActionUser`, `getSpotify`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action playFromPlaylistAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: starts a playlist at a track on Rem's device.
- Calls (from the source): Spotify `playContext`; via `requireActionUser`, `getSpotify`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action playPlaylistAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: starts a playlist on Rem's device.
- Calls (from the source): Spotify `playContext`; via `requireActionUser`, `getSpotify`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action saveToLikedAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: saves a track to Rem's Liked Songs.
- Calls (from the source): Spotify `saveTrack`; via `requireActionUser`, `getSpotify`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action removeFromPlaylistAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: removes a track from one of Rem's playlists; rewrites the cached copy.
- Calls (from the source): store `forUser`; Spotify `playlist`, `playlistTracks`, `removeFromPlaylist`, `addItemsAt`; via `requireActionUser`, `getSpotify`, `reinsertPositions`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action playerSetPlayingAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: pauses or resumes Rem's playback.
- Calls (from the source): Spotify `resumePlayback`, `pausePlayback`; via `requireActionUser`, `getSpotify`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action playPlaylistTrackAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: plays a track within a playlist on Rem's device.
- Calls (from the source): Spotify `playContext`; via `requireActionUser`, `getSpotify`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action resumePlaylistAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: reads the playlist's cached order and Rem's plays in it; starts playback after the last one.
- Calls (from the source): store `forUser`; Spotify `playlistTracks`, `playContext`; via `requireActionUser`, `getSpotify`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action startCleanAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: dedupes a playlist into a new one on Rem's account (and a backup); takes a clean:<id> lock; a background reconcile task.
- Calls (from the source): store `forUser`; via `getValidAccessTokenFor`, `spotifyAccessTokenFor`, `requireActionUser`, `getSpotify`, `spotifyClient`, `runTask`, `taskDone`, `cleanPhase1`, `reconcileClean`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action deletePlaylistAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: unfollows a playlist on Rem's account and deletes it from the store.
- Calls (from the source): store `forUser`; Spotify `deletePlaylist`; via `getValidAccessTokenFor`, `spotifyAccessTokenFor`, `requireActionUser`, `getSpotify`, `spotifyClient`, `runTask`, `taskDone`, `syncLibrary`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action trackMenuAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:115`.
- Does, when allowed: looks a track up by name and artist in Rem's library, with the playlists that hold it.
- Calls (from the source): store `forUser`; via `requireActionUser`, `getSpotify`.
- `anon`: D — requireActionUser: no session → { ok: false } before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action dockDataAction

- File: `src/app/(app)/history-actions.ts`. Gate today: `src/app/(app)/history-actions.ts:18`.
- Does, when allowed: reads every stored playlist, me_id, the clean-backup preference and the sync stamp.
- Calls (from the source): store `forUser`; via `requireActionUser`.
- `anon`: D — gated(): requireActionUser refused → an empty answer before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action dayTracksAction

- File: `src/app/(app)/history-actions.ts`. Gate today: `src/app/(app)/history-actions.ts:18`.
- Does, when allowed: reads one day's plays.
- Calls (from the source): store `forUser`; via `requireActionUser`, `tzOffsetMinutes`.
- `anon`: D — gated(): requireActionUser refused → an empty answer before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action dailyStatsAction

- File: `src/app/(app)/history-actions.ts`. Gate today: `src/app/(app)/history-actions.ts:18`.
- Does, when allowed: reads per-day play counts for every day; any width but the one Home sends is refused (PLAN §6.6).
- Calls (from the source): store `forUser`; via `requireActionUser`, `tzOffsetMinutes`.
- `anon`: D — gated(): requireActionUser refused → an empty answer before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action allTimePlaysAction

- File: `src/app/(app)/history-actions.ts`. Gate today: `src/app/(app)/history-actions.ts:18`.
- Does, when allowed: reads the 300 most-played tracks.
- Calls (from the source): store `forUser`; via `requireActionUser`.
- `anon`: D — gated(): requireActionUser refused → an empty answer before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action searchPlaysAction

- File: `src/app/(app)/history-actions.ts`. Gate today: `src/app/(app)/history-actions.ts:18`.
- Does, when allowed: LIKE-searches every play by name or artist, ten a minute per user.
- Calls (from the source): store `forUser`; via `requireActionUser`, `allowUserCall`.
- `anon`: D — gated(): requireActionUser refused → an empty answer before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### action refreshHistoryAction

- File: `src/app/(app)/history-actions.ts`. Gate today: `src/app/(app)/history-actions.ts:18`.
- Does, when allowed: re-reads the strip, the all-time totals, the visible day and the plays the client's index is missing from Rem's store; no Spotify call (decision 15).
- Calls (from the source): store `forUser`, `ledgerAdd (w)`; via `requireActionUser`, `tzOffsetMinutes`.
- `anon`: D — gated(): requireActionUser refused → NO_REFRESH before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### page /home

- File: `src/app/(app)/home/page.tsx`. Gate today: `src/app/(app)/home/page.tsx:72`.
- Does, when allowed: renders the day strip, all-time card and the opening day's rows from the Home payload.
- Calls (from the source): store `forUser`; via `readCapture`, `requirePageUser`, `tzOffsetMinutes`.
- `anon`: D — requirePageUser: no session → redirect('/login') before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### page /playlists

- File: `src/app/(app)/playlists/page.tsx`. Gate today: `src/app/(app)/playlists/page.tsx:21`.
- Does, when allowed: renders every stored playlist and the unique-song count.
- Calls (from the source): store `forUser`; via `requirePageUser`.
- `anon`: D — requirePageUser: no session → redirect('/login') before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### page /playlists/[id]

- File: `src/app/(app)/playlists/[id]/page.tsx`. Gate today: `src/app/(app)/playlists/[id]/page.tsx:29`.
- Does, when allowed: renders one playlist's cached tracks; a cold playlist is fetched with Rem's grant and cached.
- Calls (from the source): store `forUser`; Spotify `playlist`, `playlistTracks`; via `requirePageUser`, `getSpotify`, `duplicatePositions`, `formatListenTime`.
- `anon`: D — requirePageUser: no session → redirect('/login') before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### page /usage

- File: `src/app/(app)/usage/page.tsx`. Gate today: `src/app/(app)/usage/page.tsx:252`.
- Does, when allowed: renders the admin's page: per-page timings, the rows-read ledger, the Spotify call breakdown, capture health.
- Calls (from the source): store `forUser`; via `captureHealthMessage`, `readCapture`, `requirePageUser`, `tzOffsetMinutes`.
- `anon`: D — requirePageUser: no session → redirect('/login') before any read
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: D — requirePageUser refuses a uid that is not OWNER_UID; past it, /usage is the admin's (notFound() otherwise)
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### page /disconnect

- File: `src/app/(app)/disconnect/page.tsx`. Gate today: `src/app/(app)/disconnect/page.tsx:19`.
- Does, when allowed: the export button, the typed word and the fresh sign-in for a friend; for the admin, a note that his account is never deleted and Log out only.
- Calls (from the source): via `requirePageUser`.
- `anon`: D — requirePageUser: no session → redirect('/login') before any read
- `rem`: A — Rem's page: Log out only (decision 21 as ruled)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### page /friends

- File: `src/app/(app)/friends/page.tsx`. Gate today: none (public).
- Does, when allowed: a constant placeholder; no data, no session read (prerendered).
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — a constant with no data (page comment); reached through the (app) layout, which redirects a missing session

### layout (app)

- File: `src/app/(app)/layout.tsx`. Gate today: `src/app/(app)/layout.tsx:52`.
- Does, when allowed: renders the chrome with the session's name and image and the uid for the browser's storage names; not a gate for its pages (SECURITY.md).
- Calls (from the source): via `requirePageUser`.
- `anon`: D — requirePageUser: no session → redirect('/login')
- `rem`: A — the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)
- `friendA`, `friendB`: I — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `revoked`: D — requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — Log out bumped session_epoch (account.ts), so the copy's `ep` no longer matches and the identity read refuses it; its token row is gone too

### page /

- File: `src/app/page.tsx`. Gate today: none (public).
- Does, when allowed: redirects to /home.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: a redirect, no read

### page /login

- File: `src/app/(auth)/login/page.tsx`. Gate today: none (public).
- Does, when allowed: the sign-in button; a live session is sent on to /home.
- Calls (from the source): via `loginErrorMessage`.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: the sign-in page

### page /join

- File: `src/app/(auth)/join/page.tsx`. Gate today: none (public).
- Does, when allowed: PLAN §12.6's text and the request form, or, with a request cookie, where that request stands; the closed notice under SIGNUPS=owner.
- Calls (from the source): via `requestState`, `signupsMode`, `verifyRequestCookie`.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: a friend's first visit; it reads only the request its own signed cookie names

### page /signed-out

- File: `src/app/(auth)/signed-out/page.tsx`. Gate today: none (public).
- Does, when allowed: the page after Log out: recording stopped, how to resume; clears this browser's stores.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: static text, no session or reads

### page /disconnected

- File: `src/app/(auth)/disconnected/page.tsx`. Gate today: none (public).
- Does, when allowed: the page after Disconnect: remove the app at spotify.com/account/apps; clears this browser's stores.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: static text, no session or reads

### page /reconnect

- File: `src/app/(auth)/reconnect/page.tsx`. Gate today: none (public).
- Does, when allowed: decision 20's page for a dead Spotify grant: what happened, what to do, then the sign-in.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: static text and the sign-in, no session or reads

### page /privacy

- File: `src/app/(legal)/privacy/page.tsx`. Gate today: none (public).
- Does, when allowed: the privacy policy; no session, no data.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public by Spotify's terms §V (shown before sign-up)

### page /terms

- File: `src/app/(legal)/terms/page.tsx`. Gate today: none (public).
- Does, when allowed: the end-user terms; no session, no data.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public by Spotify's terms §V (shown before sign-up)

### layout (legal)

- File: `src/app/(legal)/layout.tsx`. Gate today: none (public).
- Does, when allowed: the legal pages' frame; no session, no data.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public

### layout (root)

- File: `src/app/layout.tsx`. Gate today: none (public).
- Does, when allowed: html, fonts, the host canonicalizer; no session, no data.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public

### page /kbtest

- File: `src/app/kbtest/page.tsx`. Gate today: `src/app/kbtest/page.tsx:18`.
- Does, when allowed: a dev-only keyboard fixture over dummy rows.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: D — notFound() in production builds; dummy rows in dev

## 4. Findings: cells the code has no explicit rule for

- **F1. Any cookie signed with AUTH_SECRET is served as the owner.** The session never names its user (auth.ts's jwt callback reads the one global token row for every cookie), so a friend's, a revoked friend's, or any other validly signed cookie reaches Rem's store and Rem's Spotify grant on every user entry point. Today only the owner-only signIn callback (src/lib/owner.ts) and AUTH_SECRET's secrecy stand in front of it. Closed for Phase 1 in its turn (lane 12): every request's cookie passes the identity check (src/lib/identity.ts), which knows one uid, OWNER_UID; requireUser is the only source of a uid. Phase 2 adds status and session_epoch. Owner: P1: the uid on the session, its identity check and requireUser (lane 12); P2: status and session_epoch from the identity read (lane 15). (pinned by the red-team checks below)
- **F2. A session whose Spotify grant is gone still reads the whole library and history.** The two search routes, the six history actions, /api/metrics and /api/tasks/[id] check only that a session exists (!!auth()). Once the token row is gone (Log out, or invalid_grant) the session carries `error` and every page refuses it, but these keep serving Rem's data to it, including a cookie copied before Log out. PLAN §5.4 says requireUser applies the pages' rule to them; mu/phase1's gateFromSession allows an errored session (canCallSpotify: false), which would keep serving it. Closed in Phase 1's turn (lane 12): requireUser refuses a session whose grant is gone on every entry point (src/lib/session-gate.ts). Owner: P1 (lane 12): requireUser applying PLAN §5.4's rule; P4a (lane 19): Log out bumps session_epoch. (pinned by the red-team checks below)
- **F3. Log out does not end a cookie.** logout deletes the browser's cookie and the global token row, but the JWE stays valid for its 30 days, and GET /api/auth/session re-issues it with a fresh 30 days on every read. A copy left on a shared computer is refused only while the token row is absent: the next sign-in anywhere brings it back to full access. Owner: P1: auth_time's 30-day bound (lane 12); P4a: Log out bumps session_epoch (lane 19). (1 cells: GET /api/auth/session)
- **F4. logout runs with no session check.** The logout server action clears the global Spotify token row in after() whoever posts it: no cookie, a forged or stale cookie, a friend. Anyone who can post the action stops closed-app capture until Rem signs in again (the cron then answers 503 'no token'), and plays past Spotify's last 50 are lost. Closed in Phase 1's turn (lane 12): logout clears only the gated user's own token row; a refused caller gets only its cookie cleared. Owner: P1 (lane 12, item 6: every action onto requireActionUser, logout included). (pinned by the red-team checks below)
- **F5. /usage has no admin rule.** Any session sees the operator's page: the rows-read ledger, per-page client timings and the Spotify call breakdown with raw paths. PLAN §6.2 layer 7 says both 'require is_admin' and 'for any user but the admin, aggregated'; lane 12's brief says admin-only, which this map takes. Closed in Phase 1's turn (lane 12): /usage is the admin's; anyone else gets notFound() after requirePageUser. Owner: P1 (lane 12, item 6). (pinned by the red-team checks below)
- **F6. Search payloads carry no user: ETags without a uid, bodies revalidated from the HTTP cache.** The library and history ETags are "lib-<shape>-<version>-<day>" with per-store counters that collide across users, the bodies are `private, max-age=0, must-revalidate` (kept in the HTTP cache after sign-out) and carry no `u`, and the cached reads behind them key on the version alone. Closed in Phase 1's turn (lane 12): both ETags carry the uid and the store epoch, the bodies are `private, no-store` with `u`, and every cached read goes through userCache (uid and epoch in the key). Owner: P1 (lane 12, items 3-4; PLAN §6.2 layers 4 and 6). (pinned by the red-team checks below)
- **F7. One cron check for every cron route, and CRON_SECRET_EXT about to join it.** Until the store split, /api/cron/sync ran the daily chores for any CRON_SECRET holder who sent x-vercel-cron; origin/main moved them to /api/cron/daily (75aea82), so that header opens nothing now (the red team pins it). What is left: all four cron routes share cronAuthorized() in src/lib/cron-auth.ts. Lane 07's brief takes mu/phase1's src/lib/cron-auth.ts byte for byte, a different file under the same name (cronCaller, no cronAuthorized): taken whole it removes the export four routes import; folded into cronAuthorized it opens /api/cron/daily, /api/cron/store-bench and /api/cron/usage-check to cron-job.org's secret, which PLAN §5.5 forbids (EXT opens /api/cron/sync and /api/cron/health only). Today the rule is explicit (EXT is unknown to every route); the cronjobOrg cells of those three routes are the tripwire. Owner: L07 (lane 07, done on mu/pinger: cronAuthorized stays CRON_SECRET-only, cronCaller beside it opens /api/cron/sync alone); P1 (lane 12's rebase meets the same add/add on cron-auth.ts). (3 cells: GET /api/cron/usage-check; GET /api/cron/daily; GET /api/cron/store-bench)
- **F8. /home reads Rem's store before its gate.** home/page.tsx runs getHomePayload, the cooldown and capture health in one Promise.all with auth(): an anonymous request pays three store reads before the redirect (nothing ships; the cost lands on the shared store budget). Closed in Phase 1's turn (lane 12): Home's reads start after requirePageUser. Owner: P1 (lane 12, item 6: Home's first wave behind the gate). (pinned by the red-team checks below)
- **F9. Phase 1's claims are not checked: a cookie never expires by age.** auth_time is not read, so a 31-day-old sign-in is still a session as long as the cookie keeps being renewed (F3). PLAN §5.4 bounds a session to 30 days from its sign-in. Closed by the identity check (mu/phase1): auth_time over 30 days refuses the cookie. Owner: P1 (lane 12: the identity check reads auth_time). (pinned by the red-team checks below)
- **F10. The cron's owner alarm and per-user outcome would go to cron-job.org.** /api/cron/sync answers its outcome (added counts, the 503 'no token' alarm) to whoever holds a secret. PLAN §7.2 step 0: cron-job.org gets a bare {"ok":true}, since it keeps response bodies and disables a job after a run of failures. Owner: L07 (lane 07, item 2, done on mu/pinger: the owner alarm and the outcome answer the Zenbook's CRON_SECRET only, cron-job.org gets a bare {"ok":true}); P3 (lane 17: Phase 3's tick keeps both, and the Zenbook's outcome names no friend's trigger or count). (1 cells: GET /api/cron/sync)
- **F11. Background tasks have no owner.** /api/tasks/[id] answers any session the task's full record, result included; only the random id stands in the way. Closed by mu/phase1: tasks record their owner and getTaskFor answers another user's task as missing. Owner: P1 (mu/phase1 built getTaskFor; lane 12 carries it). (pinned by the red-team checks below)

## 5. Red team (`tests/isolation/authz-redteam.test.ts`)

Every friend cell in the matrix already passes Rem's own identifiers (his playlist id `rem-pl-1`, his task id, his history day), so another user's ids in every call are covered there. These checks take what the matrix does not reach:

- [holds] a friend sending Rem's library ETag gets no 304 onto Rem's body (P1: the uid in the ETag, the friend refused)
- [holds] both search ETags carry the uid (P1)
- [holds] search bodies are `private, no-store` and stamped with the uid as `u` (P1)
- [holds] every cached read behind the search payloads and Home keys on the user (P1: userCache)
- [holds] a friend's cookie with Rem's token expired refreshes nothing of Rem's (P1: the identity check first)
- [holds] Rem's cookie copied before Log out stays refused once Rem signs in elsewhere (F3, closed in P4a)
- [holds] a 31-day-old sign-in (auth_time) is refused (P1, F9)
- [holds] GET /api/auth/session re-issues a replayed cookie with a fresh expiry (F3)
- [holds] an expired cookie, a truncated one, garbage and an unsigned JWT are no session
- [holds] a session cookie, or Rem's Spotify token, presented as the cron bearer is refused
- [holds] a sign-in's callbackUrl to another origin lands on this origin
- [holds] Log out deletes Rem's token of record (user_tokens) and its plaintext copy: a copy of his cookie is refused, and the cron stops (RULINGS Oct 15 1:33 PM)
- [holds] the revoked friend is refused by their own row (status, then epoch), never as an unknown uid; friends A and B by SIGNUPS=owner, each with only their own token row
- [holds] the app database down (identity read unavailable) reaches each require*User form as the retryable answer, never a sign-out
- [holds] a friend's completed sign-in leaves Rem's token row byte for byte
- [holds] every malformed or misplaced secret is refused
- [holds] an unset or empty CRON_SECRET matches nobody, not even an empty bearer
- [holds] x-vercel-cron opens nothing on /api/cron/sync: the chores run only on /api/cron/daily (F7, fixed by 75aea82)
- [holds] CRON_SECRET_EXT opens none of the daily, bench and usage routes, nor the chores by header (tripwire for lane 07, F7)
- [holds] cron-job.org's secret opens /api/cron/sync, and its reply is a bare {"ok":true} (F10, lane 07)
- [holds] the Zenbook pinger still gets the 503 owner alarm when no token is stored
- [holds] searchPlaysAction takes LIKE wildcards and quotes as text, and refuses an anonymous caller
- [holds] dailyStatsAction answers only the width Home sends, so a client cannot mint scans (PLAN §6.6, P4a)
- [holds] searchPlaysAction takes ten a minute per user; the eleventh reads nothing (PLAN §6.6, P4a)
- [holds] an anonymous /home sends no store statement before its redirect (P1, F8)
- [holds] every other gated page and route sends no statement for an anonymous caller

## 6. What waits on which phase

