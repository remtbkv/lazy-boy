# 01e — Authentication and secrets: how it works today, and what multi-user must change

Lane 0221_lb_mu_ov_auth, Oct 14, 2026. Planning only: nothing here changed code, data, the Zenbook
store or Vercel. Line numbers are against commit `ac6f7fe`. Every number says how it was measured or
that it is an estimate.

Status: complete (sections 0-8).

## 0. Summary

**Today.** Auth.js v5 issues a JWT session cookie encrypted under `AUTH_SECRET` that lasts 30 days from
sign-in (the app's `auth()` calls never renew it), with no server-side session state and no stable
user id in it (§1.4). Sign-in is Spotify OAuth with
PKCE and the client secret (§1.1). The Spotify grant lives in one plaintext `meta` row that every
request reads and the cron uses (§2.1); refresh is coordinated by one in-process promise and a
`meta`-table lock (§2.3); the owner guard runs only at sign-in (§1.2). The refresh path has no tests
(§2.7).

**Live problems found** (all outside this lane's planning-only remit to fix):

- **F1.** Any browser that signed in before the guard, including the second account from Oct 14, still
  acts as the owner until about Nov 13: it reads the owner's history, edits the owner's playlists, and
  its log-out deletes the owner's token. `AUTH_SECRET` was created 133 days ago, so most likely nothing
  has ended those sessions. Rotating it ends them at the cost of one sign-in.
- **Production lacks `SPOTIFY_OWNER_ID`**, so the guard keys on the stored `me_id`. That value is
  correct right now (it matches the pre-incident owner by hash). Setting the variable removes the
  dependence on store state.
- **F2.** Spotify does not rotate this app's refresh tokens (unchanged across two weeks of hourly
  refreshes) and documents a six-month lifetime. Every copy of the token row therefore stays a live
  13-scope credential for up to six months after the sign-in that minted it: 14 nightly snapshots on
  the Zenbook, 60 days of them on OneDrive, the Mac's `data/replica.db` (which holds the recorder's
  current grant).
- **F3.** The backstop recorder's grant may age out by Feb 6, 2027, silently.

**What multi-user must change** (§5):

- Key users by Spotify's `account_id`; Spotify now says the `id` field may change and must not be used
  for linking.
- Put the id and a session epoch on the JWT and check both on every request, in the same single query
  that reads the tokens. Cookies without an id are refused.
- One encrypted token row per user. Every lock, in-flight refresh and request box is keyed by user.
  The in-process `inflightRefresh` is the change that would leak one user's Spotify token to another if
  missed (A2).
- AES-256-GCM, with the user id as associated data and the key held as a Vercel Secret. Vercel KMS
  only signs; AWS KMS is not worth an AWS dependency here.
- An app-side invite list. Development mode now caps new users at five (Feb 2026), so the program's
  25-user design target needs extended quota.
- Split log-out into sign out, sign out everywhere, and disconnect.
- Revocation or the six-month expiry (both `invalid_grant`) marks only that user `needs_reconnect`;
  the cron stops calling Spotify for them and nobody else is affected. The monthly re-sign-in already
  renews every active user's grant. A disconnect, explicit or a revocation, deletes the user's data
  within the Developer Terms' five days, backups included (§5.7, §5.8).

**STORE_MIGRATION** needs no change for auth before it runs (§6). Four small additions: strip token
rows from backups and the archive, delete the cutover's plaintext copies on the Mac, ship the user-id
claim before lane 1905, and take Preview off the production store before a second user exists.

## 1. Sign-in today, end to end

Library versions: `next-auth` 5.0.0-beta.31 and `@auth/core` 0.41.2 (`package-lock.json`). This
checkout has no `node_modules`, so library behaviour below was read from those two published
tarballs (`npm pack @auth/core@0.41.2 next-auth@5.0.0-beta.31`; the `.tgz` files are kept in
`~/.claude/broke/scratch/lazyboy_mu/authjs_src_0221/`); a citation like `@auth/core jwt.js:46` is a
path inside the extracted `package/` directory.

### 1.1 The provider

- One provider, Spotify (`src/lib/auth.ts:308-339`), with 13 scopes (`auth.ts:32-46`). Four are write
  scopes: `user-library-modify`, `playlist-modify-private`, `playlist-modify-public`,
  `user-modify-playback-state`. A stolen token edits playlists and drives playback.
- `show_dialog: "true"` (`auth.ts:322`) puts Spotify's consent screen in front of every sign-in, so
  every grant carries the full scope list.
- The callback URL is pinned to `${AUTH_URL}/api/auth/callback/spotify`, with `localhost` rewritten to
  `127.0.0.1`, in the authorize step (`auth.ts:26-29, 322`), the code exchange (`customFetch`,
  `auth.ts:329-338`) and Auth.js's own redirects (`src/app/api/auth/[...nextauth]/route.ts:8-14`).
- CSRF and code injection. Auth.js's default check is PKCE alone (`@auth/core
  lib/utils/providers.js:52`); `state` is added only behind a redirect proxy (`:53-56`). The
  `code_verifier` lives in an encrypted httpOnly SameSite=Lax cookie for 15 minutes
  (`lib/utils/cookie.js:77`), and a callback that arrives without it fails
  (`lib/actions/callback/oauth/checks.js:32`). RFC 9700 §2.1 permits exactly this: clients that "have
  ensured that the authorization server supports Proof Key for Code Exchange (PKCE) [RFC7636] MAY rely
  on the CSRF protection provided by PKCE". Sign-in starts from a server action (`login()`,
  `src/app/(app)/actions.ts:60-62`), which Next accepts only as a same-origin POST.
- The client is confidential: the code exchange and every refresh authenticate with
  `SPOTIFY_CLIENT_SECRET` (Basic auth, `auth.ts:99-113`).
- The profile read is ours: `spotifyUserinfo` (`src/lib/spotify/userinfo.ts:24-38`) fetches `/v1/me` so
  that a non-allowlisted account's plain-text 403 becomes the sentinel id `spotify-not-registered`. It
  maps every non-2xx to that sentinel, so a transient 429 or 5xx on `/me` would tell an allowlisted
  user they are not registered (read from the code, not observed).
- Auth.js discards the Spotify id as the user id. The provider maps `id ← profile.id`
  (`@auth/core providers/spotify.js:62-69`); `getUserAndAccount` then sets the user's id to
  `crypto.randomUUID()` and keeps the Spotify id only as `account.providerAccountId`
  (`lib/actions/callback/oauth/callback.js:216-235`). The session JWT's `sub` is that UUID
  (`lib/actions/callback/index.js:72-77`): a new value at every sign-in, tied to nothing.
- Spotify changed its guidance on identifiers this year. `/v1/me` now returns `account_id`, "A public,
  immutable, pseudoanonymous identifier for the user's account. Use this field for account linking
  rather than the id field, as it is stable and will not change over the lifetime of the account", and
  the `id` field reads "Do not use this field for account linking — use account_id instead, which is
  immutable" (https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile,
  fetched 2026-10-14; added in the May 2026 changelog). For development-mode apps `/v1/me` also no
  longer returns `country, email, explicit_content, followers, product`
  (https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), so the
  session's `email` is empty although `user-read-email` is requested. Both are from the docs; no lane
  holds a token to observe a live `/me` response.

### 1.2 The signIn callback and the owner guard

`signIn` (`auth.ts:344-347`) sends the not-registered sentinel to `/login?error=SpotifyNotRegistered`
and otherwise returns `isOwnerSignIn(profile.id)` (`src/lib/owner.ts:10-14`). The owner is
`SPOTIFY_OWNER_ID`, else the stored `me_id`; with neither, the first sign-in on an empty store passes.
A store error throws, and Auth.js turns a throw or `false` into AccessDenied
(`@auth/core lib/actions/callback/index.js:393-405`), which `/login` words as "single-user for now"
(`src/lib/login-error.ts:11-13`). Five cases pin the decision (`tests/owner-signin.test.ts`). Auth.js
runs it before the jwt callback, so a refused account never reaches the token write.

Its limits:

- It runs only at sign-in. A session minted before it shipped is untouched (F1, below).
- It keys on the Spotify `id`, the field Spotify now says not to link on. Rem's id will not plausibly
  change, so this matters for the multi-user key (§5.1), not as a bug today.
- The fallback, `me_id`, is rewritten by every library sync from whichever account's token is stored
  (`src/lib/db.ts:1804, 1817-1823`). That is how the Oct 14 incident flipped it, and why the env var
  wins (`tests/owner-signin.test.ts:33-38`).
- **Production runs on the fallback.** `owner.ts:7` says `SPOTIFY_OWNER_ID` is set in production, but
  `vercel env ls production` (9:31 PM, names only) lists twelve variables and it is not one of them;
  the Mac's `.env.local` lacks it too. So production's guard is whatever `me_id` holds. A read-only
  probe (9:32 PM, §8) found the live `me_id` equal, by sha256 prefix, to the Oct 1 snapshot's `me_id`,
  which owned 110 of that snapshot's 116 playlists: the guard admits the pre-incident library owner,
  presumably Rem, today. It stays right only while no other account's token reaches the row, which the
  guard itself now prevents. Setting `SPOTIFY_OWNER_ID` in production (one variable, then a redeploy)
  removes the dependence on store state.

### 1.3 The jwt callback at sign-in

The sign-in pass (`auth.ts:352-377`) writes `{accessToken, refreshToken, expiresAt}` over the one
token row and deletes them from the JWT so the cookie stays small. If the store write fails it keeps
them in the cookie instead (`auth.ts:367-374`) and a later request moves them (§2.6). Nothing that
identifies the account is added: neither `providerAccountId` nor `account_id`. From then on the cookie
carries a display name and an avatar, and the server cannot tell which Spotify account a cookie
belongs to.

### 1.4 The session cookie

- Strategy `jwt`, `maxAge` 30 days (`auth.ts:300-303`), no adapter, so no server-side session table.
- On HTTPS the cookie is `__Secure-authjs.session-token`: httpOnly, SameSite=Lax, Secure, path `/`
  (`@auth/core lib/utils/cookie.js:45-52`). Its value is a JWE (`alg: dir`, `enc: A256CBC-HS512`,
  `jwt.js:46-47`) under a key HKDF-derived from `AUTH_SECRET` with the cookie name as salt
  (`jwt.js:110-122`). The browser can neither read nor forge it; whoever holds `AUTH_SECRET` can mint
  one for anybody.
- Payload: `name`, `email` (empty in development mode, §1.1), `picture`, `sub` (the random UUID),
  `iat`, `exp`, `jti`, `error` when set, and Spotify tokens only in the §1.3 fallback.
- The session lasts 30 days from sign-in and is never renewed. Auth.js's session action re-encodes
  the JWT with a fresh expiry on every call (`lib/actions/session.js:21-48`), but the app only calls
  `auth()` without arguments, and that path keeps the response body and drops its `Set-Cookie`
  (`next-auth lib/index.js:89-91`). The one route that would deliver a renewed cookie,
  `GET /api/auth/session`, is called by nothing in the app (no `SessionProvider`, no `useSession`;
  `grep` over `src/`). So every user signs in again every 30 days.
- Two things end a session before that: a jwt callback that returns `null`, after which `auth()`
  reports no session (and the session action clears the cookie where its response reaches the browser,
  `lib/actions/session.js:34, 55`), and rotating `AUTH_SECRET`, which ends every session at once.
  Today's jwt callback never returns `null`.
- Rotating `AUTH_SECRET` without logging everyone out takes `secret: [new, old]` in the config; decode
  tries each (`jwt.js:63-70`). next-auth beta.31 reads `AUTH_SECRET` as one string (`next-auth
  lib/env.js:22`), which skips @auth/core's `AUTH_SECRET_1..3` list (`@auth/core lib/utils/env.js:28-37`),
  so numbered env vars do nothing while `AUTH_SECRET` is set. A plain swap logs everyone out once,
  which this app can afford.

### 1.5 The session callback

`session` (`auth.ts:444-452`) adds only `error`. The Spotify token left the session on 2026-08-11 and
the type now forbids it (`src/types/next-auth.d.ts`; docs/SECURITY.md, "Tokens never reach the
browser"). `GET /api/auth/session` returns `{user: {name, email, image}, expires, error?}`: no user id.
Server code takes the token from `spotifyAccessToken()` (`auth.ts:270-272`), after `auth()` in the same
request (`src/lib/session.ts:10-14`).

### 1.6 Sign-out

`logout()` (`actions.ts:63-69`) schedules `clearSpotifyTokens()` for after the response and calls
`signOut()`, which clears this browser's cookie. Deleting the one row does three things: closed-app
capture stops (the cron finds no token and answers 503, `src/app/api/cron/sync/route.ts:103-111`);
every other browser's session finds no row and goes to `/login` (`auth.ts:406-409`); and nothing is
revoked at Spotify. The app calls no revocation endpoint, and Spotify's token documentation describes
none (users revoke at spotify.com/account/apps). The deleted refresh token stays valid at Spotify (§2.1),
as do its copies in the backups.

### F1 — sessions minted before the owner guard still act as the owner (open now)

Sessions carry no identity (§1.3), every request reads the single token row (§2.1), and the guard runs
only at sign-in (§1.2). The second account that completed sign-in on Oct 14 therefore holds a session
cookie that stays valid until 30 days after that sign-in, about Nov 13 (§1.4). With the owner's token
back in the row, that
browser renders the owner's history and library, its server actions edit the owner's playlists and
drive the owner's playback, and its "log out" deletes the owner's token row, which stops capture. Its
chrome still shows the second account's name and avatar. This holds unless `AUTH_SECRET` was rotated
after the incident. Most likely it was not: `vercel env ls production` (9:31 PM) shows `AUTH_SECRET`
created 133 days ago, no doc records a rotation, and a rotation would have signed Rem out. That column
may not move on an in-place edit, so this is strong evidence, not proof.

Smallest fix: rotate `AUTH_SECRET` in Vercel production (`openssl rand -base64 32`, type Secret) and
redeploy. Rem signs in once more; the token row and the cron are untouched. The lasting fix is §5.1's
identity claim, checked on every request, which also rejects every cookie that lacks one. Doing either
is outside this planning lane; it is Rem's to authorize, and I would do it before anything else in
this program.

## 2. Token storage and refresh

### 2.1 The token row and its copies

- Table `meta (key TEXT PRIMARY KEY, value TEXT)` (`db.ts:183`). The key is `spotify_tokens` when
  `NODE_ENV=production` and `spotify_tokens_dev` otherwise (`db.ts:2511-2512`), so a dev server on the
  production store keeps its own grant. The value is `JSON.stringify({accessToken, refreshToken,
  expiresAt})` in plaintext (`db.ts:2514-2516`), read by `getSpotifyTokens()` (`db.ts:2518-2526`) and
  deleted by `clearSpotifyTokens()` (`db.ts:2528-2531`).
- Every authenticated request reads it before anything renders (docs/STORE_MIGRATION.md §1), once per
  request through the React `cache()` box (`auth.ts:73-83`; docs/GOTCHAS.md measured 4 → 1 reads per
  `/home` render). The box holds a promise that every write republishes (`auth.ts:81-83`), so a
  request never serves its own pre-refresh token.
- No log carries a token. The store meter keeps the first 160 characters of each statement's SQL and
  never its arguments (`ops/zenbook-meter/meter-proxy.mjs:28-31, 58-62`), and tokens are always bound
  arguments. The one `console` line near a token prints a read error (`cron/sync/route.ts:99`).

Where copies of the token rows exist (checked 2026-10-14):

| where | what | who can read it |
|---|---|---|
| live store, `~/lazyboy-sqld/data` on the Zenbook | both rows | holders of the store JWT (`TURSO_AUTH_TOKEN`), over a Funnel hostname this public repo prints (docs/STORE_MIGRATION.md:118, docs/quota-forensic/BRIDGE.md:12) |
| `~/lazyboy-backup/snapshots` on the Zenbook | all of `meta` (`backup.py:17`), gzipped nightly, 14 files on disk | Rem's Zenbook account (files 0664 inside a 0750 home) |
| OneDrive `onedrive-backup:lazyboy-db` | the same snapshots, kept 60 days (`backup.py:15-16, 65, 75`) | Rem's Microsoft account; the Zenbook's rclone config |
| `data/replica.db` on the Mac (an Aug 8-11 copy, gitignored) | both rows | Rem's Mac account |
| `~/lazyboy-recorder/tokens.json` on the Zenbook | the recorder's own chain; `config.json` beside it holds the client id and secret | mode 0600 |
| after STORE_MIGRATION | Turso `lazyboy` and Turso's backups; `~/lazyboy-migrate/core-<stamp>.db` and the cutover lane's scratch on the Mac (§8 steps 4-5); the nightly Turso dump (§9) | a full-access, no-expiry Turso token (§5 there), a read-only one, `TURSO_PLATFORM_TOKEN` |

How I measured whether these copies are live (read-only, 2026-10-14 about 9:15 PM): a script piped
through `ssh ubuntu python3 -` opened the Oct 1, Oct 8 and Oct 14 snapshots in memory and printed an
8-hex sha256 prefix of each row's refresh token beside its `expiresAt`, and the same prefix for the
recorder's `tokens.json`; on the Mac, `sqlite3 -readonly data/replica.db` piped through `shasum`. No
token value was printed or stored.

- Production's refresh token had the same prefix (`d30e33fe`) in the Oct 1, 8 and 14 snapshots while
  the access token's `expiresAt` moved on (to Oct 1 09:23, Oct 8 08:51 and Oct 14 09:14 UTC): two weeks
  of hourly refreshes and no rotation.
  docs/quota-forensic/BRIDGE.md found the same on Aug 8. docs/GOTCHAS.md's "PKCE refresh token rotates
  on every use" does not describe this app's grant today; Spotify's wording is "Depending on the grant
  used to get the initial refresh token, a refresh token might not be included in each response"
  (https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens).
- Two grants for Rem's account are live at once. The production row and the recorder's chain
  (`35fbe7ac`) both refreshed today (the recorder's `expires_at` is Oct 15 02:15 UTC). The recorder's
  refresh token is byte-identical to the `spotify_tokens_dev` row in all three snapshots checked and in
  the Mac's `data/replica.db`. The recorder and the Mac's `.env.local` use the same client id (hash
  prefix match); I could not read production's, so "one client holds two live grants for one user" is
  likely but unverified.
- Spotify now documents a lifetime: "Refresh tokens issued to apps registered in the Developer Dashboard
  have a lifetime of 6 months. … The 6-month lifetime starts when the user authorizes your app. …
  Refreshing an access token does not extend the refresh token's lifetime" (same page).

**F2.** Together: every copy in the table holds a credential with all 13 scopes that works until six
months after the sign-in that minted it, or until the user revokes the app. Deleting the row (sign-out)
does not kill its copies. The Mac's `data/replica.db` holds the recorder's live refresh token today.
For a single user who is also the developer this is Rem's own exposure; with other users it becomes
their credentials in Rem's OneDrive for 60 days.

**F3** (adjacent). The recorder runs on the dev grant it adopted on 2026-08-06 (docs/ARCHITECTURE.md,
"The history's loss floor"), authorized on or before that day. If the 6-month rule applies to it, it
stops refreshing by 2027-02-06 at the latest; `recorder.py` raises on the HTTP error and I found no
alarm on its unit, so the history's loss floor would end silently. A fresh local sign-in, copied into
`tokens.json`, restarts the clock.

### 2.2 Refresh on the request path

On every request after sign-in the jwt callback (`auth.ts:379-443`):

1. reads the row through the box; a store error keeps the session as it is (`:379-387`);
2. with no row but tokens in the cookie, migrates them (`:388-405`, §2.6);
3. with no row, sets `error = "RefreshAccessTokenError"` (`:406-409`), and the gates send the browser to
   `/login` (`src/app/(app)/layout.tsx:48-49` and each page's own gate, docs/SECURITY.md);
4. with more than 60 s left on the access token, stops (`:410-414`);
5. otherwise refreshes through `refreshShared` and publishes the result into the box (`:415-421`);
6. on a terminal failure runs `clearTokensIfStale` and re-reads directly (`:422-439`); on a transient
   one keeps the session for the next request (`:440`).

`refreshAccessToken` (`auth.ts:98-163`) POSTs to `accounts.spotify.com/api/token` with Basic
`client_id:client_secret` and a 3 s timeout per attempt. A network error or timeout retries once; 429
and 5xx retry up to three attempts (300 and 600 ms backoff); `400 invalid_grant` is terminal; anything
else is transient. A response without `refresh_token` keeps the old one (`:146`), which is the path
production takes (§2.1).

### 2.3 Coordination

- In-process: `inflightRefresh` (`auth.ts:188-196`) is one module-scope promise. Any concurrent caller
  in the instance joins it, whatever token it started from.
- Cross-instance: `acquireLock("spotify_refresh", 30_000)` (`auth.ts:212`) is a compare-and-set on the
  `meta` key `lock:spotify_refresh` that only an expired or absent lock wins; the owner token is the
  expiry plus a nonce and only the owner can release (`db.ts:2541-2565`; tested in
  `tests/adversarial/library-and-locks.test.ts:284-330`). The holder re-reads and refreshes only if the
  row is still stale (`auth.ts:215-219`). Losers poll every 500 ms for 16 s, twice (`:228-231,
  244-252`), then refresh on their own with the store's current refresh token (`:232-237`). A loser's
  worst case is about 32 s of polling plus one refresh (from the constants).
- With no rotation (§2.1), concurrent refreshes no longer race into `invalid_grant`; the lock now saves
  duplicate token-endpoint calls and keeps the row consistent. It stays, because Spotify reserves the
  right to rotate.
- No `lock:` row appears in the Oct 1, 8 or 14 snapshots (same probe): the lock is short-lived, as
  designed.

### 2.4 Session-less refresh

`getValidAccessToken()` (`auth.ts:278-289`) reads the row directly, returns the access token with 60 s
headroom, otherwise refreshes through `refreshShared`, and on a terminal failure clears and returns
`null`. Its callers are the cron tick (`cron/sync/route.ts:96-119`), the clean reconcile's token getter
(`actions.ts:46-57`) and the library scan's getter (`src/lib/playlists-sync.ts:58-66`). None names a
user; each means "the account in the row".

### 2.5 `clearTokensIfStale`

`auth.ts:170-181`: a fresh stored token vetoes the clear; otherwise the row is deleted only if its
refresh token is the one that just failed (wave-2 audit B4). The rule is per row and carries over
unchanged to per-user rows.

### 2.6 Tokens in the cookie

Two paths leave Spotify tokens in the session cookie, encrypted under `AUTH_SECRET`: the sign-in
fallback when the store write fails (`auth.ts:367-374`), and sessions from before the tokens moved to
the store, migrated on their next request (`auth.ts:388-405`). Any session of the second kind has long
since expired, so today the migration only finishes what the fallback started. Because the app never
re-issues the cookie (§1.4), the `delete t.accessToken` lines in both paths never reach the browser: a
cookie that once held tokens keeps them until it expires, and if a log-out elsewhere deletes the row,
that cookie's next request writes its old grant back (`auth.ts:389-398`).

### 2.7 Tests

The refresh path has none. Tests cannot load `src/lib/auth.ts` (next-auth pulls in `next/server`,
`tests/owner-signin.test.ts:5-6`), so every suite that touches it mocks `@/lib/auth`
(`tests/small-fixes-l1.test.ts:18`, `tests/capture-health.test.ts:94`,
`tests/remove-duplicate-copy.test.ts:16`, `tests/now-playing-route.test.ts:13`). The lock primitive and
the owner decision are tested; `coordinatedRefresh`, `clearTokensIfStale`, `getValidAccessToken` and
the jwt callback are not. Making exactly this code per-user is the riskiest change in the program
(§5.2).

## 3. Secrets: who holds what

### 3.1 Inventory

Sources: the env names the code reads (`grep process.env` over `src/`), `.env.example`, the key names
(not values) in the Mac's `.env.local`, `vercel env ls production` (names, targets and ages only,
9:31 PM), docs/SECURITY.md:49-54 for `CRON_SECRET`, docs/quota-forensic/BRIDGE.md:165-182 and an
`ls -la` on the Zenbook for its files (2026-10-14).

| secret | read by | held in | unlocks today |
|---|---|---|---|
| `AUTH_SECRET` | Auth.js (`next-auth lib/env.js:22`) | Vercel Production and Preview; Mac `.env.local` | minting a session cookie, which today is full owner access (F1) |
| `SPOTIFY_CLIENT_SECRET` (+ public `SPOTIFY_CLIENT_ID`) | `auth.ts:100, 310` | Vercel Production and Preview; Mac `.env.local`; Zenbook `~/lazyboy-recorder/config.json` (0600) | refreshing any stored refresh token; impersonating the app at Spotify |
| `TURSO_AUTH_TOKEN` (+ `TURSO_DATABASE_URL`) | `db.ts:128-129` | Vercel Production and Preview; Mac `.env.local`; Zenbook `~/lazyboy-sqld/jwt-token.txt` (0600) | the whole store, read and write, token rows included, from anywhere (the hostname is public) |
| sqld signing key | sqld (`--auth-jwt-key-file` holds the public half) | Zenbook `~/lazyboy-sqld/jwt-private.pem` (0600, BRIDGE.md:169) | minting store tokens: same as the row above |
| `TURSO_PLATFORM_TOKEN` (+ `TURSO_ORG`) | `/usage` render (`src/app/(app)/usage/page.tsx:85-86`), `/api/cron/usage-check` (`route.ts:124-136`) | Vercel Production; Mac `.env.local` | the Turso org's platform API; after STORE_MIGRATION, minting a token for the core database |
| `CRON_SECRET` | `cron/sync/route.ts:61-66` and `cron/usage-check/route.ts:120-121`, both constant-time | Vercel Production (Sensitive per SECURITY.md); Mac `.env.local`; Zenbook `~/lazyboy-cron/env` (0600); stale copies in the cron-job.org job and `/etc/lazyboy-sync.env` (SECURITY.md:49-54) | running the sync and usage-check routes on demand |
| `CRONJOB_API_KEY` (+ `CRONJOB_JOB_ID`) | `src/lib/cronjob.ts:17-36` | Vercel Production | the cron-job.org account's jobs (that branch has not run since Aug 10, STORE_MIGRATION.md:72-77) |
| Vercel CLI token | the tunnel updater, retired | Zenbook `~/lazyboy-tunnel/env` (0600, BRIDGE.md:175); dead since Aug 9 (STORE_MIGRATION.md:363) | nothing while dead; a live one reads and writes every secret above |
| rclone OneDrive token | `backup.py` | Zenbook rclone config | the 60 days of backups, which hold token rows (F2) |
| Spotify refresh tokens | §2 | §2.1's table | the user's Spotify account, 13 scopes |

Not secrets, for completeness: `SPOTIFY_OWNER_ID` (absent from production, §1.2), `AUTH_URL`,
`TURSO_DATABASE_NAME`, `LAZYBOY_NO_REPLICA`. Preview holds the same `AUTH_SECRET`, client secret and
store token as Production, so a Preview build of any branch can read the store's token row and mint
cookies that production accepts. The repo is public (`gh repo view`: `PUBLIC`) and BRIDGE.md:182
states no secret value is committed; a pattern scan for JWT, Spotify-token and PEM shapes
(`git grep -E 'eyJ…|AQ…|BQ…|-----BEGIN'`) found none.

### 3.2 Blast radius and rotation, and what N users changes

- `AUTH_SECRET`. Today a forged cookie is the owner. Once sessions carry a user id (§5.1), a forged
  cookie can name any user, so it becomes the key to every account's in-app session. It never reveals
  a Spotify token by itself, because tokens stay in the store. Rotation: swap and redeploy, which logs
  everyone out once, or `secret: [new, old]` for a grace period (§1.4).
- `SPOTIFY_CLIENT_SECRET`. With it, any refresh token in any backup is usable. Whether a refresh token
  from this app can be refreshed without the secret is unknown: the sign-in sends a PKCE verifier
  and authenticates with the secret, and Spotify's docs describe the PKCE refresh as needing only the
  public `client_id` ("client_id: Only required for the PKCE extension",
  https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens). Testing it would
  mean using a live grant, which this lane does not do. Plan as if a leaked refresh token alone is
  enough. Rotation: in the Spotify dashboard, then Vercel, `.env.local` and the recorder's
  `config.json`. I expect existing refresh tokens survive a secret rotation, but I have not seen that
  documented.
- The store token. Today it is one user's data and one user's live grant. With N users it is
  everyone's data and, unless §5.3 is built, everyone's live grant. sqld checks only the signature, so
  revoking one leaked JWT means replacing the keypair (all tokens die at once). After STORE_MIGRATION
  the store token is a Turso token "full access, no expiry" (STORE_MIGRATION.md:129).
- `TURSO_PLATFORM_TOKEN`. After the migration it can mint a core-database token, so it is worth the
  same as the store token, and it sits in the Vercel runtime to feed a page (`/usage`) and a guard that
  is dormant. With N users I would take it out of the runtime (§6).
- `CRON_SECRET`. Today: extra syncs of one account. With N users a holder can make the cron fan out
  across every user on demand. That spends Spotify quota, which is counted "per developer account
  rather than per Client ID" in development mode
  (https://developer.spotify.com/documentation/web-api/references/changes/july-2026), so it can push
  every user into a 429. No data leaks through it.
- The rest are unchanged by multi-user.

## 4. Census: every single-user assumption in auth

Sizes as in 01-current-system.md: **S** a key or filter in one place; **M** a function's contract or a
table's key changes and callers follow; **L** a new mechanism, a migration over live data, or a loop
that must fan out per user. The data layer beyond tokens is 01a's, the request surface 01b's, the
background work 01c's; rows here stop at the auth boundary.

| # | where | single-user assumption | multi-user needs | size |
|---|---|---|---|---|
| A1 | `db.ts:2511-2531` | one token row per environment in `meta` | a per-user token table keyed `(account_id, env)`, encrypted (§5.2, §5.3) | M |
| A2 | `auth.ts:188-196` | `inflightRefresh` is one promise per instance | a map keyed by user. Left as is, user B's concurrent refresh joins user A's and receives **A's tokens**: B's request then reads and writes A's Spotify account. The one change here that leaks across users silently. | S, critical |
| A3 | `auth.ts:73-83` | the request's token box holds one user's tokens | key the box by user, so nothing that touches two users in one request can mix them | S |
| A4 | `auth.ts:212` | lock name `spotify_refresh` | `spotify_refresh:<account_id>:<env>`. Shared, a user who loses the lock to another user's refresh waits up to ~32 s for a token nobody is refreshing, then refreshes alone (§2.3) | S |
| A5 | `auth.ts:170-289` | `coordinatedRefresh`, `waitForFreshToken`, `clearTokensIfStale`, `getValidAccessToken` read and clear "the" row | each takes the account id; tests first (§2.7) | M |
| A6 | `auth.ts:270-272`; `src/lib/session.ts:9-19` | `spotifyAccessToken()` and `getSpotify()` return "the" token with no owner | return the token together with the account id the session named, so callers scope their reads by the same id | S |
| A7 | `auth.ts:352-377` | the sign-in pass writes the global row and puts no identity on the JWT | write the user's row; put `account_id` and a session epoch on the JWT (§5.1) | M |
| A8 | `auth.ts:379-443` | later requests trust any cookie that decrypts | require the id, check the user's status and epoch, return `null` otherwise (§5.1, §5.6) | M |
| A9 | `auth.ts:444-452`; `src/types/next-auth.d.ts` | the session exposes no id | `session.user.id` (STORE_MIGRATION §10 already wants one) | S |
| A10 | `auth.ts:344-347`; `src/lib/owner.ts` | owner-only sign-in by Spotify `id` | a sign-up gate (§5.4) | M |
| A11 | `db.ts:1804, 1817-1823, 2034-2036, 2297, 2310` | `me_id` is one global value, rewritten by every library sync | a per-user `spotify_id` on the user row, refreshed at sign-in (data side: 01a) | M |
| A12 | `src/app/(app)/actions.ts:63-69` | log out deletes the only token row, which also stops capture and signs out every device | delete only this user's state, and decide what log out means (§5.6) | S + Rem's call |
| A13 | `src/lib/login-error.ts:11-13` | "single-user for now" copy | a sign-up-gate message | S |
| A14 | `cron/sync/route.ts:96-119` | the cron syncs "the" account | fan out over users, each isolated (§5.9; 01c) | L |
| A15 | `cron/sync/route.ts:103-111` | no token row means "signed out", answered 503 | per-user status; 503 only when the store or every user fails (§5.7) | S |
| A16 | `actions.ts:46-57`; `src/lib/playlists-sync.ts:58-66` | background token getters read "the" account | bind the getter to the account id at task creation | S |
| A17 | `src/lib/playlists-sync.ts:22` | one `currentSyncId` per instance | keyed by user (01b/01c) | S |
| A18 | `auth.ts:367-374, 388-405` | tokens may sit in the cookie and migrate into "the" row | remove both paths: a sign-in whose token write fails should fail visibly and be retried (§5.2) | S |
| A19 | `owner.ts:11`; `.env.example:8-10` | `SPOTIFY_OWNER_ID` names the only user | keep it as the bootstrap admin's id, or retire it after the owner is migrated | S |
| A20 | Zenbook `~/lazyboy-recorder` | one refresh-token chain, Rem's | stays owner-only unless Rem decides otherwise (§5.9, §7) | – |
| A21 | `tests/*` mocking `@/lib/auth` | the refresh path is untestable | move the token core out of `auth.ts` into a module the simulated environment can load (§5.2) | M |

## 5. What multi-user must change

These are recommendations for the three designs, with the reason for each. Schema sketches are
illustrations; the data model as a whole is 01a's and the designs'.

### 5.1 Identity: the session must name the user

The key is Spotify's `account_id`. The alternatives each fail: the Spotify `id` is the field Spotify
says may change and must not be used for linking (§1.1); Auth.js's `sub` is a fresh random UUID at
every sign-in (§1.1); email is not returned in development mode and is not an identity anyway.

- Sign-in pass of the jwt callback: set `token.uid = profile.account_id` and `token.epoch =
  users.session_epoch`, taken from the profile and the user row only, never from the incoming token.
- Every later request: no `uid` → return `null`. Auth.js then treats the request as signed out and
  clears the cookie where it can (§1.4). This one rule closes F1 and makes everyone sign in once at
  rollout.
- Read the user row and the token row in one query (`users LEFT JOIN user_tokens`), through the
  request box. Unknown user, a status other than active, or `token.epoch !== users.session_epoch` →
  `null`. Today's request already pays one token read before rendering; the join keeps it at one round
  trip, so identity costs no latency. Two separate reads would add one round trip per request (about
  15 ms on Turso at STORE_MIGRATION's R1 target; 40-210 ms medians through today's Funnel, measured from
  the Mac, STORE_MIGRATION §1).
- `session.user.id = uid`. Spotify calls `account_id` "public … pseudoanonymous", so sending it to its
  own user's browser is fine, and the browser needs it to key its caches (§5.6).
- Pass the id explicitly. `getSpotify()` (or its successor) should return `{ uid, sp }`, and every
  store function that reads user data should take `uid` as an argument. An ambient "current user" (for
  example AsyncLocalStorage set in `auth()`) does not exist in the cron or in background tasks that
  outlive their request (`src/lib/tasks/`), and where it does exist it can be the wrong user; an
  explicit argument is checkable by the type system and by grep.

### 5.2 Per-user token rows, locks and request boxes

A sketch (01a owns the schema):

```sql
CREATE TABLE users (
  account_id    TEXT PRIMARY KEY,     -- Spotify account_id, immutable
  spotify_id    TEXT NOT NULL,        -- mutable; refreshed at sign-in; replaces me_id
  status        TEXT NOT NULL,        -- active | needs_reconnect | disabled
  session_epoch INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE TABLE user_tokens (
  account_id TEXT NOT NULL,
  env        TEXT NOT NULL,           -- prod | dev: replaces the spotify_tokens/_dev key split
  blob       TEXT NOT NULL,           -- encrypted {accessToken, refreshToken} (§5.3)
  expires_at INTEGER NOT NULL,        -- plaintext, so the cron can pick who needs a refresh
  granted_at INTEGER NOT NULL,        -- last authorization: the 6-month clock (§5.7)
  PRIMARY KEY (account_id, env)
);
```

- Every function in §2.2-2.5 takes the account id: the lock becomes
  `lock:spotify_refresh:<account_id>:<env>` (A4), the in-process `inflightRefresh` becomes a map keyed
  the same way (A2), the request box is keyed by account (A3), and `clearTokensIfStale` compares
  within one user's row.
- Move the token core (`refreshAccessToken`, `coordinatedRefresh`, `waitForFreshToken`,
  `clearTokensIfStale`, `getValidAccessToken`, the in-flight map) out of `auth.ts` into a module with
  no next-auth import, and keep the jwt callback's body as a function of `(token, account, profile,
  deps)`, so the simulated environment (`tests/setup.ts`: a local SQLite file and a scripted fetch) can
  run them. Known-answer tests to write first:
  1. Two users with expired tokens refresh concurrently in one process: each ends with its own new
     token, one token-endpoint call per user (A2).
  2. User A holds the refresh lock; user B's refresh does not wait (A4).
  3. `invalid_grant` for A clears A's row only (A5).
  4. A's ciphertext copied into B's row fails to decrypt (§5.3).
  5. A cookie with no `uid`, an unknown `uid`, a disabled user or a stale epoch: the callback returns
     `null` (§5.1, §5.6).
  6. `getValidAccessToken(uid)` for a user with no row returns `null` and makes no Spotify call.
- Remove the cookie-held-token paths (A18). They exist for a store hiccup during sign-in; with N users
  a sign-in that cannot write its token row should fail and be retried while the user is still on the
  page. A token parked in a cookie is invisible to the cron, so that user's capture would stop silently
  until a later request migrated it.
- Write load (estimate from the code, not measured): the cron needs a valid access token for every
  active user around the clock (it checks `currentlyPlaying` each tick, `cron/sync/route.ts:133-137`),
  so each user costs about 24 refreshes a day, each one row write plus a lock acquire and release:
  about 72 writes per user per day. Five users: ~360 a day; 25 users: ~1,800 a day, about 54K a month
  against Turso's free 10M (STORE_MIGRATION R4). Reads stay at one per request.

### 5.3 Encryption at rest and key handling on Vercel

What it protects: every place a token row goes that is not the Vercel runtime. That is the store
(Zenbook today, Turso after Oct 15), its backups (14 days on the Zenbook, 60 on OneDrive, Turso's
own), the migration's snapshots and scratch copies, `data/replica.db`, a dev server pointed at
production, and whoever holds a leaked store or platform token. All of them hold live, 13-scope
credentials today (F2). With other people's accounts in the store, these copies are the main risk.

What it does not protect: anything that runs code in production (a bad deploy, a compromised
dependency, Vercel itself), because that code holds the key; and a holder of `AUTH_SECRET`, who can
drive the app as any user without ever seeing a token.

Recommended design:

- AES-256-GCM from Node's built-in `crypto`, no new dependency; a random 12-byte IV per write.
- Stored as `v1.<base64url(iv ‖ ciphertext ‖ tag)>`, where `v1` names the key.
- Associated data `lazyboy:tokens:<account_id>:<env>`. Without it, someone with write access to the
  store but no key could copy a victim's ciphertext into their own row and use the app, through their
  own session, on the victim's Spotify account. With it, the moved ciphertext fails to authenticate.
- Plaintext columns: `account_id`, `env`, `expires_at`, `granted_at`. Both tokens go in one blob; the
  access token lives an hour, and encrypting it costs nothing extra.
- Keys in one env var, `TOKEN_KEYS="v2:<base64 32 bytes>,v1:<…>"`: the first writes, reads pick by
  prefix. On Vercel, type Secret ("Secret values are write-only after saving",
  https://vercel.com/docs/environment-variables/sensitive-environment-variables), Production only.
  Preview gets no key (and no production store, §6). Dev rows use a dev key, so the production key
  never sits in `.env.local`, and `vercel env pull` cannot return a Secret.
- Rotation: put the new key first and redeploy. Active users' rows re-encrypt at their next refresh,
  about hourly; a one-off script re-encrypts the rest; drop the old key once
  `SELECT count(*) FROM user_tokens WHERE blob LIKE 'v1.%'` is zero.
- Losing the key costs every user one sign-in and nothing else, so a copy in Rem's password manager is
  enough backup.
- A blob that fails to decrypt is treated as no token (`needs_reconnect`) and logged with the account
  id, never the blob.
- Cost: microseconds of CPU per request for a ~600-byte blob (an estimate; AES-GCM is hardware-
  accelerated on x86), against a store round trip of tens of milliseconds, and no extra round trip.

Alternatives I would not take:

- Vercel KMS (beta) only signs: "KMS does not support symmetric (HS*) keys", and it exposes
  `signJWT`/`signMessage` (https://vercel.com/docs/kms, updated Sep 7, 2026). It cannot encrypt or
  decrypt.
- AWS KMS through Vercel's OIDC federation keeps the key out of Vercel's env and logs every decrypt.
  It defends against someone who can read Vercel's env but cannot run code there, and Secret values
  already cannot be read without running code. The price is an AWS account and a network call (or a
  cached data key) on every request, and Rem has already ruled AWS out for this app
  (STORE_MIGRATION.md:107).
- Encrypting the database file at the storage layer protects the disk only. The exposures above go
  through the store's API (dumps, backups, a leaked token), which sees plaintext.

### 5.4 Sign-up gating in place of the owner guard

Two gates exist today: Spotify's development-mode allowlist (an account not on it gets a 403 from
`/v1/me`, GOTCHAS "Sign-in by an account outside that allowlist") and the owner guard.

Spotify's current rules for development-mode apps, from the February 2026 migration guide
(https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide, fetched
2026-10-14): "All Development Mode apps require the app owner to have an active Spotify Premium
subscription. If the owner's Premium subscription lapses, the app will stop working"; new apps get
"Users per app 5"; and "Existing apps are grandfathered: If you already have multiple Client IDs or
more than 5 users, you will retain them. These limits only restrict what you can create or add going
forward." So in development mode the allowlist can grow to five users at most (the page does not say
whether the owner counts). **This program's design brief targets 25 users under development mode,
which exceeds what Spotify allows today.** Designs should take five as the
development-mode ceiling and treat 25 as an extended-quota question for 01f. docs/SECURITY.md:70-71
("caps to 25 allowlisted users") is out of date.

Recommended app-side gate, replacing `isOwnerSignIn`:

- An invite table keyed by Spotify `id`, the identifier Rem can see before the person ever signs in (it
  is in their profile URL); `account_id` only appears through `/v1/me` with their token. On first
  sign-in a matching unclaimed invite creates the `users` row under `account_id` and records the claim;
  from then on the user is found by `account_id`, so a later change of `id` does not matter.
- `SPOTIFY_OWNER_ID` bootstraps the first admin (Rem), as today. Admin is a flag on the `users` row
  bound to his `account_id`; store-wide views such as `/usage` gate on it (01b).
- Fails closed on a store error, as `owner.ts:8-9` does now.
- Keep it even while Spotify's allowlist also gates: the app cannot see the dashboard; extended quota
  would remove that gate and the app's own must already exist; and `users.status` lets Rem cut a user
  off without the dashboard.
- Every user adds cron work and Spotify calls counted against Rem's developer account (July 2026
  changelog, §3.2), so the gate is also the cost control.
- Rem's Premium subscription becomes an uptime dependency for every user (the quote above).

### 5.5 Account linking

- One provider, so linking means mapping a Spotify account to an app user, and the key is
  `account_id` (§5.1). Never link by email: development mode returns none, and email linking lets
  whoever controls an address claim an account; Auth.js only allows it behind
  `allowDangerousEmailAccountLinking`.
- Treat the Spotify `id` as an attribute: refresh `users.spotify_id` at sign-in and on library sync.
  Playlist owners arrive as Spotify ids, so `getLibraryTracks`' owner filter (`db.ts:2310`) keeps
  working.
- If `/v1/me` comes back without `account_id`, refuse the sign-in and log it; do not fall back to `id`.
  A fallback keys some users on a mutable field, and one person could later end up as two users. The
  docs say `account_id` is returned; nobody has seen it from this app. The first post-change sign-in
  (Rem's) settles it, and should happen before invites go out.
- Read `profile.account_id` in the signIn and jwt callbacks, which both receive the raw profile at
  sign-in. `account.providerAccountId` is the Spotify `id` (`@auth/core
  lib/actions/callback/oauth/callback.js:233`) and is not the key.
- One person with two Spotify accounts is two users. Merging histories is a product feature, not a
  linking rule; I would not build it.
- Rem's existing data belongs to his `account_id`. Bind it on his first sign-in after the change by
  matching `profile.id` to `SPOTIFY_OWNER_ID`, or read it once from `/v1/me` with the stored production
  token during the data migration. Never bind through `me_id`, which an intruder's sync can rewrite
  (`tests/owner-signin.test.ts:33-38`).

### 5.6 Session fixation, sign-out and server-side revocation

- Classic fixation needs a session id that survives login. Auth.js mints a new encrypted JWT at
  sign-in from a `defaultToken` built from the signing-in user alone (`@auth/core
  lib/actions/callback/index.js:72-79`), replacing whatever cookie the browser held. The design keeps
  that only if the sign-in branch takes `uid` and `epoch` from the profile and the user row, never from
  the incoming token (§5.1).
- Login CSRF, planting the attacker's account in the victim's browser, is blocked by PKCE (§1.1).
  Adding `"state"` to the provider's `checks` is free defence in depth; RFC 9700 does not require it.
- One browser, two users. B signing in over A gets a clean B session. What can leak is client-side
  state that outlives the switch: the `lb-nowplaying` localStorage cache (GOTCHAS, "The now-playing
  localStorage cache"), the planned IndexedDB search copy (STORE_MIGRATION §10, which already clears on
  a different user id or sign-out), and the browser's HTTP cache for `/api/search/*`. Those ETags are
  `lib-<shape>-<version>-<date>` and `hist-…` with no user in them
  (`src/app/api/search/library/route.ts:39`, `history/route.ts:26`). Two users whose version numbers
  match on the same day would revalidate each other's cached body to a 304, so the ETag must carry the
  user id (01b/01d). All of these key on `session.user.id` (A9).
- Split today's single log-out into three actions:
  1. **Sign out**: clear this browser's cookie. Capture continues.
  2. **Sign out everywhere**: bump `users.session_epoch`; every other cookie fails its next request.
  3. **Disconnect**: delete the token row, stop capture, delete the data (§5.8), and tell the user to
     remove the app at spotify.com/account/apps, since the app cannot revoke the grant itself. Spotify's
     policy requires this mechanism (§5.7).
  Today log out stops capture and signs out every device (§1.6); the split changes that. It is Rem's
  call; I recommend it, because with several users signing out of a shared computer should not stop
  their history, and the policy needs a separate disconnect anyway.
- An admin disable sets `users.status = 'disabled'`; it takes effect on the user's next request.
- Keep the fixed 30-day lifetime (§1.4). The epoch is a server-side kill switch, so a shorter cookie
  buys little, and `AUTH_SECRET` rotation remains the everyone-out switch. Both checks ride the
  request's single token read (§5.1). If a design makes sessions renew on use, it lengthens how long a
  stolen cookie lives and stops the monthly re-authorization that §5.7 relies on.

### 5.7 When a user revokes the app

Today, single user (from the code): the user removes the app at spotify.com/account/apps. Whether the
stored access token stops working at once is undocumented; it expires within an hour regardless
(`expires_in` 3600). A 401 meanwhile surfaces as a `SpotifyError` (`src/lib/spotify/client.ts:206-211`)
and triggers nothing. The next refresh gets `400 invalid_grant`, which is terminal:
`clearTokensIfStale` deletes the row; the request path sets `error` and sends the browser to `/login`;
the cron answers 503 "no token" (`cron/sync/route.ts:103-111`) and the Zenbook's timer logs a failure.
Capture stops; plays beyond Spotify's 50-play window are lost until the user signs in again.

What N users need:

- Isolation: user A's `invalid_grant` clears A's row only, costs one token-endpoint call, and delays
  nobody else (per-user locks, A4; per-user error handling and time budget in the cron, 01c). Once A's
  row is gone the cron skips A, so a revoked user costs nothing per tick.
- Status, not absence: set `users.status = 'needs_reconnect'` where the row is cleared. The UI can then
  say "Spotify disconnected Lazy Boy — reconnect", and the cron stops reading "one user has no token" as
  "capture is down" (A15: today's 503 would fire whenever any one user disconnects).
- A 401 on a token the store believes fresh should zero that user's `expires_at`, so the next call
  refreshes and finds out within seconds instead of within the hour. Small and optional.
- Revocation and expiry look the same: the token endpoint "returns invalid_grant when a refresh token is
  expired, revoked, or otherwise invalid" (refreshing-tokens page). `granted_at` separates them: under
  six months it was revoked (or invalidated by Spotify for some other reason, which the docs do not
  list); at six months it expired.
- The six-month lifetime mostly takes care of itself today. Sessions end 30 days after sign-in (§1.4),
  and every sign-in passes Spotify's consent screen (`show_dialog`), which is a new authorization and
  restarts the clock. It runs out only for a user who has not signed in for six months while the cron
  kept capturing for them; their capture stops then, and an in-app prompt cannot reach someone who never
  opens the app. E-mail is out: development mode returns no address, and the policy says "Don't email
  users unless they have provided you with their explicit consent" (https://developer.spotify.com/policy).
  So: mark them `needs_reconnect` at expiry, show the reason when they come back, and accept the gap.
  If a design ever makes sessions renew on use (§5.6), add an in-app "Reconnect Spotify" prompt from
  `granted_at + 165 days`. Rem's own production grant follows the same rule: it runs out six months
  after his last sign-in.
- Deleting data. Spotify's Developer Policy: "when a user disconnects their Spotify account or otherwise
  expresses an intent to prevent your SDA from accessing their data, you agree to delete and no longer
  request or process any of that user's personal data" (https://developer.spotify.com/policy, fetched
  2026-10-14). The Developer Terms put a clock on it: "discontinue accessing the applicable Spotify
  Personal Data and delete the applicable Spotify Personal Data in your possession or control within
  five (5) days" (Data Protection Appendix §5, as quoted in 01f-platform.md §1.5). An explicit in-app
  Disconnect is that intent: delete at once. An `invalid_grant` is ambiguous, and `granted_at` splits
  it. Under six months, treat it as a disconnect: stop all processing at once (no token, no calls),
  tell the user on their next visit, and delete within five days unless they reconnect first. At six
  months it is an expiry: stop processing, keep the data, mark `needs_reconnect`. The owner is exempt.
  Whether Rem wants the five-day deletion on an ambiguous signal is his call (§7); an earlier purge is
  irreversible, a later one is outside the Terms.

### 5.8 Account deletion

- The policy requires "an easily accessible mechanism to disconnect their Spotify account from your SDA
  at any time and provide clear instructions on how to do so", and a privacy policy (same page).
- Order, as an idempotent job: bump the epoch (sessions die), delete the token row (access stops),
  delete every user-scoped row and cached payload (01a's tables; user-keyed `meta` entries; any
  telemetry that gains a user column), delete lock rows, and delete the `users` row last, so a crash
  midway leaves a row the job can find and finish.
- Tell the user to remove Lazy Boy at spotify.com/account/apps; the app cannot revoke the grant.
- Backups are the hard part. They keep data 14 days on the Zenbook and 60 on OneDrive
  (`backup.py:16`), plus Turso's own retention after the migration, and the Terms' five-day deletion
  clock (§5.7) covers data "in your possession or control". Options, cheapest first: split the backup
  by user once tables carry one, keeping the owner's rows on today's retention and everyone else's for
  at most five days; or shorten all retention to five days; or per-user data keys, destroyed at
  deletion (crypto-shredding), which is more machinery than five users justify. I would take the
  split. With §5.3 a deleted user's tokens in any backup are ciphertext either way. 01f §1.5 reaches
  the same conclusion from the Terms' side.

### 5.9 Session-less paths acting for N users

- The cron (A14) iterates users that are active and have a production token row, calls
  `getValidAccessToken(uid)` per user, and isolates each user's failures and time (01c). It should
  refresh only users who need a Spotify call on that tick.
- `CRON_SECRET` stays the cron's only gate, and fan-out raises its value (§3.2). A separate secret per
  caller (the Zenbook timer, Vercel's cron) would let one be rotated without the other; optional.
- Background tasks bind their token getter to the user at creation (A16).
- The recorder holds Rem's grant in plaintext on the Zenbook. Extending it to other users means giving
  the Zenbook every user's refresh token, decrypted (the key on an apartment laptop), or asking every
  user to authorize a second grant for it. I would keep it owner-only; other users' capture then rests
  on the Vercel cron alone, with Spotify's 50-play window as their loss floor. Rem's call (§7).
- A dev server pointed at the production store (today's `.env.local`, and STORE_MIGRATION §8 step 15
  keeps it so) can read every user's data. §5.3 keeps their tokens out of reach; their history is not.
  Point dev at a local or separate store once a second user exists.

### 5.10 docs/SECURITY.md's open checklist, from the auth side

- `AUTH_URL` and `AUTH_SECRET` (SECURITY.md:65-66): `AUTH_URL` is set in Production and Preview
  (`vercel env ls`); `AUTH_SECRET` needs the F1 rotation, and Preview should get its own (§3.1).
- Development mode (SECURITY.md:70-71): the cap is now five, not 25 (§5.4).
- CSP (SECURITY.md:72-73): with N users an XSS acts as its victim only (the session cookie is httpOnly,
  server actions run as the victim). The text the app renders comes from Spotify, and any Spotify user
  can name a playlist, so the main defence remains React's escaping. A nonce-based CSP is still worth
  having; I would not make it a multi-user blocker.
- Rate limiting (SECURITY.md:74-75): with N users, per-user limits on server actions protect the
  shared Spotify quota (§3.2); 01b and 01c own the mechanism.
- No token logging (SECURITY.md:79-80): holds today (§2.1). Keep the decrypt-failure log to the account
  id (§5.3).

## 6. What multi-user needs from STORE_MIGRATION.md

What auth needs from the store once it is on Turso:

- `users`, `user_tokens` and the lock rows on the core client, never the telemetry one. The telemetry
  client gets one attempt and a 4 s timeout (STORE_MIGRATION §6 item 1), which is wrong for a read
  every request waits on. The plan already keeps `meta` on core (§5 there).
- One round trip per request for identity and tokens together (§5.1), at the plan's R1 target of
  p50 ≤ 15 ms.
- The refresh lock is a compare-and-set, which is sound on Turso's single primary. If read replicas
  are ever added, token and lock reads stay on the primary; GOTCHAS already says this for `meta`.
- Writes from tokens are small: about 54K a month at 25 users (§5.2), against 10M.

Does anything in it need to change before it runs (Oct 15, 8 PM)? Nothing is required for auth. The
cutover moves `meta` whole, compares both token rows (§8 step 10) and fences the Zenbook so an old
deployment cannot write a refreshed token there (§6 item 8). Multi-user's tables come later. Four small
changes I would make, none of them blocking:

1. **Backups and the archive drop the token rows.** Lane 1904 rewrites `backup.py` (§9) and lane 1909
   archives the Zenbook's old core tables to OneDrive (§9, "The 7-day cleanup"). Both copy `meta` with
   live 13-scope grants (F2). Deleting `meta` rows `spotify_tokens%` and `lock:%` from the copy before
   gzip removes that exposure today, long before §5.3 exists. The cost is one sign-in after a restore.
   The cutover's own snapshot and import must keep the rows (R5: Rem stays signed in).
2. **Lane 1903 deletes its plaintext copies when it finishes**: the core snapshot copied to the lane's
   scratch on the Mac (§8 step 5) and the mode-600 copy of `.env.local` (§8 step 15). The first holds
   live grants, the second every secret in §3.1.
3. **Give lane 1905 a real user id.** Its IndexedDB copy is keyed by "the signed-in user's id"
   (STORE_MIGRATION.md:332), and today's session carries none (§1.5). Shipping A7-A9 first (the
   account id on the JWT, cookies without it refused, `session.user.id` exposed) gives 1905 the id
   multi-user will use, and it is the lasting fix for F1. It is a small auth change of its own, not
   something to fold into 1905's scope.
4. **Preview stays on the production store until a second user exists** (STORE_MIGRATION.md:71, §8
   step 9). After that, any branch deployment could read every user's data, so Preview needs its own
   database or none. Not a change for the cutover.

After the cutover, for multi-user: the app's Turso token is "full access, no expiry"
(STORE_MIGRATION.md:129) and `TURSO_PLATFORM_TOKEN` can mint another. Once §5.3 ships, neither unlocks
anyone's Spotify account, but both still read every user's history. I would take the platform token
out of the Vercel runtime when the second user arrives; it serves `/usage` and a dormant guard (§3.2).

## 7. Decisions that are Rem's

1. **F1, now:** rotate `AUTH_SECRET` in production, and in the same redeploy set `SPOTIFY_OWNER_ID`
   there (§1.2). Recommend yes, tonight: it costs one sign-in and closes a live cross-account hole, and
   the owner guard stops depending on what `me_id` holds.
2. **What "log out" means:** today it stops capture and signs out every device. Recommend splitting
   it into sign out, sign out everywhere, and disconnect (§5.6).
3. **Data after an `invalid_grant`:** recommend treating one that arrives under six months as a
   disconnect (stop at once, delete within the Terms' five days unless the user reconnects), and one at
   six months as an expiry (stop, keep the data), owner exempt (§5.7). The alternative, keeping data
   on every ambiguous signal, is gentler on users and outside the Terms.
4. **Backups with other people's data:** recommend splitting them by user, owner on today's
   retention, everyone else five days at most (§5.8).
5. **The recorder:** recommend owner-only (§5.9).
6. **Token rows out of the backups:** recommend yes, now (§6 item 1).
7. **Encryption at rest with a Vercel-held key:** recommend yes, before the second user signs in;
   no KMS (§5.3).
8. **Who may sign up:** recommend an app-side invite list next to Spotify's allowlist, capped at what
   development mode allows (five, §5.4). Whether to seek extended quota for more is 01f's question and
   Rem's.
9. **Dev against the production store:** recommend moving dev to a local or separate store once a
   second user exists (§5.9).
10. **`TURSO_PLATFORM_TOKEN` in the runtime:** recommend removing it with the second user (§6).

## 8. Unknowns and what I did not verify

- Whether `AUTH_SECRET` was edited in place after the incident (the env listing shows it created 133
  days ago; F1).
- Whether production uses the same Spotify client id as dev (values are not readable).
- Whether `SPOTIFY_OWNER_ID` is set as a team-level shared variable that `vercel env ls` does not
  list. If it is, production's guard uses it and §1.2's "runs on the fallback" does not hold.
- Whether `/v1/me` returns `account_id` to this development-mode app (documented, not observed).
- Whether this app's refresh tokens can be refreshed without the client secret (§3.2).
- Whether revoking at spotify.com stops the current access token at once, and whether a password
  change or other account event also invalidates grants.
- Whether the six-month lifetime applies to grants issued before Spotify documented it (F3).
- Whether development mode's five-user cap counts the owner, and how many accounts the allowlist
  holds today.
- Who the second account was, and whether its browser still holds the cookie.
- Whether Vercel builds Preview deployments for pull requests from forks of this public repo with
  Preview's env (which holds the store token); I did not check the project's setting.
- Every library-internal claim comes from the `@auth/core` 0.41.2 and `next-auth` 5.0.0-beta.31
  tarballs; a different installed version could differ.

Read-only measurements in this file, all on 2026-10-14 between 9:12 and 9:33 PM: `ls -la` of three
Zenbook directories; key names of the recorder's two JSON files; the hash-prefix probe of three
Zenbook snapshots and `tokens.json` (§2.1); `rclone listremotes` (names only); `sqlite3 -readonly` on
the Mac's `data/replica.db` and `data/listens.db`; key names of the Mac's `.env.local`; a client-id
hash-prefix comparison; `gh repo view` for visibility; `vercel env ls production` (names, targets,
ages); and one query on the live store, `SELECT value FROM meta WHERE key = 'me_id'`, sent to sqld
over the Zenbook's loopback (127.0.0.1:8092, not through the meter), whose result was printed only as a
hash prefix beside the Oct 1 snapshot's `me_id` and playlist owners (§1.2). The two probe scripts are
`token_rotation_probe.py` and `owner_probe.py` in this lane's scratch
(`~/.claude/broke/scratch/lazyboy_mu/authjs_src_0221/`).
