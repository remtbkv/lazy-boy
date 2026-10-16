# Who may call what: the authorization map

Generated from `tests/isolation/authz-registry.ts` and the code by `tests/isolation/authz-doc.ts`; do not edit by hand. `npm test` fails when this file is stale; `AUTHZ_WRITE=1 npx vitest run tests/isolation/authz-map.test.ts` rewrites it. Every cell below is a test (`tests/isolation/authz-{route,auth,action,page}.test.ts`) that runs the entry point through the real Auth.js (a real cookie, src/lib/auth.ts's own callbacks) against a throwaway store seeded with Rem's rows and the scripted Spotify.

56 entry points × 12 principals = 672 cells: 203 allow, 395 deny, 74 isolated. 124 cells are not at their target in today's single-user code; each is pinned to what it does today and names the phase that moves it. 11 findings (cells with no explicit rule), 22 red-team checks (9 pinned).

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
| GET /api/now-playing | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| POST /api/sync | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| POST /api/metrics | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D ←A P1 | D |
| GET /api/search/library | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D ←A P1 | D |
| GET /api/search/history | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D ←A P1 | D |
| GET /api/tasks/[id] | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D ←A P1 | D |
| POST /api/playlists/[id]/tracks | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| POST /api/playlists/sync | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| GET /api/cron/sync | D | D | D | D | D | A | A | D | A | D | D | D |
| GET /api/cron/usage-check | D | D | D | D | D | A | A | D | D | D | D | D |
| GET /api/cron/daily | D | D | D | D | D | A | A | D | D | D | D | D |
| GET /api/cron/store-bench | D | D | D | D | D | A | A | D | D | D | D | D |
| GET /api/auth/session | D | A | I | I | D ←a P1 | D | D | D | D | D | D ←a P4a | D |
| GET /api/auth/csrf | A | A | A | A | A | A | A | A | A | A | A | A |
| GET /api/auth/providers | A | A | A | A | A | A | A | A | A | A | A | A |
| POST /api/auth/signin/spotify | A | A | A | A | A | A | A | A | A | A | A | A |
| GET /api/auth/callback/spotify | D | A | I | I | D | D | D | D | D | D | D | D |
| POST /api/auth/signout | A | A | A | A | A | A | A | A | A | A | A | A |
| action login | A | A | A | A | A | A | A | A | A | A | A | A |
| action logout | D ←A P1 | A | I ←A P1 | I ←A P1 | D ←A P1 | D ←A P1 | D ←A P1 | D ←A P1 | D ←A P1 | D ←A P1 | D | D ←A P1 |
| action mergeAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action saveQueueAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action subtractPreviewAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action saveCompareDiffAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action addToQueueAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action playTrackAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action playFromPlaylistAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action playPlaylistAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action saveToLikedAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action removeFromPlaylistAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action playerSetPlayingAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action playPlaylistTrackAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action resumePlaylistAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action startCleanAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action deletePlaylistAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action trackMenuAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| action dockDataAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D ←A P1 | D |
| action dayTracksAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D ←A P1 | D |
| action dailyStatsAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D ←A P1 | D |
| action allTimePlaysAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D ←A P1 | D |
| action searchPlaysAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D ←A P1 | D |
| action refreshHistoryAction | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| page /home | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| page /playlists | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| page /playlists/[id] | D | A | I ←A P1 | I ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| page /usage | D | A | D ←A P1 | D ←A P1 | D ←A P1 | D | D | D | D | D | D | D |
| page /friends | A | A | A | A | A | A | A | A | A | A | A | A |
| layout (app) | D | A | I | I | D ←a P1 | D | D | D | D | D | D | D |
| page / | A | A | A | A | A | A | A | A | A | A | A | A |
| page /login | A | A | A | A | A | A | A | A | A | A | A | A |
| page /privacy | A | A | A | A | A | A | A | A | A | A | A | A |
| page /terms | A | A | A | A | A | A | A | A | A | A | A | A |
| layout (legal) | A | A | A | A | A | A | A | A | A | A | A | A |
| layout (root) | A | A | A | A | A | A | A | A | A | A | A | A |
| page /kbtest | D | D | D | D | D | D | D | D | D | D | D | D |

## 3. Each entry point

### GET /api/build

- File: `src/app/api/build/route.ts`. Gate today: none (public).
- Does, when allowed: returns this deployment's build id; no store, no session.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public by design: a git sha already public in every asset URL (route comment, GOTCHAS)

### GET /api/now-playing

- File: `src/app/api/now-playing/route.ts`. Gate today: `src/app/api/now-playing/route.ts:22`.
- Does, when allowed: reads Spotify's currently-playing with Rem's grant; reads and writes the context-name cache (contexts).
- Calls (from the source): store `getContextName`, `recordContexts (w)`; Spotify `currentlyPlaying`, `contextName`; via `spotifyAccessToken`, `spotifyClient`, `spotifyCooldownMs`.
- `anon`: D — auth() null → 200 {playing:null} with no store read (deliberately not 401: polled every 6 s)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### POST /api/sync

- File: `src/app/api/sync/route.ts`. Gate today: `src/app/api/sync/route.ts:17`.
- Does, when allowed: harvests recently-played with Rem's grant into plays/tracks; writes meta user_tz from the tzoffset cookie and the sync stamps.
- Calls (from the source): store `getLastSync`, `ledgerSyncCall (w)`, `setUserTzOffset (w)`; via `spotifyAccessToken`, `spotifyClient`, `syncRecentPlays`.
- `anon`: D — auth() null → 401 before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### POST /api/metrics

- File: `src/app/api/metrics/route.ts`. Gate today: `src/app/api/metrics/route.ts:20`.
- Does, when allowed: appends client timing rows to client_metrics (shown on /usage).
- Calls (from the source): store `recordClientMetrics (w)`.
- `anon`: D — auth() null → 401 before the body is read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D ←A P1 — none: this gate checks only that a session exists (F2) [F2]

### GET /api/search/library

- File: `src/app/api/search/library/route.ts`. Gate today: `src/app/api/search/library/route.ts:22`.
- Does, when allowed: returns every track in a playlist or Liked Songs (the library index), ETag'd.
- Calls (from the source): store `getLibraryIndex`, `getLibraryIndexVersion`.
- `anon`: D — auth() null → 401 before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D ←A P1 — none: this gate checks only that a session exists (F2) [F2]

### GET /api/search/history

- File: `src/app/api/search/history/route.ts`. Gate today: `src/app/api/search/history/route.ts:16`.
- Does, when allowed: returns every played track and every play (the history index), ETag'd.
- Calls (from the source): store `getHistoryIndex`, `getHistoryIndexVersion`.
- `anon`: D — auth() null → 401 before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D ←A P1 — none: this gate checks only that a session exists (F2) [F2]

### GET /api/tasks/[id]

- File: `src/app/api/tasks/[id]/route.ts`. Gate today: `src/app/api/tasks/[id]/route.ts:10`.
- Does, when allowed: returns one background task's progress and result from the in-process registry.
- Calls (from the source): via `getTask`.
- `anon`: D — auth() null → 401
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F11]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D ←A P1 — none: this gate checks only that a session exists (F2) [F2]

### POST /api/playlists/[id]/tracks

- File: `src/app/api/playlists/[id]/tracks/route.ts`. Gate today: `src/app/api/playlists/[id]/tracks/route.ts:13`.
- Does, when allowed: reads one playlist's snapshot from Spotify with Rem's grant; re-fetches and rewrites its cached tracks when changed.
- Calls (from the source): store `storePlaylistTracks (w)`; Spotify `playlist`, `playlistTracks`; via `spotifyAccessToken`, `spotifyClient`.
- `anon`: D — auth() null → 401 before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### POST /api/playlists/sync

- File: `src/app/api/playlists/sync/route.ts`. Gate today: `src/lib/playlists-sync.ts:28`.
- Does, when allowed: starts a full library scan with Rem's grant as a background task; rewrites playlists, playlist_tracks, saved_tracks.
- Calls (from the source): via `startLibrarySync`, `taskDone`.
- `anon`: D — startLibrarySync: auth() null → 'unauthorized' → 401
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### GET /api/cron/sync

- File: `src/app/api/cron/sync/route.ts`. Gate today: `src/app/api/cron/sync/route.ts:58`.
- Does, when allowed: the tick, at most one per 90 s whoever calls (the stamp, acquireLock('tick')): currently-playing and recently-played with Rem's stored grant, harvest stamps, plays; a library rescan every 30 min.
- Calls (from the source): store `acquireLock (w)`, `getHarvestGate`, `getLibraryScanAttemptAt`, `getLibrarySyncedAt`, `getSpotifyTokens`, `ledgerSyncCall (w)`, `setHarvestGate (w)`, `setLibraryScanAttemptAt (w)`; Spotify `currentlyPlaying`; via `getValidAccessToken`, `cronCaller`, `spotifyClient`, `syncRecentPlays`, `syncLibrary`, `shouldHarvest`.
- `anon`: D — cronCaller() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET` (the Zenbook) or `Bearer $CRON_SECRET_EXT` (cron-job.org), timing-safe, an unset secret matching nobody; a cookie is not a secret; no header → 401
- `rem`: D — cronCaller() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET` (the Zenbook) or `Bearer $CRON_SECRET_EXT` (cron-job.org), timing-safe, an unset secret matching nobody; a cookie is not a secret; Rem's cookie → 401
- `friendA`, `friendB`, `revoked`, `staleSecret`, `staleLogout`, `forged`: D — cronCaller() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET` (the Zenbook) or `Bearer $CRON_SECRET_EXT` (cron-job.org), timing-safe, an unset secret matching nobody; a cookie is not a secret; a cookie → 401
- `vercelCron`: A — Bearer $CRON_SECRET → the tick (vercel.json, 07:00 UTC)
- `zenbookPinger`: A — Bearer $CRON_SECRET
- `zenbookRecorder`: D — cronCaller() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET` (the Zenbook) or `Bearer $CRON_SECRET_EXT` (cron-job.org), timing-safe, an unset secret matching nobody; a cookie is not a secret; a Spotify bearer is not the secret → 401
- `cronjobOrg`: A — Bearer $CRON_SECRET_EXT → the tick; the reply is a bare {"ok":true}, never the outcome or the owner alarm (PLAN §7.2 step 0) [F10]

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

- File: `src/app/api/cron/daily/route.ts`. Gate today: `src/app/api/cron/daily/route.ts:52`.
- Does, when allowed: the daily chores: recompute all-time totals, rebuild the Home payload, prune api_log and client_metrics, the played_at check, the usage check.
- Calls (from the source): via `cronAuthorized`, `runUsageCheck`.
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
- Calls (from the source): store `benchStore`; via `cronAuthorized`.
- `anon`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; no header → 401
- `rem`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; Rem's cookie → 401
- `friendA`, `friendB`, `revoked`, `staleSecret`, `staleLogout`, `forged`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; a cookie → 401
- `vercelCron`, `zenbookPinger`: A — Bearer $CRON_SECRET
- `zenbookRecorder`: D — cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret; a Spotify bearer is not the secret → 401
- `cronjobOrg`: D — CRON_SECRET_EXT is unknown to cronAuthorized() → 401; PLAN §5.5 keeps it out of every cron route but sync and health [F7]

### GET /api/auth/session

- File: `src/app/api/auth/[...nextauth]/route.ts`. Gate today: `src/lib/auth.ts:444`.
- Does, when allowed: answers the cookie's own session (name, email, expiry, error; never a token) and re-issues the cookie with a fresh 30 days.
- Calls (from the source): via `Auth.js`.
- `anon`: D — no cookie → null
- `rem`: A — the cookie decodes; the session callback copies only `error` (tokens stay off the session, SECURITY.md)
- `friendA`, `friendB`: I — answers the cookie's own claims only; no identity check (F1), harmless here [F1]
- `revoked`: D ←a P1 — none: a revoked friend's cookie still gets its session (F1) [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D ←a P4a — none: the copied cookie still decodes and is re-issued with a fresh 30 days (F3) [F3]

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

- File: `src/app/api/auth/[...nextauth]/route.ts`. Gate today: `src/lib/auth.ts:346`.
- Does, when allowed: finishes OAuth: exchanges the code, reads /v1/me uncached-by-design, runs signIn (owner only), writes the token row, sets the session cookie.
- Calls (from the source): via `Auth.js`.
- `anon`: D — a stranger off the dev-mode allowlist: /v1/me 403 → /login?error=SpotifyNotRegistered, nothing written
- `rem`: A — SPOTIFY_OWNER_ID matches → the token row is written and a cookie set
- `friendA`, `friendB`: I — owner-only signIn (src/lib/owner.ts) → AccessDenied before the token write; from P4a an invite claim gives them their own uid and row
- `revoked`: D — owner-only signIn → AccessDenied; from P2 a disabled row is refused with 'ask Rem'
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

- File: `src/app/(app)/actions.ts`. Gate today: none (public).
- Does, when allowed: deletes the global Spotify token row (after the response) and this browser's cookie.
- Calls (from the source): store `clearSpotifyTokens (w)`; via `signOut`.
- `anon`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `forged`: D ←A P1 — none: no session check before the token row is cleared (F4) [F4]
- `rem`: A — the owner signing out (today: clears the one token row, which stops capture)
- `friendA`, `friendB`: I ←A P1 — none: no session check before the token row is cleared (F4) [F4]
- `staleLogout`: D — nothing left to clear: the token row is already gone; still no session check (F4) [F4]

### action mergeAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: creates a playlist from several on Rem's account; records it in playlists.
- Calls (from the source): store `getMeId`, `upsertStoredPlaylist (w)`; Spotify `mergePlaylists`; via `getSpotify`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action saveQueueAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: reads Rem's queue and saves it as a new playlist; records it.
- Calls (from the source): store `getMeId`, `upsertStoredPlaylist (w)`; Spotify `saveQueue`; via `getSpotify`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action subtractPreviewAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: reads cached (or live) tracks of the named playlists; returns the set difference.
- Calls (from the source): store `getPlaylistTracks`, `storePlaylistTracks (w)`; Spotify `playlistTracks`; via `getSpotify`, `intersect`, `keyOf`, `subtract`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action saveCompareDiffAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: creates a playlist on Rem's account from the given uris; records it.
- Calls (from the source): store `getMeId`, `upsertStoredPlaylist (w)`; Spotify `createFromUris`; via `getSpotify`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action addToQueueAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: adds a track to Rem's playback queue.
- Calls (from the source): Spotify `addToQueue`; via `getSpotify`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action playTrackAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: starts a track on Rem's active device.
- Calls (from the source): Spotify `playTracks`; via `getSpotify`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action playFromPlaylistAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: starts a playlist at a track on Rem's device.
- Calls (from the source): Spotify `playContext`; via `getSpotify`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action playPlaylistAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: starts a playlist on Rem's device.
- Calls (from the source): Spotify `playContext`; via `getSpotify`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action saveToLikedAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: saves a track to Rem's Liked Songs.
- Calls (from the source): Spotify `saveTrack`; via `getSpotify`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action removeFromPlaylistAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: removes a track from one of Rem's playlists; rewrites the cached copy.
- Calls (from the source): store `getPlaylistSnapshot`, `getPlaylistTrackOrder`, `removeCachedPlaylistTrack (w)`, `storePlaylistTracks (w)`; Spotify `playlist`, `playlistTracks`, `removeFromPlaylist`, `addItemsAt`; via `getSpotify`, `reinsertPositions`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action playerSetPlayingAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: pauses or resumes Rem's playback.
- Calls (from the source): Spotify `resumePlayback`, `pausePlayback`; via `getSpotify`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action playPlaylistTrackAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: plays a track within a playlist on Rem's device.
- Calls (from the source): Spotify `playContext`; via `getSpotify`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action resumePlaylistAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/lib/session.ts:14`.
- Does, when allowed: reads the playlist's cached order and Rem's plays in it; starts playback after the last one.
- Calls (from the source): store `getPlaylistTrackOrder`, `playedTracksInContext`, `storePlaylistTracks (w)`; Spotify `playlistTracks`, `playContext`; via `getSpotify`.
- `anon`: D — getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action startCleanAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:120`.
- Does, when allowed: dedupes a playlist into a new one on Rem's account (and a backup); takes a clean:<id> lock; a background reconcile task.
- Calls (from the source): store `acquireLock (w)`, `releaseLock (w)`, `getCleanBackupPref`, `getMeId`, `upsertStoredPlaylist (w)`; via `getValidAccessToken`, `spotifyAccessToken`, `getSpotify`, `spotifyClient`, `runTask`, `taskDone`, `cleanPhase1`, `reconcileClean`.
- `anon`: D — auth() null → { ok: false, 'Not authenticated' } before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action deletePlaylistAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:120`.
- Does, when allowed: unfollows a playlist on Rem's account and deletes it from the store.
- Calls (from the source): store `deletePlaylistFromDb (w)`; Spotify `deletePlaylist`; via `getValidAccessToken`, `spotifyAccessToken`, `getSpotify`, `spotifyClient`, `runTask`, `taskDone`, `syncLibrary`.
- `anon`: D — auth() null → { ok: false, 'Not authenticated' } before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action trackMenuAction

- File: `src/app/(app)/actions.ts`. Gate today: `src/app/(app)/actions.ts:370`.
- Does, when allowed: looks a track up by name and artist in Rem's library, with the playlists that hold it.
- Calls (from the source): store `findTrackWithPlaylists`; via `getSpotify`.
- `anon`: D — auth() null → { ok: false, 'Not signed in.' } before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### action dockDataAction

- File: `src/app/(app)/history-actions.ts`. Gate today: `src/app/(app)/history-actions.ts:30`.
- Does, when allowed: reads every stored playlist, me_id, the clean-backup preference and the sync stamp.
- Calls (from the source): store `getCleanBackupPref`, `getMeId`, `getPlaylistsSyncedAt`, `getStoredPlaylists`.
- `anon`: D — allowed(): auth() null → an empty answer before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D ←A P1 — none: this gate checks only that a session exists (F2) [F2]

### action dayTracksAction

- File: `src/app/(app)/history-actions.ts`. Gate today: `src/app/(app)/history-actions.ts:30`.
- Does, when allowed: reads one day's plays.
- Calls (from the source): store `getPlaysByDay`; via `tzOffsetMinutes`.
- `anon`: D — allowed(): auth() null → an empty answer before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D ←A P1 — none: this gate checks only that a session exists (F2) [F2]

### action dailyStatsAction

- File: `src/app/(app)/history-actions.ts`. Gate today: `src/app/(app)/history-actions.ts:30`.
- Does, when allowed: reads per-day play counts for up to 100,000 days.
- Calls (from the source): store `getDailyStats`; via `tzOffsetMinutes`.
- `anon`: D — allowed(): auth() null → an empty answer before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D ←A P1 — none: this gate checks only that a session exists (F2) [F2]

### action allTimePlaysAction

- File: `src/app/(app)/history-actions.ts`. Gate today: `src/app/(app)/history-actions.ts:30`.
- Does, when allowed: reads the 300 most-played tracks.
- Calls (from the source): store `getAllTimePlays`.
- `anon`: D — allowed(): auth() null → an empty answer before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D ←A P1 — none: this gate checks only that a session exists (F2) [F2]

### action searchPlaysAction

- File: `src/app/(app)/history-actions.ts`. Gate today: `src/app/(app)/history-actions.ts:30`.
- Does, when allowed: LIKE-searches every play by name or artist.
- Calls (from the source): store `searchHistory`.
- `anon`: D — allowed(): auth() null → an empty answer before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D ←A P1 — none: this gate checks only that a session exists (F2) [F2]

### action refreshHistoryAction

- File: `src/app/(app)/history-actions.ts`. Gate today: `src/app/(app)/history-actions.ts:30`.
- Does, when allowed: harvests recently-played with Rem's grant, then re-reads the strip, all-time totals and the visible day.
- Calls (from the source): store `getAllTimePlays`, `getAllTimeStats`, `getDailyStats`, `getPlaysByDay`, `ledgerSyncCall (w)`, `searchHistory`; via `getSpotify`, `syncRecentPlays`, `tzOffsetMinutes`.
- `anon`: D — allowed(): auth() null → NO_REFRESH before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — allowed() passes, then getSpotify() finds no token and redirects to /login before any read

### page /home

- File: `src/app/(app)/home/page.tsx`. Gate today: `src/app/(app)/home/page.tsx:86`.
- Does, when allowed: renders the day strip, all-time card and the opening day's rows from the Home payload.
- Calls (from the source): store `getAllTimeStats`, `getCaptureHealth`, `getDailyStats`, `getHomePayload`, `getPlaysByDay`, `getSpotifyCooldownUntil`, `rebuildHomePayload (w)`; via `tzOffsetMinutes`.
- `anon`: D — auth() null → redirect('/login'); nothing ships, but three store reads run first (F8) [F8]
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### page /playlists

- File: `src/app/(app)/playlists/page.tsx`. Gate today: `src/app/(app)/playlists/page.tsx:21`.
- Does, when allowed: renders every stored playlist and the unique-song count.
- Calls (from the source): store `getStoredPlaylists`, `getMeId`, `getPlaylistsSyncedAt`, `getUniqueSongCount`.
- `anon`: D — auth() null → redirect('/login') before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### page /playlists/[id]

- File: `src/app/(app)/playlists/[id]/page.tsx`. Gate today: `src/app/(app)/playlists/[id]/page.tsx:34`.
- Does, when allowed: renders one playlist's cached tracks; a cold playlist is fetched with Rem's grant and cached.
- Calls (from the source): store `getMeId`, `getPlaylistSnapshot`, `getPlaylistTracks`, `getStoredPlaylist`, `storePlaylistTracks (w)`; Spotify `playlist`, `playlistTracks`; via `getSpotify`, `duplicatePositions`, `formatListenTime`.
- `anon`: D — auth() null → redirect('/login') before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### page /usage

- File: `src/app/(app)/usage/page.tsx`. Gate today: `src/app/(app)/usage/page.tsx:252`.
- Does, when allowed: renders the operator's page: per-page timings, the rows-read ledger, the Spotify call breakdown, capture health.
- Calls (from the source): store `getCaptureHealth`; via `captureHealthMessage`, `tzOffsetMinutes`.
- `anon`: D — auth() null → redirect('/login') before any read
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: D ←A P1 — none: no admin rule (F5); any session is the owner (F1) [F5]
- `revoked`: D ←A P1 — none: no per-request identity (F1), so the cookie is served Rem's store and grant [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### page /friends

- File: `src/app/(app)/friends/page.tsx`. Gate today: none (public).
- Does, when allowed: a constant placeholder; no data, no session read (prerendered).
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — a constant with no data (page comment); reached through the (app) layout, which redirects a missing session

### layout (app)

- File: `src/app/(app)/layout.tsx`. Gate today: `src/app/(app)/layout.tsx:49`.
- Does, when allowed: renders the chrome with the session's name and image; not a gate for its pages (SECURITY.md).
- `anon`: D — auth() null → redirect('/login')
- `rem`: A — the owner's session: today every session is the owner's
- `friendA`, `friendB`: I — renders the cookie's own name and image; no identity check (F1), no store read [F1]
- `revoked`: D ←a P1 — none: renders the chrome for a revoked friend's cookie (F1) [F1]
- `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`: D — carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted
- `staleSecret`, `forged`: D — the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)
- `staleLogout`: D — the token row is gone, so the jwt callback sets session.error and this gate refuses it

### page /

- File: `src/app/page.tsx`. Gate today: none (public).
- Does, when allowed: redirects to /home.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: a redirect, no read

### page /login

- File: `src/app/(auth)/login/page.tsx`. Gate today: none (public).
- Does, when allowed: the sign-in button; a live session is sent on to /home.
- Calls (from the source): via `loginErrorMessage`.
- `anon`, `rem`, `friendA`, `friendB`, `revoked`, `vercelCron`, `zenbookPinger`, `zenbookRecorder`, `cronjobOrg`, `staleSecret`, `staleLogout`, `forged`: A — public: the sign-in page

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

- **F1. Any cookie signed with AUTH_SECRET is served as the owner.** The session never names its user (auth.ts's jwt callback reads the one global token row for every cookie), so a friend's, a revoked friend's, or any other validly signed cookie reaches Rem's store and Rem's Spotify grant on every user entry point. Today only the owner-only signIn callback (src/lib/owner.ts) and AUTH_SECRET's secrecy stand in front of it. Owner: P1: the uid on the session, its identity check and requireUser (lane 12); P2: status and session_epoch from the identity read (lane 15). (104 cells: GET /api/now-playing; POST /api/sync; POST /api/metrics; GET /api/search/library; GET /api/search/history; GET /api/tasks/[id]; POST /api/playlists/[id]/tracks; POST /api/playlists/sync; GET /api/auth/session; action mergeAction; action saveQueueAction; action subtractPreviewAction; action saveCompareDiffAction; action addToQueueAction; action playTrackAction; action playFromPlaylistAction; action playPlaylistAction; action saveToLikedAction; action removeFromPlaylistAction; action playerSetPlayingAction; action playPlaylistTrackAction; action resumePlaylistAction; action startCleanAction; action deletePlaylistAction; action trackMenuAction; action dockDataAction; action dayTracksAction; action dailyStatsAction; action allTimePlaysAction; action searchPlaysAction; action refreshHistoryAction; page /home; page /playlists; page /playlists/[id]; page /usage; layout (app))
- **F2. A session whose Spotify grant is gone still reads the whole library and history.** The two search routes, the six history actions, /api/metrics and /api/tasks/[id] check only that a session exists (!!auth()). Once the token row is gone (Log out, or invalid_grant) the session carries `error` and every page refuses it, but these keep serving Rem's data to it, including a cookie copied before Log out. PLAN §5.4 says requireUser applies the pages' rule to them; mu/phase1's gateFromSession allows an errored session (canCallSpotify: false), which would keep serving it. Owner: P1 (lane 12): requireUser applying PLAN §5.4's rule; P4a (lane 19): Log out bumps session_epoch. (9 cells: POST /api/metrics; GET /api/search/library; GET /api/search/history; GET /api/tasks/[id]; action dockDataAction; action dayTracksAction; action dailyStatsAction; action allTimePlaysAction; action searchPlaysAction)
- **F3. Log out does not end a cookie.** logout deletes the browser's cookie and the global token row, but the JWE stays valid for its 30 days, and GET /api/auth/session re-issues it with a fresh 30 days on every read. A copy left on a shared computer is refused only while the token row is absent: the next sign-in anywhere brings it back to full access. Owner: P1: auth_time's 30-day bound (lane 12); P4a: Log out bumps session_epoch (lane 19). (1 cells: GET /api/auth/session)
- **F4. logout runs with no session check.** The logout server action clears the global Spotify token row in after() whoever posts it: no cookie, a forged or stale cookie, a friend. Anyone who can post the action stops closed-app capture until Rem signs in again (the cron then answers 503 'no token'), and plays past Spotify's last 50 are lost. Owner: P1 (lane 12, item 6: every action onto requireActionUser, logout included). (11 cells: action logout)
- **F5. /usage has no admin rule.** Any session sees the operator's page: the rows-read ledger, per-page client timings and the Spotify call breakdown with raw paths. PLAN §6.2 layer 7 says both 'require is_admin' and 'for any user but the admin, aggregated'; lane 12's brief says admin-only, which this map takes. Owner: P1 (lane 12, item 6). (2 cells: page /usage)
- **F6. Search payloads carry no user: ETags without a uid, bodies revalidated from the HTTP cache.** The library and history ETags are "lib-<shape>-<version>-<day>" with per-store counters that collide across users, the bodies are `private, max-age=0, must-revalidate` (kept in the HTTP cache after sign-out) and carry no `u`, and the cached reads behind them key on the version alone. Owner: P1 (lane 12, items 3-4; PLAN §6.2 layers 4 and 6). (pinned by the red-team checks below)
- **F7. One cron check for every cron route, and CRON_SECRET_EXT about to join it.** Until the store split, /api/cron/sync ran the daily chores for any CRON_SECRET holder who sent x-vercel-cron; origin/main moved them to /api/cron/daily (75aea82), so that header opens nothing now (the red team pins it). What is left: all four cron routes share cronAuthorized() in src/lib/cron-auth.ts. Lane 07's brief takes mu/phase1's src/lib/cron-auth.ts byte for byte, a different file under the same name (cronCaller, no cronAuthorized): taken whole it removes the export four routes import; folded into cronAuthorized it opens /api/cron/daily, /api/cron/store-bench and /api/cron/usage-check to cron-job.org's secret, which PLAN §5.5 forbids (EXT opens /api/cron/sync and /api/cron/health only). Today the rule is explicit (EXT is unknown to every route); the cronjobOrg cells of those three routes are the tripwire. Owner: L07 (lane 07, done on mu/pinger: cronAuthorized stays CRON_SECRET-only, cronCaller beside it opens /api/cron/sync alone); P1 (lane 12's rebase meets the same add/add on cron-auth.ts). (3 cells: GET /api/cron/usage-check; GET /api/cron/daily; GET /api/cron/store-bench)
- **F8. /home reads Rem's store before its gate.** home/page.tsx runs getHomePayload, the cooldown and capture health in one Promise.all with auth(): an anonymous request pays three store reads before the redirect (nothing ships; the cost lands on the shared store budget). Owner: P1 (lane 12, item 6: Home's first wave behind the gate). (1 cells: page /home)
- **F9. Phase 1's claims are not checked: a cookie never expires by age.** auth_time is not read, so a 31-day-old sign-in is still a session as long as the cookie keeps being renewed (F3). PLAN §5.4 bounds a session to 30 days from its sign-in. Owner: P1 (lane 12: the identity check reads auth_time). (pinned by the red-team checks below)
- **F10. The cron's owner alarm and per-user outcome would go to cron-job.org.** /api/cron/sync answers its outcome (added counts, the 503 'no token' alarm) to whoever holds a secret. PLAN §7.2 step 0: cron-job.org gets a bare {"ok":true}, since it keeps response bodies and disables a job after a run of failures. Owner: L07 (lane 07, item 2, done on mu/pinger: the owner alarm and the outcome answer the Zenbook's CRON_SECRET only, cron-job.org gets a bare {"ok":true}). (1 cells: GET /api/cron/sync)
- **F11. Background tasks have no owner.** /api/tasks/[id] answers any session the task's full record, result included; only the random id stands in the way. Owner: P1 (mu/phase1 built getTaskFor; lane 12 carries it). (2 cells: GET /api/tasks/[id])

## 5. Red team (`tests/isolation/authz-redteam.test.ts`)

Every friend cell in the matrix already passes Rem's own identifiers (his playlist id `rem-pl-1`, his task id, his history day), so another user's ids in every call are covered there. These checks take what the matrix does not reach:

- [P1] the library ETag a friend gets equals Rem's (no uid in it), so a shared browser would 304 onto Rem's body
- [P1] neither search ETag carries the uid
- [P1] search bodies are revalidated from the HTTP cache instead of `private, no-store`, and carry no `u`
- [P1] the cached reads behind the search payloads and Home key on version and shape, never the user
- [P1] a friend's cookie with Rem's token expired makes the session read refresh Rem's grant
- [P4a] Rem's cookie copied before Log out works fully again once Rem signs in elsewhere (F3)
- [P1] a 31-day-old sign-in (auth_time) still reads the library (F9)
- [holds] GET /api/auth/session re-issues a replayed cookie with a fresh expiry (F3)
- [holds] an expired cookie, a truncated one, garbage and an unsigned JWT are no session
- [holds] a session cookie, or Rem's Spotify token, presented as the cron bearer is refused
- [holds] a sign-in's callbackUrl to another origin lands on this origin
- [holds] a friend's completed sign-in leaves Rem's token row byte for byte
- [holds] every malformed or misplaced secret is refused
- [holds] an unset or empty CRON_SECRET matches nobody, not even an empty bearer
- [holds] x-vercel-cron opens nothing on /api/cron/sync: the chores run only on /api/cron/daily (F7, fixed by 75aea82)
- [holds] CRON_SECRET_EXT opens none of the daily, bench and usage routes, nor the chores by header (tripwire for lane 07, F7)
- [holds] cron-job.org's secret opens /api/cron/sync, and its reply is a bare {"ok":true} (F10, lane 07)
- [holds] the Zenbook pinger still gets the 503 owner alarm when no token is stored
- [holds] searchPlaysAction takes LIKE wildcards and quotes as text, and refuses an anonymous caller
- [P4a] dailyStatsAction accepts any width up to 100,000 days (PLAN §6.6)
- [P1] an anonymous /home sends store statements before its redirect (F8)
- [holds] every other gated page and route sends no statement for an anonymous caller

## 6. What waits on which phase

- **P1**: 123 cells and 7 red-team checks.
  - GET /api/now-playing: friendA, friendB, revoked
  - POST /api/sync: friendA, friendB, revoked
  - POST /api/metrics: friendA, friendB, revoked, staleLogout
  - GET /api/search/library: friendA, friendB, revoked, staleLogout
  - GET /api/search/history: friendA, friendB, revoked, staleLogout
  - GET /api/tasks/[id]: friendA, friendB, revoked, staleLogout
  - POST /api/playlists/[id]/tracks: friendA, friendB, revoked
  - POST /api/playlists/sync: friendA, friendB, revoked
  - GET /api/auth/session: revoked
  - action logout: anon, friendA, friendB, revoked, vercelCron, zenbookPinger, zenbookRecorder, cronjobOrg, staleSecret, forged
  - action mergeAction: friendA, friendB, revoked
  - action saveQueueAction: friendA, friendB, revoked
  - action subtractPreviewAction: friendA, friendB, revoked
  - action saveCompareDiffAction: friendA, friendB, revoked
  - action addToQueueAction: friendA, friendB, revoked
  - action playTrackAction: friendA, friendB, revoked
  - action playFromPlaylistAction: friendA, friendB, revoked
  - action playPlaylistAction: friendA, friendB, revoked
  - action saveToLikedAction: friendA, friendB, revoked
  - action removeFromPlaylistAction: friendA, friendB, revoked
  - action playerSetPlayingAction: friendA, friendB, revoked
  - action playPlaylistTrackAction: friendA, friendB, revoked
  - action resumePlaylistAction: friendA, friendB, revoked
  - action startCleanAction: friendA, friendB, revoked
  - action deletePlaylistAction: friendA, friendB, revoked
  - action trackMenuAction: friendA, friendB, revoked
  - action dockDataAction: friendA, friendB, revoked, staleLogout
  - action dayTracksAction: friendA, friendB, revoked, staleLogout
  - action dailyStatsAction: friendA, friendB, revoked, staleLogout
  - action allTimePlaysAction: friendA, friendB, revoked, staleLogout
  - action searchPlaysAction: friendA, friendB, revoked, staleLogout
  - action refreshHistoryAction: friendA, friendB, revoked
  - page /home: friendA, friendB, revoked
  - page /playlists: friendA, friendB, revoked
  - page /playlists/[id]: friendA, friendB, revoked
  - page /usage: friendA, friendB, revoked
  - layout (app): revoked
  - red team: the library ETag a friend gets equals Rem's (no uid in it), so a shared browser would 304 onto Rem's body
  - red team: neither search ETag carries the uid
  - red team: search bodies are revalidated from the HTTP cache instead of `private, no-store`, and carry no `u`
  - red team: the cached reads behind the search payloads and Home key on version and shape, never the user
  - red team: a friend's cookie with Rem's token expired makes the session read refresh Rem's grant
  - red team: a 31-day-old sign-in (auth_time) still reads the library (F9)
  - red team: an anonymous /home sends store statements before its redirect (F8)
- **P4a**: 1 cells and 2 red-team checks.
  - GET /api/auth/session: staleLogout
  - red team: Rem's cookie copied before Log out works fully again once Rem signs in elsewhere (F3)
  - red team: dailyStatsAction accepts any width up to 100,000 days (PLAN §6.6)
