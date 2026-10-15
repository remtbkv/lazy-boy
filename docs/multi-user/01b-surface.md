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

None of them does. Every cache below is keyed on content versions, days, offsets or ids, never on a
person.

### 3.1 Next's Data Cache (`unstable_cache`)

Seven entries, all in `src/lib/db.ts`. No entry carries `tags`, and nothing in `src/` calls
`revalidateTag` (`grep`, section 9).

| entry | defined | key parts | arguments (also in the key) | TTL | user in key |
|---|---|---|---|---|---|
| all-time list | `db.ts:983-994` | `["all-time-plays"]` | `limit`, slow marker | 3,600 s | no |
| day strip | `db.ts:1082-1090` | `["daily-stats"]` | `offsetMin`, `days`, `write_seq` | 3,600 s | no |
| one past day | `db.ts:1176-1180` | `["plays-by-day-frozen"]` | `day`, `offsetMin`, `write_seq` | 86,400 s | no |
| today, yesterday | `db.ts:1181-1191` | `["plays-by-day-live"]` | `day`, `offsetMin`, `write_seq` | 3,600 s | no |
| library payload | `db.ts:1600-1613` | `["library-index", "v1"]` | `library_seq`, shape | 86,400 s | no |
| history payload | `db.ts:1615-1623` | `["history-index", "v2"]` | slow marker, shape | 86,400 s | no |
| playlist grid | `db.ts:1906-1914` | `["stored-playlists"]` | `write_seq` | 3,600 s | no |

How the key is built matters for the fix. In Next 16.2.6 (`package.json` pins `next` 16.2.6;
`dist/server/web/spec-extension/unstable-cache.js:55` and `:82` in its npm tarball) the key is the
callback's source text, the key parts, then `JSON.stringify(args)`. A user id therefore separates
entries only when it is an argument or a key part. A wrapper that captures the id in a closure, such
as `unstable_cache(() => readPlaylists(userId), ["stored-playlists"])`, has the same source text for
every user and serves the first user's entry to all of them. A per-user version counter without the
id in the key fails the same way whenever two users' counters hold the same value, which small
integers do often.

Two more properties carry over. The Data Cache outlives a deploy (`GOTCHAS.md` "The Data Cache
OUTLIVES THE DEPLOY"), so adding the user to the keys must also move the shape tokens, or the first
multi-user deploy could be handed single-user entries. And with no tags, an entry built from a deleted
user's rows stays in the cache until its TTL runs out, up to 24 hours; purging on account deletion
needs a per-user tag and a `revalidateTag` call.

### 3.2 Version markers and ETags

The keys above move on three global counters in `meta`: `write_seq` (bumped by any write a cached
read serves, `db.ts:345-360`, read once per request at `db.ts:402-416`), `library_seq` (playlist and
Liked membership changes, `db.ts:374-383`) and the slow marker `slow_seq_pub` (a copy of `write_seq`
republished at most every 10 minutes, `db.ts:1550-1596`). With one counter for everyone, any user's
play moves every user's live keys and, within 10 minutes, every browser's history payload. That is a
cost that grows with the number of users, not a leak: hit rates fall and payloads re-download for
everyone after anyone listens. Per-user counters fix it, paired with the user id in every key
(3.1).

The two search routes turn the counters into ETags:

| route | ETag | headers | 304 when |
|---|---|---|---|
| `/api/search/library` | `"lib-v1-<library_seq>-<UTC day>"` (`route.ts:39`) | `private, max-age=0, must-revalidate` (42) | `If-None-Match` equals it (45-47) |
| `/api/search/history` | `"hist-v2-<slow marker>-<UTC day>"` (`route.ts:26`) | the same (29) | the same (31-33) |

Neither tag names the user, and neither response sends `Vary`. On a shared browser profile (A signs
out, B signs in) the HTTP cache still holds A's body under the same URL, and B's request revalidates
with A's tag. With per-user counters and no user in the tag, equal counter values on the same day
answer 304 and the browser shows A's library to B. `private` keeps CDNs out of it, not the browser.
The tag needs an opaque per-user component.

### 3.3 Request-scoped boxes

Three React `cache()` boxes take no arguments: the token box (`auth.ts:73-83`), the `write_seq` box
(`db.ts:402-416`) and the ordered-plays scan (`db.ts:854-869`). They are safe while one request serves
one user, which holds for every page, action and route above. A cron fan-out that handled several
users inside one React request scope would hand the first user's box to the rest. The code's own
comment says `cache()` is a pass-through outside a React request (`auth.ts:68-69`), which would cover
a route handler, but I did not verify that for Next 16. The safe rule is to give every box the user
id as its argument.

### 3.4 Module and `globalThis` state (the task registry included)

Per-instance memory, shared by every request the instance serves (`GOTCHAS.md` "Per-instance server
state is invisible across serverless instances").

| state | where | two users, as written | needs |
|---|---|---|---|
| task store and running-promise maps | `src/lib/tasks/registry.ts:21-23`, `:70` | tasks have no owner (`registry.ts:9-18`); `/api/tasks/[id]` returns any id it finds (`route.ts:13-15`). Ids are `crypto.randomUUID()` (`registry.ts:27`), so the risk is an id that leaks, and two leak paths exist: `currentSyncId` below and the browser's `clean:active` (3.6) | an owner on each task, checked by the route; the cross-instance gap stays as ROADMAP Phase 3 describes |
| `currentSyncId` | `src/lib/playlists-sync.ts:22`, `:50-54`, `:69` | one library sync per instance for everyone: B's kick while A's sync runs returns A's task id, B polls A's progress, and B's own library never syncs | one entry per user, or a per-user DB lock in its place |
| `inflightRefresh` | `auth.ts:188-196` | `refreshShared(refreshToken)` ignores its argument while a refresh is in flight, so B awaits A's refresh and receives A's tokens | a map keyed by user |
| `playlistsCache` | `src/lib/spotify/resources.ts:76-81`, `:89-104` | one entry per instance for 60 s, deliberately not keyed ("this is a single-user app", 76-79). A library sync for B within 60 s of A's on the same instance reads A's playlist list and stores it as B's library under B's `me_id` (`src/lib/sync/library.ts:40-50`) | key by user, or delete it; its only callers are `myPlaylistsAll` and `myPlaylists` (`resources.ts:125-135`) |
| `cooldownUntil` and the persisted `spotify_cooldown_until` | `src/lib/spotify/client.ts:48`, `:157`, `:178`; `db.ts:2376-2392` | one user's 429 or ban holds back every user's calls | right only if Spotify's limit is per app; 01f owns that answer |
| `uniqueRecomputeKickedAt` | `db.ts:1960-1965` | one throttle for every user's unique-song recompute | per user |
| store client, `apiLogWrites` | `db.ts:133-146`, `:2601` | shared connection and a prune counter | ok |

### 3.5 Locks in `meta`

`lock:spotify_refresh` (`auth.ts:212`, `:221`) is one lease for everyone. Under per-user token rows it
would serialise every user's refresh behind one 30 s lease, and a loser would poll the global row
(`waitForFreshToken`, `auth.ts:244-252`) for a token that is not its own. It needs the user in its
name. `lock:clean:<playlistId>` (`actions.ts:130`, `:156`) is keyed by playlist only: two users
cleaning the same collaborative playlist would block each other for the Phase-1 window. No leak, but
`clean:<user>:<playlist>` is the right key.

### 3.6 Browser-side state

| key | where | stamped with | two people on one browser profile |
|---|---|---|---|
| `lb-days` (sessionStorage) | `src/app/(app)/home/den-home.tsx:325-362` | build id | in the same tab after A signs out, B sees A's stored past days until the build changes |
| `lb-nowplaying` (localStorage and a BroadcastChannel) | `src/components/now-playing-context.tsx:62-63`, `:240`, `:371-379`, `:407-415` | a 30 s age (`:70`) | a tab opened within 30 s of A's last poll paints A's song, which Home's play handoff can treat as live |
| `clean:active` (localStorage) | `src/lib/clean-progress.ts:5-27`, polled at `src/components/clean-progress.tsx:52-57` | nothing | B's watcher polls A's clean task, alive up to 10 min after it ends (`registry.ts:42`), and shows its result |
| HTTP cache of the search payloads | the two search routes | ETag | 3.2 |
| `lb-ring:<image>`, `lb:metrics-session`, `lb-build-reload-at`, `lb-perf` | `src/app/(app)/chrome.tsx:202-255`, `src/lib/metrics-client.ts:57-87`, `now-playing-context.tsx:75`, `src/lib/search-perf.ts:6-26` | – | harmless |

Sign-out clears none of them (`actions.ts:63-69`). The client Router Cache holds dynamic pages for
30 s (`next.config.ts:23-25`), but sign-in is a full navigation through accounts.spotify.com, so
nothing in it survives a change of user. The planned IndexedDB copy of the payloads joins this table
(section 7).

### 3.7 Vercel-side surfaces: preview deployments, CDN

No response that carries personal data can land in a shared cache: the data pages are dynamic
(`force-dynamic` on Home, Playlists and Usage; the detail page reads cookies through `auth()`), the
search payloads are `private`, and nothing in `src/` sets `public` or `s-maxage` (`grep`, section 9).
The Data Cache (3.1) is the only shared server-side cache.

Preview deployments are the wider surface. `vercel env ls` (section 9) shows `AUTH_SECRET`,
`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `AUTH_URL`
set for Production and Preview alike, and `docs/STORE_MIGRATION.md` §3 says "Preview deployments use
the production store." Vercel builds previews with `NODE_ENV=production`, so they also use the
production token key (`db.ts:2511-2512`). A preview of any pushed branch reads and writes production
data and refreshes the production token today; with many users it would do that for all of them.
Whether Vercel Deployment Protection gates preview URLs on this project I did not check.

## 4. Entry points that would leak or mix data across users, as written

## 5. What the surface needs for multi-user

## 6. Exposures that exist today, single-user

## 7. What multi-user needs from STORE_MIGRATION.md

## 8. Unknowns and what I did not verify

## 9. What I ran
