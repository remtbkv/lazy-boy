# SECURITY.md

Security posture and the checklist to clear before a public production deploy. The data is a
database per user (multi-user PLAN §4), named by each user's row in the app database
`lazyboy-app`, which also holds every user's Spotify tokens encrypted under `TOKEN_KEYS`
(Phase 2); the runbooks for a token-key rotation, a restore, a rollback and a suspected
cross-user exposure are at the end.

## Already in place

- **Tokens never reach the browser.** The Spotify access/refresh tokens live in the DB
  (source of truth; the Auth.js JWT cookie is kept lean) and are only read server-side
  (Server Components, actions, route handlers). `src/lib/session.ts` is `server-only`.

  This bullet was aspirational until 2026-08-11 and the audit that day caught it. The session
  callback set `session.accessToken`, and **everything on the `Session` object is serialized to
  the browser by Auth.js at `GET /api/auth/session`** — so any authenticated request to that
  endpoint, i.e. any script running on the origin, got back a live Spotify token with all 13
  scopes, the modify ones included. With no CSP shipped yet, that turned any XSS from session
  theft into Spotify account takeover. Nothing client-side ever used it (the app mounts no
  `SessionProvider`).

  The token now travels server-side only, via `spotifyAccessTokenFor(uid)` in `src/lib/auth.ts`: it
  reads the request-scoped token box that the jwt callback already populated — the same read
  the session callback used to make — so there is no extra DB round trip. **Call it after
  `auth()` in the same request**, never in parallel: the jwt callback is what refreshes an
  expired token and publishes it. Refresh itself stays centralized (rule 3) — this is a bare
  accessor, not a third token path.

  The invariant is enforced by the type, not by discipline: `accessToken` is gone from the
  `Session` interface in `src/types/next-auth.d.ts`, so `session.accessToken` is now
  `TS2339: Property 'accessToken' does not exist on type 'Session'` (verified). Adding any
  field to that interface publishes it to the browser — treat it as a public API.
- **Every entry point takes its user from `requireUser()`** (`src/lib/require-user.ts`), the
  only source of a uid for a request: pages redirect, routes answer 401 with the signed-out
  marker (or 503 when the identity check cannot run), actions answer `{ ok: false }`. A
  session whose Spotify grant is gone is refused everywhere. `/api/now-playing` answers
  `{playing:null}`; `/api/build` is deliberately public and carries no personal data. The
  census (`tests/isolation/entry-points.test.ts`) and the authorization map
  (`docs/multi-user/AUTHZ.md`, every entry point against twelve principals through the real
  Auth.js) fail on an entry point nobody accounted for.
- **The session names its user, checked on every request** (multi-user Phase 1): the cookie
  carries a uid, a session epoch and `auth_time`; the identity check refuses a cookie with no
  uid, an unknown uid, a stale epoch, or a sign-in over 30 days old.
- **A database names its owner.** The first open of a user's database in a process checks its
  `meta.owner_uid` against the uid asking, before any read result is used or any write is
  sent; a mismatch is refused and recorded as an isolation event, which turns the hourly
  health check (`/api/cron/health`) red. Cached reads carry the uid in their key and its stamp
  on their value (`src/lib/user-cache.ts`); the search payloads carry it in their ETag and body
  and are served `private, no-store`; browser storage names carry it, and sign-out clears them.
- **Every page that reads personal data gates for ITSELF**, before its first read. The `(app)`
  layout's `redirect()` is chrome, not the gate: Next renders a layout and its page in
  parallel, so a page under a redirecting layout still runs its fetches and still flushes its
  flight payload into the body of the 307. Measured 2026-08-11 — an unauthenticated
  `curl https://lazy-spotify.vercel.app/playlists` returned 70KB carrying every playlist name
  and cover URL next to `location: /login`; `/home` carried track names, artists and per-day
  play counts; `/usage` carried the ledger. The gate must not sit in a `Promise.all` with the
  reads either, or they run anyway.
- **Centralized token refresh** in `src/lib/auth.ts` (no scattered token handling).
- **No SQL injection.** All libSQL (`@libsql/client`) queries use bound params (`:name`/`?`).
- **Cron auth (fail-closed).** Every `/api/cron/*` route (`sync`, `daily`, `usage-check`,
  `store-bench`, `health`) is session-less; each requires `Authorization: Bearer $CRON_SECRET`,
  checked in constant time (`src/lib/cron-auth.ts`: `cronAuthorized`; `cronCaller` for the
  health check, which also accepts cron-job.org's `CRON_SECRET_EXT`). An unset `CRON_SECRET` rejects every
  caller (it does not wave them through), so no cron route can be triggered anonymously in a
  misconfigured deploy. `store-bench` returns timings and the store's host, never a token.
  `/api/cron/sync` alone also takes `CRON_SECRET_EXT` (cron-job.org's, `cronCaller()`), answers it
  a bare `{"ok":true}` before the tick runs (in `after()`), and does at most one tick per 90 s
  whoever calls (docs/ARCHITECTURE.md).
- **`CRON_SECRET` holders.** A rotation must update every copy, or that caller 401s silently:
  Vercel production env (`CRON_SECRET`, Sensitive: write-only, redeploy to apply); the Mac's
  `.env.local`; the Zenbook's `~/lazyboy-cron/env` (the 2-min `lazyboy-cron-sync.timer`). The
  cron-job.org job's header held a pre-2026-08-10 `CRON_SECRET`; it gets `CRON_SECRET_EXT` instead.
  `/etc/lazyboy-sync.env` (the root `lazyboy-sync.timer`) holds a pre-07-01 secret and is
  slated for removal, not update (burn lazyboy-review 2026-10-03, Z1/Z2).
- **`CRON_SECRET_EXT` holders:** Vercel production env (`CRON_SECRET_EXT`, Sensitive) and the
  cron-job.org job's `Authorization` header. Nowhere else: it opens only `/api/cron/sync`.
- **CSRF.** Auth.js protects its routes; Next.js server actions are POST-only with origin checks.
- **Baseline security headers** in `next.config.ts` (`X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, HSTS).
- **Secrets are gitignored** (`.env.local`); only `.env.example` is committed.
- **Who may sign in.** The `signIn` callback asks the app database (`identity-read.ts
  resolveSignIn`), keyed on Spotify's `account_id`: the admin's row, or, from Phase 4a with
  `SIGNUPS=invite`, an invite Rem approved, claimed once by the account carrying that request's
  signed cookie (`request-cookie.ts`). `SIGNUPS=owner` refuses every row but the admin's at
  sign-in, at every request's identity read and at the cron's claim, so one variable and a
  redeploy freeze every friend. A refused login gets AccessDenied (or a named case on /login)
  before the token is written. The owner-only guard `src/lib/owner.ts` was removed in Phase 4a.
- **Scripts name their user.** Every script that reads or writes a user's database requires
  `--user <uid>`, checked before it opens anything, and refuses a database that names another
  owner (`scripts/script-user.mjs`).

## Before production — checklist

- [ ] **`AUTH_URL`** set to the real HTTPS origin; **`AUTH_SECRET`** is a strong random value
      (`openssl rand -base64 32`), stored in the host's secret manager, not in the repo.
- [x] **User-scope the listen-history store.** A database per user, reached only through
      `forUser(uid)` (multi-user Phase 1), at the database the user's `users` row names
      (Phase 2, with the tokens encrypted in `user_tokens`); Phase 4a adds the first other user.
- [ ] **Spotify's development mode allows five accounts, Rem's included** (the dashboard's
      User Management; multi-user PLAN §13.2, RULINGS Oct 15 12:46 PM). Each friend is added by hand in the dashboard;
      at most four. Other accounts get Spotify's 403 at sign-in. Extended quota is not sought.
- [ ] **Content-Security-Policy.** Add a strict CSP with per-request nonces for Next's inline
      runtime (omitted now because a naive CSP breaks the app).
- [ ] **Rate limiting** on route handlers / server actions (e.g. per-IP or per-user) to protect
      both this app and the Spotify quota.
- [ ] **Input validation** on route params (`q`, `day`, track `uri`/`id`) — currently
      lightly coerced; tighten before exposing publicly.
- [ ] **HTTPS enforced** end-to-end (HSTS is set, but confirm the host redirects HTTP→HTTPS).
- [ ] **No token/secret logging.** Keep the temporary `console.log` debugging out of committed
      code (none currently); scrub any error reporting of tokens.
- [ ] `allowedDevOrigins` is dev-only and harmless in prod, but review it isn't masking a real
      CORS need.

## Rotating a token key (multi-user PLAN §5.3, decision 23: on compromise only)

1. Put the new key first: `TOKEN_KEYS=v2:<new>,v1:<old>` (generated inside the pipe that sets
   it, one copy kept somewhere safe), and redeploy. The first runtime to hold `v2` writes its
   sentinel; new writes take `v2`, old blobs still read under `v1`.
2. Re-encrypt every blob not under the first key (the daily chore, once it exists; until then
   a refresh rewrites each user's blob within the hour).
3. Drop `v1` only after `SELECT count(*) FROM user_tokens WHERE blob LIKE 'v1.%'` reads 0. The
   cold-start check covers the configured keys only: with `v1` dropped early, each blob still
   under it fails one user at a time (a `decrypt` event each, the user left `active`, nothing
   written), and that user signs in again.

## Restores (multi-user PLAN §12.5)

Every Turso restore makes a database with a new name (point-in-time and dump restores alike),
and the app follows `users.db_name` on every request, so a new name is safe.

- **A user's database** (Rem's or a friend's): create it from point-in-time or a dump; check its
  `owner_uid`; write a new `store_epoch`; set the user's `sync_state` to `paused` (Phase 3);
  move `users.db_name` to the new name; delete the old database's `owner_uid`, so any process
  still holding it refuses it at its next open; resume. A warm instance reaches the new name at
  the user's next identity read (or claim): `forUserAt` drops the old name's client and open
  verdict and checks the new database's owner. Rem's database restored from a nightly backup
  holds no plaintext token; his token is in `user_tokens`, which the restore does not touch.
- **`lazyboy-app`**: the restored copy revives what changed since it was taken, so before the
  pingers resume: delete every `users` row whose `lb-u-<uid>` database no longer exists
  (`turso db list`), re-run their telemetry deletion, re-apply every deletion and disable
  recorded since the copy in the telemetry store's lifecycle log, bump every `session_epoch`
  (sessions ended since the copy stay ended), then resume. Point `APP_DATABASE_URL` at the new
  name and redeploy. Its `user_tokens` blobs need the same `TOKEN_KEYS`.
- **Restore `lazyboy-app` from Turso's point-in-time history** (one day on the free plan): it
  holds every user's rows. The nightly copies on the Zenbook and OneDrive hold the admin's rows
  alone (RULINGS Oct 15 6:21 PM; `ops/zenbook-backup/backup.py` `keep_admin_app_rows`), so a
  restore from one brings back no friend: every `lb-u-<uid>` in `turso db list` is then a database
  no `users` row names, which no session, tick, Disconnect or daily chore reaches, and nothing
  ever removes. A friend's data is kept only while they stay connected and goes within five days
  of leaving, so after such a restore, the same day: list those databases, tell each friend their
  account was lost, and for each insert a stub row (`INSERT INTO users (uid, spotify_id, db_name,
  status, status_at, is_admin, session_epoch, invited_at) VALUES ('<uid>', 'orphan:<uid>',
  'lb-u-<uid>', 'disabled', <now ms>, 0, 1, 0)`; `disabled`, so no tick or session takes it) and
  run `node scripts/user.mjs --remove <uid>`, which destroys the database, deletes the uid's
  telemetry and logs it (`tests/isolation/t11-deletion.test.ts` runs this stub through the job).
  A friend who wants back is invited again, with a new uid and an empty history.
- **Rehearsed** before the first friend: restore a throwaway user's database under a new name,
  see the app serve from it, destroy it.

## Rollback (multi-user PLAN §13.5)

1. **Revert the phase's merge on `main` and push.** An ordinary production deploy of the old
   code on today's environment; it survives the morning push and keeps domain assignment on.
2. **Instant Rollback only as a stopgap** while the revert builds, and only when the previous
   deployment is the pre-phase build and no secret or store credential changed in between.
   That rules it out across Phase 0 and Phase 1 (`AUTH_SECRET` rotated), Phase 2 (the
   `lazyboy` token invalidated) and Phase 4a (friends' cookies would meet pre-friend code).
   Undo Rollback once the revert is live.
3. **Environment changes are additive**, or the phase says why the older build works with the
   new value. Phase 1's four `meta` keys and `OWNER_UID` are ignored by the build before it.
4. **Schema state**: additive steps leave `min_reader`, so the older build opens the database;
   a rebuild raises it, and that phase's rollback is the migrate script's reverse step.
5. **After each secret rotation**, once the new build has run a day, delete the production
   deployments built before it (`vercel rm <url>`), so no rollback can bring the old secret
   back or put single-user code in front of a friend's cookie.
6. **Rehearse it** on Rem alone inside the phase's soak.

**Phase 2's cell** (PLAN §11.4 "Rollback"). The build before Phase 2 reads Rem's plaintext
token row in `lazyboy.meta`, which Phase 2 keeps for a week after the move:

- **Inside the week**: revert and push. The older build runs on the group token, which reaches
  `lazyboy`, and reads the plaintext row; an access token past its expiry is renewed by the
  unchanged refresh token. If Rem pressed Log out under Phase 2, the plaintext copy went with
  his row, so he signs in once.
- **After the week** (the plaintext row deleted, §11.4 step 6): set `LB_TOKEN_ROLLBACK=1` in
  Production and redeploy Phase 2 first. Rem's next token read in each process writes his
  plaintext row back from his blob (`[token-move] rollback: … written back from the blob`) and
  every later write of his tokens is mirrored there. Check the row exists, then revert.
- Never Instant Rollback across Phase 2: every deployment before it holds the invalidated
  `lazyboy` token. A rollback to a build from before the interim pinger's guard pauses the
  cron-job.org job first.

## Inviting a friend (multi-user Phase 4a; PLAN §12.1 as RULINGS Oct 15 12:46 PM rule it)

Two gates, both needed: Spotify's User Management list (five accounts in development mode, Rem's
included) and an invite in the app database. Production runs `SIGNUPS=invite`; `owner` freezes
every friend with one redeploy.

1. The friend asks at `/join`: the e-mail on their Spotify account, a name or none, and the
   policy and terms accepted. The form stores one request (`app-db.ts createJoinRequest`, capped
   in SQL: 5 an hour, 8 waiting, none once 5 places are held) and leaves a signed request cookie
   for two days. It creates no database and calls nothing outside the app database.
2. Rem, in his own terminal (it prints e-mails, so it refuses inside a Claude Code session):
   `node scripts/invite.mjs --list`.
3. Rem adds the e-mail in the Spotify dashboard's User Management.
4. `node scripts/invite.mjs --approve <request id>`: reserves the uid, creates `lb-u-<uid>`
   with the Keychain's platform token, applies the user schema and its four `meta` keys, marks
   the row `invited` and prints the join link (14 days). `--decline <request id>` drops a
   request; `--revoke <uid>` withdraws an unclaimed invite and destroys its empty database.
5. The friend connects, from the browser that filled in the form or through the link; their
   sign-in claims the invite once, by compare-and-set (`claimInvite`; T9,
   `tests/isolation/claim-signin.test.ts`). An unclaimed invite expires on its 14th day.

## Deleting a friend's data (PLAN §12.3; decision 21 as ruled: never Rem's)

- **Their choice**: `/disconnect` (the export first, the typed word, a sign-in within ten
  minutes). The job runs at once; its last step waits out the 50-s lease window and finishes in
  `after()` or at the next daily run.
- **Rem's**: `node scripts/user.mjs --remove <uid>` with `TELEMETRY_DATABASE_URL` and
  `TELEMETRY_AUTH_TOKEN` in the shell (after a friend asks by e-mail, or after the health check
  reports them `removed` from the allowlist for a week). `--disable` / `--enable` end and restore
  their sessions and sync without deleting.
- **Automatic**: day 4 of a confirmed revocation, held while an app-wide `invalid_grant` event
  stands, run by the daily chores (`/api/cron/daily`, and the tick when they are overdue), which
  also retry any deletion still `deleting`.
- **What it removes**: the sessions (epoch + 1), the token, queue, lock and request rows, the
  database `lb-u-<uid>` (Turso's Platform API, `TURSO_PLATFORM_TOKEN`, Production only), their
  rows in every telemetry table with a `user_id` column (api_log, client_metrics, the meter's
  cpu_meter), then the users row becomes `deleted` (uid, account_id, status, date) for at most five
  days. While that row is kept, every daily run deletes the uid's telemetry rows again (a request or
  task in flight writes after the job) and expires the uid's entries in Vercel's Data Cache (the
  `u:<uid>` tag userCache puts on each). It refuses the admin, any row not naming `lb-u-<uid>`,
  and any database whose `owner_uid` is someone else's (T11). Backups hold no friend's data to
  delete (`ops/zenbook-backup`: the nightly job deletes any `lb-u-` copy first and checks that none
  is left). The browser that disconnects clears its copies before the action runs.
- **Check it finished**: `/api/cron/health` turns red (`deletion`) on a user `revoked` or
  `deleting` for over a day; the users row reads `deleted`; `turso db list` has no `lb-u-<uid>`.

## A suspected cross-user exposure (multi-user PLAN §13.6)

For an isolation event that is not a test, a friend's report, or anything else that suggests
one person saw or changed another's data:

1. **Freeze**: set `SIGNUPS=owner` and redeploy; every non-admin session ends at its next
   request and every non-admin sync at the next claim.
2. **Keep the evidence**: the isolation events and their codes (`client_metrics` rows with
   event `isolation` in Phase 1, `events` from Phase 2), `api_log` by `user_id` for the
   window, the deployment id, the request ids in Vercel's logs while they last (about an hour
   on Hobby).
3. **Work out whose data reached whom**, from the codes and the logs.
4. **Within 24 hours of suspecting it**, write to `security@spotify.com` (Developer Terms, Data
   Protection Appendix §9) and tell the affected friend directly.
5. **Fix**, move the affected shape tokens so every cached body is rebuilt, and run the whole
   suite with its planted-bug self-test.
6. **Unfreeze**, and add the case to the isolation suite.

---

**Related:** [ARCHITECTURE → Auth & tokens](ARCHITECTURE.md#auth--tokens) (how refresh is
coordinated) · [GOTCHAS → Per-instance server state / Production security](GOTCHAS.md) ·
[ROADMAP](ROADMAP.md) · [multi-user PLAN](multi-user/PLAN.md) and [Phase 1](multi-user/PHASE1.md).
