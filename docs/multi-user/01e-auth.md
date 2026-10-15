# 01e — Authentication and secrets: how it works today, and what multi-user must change

Lane 0221_lb_mu_ov_auth, Oct 14, 2026. Planning only: nothing here changed code, data, the Zenbook
store or Vercel. Line numbers are against commit `ac6f7fe`. Every number says how it was measured or
that it is an estimate.

Status: outline — sections fill in order; each is committed as it lands.

## 0. Summary

## 1. Sign-in today, end to end

Library versions: `next-auth` 5.0.0-beta.31 and `@auth/core` 0.41.2 (`package-lock.json`). This
checkout has no `node_modules`, so library behaviour below was read from those two published
tarballs (`npm pack`, extracted to the lane's scratch); a citation like `@auth/core jwt.js:46` points
into them.

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
  wins (`tests/owner-signin.test.ts:33-38`). `owner.ts:7` says `SPOTIFY_OWNER_ID` is set in production;
  I did not read Vercel's env to confirm it. The Mac's `.env.local` does not set it (its key names,
  read 2026-10-14), so a local dev server, which points at the production store, falls back to
  production's `me_id`.

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
  (`@auth/core lib/utils/cookie.js:45-48`). Its value is a JWE (`alg: dir`, `enc: A256CBC-HS512`,
  `jwt.js:46-47`) under a key HKDF-derived from `AUTH_SECRET` with the cookie name as salt
  (`jwt.js:110-122`). The browser can neither read nor forge it; whoever holds `AUTH_SECRET` can mint
  one for anybody.
- Payload: `name`, `email` (empty in development mode, §1.1), `picture`, `sub` (the random UUID),
  `iat`, `exp`, `jti`, `error` when set, and Spotify tokens only in the §1.3 fallback.
- Wherever Auth.js can set a cookie (route handlers, server actions), the session action re-encodes the
  JWT with a fresh 30-day expiry (`lib/actions/session.js:21-48`). A session in regular use never
  expires.
- Two things end a session early: a jwt callback that returns `null`, after which the session action
  clears the cookie (`lib/actions/session.js:34, 55`), and rotating `AUTH_SECRET`, which ends every
  session at once. Today's jwt callback never returns `null`.
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
revoked at Spotify. The app calls no revocation endpoint and I found none in Spotify's Web API docs
(users revoke at spotify.com/account/apps). The deleted refresh token stays valid at Spotify (§2.1),
as do its copies in the backups.

### F1 — sessions minted before the owner guard still act as the owner (open now)

Sessions carry no identity (§1.3), every request reads the single token row (§2.1), and the guard runs
only at sign-in (§1.2). The second account that completed sign-in on Oct 14 therefore holds a session
cookie that stays valid until 30 days after its last use. With the owner's token back in the row, that
browser renders the owner's history and library, its server actions edit the owner's playlists and
drive the owner's playback, and its "log out" deletes the owner's token row, which stops capture. Its
chrome still shows the second account's name and avatar. This holds unless `AUTH_SECRET` was rotated
after the incident; I could not check (I did not read Vercel's env, and no doc records a rotation).

Smallest fix: rotate `AUTH_SECRET` in Vercel production (`openssl rand -base64 32`, Sensitive) and
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

- Production's refresh token had the same prefix (`d30e33fe`) on Oct 1, 8 and 14 while `expiresAt`
  advanced (09:23, 08:51 and 09:14 UTC): two weeks of hourly refreshes and no rotation.
  docs/quota-forensic/BRIDGE.md found the same on Aug 8. docs/GOTCHAS.md's "PKCE refresh token rotates
  on every use" does not describe this app's grant today; Spotify's wording is "Depending on the grant
  used to get the initial refresh token, a refresh token might not be included in each response"
  (https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens).
- Two grants for Rem's account are live at once. The production row and the recorder's chain
  (`35fbe7ac`) both refreshed today (the recorder's `expires_at` is Oct 15 02:15 UTC). The recorder's
  refresh token is byte-identical to the `spotify_tokens_dev` row in the store, in every snapshot, and
  in the Mac's `data/replica.db`. The recorder and the Mac's `.env.local` use the same client id (hash
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
since been migrated or expired, so today the migration only finishes what the fallback started.

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
(not values) in the Mac's `.env.local`, docs/STORE_MIGRATION.md §3 for Vercel, docs/SECURITY.md:49-54
for `CRON_SECRET`, docs/quota-forensic/BRIDGE.md:165-182 and an `ls -la` on the Zenbook for its files
(2026-10-14). I read no Vercel env, so where a secret sits there comes from those docs.

| secret | read by | held in | unlocks today |
|---|---|---|---|
| `AUTH_SECRET` | Auth.js (`next-auth lib/env.js:22`) | Vercel; Mac `.env.local` | minting a session cookie, which today is full owner access (F1) |
| `SPOTIFY_CLIENT_SECRET` (+ public `SPOTIFY_CLIENT_ID`) | `auth.ts:100, 310` | Vercel; Mac `.env.local`; Zenbook `~/lazyboy-recorder/config.json` (0600) | refreshing any stored refresh token; impersonating the app at Spotify |
| `TURSO_AUTH_TOKEN` (+ `TURSO_DATABASE_URL`) | `db.ts:128-129` | Vercel Production and Preview (STORE_MIGRATION.md:69-71); Mac `.env.local`; Zenbook `~/lazyboy-sqld/jwt-token.txt` (0600) | the whole store, read and write, token rows included, from anywhere (the hostname is public) |
| sqld signing key | sqld (`--auth-jwt-key-file` holds the public half) | Zenbook `~/lazyboy-sqld/jwt-private.pem` (0600, BRIDGE.md:169) | minting store tokens: same as the row above |
| `TURSO_PLATFORM_TOKEN` (+ `TURSO_ORG`) | `/usage` render (`src/app/(app)/usage/page.tsx:85-86`), `/api/cron/usage-check` (`route.ts:124-136`) | Vercel Production; Mac `.env.local` | the Turso org's platform API; after STORE_MIGRATION, minting a token for the core database |
| `CRON_SECRET` | `cron/sync/route.ts:61-66` (constant-time compare), `cron/usage-check/route.ts:120` | Vercel (Sensitive); Mac `.env.local`; Zenbook `~/lazyboy-cron/env` (0600); stale copies in the cron-job.org job and `/etc/lazyboy-sync.env` (SECURITY.md:49-54) | running the sync and usage-check routes on demand |
| `CRONJOB_API_KEY` (+ `CRONJOB_JOB_ID`) | `src/lib/cronjob.ts:17-36` | Vercel Production | the cron-job.org account's jobs (that branch has not run since Aug 10, STORE_MIGRATION.md:72-77) |
| Vercel CLI token | the tunnel updater, retired | Zenbook `~/lazyboy-tunnel/env` (0600, BRIDGE.md:175); dead since Aug 9 (STORE_MIGRATION.md:363) | nothing while dead; a live one reads and writes every secret above |
| rclone OneDrive token | `backup.py` | Zenbook rclone config | the 60 days of backups, which hold token rows (F2) |
| Spotify refresh tokens | §2 | §2.1's table | the user's Spotify account, 13 scopes |

Not secrets, for completeness: `SPOTIFY_OWNER_ID`, `AUTH_URL`, `TURSO_DATABASE_NAME`. The repo is
public (`gh repo view`: `PUBLIC`) and BRIDGE.md:182 states no secret value is committed; a pattern scan
for JWT, Spotify-token and PEM shapes (`git grep -E 'eyJ…|AQ…|BQ…|-----BEGIN'`) found none.

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

## 5. What multi-user must change

### 5.1 Identity: the session must name the user
### 5.2 Per-user token rows, locks and request boxes
### 5.3 Encryption at rest and key handling on Vercel
### 5.4 Sign-up gating in place of the owner guard
### 5.5 Account linking
### 5.6 Session fixation, sign-out and server-side revocation
### 5.7 When a user revokes the app
### 5.8 Account deletion
### 5.9 Session-less paths acting for N users

## 6. What multi-user needs from STORE_MIGRATION.md

## 7. Decisions that are Rem's

## 8. Unknowns and what I did not verify
