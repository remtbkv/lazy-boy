# 01b — The request surface: entry points, gates, caches, and where users would mix

Lane 0221_lb_mu_ov_surface, Oct 14, 2026. Planning only: nothing here changed code, data, the Zenbook
store or Vercel. Line numbers are against commit `1c7aabb` (no file under `src/` changed between it
and `90e912f`, checked with `git diff --stat 1c7aabb HEAD -- src`). Every claim cites `file:line`
or a doc section; every number says how it was measured. Section 9 lists every command I ran.

Status: outline. Sections fill in order and are committed as each lands.

## 0. Summary

## 1. How a request learns who the user is today

It doesn't. A request learns *that* someone is signed in, then acts on the one account whose tokens
sit in the store. Three facts make that so.

### 1.1 The session cookie carries no Spotify id

The session is an Auth.js v5 JWT in a cookie, 30-day `maxAge` (`src/lib/auth.ts:300-303`), with no
database adapter. Without an adapter, Auth.js mints the user's id as a fresh random UUID at every
sign-in rather than taking the provider's id: `@auth/core` 0.41.2 (the version in
`package-lock.json:53-54`), `lib/actions/callback/oauth/callback.js:224` sets
`id: crypto.randomUUID()`, and `lib/actions/callback/index.js:72-77` copies it into the token as
`sub`. The Spotify id exists in that same step as `account.providerAccountId`
(`callback.js:233`), but the app's `jwt` callback never stores it: on sign-in it writes the tokens to
the store and deletes them from the cookie (`auth.ts:352-377`), and nothing else is added. The
`session` callback exposes `error` only (`auth.ts:444-452`; the type at
`src/types/next-auth.d.ts:10-13`). So the cookie holds `name`, `email`, `picture`, a random `sub`,
and sometimes `error`. Nothing on the server or in the browser can say which Spotify account a
session belongs to.

### 1.2 Every Spotify call uses the one global token row

All four token paths read the same row, `meta.spotify_tokens` (`spotify_tokens_dev` outside
production; the key is chosen at `src/lib/db.ts:2511-2512`, read at `db.ts:2518-2526`):

| path | where | used by |
|---|---|---|
| `getSpotify()` → `spotifyAccessToken()` → `readTokensShared()` → `getSpotifyTokens()` | `src/lib/session.ts:13-18`, `auth.ts:270-272`, `auth.ts:74-78` | every page, action and route that calls Spotify for the signed-in user |
| `getValidAccessToken()` | `auth.ts:278-289` | `/api/cron/sync`, `startLibrarySync`, and through `refreshingToken()` (`src/app/(app)/actions.ts:46-57`) the clean and delete actions |
| the `jwt` callback's refresh | `auth.ts:379-441` | every `auth()` call |
| sign-in's write | `auth.ts:352-362` → `setSpotifyTokens` (`db.ts:2514-2516`) | every completed sign-in |

The last row is the incident that prompted this program: a second account's sign-in overwrote the
owner's row, and from then on every request, including the owner's, ran as the second account
(commit `044c9b6`'s message).

### 1.3 Every store read is unscoped

No table has a user column (`db.ts:158-243`, the schema), and no exported read in `db.ts` takes a
user argument. The single-user assumptions sit in three places a request touches: global `meta` keys
(`me_id`, `home_payload`, `user_tz_offset`, `last_sync`, the version markers, the token row), global
tables (`plays`, `tracks`, `playlists`, `playlist_tracks`, `saved_tracks`, `contexts`), and a fixed
home zone, `America/New_York`, for payloads built on the write path (`db.ts:1265-1270`). The full
census of tables and keys is 01a's; this file follows them only where a request or a cache meets
them.

### 1.4 What that means right now: any valid session is the owner

The `jwt` callback trusts any cookie that decrypts with `AUTH_SECRET`. For a returning session it
reads the global row and, if the token is fresh, clears `error` and returns (`auth.ts:379-414`); it
never compares the session's person with the token's owner. The owner-only guard runs only in the
`signIn` callback (`auth.ts:344-347`), which a returning session never passes through. So the
browser that completed the second account's sign-in before the guard deployed (8:41 PM) holds a
cookie that today resolves to the owner's token: that browser sees the owner's history and library,
and its clicks drive the owner's Spotify (playback, playlist creation, removal). It shows the second
account's own name and avatar in the header (`src/app/(app)/layout.tsx:51-52` reads them from the
cookie), over the owner's data.

`vercel env ls` (read-only, section 9) lists `AUTH_SECRET` as created 133 days ago in Production and
Preview. The listing shows creation age only, so a rotation since then is unlikely but not proven
from it. Rotating `AUTH_SECRET` is the immediate fix; section 6, item E1, has the options.

## 2. Entry-point inventory

Eight pages, 24 server actions and 12 route files (`find src/app -type f`, section 9). The last
column says what each does with two signed-in users as the code stands, in four labels:

- **reads-other**: returns stored data that may belong to the other user;
- **acts-as-other**: calls Spotify with the other user's token, reading or changing their account;
- **writes-shared**: writes rows or cache entries that every user reads;
- **ok**: nothing user-specific.

### 2.1 Pages

The `(app)` layout calls `auth()` and redirects (`src/app/(app)/layout.tsx:48-49`), but that is
chrome, not a gate: Next renders a layout and its page in parallel (`docs/SECURITY.md` "Every page
that reads personal data gates for ITSELF"). The layout also mounts the pollers every page carries:
`NowPlayingProvider` (`/api/now-playing`), `SyncOnLoad` (`/api/sync`), `CleanProgressWatcher`
(`/api/tasks/[id]`), `MetricsCollector` (`/api/metrics`) and `TimezoneCookie` (`layout.tsx:56-68`).

| route | file:line | gate | reads and writes | two users |
|---|---|---|---|---|
| `/` | `src/app/page.tsx:3-5` | none needed | redirects to `/home` | ok |
| `/login` | `src/app/(auth)/login/page.tsx:12-13` | inverse: a live session goes to `/home` | error text (`src/lib/login-error.ts:3-15`, which says "single-user for now") | ok; the copy changes |
| `/home` | `src/app/(app)/home/page.tsx:78-88` | `auth()` + `!session.error`, inside the same `Promise.all` as three reads (78-83), so the reads run whatever the gate decides | `meta.home_payload` (`db.ts:1348-1357`), `spotify_cooldown_until` (`db.ts:2376-2379`), capture health (`db.ts:1738-1741`); with no payload, `readHomeInline` (56-67) runs the cached strip, all-time and day reads and fires `rebuildHomePayload()`. The client then loads the dock, both search payloads and the history actions | reads-other: every user gets the one payload row |
| `/playlists` | `src/app/(app)/playlists/page.tsx:20-28` | gate first | `getStoredPlaylists()` (cached, 3.1), `getMeId()`, `getUniqueSongCount()`, `getPlaylistsSyncedAt()`; `<PlaylistsSync>` may POST `/api/playlists/sync` | reads-other |
| `/playlists/[id]` | `src/app/(app)/playlists/[id]/page.tsx:33-46` | gate first | `getPlaylistTracks(id)`, `getPlaylistSnapshot(id)`, `getStoredPlaylist(id)`, `getMeId()`; with nothing cached, `getSpotify()` → `sp.playlist(id)` + `sp.playlistTracks(id)` → `storePlaylistTracks(id, …)` (152-194). `isMine` compares with the global `me_id` (92) | reads-other: any cached playlist by id, with no check that this viewer may see it; acts-as-other on the cold path; writes-shared |
| `/friends` | `src/app/(app)/friends/page.tsx:1-8,25-43` | none of its own; static, behind the layout's redirect | constant text | ok |
| `/usage` | `src/app/(app)/usage/page.tsx:244-254` | gate first | read ledger, Turso org usage (`TURSO_PLATFORM_TOKEN`), `client_metrics` (recent opens with times, verbatim error messages), `api_log` breakdowns, capture health | reads-other: operator telemetry covering everyone's activity |
| `/kbtest` | `src/app/kbtest/page.tsx:17-19` | 404 in production | dummy rows | ok |

### 2.2 Server actions

Every exported function of a `"use server"` module is a public POST endpoint, callable by anyone
holding its action id; the gate has to be inside each one. The id of an action ships in the client
bundle of whatever component imports it. Two actions have no caller in `src/` (`grep`, section 9);
Next 15+ leaves unused actions' ids out of the client bundle, which I did not verify against a build
here.

| action | file:line | gate | token | touches | two users |
|---|---|---|---|---|---|
| `login` | `actions.ts:60-62` | none (starts OAuth) | – | Auth.js sign-in | ok |
| `logout` | `actions.ts:63-69` | **none** | – | `clearSpotifyTokens()` after the response (`db.ts:2528-2531`), then `signOut` | writes-shared: deletes the only token row, so one person's sign-out stops capture for the account in it |
| `mergeAction` | `actions.ts:86-99` | `getSpotify` | global | creates a playlist; `recordNewPlaylist` (77-84) inserts it into `playlists` owned by the global `me_id` | acts-as-other, writes-shared |
| `startCleanAction` | `actions.ts:105-161` | `auth()` + `!error` + token present (119-122) | `refreshingToken()`: global | lock `clean:<playlistId>` (130), global backup pref (137), `cleanPhase1` over the stored library (`getLibraryTracks`, `db.ts:2286-2325`, owner filter from `me_id`), new playlists, a `clean-reconcile` task (147-152) | acts-as-other, reads-other, writes-shared |
| `playPlaylistAction` | `actions.ts:165-169` | `getSpotify` | global | player | acts-as-other; no caller |
| `deletePlaylistAction` | `actions.ts:175-206` | `auth()` + `!error` + token (179-182) | `refreshingToken()`: global | unfollows on Spotify (188), `deletePlaylistFromDb` (193; `db.ts:2188-2205`), maybe a library-sync task (197-200) | acts-as-other (destructive), writes-shared; no caller |
| `saveQueueAction` | `actions.ts:208-220` | `getSpotify` | global | reads the queue, creates a playlist, `recordNewPlaylist` | acts-as-other, writes-shared |
| `subtractPreviewAction` | `actions.ts:252-291` | `getSpotify` | global | `playlistTracksCached` (237-246): cached tracks by playlist id; on a miss a live fetch and a cache write | reads-other: any cached playlist by id |
| `saveCompareDiffAction` | `actions.ts:293-307` | `getSpotify` | global | creates a playlist, `recordNewPlaylist` | acts-as-other, writes-shared |
| `addToQueueAction`, `playTrackAction`, `playFromPlaylistAction` | `actions.ts:310-356` | `getSpotify` | global | player | acts-as-other |
| `trackMenuAction` | `actions.ts:360-391` | `auth()` + `!error` (369-370) | – | `findTrackWithPlaylists` (`db.ts:2432-2480`): a track row and the names of every stored playlist holding it | reads-other |
| `saveToLikedAction` | `actions.ts:393-408` | `getSpotify` | global | Liked Songs | acts-as-other |
| `removeFromPlaylistAction` | `actions.ts:410-473` | `getSpotify` | global | cached order (420), live playlist (430, 443), `storePlaylistTracks` (445), `removeCachedPlaylistTrack` (456, 465) | acts-as-other, writes-shared |
| `playerSetPlayingAction`, `playPlaylistTrackAction` | `actions.ts:526-541` | `getSpotify` via `playerControl` (509-524) | global | player | acts-as-other |
| `resumePlaylistAction` | `actions.ts:557-663` | `getSpotify` (566) | global | cached order and `playedTracksInContext` (`db.ts:2405-2425`: every stored play from that context) | reads-other: the resume point comes from every play in the store; acts-as-other |
| `dockDataAction` | `history-actions.ts:44-57` | `!!auth()` (29-31) | – | stored playlists, `me_id`, backup pref, synced-at | reads-other |
| `dayTracksAction` | `history-actions.ts:60-65` | `!!auth()`; day format checked | – | `getPlaysByDay` (cached) | reads-other |
| `dailyStatsAction` | `history-actions.ts:68-72` | `!!auth()`; `days` capped at 100,000 and otherwise client-chosen | – | `getDailyStats` (cached; each distinct `days` is a new cache key and a scan of that many days) | reads-other |
| `allTimePlaysAction` | `history-actions.ts:75-78` | `!!auth()` | – | `getAllTimePlays(300)` (cached) | reads-other |
| `refreshHistoryAction` | `history-actions.ts:119-182` | `!!auth()`, then `getSpotify` | global | `syncRecentPlays` (plays, contexts, the Home payload), then strip, all-time, newest plays, a day or the all-time list | acts-as-other, writes-shared, reads-other |
| `searchPlaysAction` | `history-actions.ts:190-195` | `!!auth()` | – | `searchHistory`, a `LIKE` over every play (`db.ts:884-904`) | reads-other |

### 2.3 API routes

| route | file:line | gate | touches | two users |
|---|---|---|---|---|
| `/api/auth/[...nextauth]` GET, POST | `src/app/api/auth/[...nextauth]/route.ts:16-22` | Auth.js; owner guard in `signIn` (`auth.ts:344-347`) | sign-in writes the global token row (`auth.ts:352-362`); `GET /api/auth/session` returns name, email, image, `expires`, `error` | writes-shared (sign-in) |
| `/api/build` GET | `src/app/api/build/route.ts:15-20` | public by design (`GOTCHAS.md` "Deployment skew + stale tabs") | the build id; no auth, no DB | ok |
| `/api/cron/sync` GET | `src/app/api/cron/sync/route.ts:60-66` | `Bearer $CRON_SECRET`, timing-safe, fail-closed | global token (96-112), global harvest gate (129-146), library rescan (30-42, 171); daily chores behind a header Vercel never sends (71-91) | captures one account only; responses carry counts, no personal data |
| `/api/cron/usage-check` GET | `src/app/api/cron/usage-check/route.ts:119-123` | `CRON_SECRET` | Turso org usage, ledger rows | ok (operator) |
| `/api/metrics` POST | `src/app/api/metrics/route.ts:16-17` | `!!auth()` | `client_metrics` rows: a client-chosen tab id, no user | writes-shared (telemetry `/usage` shows) |
| `/api/now-playing` GET | `src/app/api/now-playing/route.ts:18-28` | `auth()` + `!error` + token, else 200 `{playing:null}` | `currentlyPlaying()` with the global token; `contexts` read and write (36-55) | acts-as-other: the token owner's live playback |
| `/api/playlists/[id]/tracks` POST | `src/app/api/playlists/[id]/tracks/route.ts:10-16` | `auth()` + `!error` + token | live playlist with the global token, `storePlaylistTracks(id, …)` (29) | acts-as-other, writes-shared |
| `/api/playlists/sync` POST | `src/app/api/playlists/sync/route.ts:8-22` | none in the route; `startLibrarySync` checks `auth()` + `!error` + token (`src/lib/playlists-sync.ts:27-28`) | global cooldown (35), global freshness stamp (45-48), the instance's single running-sync id (22, 50-54), a global-token getter (61-65) | acts-as-other, writes-shared, and gives any caller the running task's id |
| `/api/search/history` GET | `src/app/api/search/history/route.ts:15-16` | `!!auth()` | the history payload (3.1, 3.2) | reads-other |
| `/api/search/library` GET | `src/app/api/search/library/route.ts:21-22` | `!!auth()` | the library payload | reads-other |
| `/api/sync` POST | `src/app/api/sync/route.ts:14-20` | `auth()` + `!error` + token | writes the global tz offset (24-27), global 60 s debounce on `last_sync` (28-31), `syncRecentPlays` with the global token (33) | acts-as-other, writes-shared |
| `/api/tasks/[id]` GET | `src/app/api/tasks/[id]/route.ts:9-15` | `!!auth()` | `getTask(id)`: any task in this instance's memory, no owner check | reads-other once an id leaks (3.4) |

### 2.4 Gate consistency

Three strengths of gate are in use, and they disagree about a session whose Spotify refresh died
(`session.error` set):

1. `auth()` + `!session.error` + a token: the four data pages, every `getSpotify()` caller, `/api/sync`,
   `/api/now-playing`, `/api/playlists/[id]/tracks`, `startLibrarySync`.
2. `!!auth()` only: all six history actions (`history-actions.ts:29-31`), both search routes,
   `/api/metrics`, `/api/tasks/[id]`. A dead-refresh session still reads everything stored.
3. None: `logout` (`actions.ts:63-69`), `login`, `/api/build`. The cron routes use the secret.

None of these checks *who*; all of them check *whether*. Multi-user needs one helper that every entry
point calls first and that returns the session's Spotify id or refuses (section 5, S2). Whether a
dead refresh token should block reading your own stored history is a product call; my
recommendation is to allow reads and block only Spotify calls, since the history is the user's and a
re-login fixes capture.

## 3. Caches and shared state, and whether each key separates users

### 3.1 Next's Data Cache (`unstable_cache`)
### 3.2 Version markers and ETags
### 3.3 Request-scoped boxes
### 3.4 Module and `globalThis` state (the task registry included)
### 3.5 Locks in `meta`
### 3.6 Browser-side state
### 3.7 Vercel-side surfaces: preview deployments, CDN

## 4. Entry points that would leak or mix data across users, as written

## 5. What the surface needs for multi-user

## 6. Exposures that exist today, single-user

## 7. What multi-user needs from STORE_MIGRATION.md

## 8. Unknowns and what I did not verify

## 9. What I ran
