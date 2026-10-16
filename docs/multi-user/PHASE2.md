# Multi-user Phase 2, built ahead of its turn

Lane 1945_lb_mu_02_p2_build, Oct 15, 2026, branch `mu/phase2`, cut from `mu/phase1` at `84182e5`. Nothing
here is merged, pushed or deployed. Nothing touched production data, the Zenbook, Vercel, Turso or the
Keychain: the script ran only against a scripted Platform API and local database files.

Status: complete for this lane, Oct 15, 2026, about 10:30 PM. §2 is what landed, §3 what proves it, §4 what
is left and why, §5 how to review.

## 1. What this branch is

PLAN.md §13.4 lets a lane build a phase early, in new files and in files no queued lane edits; this lane's
brief narrowed that to new files and the files `mu/phase1` changed. So the branch edits, of Phase 1's files,
`src/lib/auth.ts`, `identity.ts`, `session-gate.ts`, `token-core.ts`, `isolation.ts`, `CLAUDE.md` and the
isolation suite's harness, planted bugs, static checks and two test files, and deletes Phase 1's
`token-store-owner.ts` with its test, which this branch left with no caller. Everything else is new.
`git diff --stat mu/phase1...mu/phase2` lists exactly these.

What a deploy of this branch needs (lane 22, PLAN §11.4 steps 1-3): `APP_DATABASE_URL` (an `https://` URL)
and `TOKEN_KEYS` in Production, a `TURSO_AUTH_TOKEN` that reaches `lazyboy-app` (step 2's group token), the
admin's `users` row (the script's step 1), and Phase 1's `OWNER_UID`. What Rem would notice: nothing, if
those are set. His Phase 1 cookie names `OWNER_UID` at epoch 0, which is the admin row, so he stays signed
in; his first token read copies his plaintext token into `user_tokens`. With `APP_DATABASE_URL` or
`TOKEN_KEYS` missing or wrong, every request answers the retryable "unavailable" (a 503, or the error page
with a retry), nobody is signed out and no user state is written; the next correct deploy serves again.

One dependency to know before the turn: **sign-in now needs Spotify's `account_id` on the profile**
(PLAN §5.1). A sign-in whose profile lacks it is refused. Rem's existing cookie keeps working for up to 30
days without a sign-in, so this bites at his next sign-in. Lane 01's probe (`rem_dev_signin`) answers
whether `/v1/me` sends `account_id`; if it does not, Phase 2 stops at §11.4 step 1 (decision 31).

## 2. What is built

Each item names the PLAN.md section it implements.

- **The app database** (§4.2, §4.5): `src/lib/app-schema.ts` holds `APP_SCHEMA` as versioned steps
  (`users` with its open-invite index, `user_tokens`, `sync_state`, `events`, `app_meta`), the statements
  that bring a database to the code's version with `schema_version` and `min_reader` in the same batch, and
  the admin row's insert. It imports nothing, so the Mac script loads it under plain Node.
  `src/lib/app-db.ts` holds every statement the runtime runs on `lazyboy-app`, and the client: one per
  process, over `makeStoreFetch` (imported), `https://` only. `APP_DATABASE_URL` unset means dev: a file
  `app.db` beside the dev store's file (`data/` in dev, the throwaway directory under `npm test`). A
  deployment (`VERCEL_ENV` production or preview) without it refuses; a remote URL anywhere but production
  refuses, so dev never holds production's URL. The first open applies additive steps where §4.5 allows
  (production, or dev's own file), refuses a database whose `min_reader` is above the code, and refuses
  anything behind elsewhere.
- **The users lifecycle** (§4.2): `moveStatus`, the one writer of `users.status`, a compare-and-set from the
  status the caller read, stamping `status_at`. The statuses are PLAN's minus `dormant` (RULINGS Oct 15,
  12:26 PM: friends' history kept while connected, no idle pause).
- **The identity read** (§5.1, §12.1): `readIdentityRow` is §5.1's one statement. `src/lib/identity-read.ts`
  turns it into `appIdentityLookup`, identity.ts's `IdentityLookup` with Phase 1's signature (it replaces
  `ownerOnlyLookup`, now removed), after the token-key check; `readIdentity` runs it through `checkIdentity`
  under the deployment's `SIGNUPS`, so `SIGNUPS=owner` (or unset) refuses every non-admin row whatever it
  says. Its three outcomes: allowed; refused (no uid, unknown uid, a status other than `active` or
  `needs_reconnect`, a stale epoch, a sign-in over 30 days old, a non-admin under `owner`); unavailable (the
  read threw, or the keys failed their sentinel). auth.ts's jwt and session callbacks use it.
- **Sign-in by account_id** (§5.1): `resolveSignIn`, the signIn callback's decision. No `account_id` on the
  profile: refused and logged, never keyed on `id`. A row with that `account_id`: `active` signs in,
  `needs_reconnect` and `revoked` return to `active` by compare-and-set (a fresh consent is what they waited
  for), `disabled` is refused with "ask Rem", `deleting` and `deleted` with the date. A changed Spotify `id` is
  followed onto the row. No row: the admin row naming that Spotify id, with `account_id` still NULL, is bound
  once (§11.4 step 1); anyone else is AccessDenied, since the invite claim waits for Phase 4a.
  `SIGNUPS=owner` refuses every non-admin here too. The jwt callback's sign-in branch puts the row's uid and
  epoch on the cookie (`signInClaims` takes the row), never the profile's.
- **Tokens per user** (§5.2-5.3):
  - `src/lib/token-crypto.ts`: AES-256-GCM, a random 12-byte IV per write, `v<n>.<base64url(iv ‖ ciphertext
    ‖ tag)>`, both tokens in one blob, associated data `lazyboy:tokens:v1:<uid>`. `TOKEN_KEYS`
    (`v2:<base64>,v1:<base64>`) parsed strictly; the first key writes, reads pick by prefix.
  - `src/lib/token-keys.ts`: one sentinel blob per configured key in `app_meta` (`sentinel:<id>`), written by
    the first runtime that holds the key (§11.4 step 1: from the runtime, not the Mac), checked before any
    token is read or written; a missing, malformed or wrong key refuses with a log line.
  - `src/lib/token-store-app.ts`: the `TokenStore` over `user_tokens`. A sign-in's write lands only while
    the user is `active`, `needs_reconnect` or `revoked` (PLAN's list minus `dormant`) and throws otherwise;
    `granted_at` moves only when the refresh token being written differs from the stored one. One lease per
    user, `lock:spotify_refresh:<uid>`. A blob that fails to decrypt records a `decrypt` event with the uid
    and never the blob, writes nothing about the user, and fails the read.
  - `src/lib/token-core.ts`: the store names the row it read (`rev`, the blob). A refresh writes only over
    that row; if a sign-in wrote a newer grant meanwhile, the refresh stores nothing and answers with it, and
    if the row is gone (the deletion job's first step) it stores nothing at all. A dead grant clears only the
    row it read. No row means nothing to refresh.
  - auth.ts: the two paths that parked tokens in the cookie when the store write failed are gone (§5.1); a
    sign-in that cannot write its row fails visibly.
- **The admin's token, moved by the runtime** (§11.4 step 3, "Rollback"; security R9):
  `src/lib/token-move.ts`. The admin's first token read in a process, finding no `user_tokens` row, encrypts
  his plaintext `meta.spotify_tokens` row from `lazyboy`, reads it back and logs `[token-move] admin <uid>:
  the blob written decrypts to the plaintext row`. `app_meta` `token_copy:<uid>` makes it once ever, so a
  cleared dead grant never brings the old plaintext token back, and a row a sign-in wrote first is never
  overwritten. `LB_TOKEN_ROLLBACK=1` writes the plaintext row back from the blob at the admin's first read
  and mirrors every later write of his tokens. auth.ts wraps its store with it, so the tick's
  `getValidAccessToken()` is what triggers the copy.
- **Isolation events** (§6.5): `reportIsolation` also writes `lazyboy-app.events` (uid, code, time),
  awaited; the log line and the telemetry row stay. An unreachable app database costs the row, logged, not
  the other two. The token core's owner assertion records a `token-owner` event with the caller's uid
  before it throws (added by lane 03's review).
- **`scripts/phase2-app-db.mjs`** (§11.4 steps 1 and 5): with the platform token from the Keychain item
  `lazyboy-turso-platform` (read into memory, never printed) it creates `lazyboy-app` in group `default`,
  applies `APP_SCHEMA`, and inserts the admin row from `OWNER_UID` and `SPOTIFY_OWNER_ID` with `account_id`
  NULL. Re-runnable; `--dry-run` writes nothing. `--snapshot-out F` records `lazyboy`'s seven counts,
  `max(played_at)` and meta key names (never values) before step 2; `--verify --snapshot F` runs step 5's
  checks on one-hour read-only tokens: schema version, one admin row, an encrypted token row, the runtime's
  copy marker, a sentinel, no events, counts and `max(played_at)` against the snapshot, no meta key removed
  (`plsnap:` and `lock:` excepted), Phase 1's four keys, `spotify_tokens` still present, and
  `verify-derived.mjs`. It prints the two checks only a person can make. It refuses to run with
  `TOKEN_KEYS` set.
- **T12's harness** (§6.4): `tests/t12-phase2-rehearsal.test.ts`, below.
- **Docs**: CLAUDE.md's file map. This file.

## 3. The tests, and what each proves

All in the simulated environment (`npm test`): local SQLite files, a scripted Spotify, a scripted Platform
API; no store, no Spotify, no Vercel. 97 new tests. Gates on the branch head: `tsc --noEmit` clean, lint
clean, `npm run build` passes with no store variables set, the three node suites pass, and vitest passes
706 of 708: the two failures are the date time-bombs `mu/phase1` inherited from `main` at `6577f4b`
(`store-plays.test.ts` "daily stats agree…", `sync-history.test.ts` "harvests, resolves context names…",
QUEUE.md T1), identical before this lane changed anything. Their fixed versions (`ca44438` on
`store-split`) pass against this branch; the turn's rebase brings them in.

**Red first.** Each new check was shown failing before it was trusted (RULES 9):

| check | shown failing against |
|---|---|
| `token-core`: a refresh finishing after a sign-in leaves the sign-in's grant; one finishing after the row is gone stores nothing | Phase 1's core, which wrote with the unconditional `set` |
| `token-store-app`: a decrypt failure records an `events` row | Phase 1's `isolation.ts` (no events row) |
| `app-db` | seven mutations, each red: the refresh write without its blob compare, the sign-in write without the live-owner check, the status write without its compare, the client without the store fetch, `granted_at` moving on every write, unlisted `app_meta` keys accepted, the admin binding without `is_admin` |
| `token-store-app`, `token-keys` | five mutations: `granted_at` always moving on refresh, the decrypt event dropped, a sign-in always moving `granted_at`, the sentinel compare skipped, the key check skipped |
| `identity-read` | five mutations: the `SIGNUPS` check at sign-in, `SIGNUPS` in the read, the deleted branch, the key check before the read, the `account_id` lookup. Later, its own test: a sign-in `SIGNUPS=owner` refused still moved a revoked friend back to `active` (the compare-and-set ran before the check); every refusal now comes before any write |
| `token-move` | five mutations: the once-ever marker check, the rollback mirror, every uid treated as the admin, the flag ignored, the marker never written |
| `phase2-app-db` | seven mutations: the `TOKEN_KEYS` refusal, `--verify` on a full-access token, `--dry-run` writing, the events check, the removed-key check, the admin row binding `account_id`, a re-run rewriting the row |
| S3 | an export added to `app-db.ts` (a read of every user's tokens), and one dropped |
| T12 | the runtime's copy bypassed: three of seven red. Its first run also failed on `--verify` reporting `lazyboy-app` missing, a harness bug (the scripted API forgot step 1's database between runs) |

**Planted bugs** added to `tests/isolation/planted-bugs.test.ts`, each caught and each passing over the real
code, kept for good (PLAN §6.4): a cipher that drops the associated data; a cipher that reuses its IV; a
refresh write that is not conditional; a `TokenStore` that answers another uid's row; an identity read that
ignores `SIGNUPS`. Lane 03's review added a key check that opens only the first key's sentinel (no test
pinned "one sentinel per configured key" until then).

| file | what it proves |
|---|---|
| `token-crypto.test.ts` | `TOKEN_KEYS` parsed in order with the first key writing; empty, unnamed, short, long, duplicate and non-base64 keys refused. The blob round-trips, names its key, is `iv ‖ ciphertext ‖ tag`, holds no token in the clear; A's blob does not decrypt as B; 64 writes take 64 IVs; a tampered byte, an unknown key id, a wrong key and garbage fail closed; the error names no part of the blob; an older key's blob reads once a new key is first, and new writes take the new key |
| `app-db.test.ts` | where the app database is in dev, production and Preview, and every refusal; the client's requests carry the gzip pin through the store fetch's three attempts; the first open creates every table at the code's version; `min_reader` above the code refuses; a database behind is brought up only where applying is allowed. `moveStatus`: moves from what it read and stamps `status_at`, loses to an earlier move, a sign-in and the deletion job cannot both win, no `dormant`. The identity read's columns. T6's half for Phase 2: the sign-in lookup returns only its `account_id`'s row, the admin binding takes only the admin row naming that Spotify id and only once, `app_meta` accepts only the listed keys. Per-user leases. The sign-in write only for a live owner (three statuses yes, four plus an unknown uid no); a refresh write only over the blob it read, `granted_at` moving only when rotated; a clear only of the row read; the copy never overwriting; an events row |
| `token-store-app.test.ts` | T5's token half over the real store: ciphertext at rest under the user's associated data; each uid its own row; two users refreshing at once each end with their own token after one call each; A's lease does not delay B; `invalid_grant` for A leaves B's blob byte for byte; no row, no Spotify call; a refresh after a sign-in leaves the sign-in's grant and `granted_at`; a refresh after the deletion job's first step stores nothing, and so does a sign-in; `granted_at` kept across a sign-in and a refresh with the same refresh token and moved by a new one; A's blob in B's row is a `decrypt` event for B with no blob in any log line, B's `users` row and token row unchanged, no Spotify call. Sentinels: written at first boot; a wrong key refuses reads and writes, logs, leaves users `active` and writes no event, and the right key resumes with no sign-in; missing or malformed keys refuse; a new key put first gets its own sentinel, old blobs read and new writes take it |
| `identity-read.test.ts` | T5's identity half: Rem's Phase 1 cookie is allowed; refused for no uid, an unknown uid, a stale epoch, a 31-day-old sign-in, each status but `active` and `needs_reconnect`, and a friend under `SIGNUPS=owner` or unset; unavailable when the read throws (cookie unchanged, no uid, `idUnavailable` on the session, the gate answers unavailable) and when the key fails its sentinel (users untouched). T9's `account_id` half: a profile without one refused with nothing keyed on its `id`; a returning user found after their `id` changed, the row following it; a deleted user told the date, deleting refused, disabled told to ask Rem; `needs_reconnect` and `revoked` back to `active`; `SIGNUPS=owner` at sign-in, writing nothing (a revoked friend stays revoked); the admin binding once and nobody else; the cookie's claims from the row |
| `token-move.test.ts` | the copy: encrypted, verified, logged, plaintext left in place; once ever; never over a sign-in's row; only the admin; nothing without a plaintext row or a live admin; the copied token refreshes. The rollback: plaintext written back from the blob and every later write mirrored; no other user's write touches it, and nothing is copied |
| `isolation-events.test.ts` | an event writes the events row, the telemetry row and the log line with the uid and code only; with the app database unreachable the log and telemetry still happen |
| `phase2-app-db.test.ts` | the refusals (`TOKEN_KEYS` set, before any call; a malformed `OWNER_UID`; no `SPOTIFY_OWNER_ID`; `lazyboy-app` in another group); `--dry-run` makes one GET and opens nothing; step 1 creates `lazyboy-app` in `default` with the platform token as bearer and never prints it, mints one full-access hour, writes the exact admin row and the two version keys and no token row; a re-run creates nothing and leaves the row; `--snapshot-out` writes counts and key names, never the token value; `--verify` passes once the runtime has run, on read-only tokens, and fails on each of eight things step 5 must catch |
| `t12-phase2-rehearsal.test.ts` | T12, below |
| `static.test.ts` | S3: `app-db.ts`'s exports equal a reviewed snapshot. S4 gains two reviewed entries: the app-database client (keyed by URL) and the key check's verdict |
| `token-core.test.ts`, `identity.test.ts` (changed) | the memory store now versions its rows; the conditional-write cases above; `signInClaims` takes the row |

**T12** (PLAN §6.4): `T12_BACKUP=<file> T12_REPORT=<file> npx vitest run tests/t12-phase2-rehearsal.test.ts`
takes a nightly backup (`.db`, `.db.gz`, `.sql`, `.sql.gz`), copies it into a throwaway directory and
rehearses §11.4 there: it refuses a backup that still holds a token row, plants a synthetic one (and Phase
1's four meta keys if the backup predates Phase 1's deploy, as lane 14 writes them), snapshots, runs the
script's step 1 against a scripted Platform API, runs the runtime's first boot and tick (sentinel, the copy
and its log line, one refresh), runs `--verify` with `verify-derived.mjs` on the copy, checks Rem's Phase 1
cookie through the identity read, checks the copy left `lazyboy`'s tables as they were, and runs the
rollback flag. The one check that cannot pass on a copy is `max(played_at)` moving, since a copy captures
nothing; the test expects exactly that one. The report holds aggregates only, and the copy is deleted.
Without `T12_BACKUP`, `npm test` runs it on a synthetic backup written by `db.ts`'s own write path and
gzipped, so the harness stays tested; the `.sql` path has not run on a real dump.

## 4. Left for Rem's decisions, or for the turn

**Waiting on a decision of Rem's** (PLAN §18's last table, Phase 2 row): `lazyboy-app` as a database of its
own and §11.4's steps on Rem's data (decision 11, approved Oct 15 6:21 PM; lane 22 runs them at the hour Rem
picks, `rem_token_move_hour`); the platform token in the Keychain (decision 24; lane 22 moves it there);
`account_id` (decision 31, only if lane 01's probe shows it absent).

**Left for the turn** (lane 15), each because it sits in a file queued lanes edit or outside this lane's
boundary:

1. **`db.ts`'s meta token functions leave their callers.** Three callers still read or clear the plaintext
   row, and each is wrong once tokens live in `user_tokens`:
   - `/api/cron/sync` decides "no token" (503, capture stopped) with `getSpotifyTokens()`. While the
     plaintext row stays (a week), a cleared admin grant reads as a store hiccup (200 "skipped"). It should
     read the admin's `user_tokens` row (`readTokenRow(ownerUid)`).
   - `getCaptureHealth()` in `db.ts` (the banner and the health check) tests the meta key. Before §11.4 step 6
     it never sees a dead grant; after it, it reports "no token" for good. Same fix.
   - `logout` in `actions.ts` clears the meta row, so under Phase 2 logging out no longer stops capture,
     which RULINGS Oct 15 1:33 PM requires. It should clear the user's `user_tokens` row (Phase 4a then
     splits Log out from Disconnect).
   After step 6, `get/set/clearSpotifyTokens` stay only as token-move.ts's plaintext reader and writer,
   until the rollback window closes.
2. **`forUser` takes `db_name` from the identity read**: `readIdentityRow` already returns `dbName`;
   `forUser` is Phase 1's turn work in `db.ts`.
3. **One round trip per request**: the identity read returns the token columns (§5.1), but the jwt callback
   still reads the token through the store, a second statement. Seeding the request's token box from the
   identity row saves it; it touches the token box in auth.ts and the store's decrypt path together, so it
   belongs with the turn's measurements (I$).
4. **The sentinel check at cold start** runs on the first identity read or token use in a process, which
   every gated request makes; wiring it into `instrumentation.ts`'s `register()` (queued) makes it truly at
   boot.
5. **`.env.example`**: `APP_DATABASE_URL` (unset in dev), a dev `TOKEN_KEYS`, `LB_TOKEN_ROLLBACK`, and that
   production's `TURSO_AUTH_TOKEN` is the group token, which `app-db.ts` uses for `lazyboy-app` too.
   `store-split` edits the same file.
6. **README.md's deploy and local-start steps** (PLAN §12.1), **SECURITY.md's runbooks** (§12.5, §13.5,
   §13.6) and its checklist's 25-user line, **ARCHITECTURE.md**'s and **GOTCHAS.md**'s lines saying tokens
   live in `meta.spotify_tokens`. Not this lane's files, or files queued lanes edit. Dev sign-in needs an
   admin row in dev's own `app.db`; `npm run setup` creates one in Phase 4a (T18), and until then README's
   local-start step says how.
7. **/login's wording** for the new refusal codes: `signInRefusalMessage` (identity-read.ts) holds it;
   `src/lib/login-error.ts` calls it, with the `on=` date for a deleted account. Until then /login says
   "Sign-in didn't complete (AccountDeleted)".
8. **The health check reads `events`** instead of listing isolation as unchecked: the read is one
   `count(*)`, but marking a row `alarmed` is §7.10's and arrives with Phase 1's turn health read.
9. **Re-encrypting blobs not under the first key** is a daily chore (§5.3), in lane 1901's daily route; it
   matters only after a rotation (decision 23: on compromise only).
10. **Two or more users, or the admin, failing to decrypt in one tick answers 503** (§5.3): the tick is
    Phase 3's.
11. **T6's claim half** (Phase 3's claim) and **T9's invite half** (Phase 4a's request form, RULINGS Oct 15
    12:46 PM).
12. **A decrypt failure on the request path** writes nothing and keeps the session, as §5.3 asks, but the
    page then renders without a Spotify token instead of §5.1's retryable answer: turning it into that
    answer is `requireUser()`'s and the pages' (the gated pages are queued files).
13. **Every entry point on `requireUser()` before this deploys** (lane 03's review). Phase 1's identity
    lookup never threw; this one does, by design, when the app database or the key check fails. The
    `(app)` layout, Home, `/usage`, the search and metrics routes, `/api/sync` and `getSpotify` still gate
    on a bare `auth()`, which then returns a session with `idUnavailable` and no uid: the layout, Home,
    `/usage` and the search and metrics routes pass it and serve as single-user code does, while
    `getSpotify` and `/api/sync` redirect to /login or answer a plain 401 when the token read fails with the
    database. PHASE1.md §4 moves them at Phase 1's turn (lane 12); lane 15 checks that no `auth()` gate is
    left outside `require-user.ts` and that the two owner shims in auth.ts are gone.
14. **Key rotation's runbook** (SECURITY.md, with item 6): the sentinels cover the configured keys only.
    `TOKEN_KEYS` with the old key dropped, or a wrong key under a new id, passes the cold-start check, and
    every blob under the missing key fails one user at a time (a `decrypt` event each, users left
    `active`, nothing written; checked by lane 03). So drop an old key only after
    `SELECT count(*) FROM user_tokens WHERE blob LIKE '<old id>.%'` reads 0.

**Choices made where PLAN left one open** (PLAN's recommendation where it has one):

- `users` times (`status_at`, `invited_at`, `last_sign_in`) and `events.at` are milliseconds; the token
  columns (`expires_at`, `granted_at`) are seconds, as `SpotifyTokens.expiresAt` is.
- The associated data's `v1` is the blob format's version, fixed; the key's id is the blob's prefix.
- `app_meta` gains two listed keys: `sentinel:v<n>` and `token_copy:<uid>`.
- The copied admin row's `granted_at` is the copy's time: the true grant date is not in the plaintext row.
  The ~170-day rule (§5.4) reads a young grant as revoked, and the admin is never revoked automatically.
- The identity read refuses `revoked`, as §5.1's list says; a fresh sign-in returns the user to `active`.
- `isOwnerSignIn` (owner.ts) still runs before the app database's decision; Phase 4a removes it.
- `APP_DATABASE_URL` on Preview: refused, so a Preview deployment answers "unavailable" (PLAN §10.2: Preview
  gets no store variables).
- The script's `--dry-run` still reads (one GET with the platform token) to say whether `lazyboy-app`
  exists; `--verify` counts `meta` without `plsnap:` and `lock:` keys, since ordinary activity adds and
  removes them (migration 16).

## 5. How to review the branch

```bash
git worktree add ~/projects/lazyboy-wt/<yours> mu/phase2 && cd ~/projects/lazyboy-wt/<yours> && npm ci
git log --oneline mu/phase1..mu/phase2        # one commit per piece, docs last
git diff --stat mu/phase1...mu/phase2
npx vitest run tests/isolation tests/phase2-app-db.test.ts tests/t12-phase2-rehearsal.test.ts
npm test                                      # fails only on the two inherited T1 date tests
npx tsc --noEmit && npm run lint && npm run build
```

Read in this order: `src/lib/app-schema.ts` and `src/lib/app-db.ts` (every statement, one sitting);
`src/lib/token-crypto.ts`, `token-keys.ts`, `token-store-app.ts`; `git diff mu/phase1...mu/phase2 --
src/lib/token-core.ts` (the conditional writes); `src/lib/identity-read.ts`; `src/lib/token-move.ts`;
`git diff mu/phase1...mu/phase2 -- src/lib/auth.ts`; then `tests/isolation/planted-bugs.test.ts` and
`scripts/phase2-app-db.mjs`. A cross-user path would most likely hide in: the statements in `app-db.ts`
that take no uid, the sign-in decision when a row's status moves under it, the store's `get` and `rev`, and
the admin bridge's notion of who the admin is (`OWNER_UID`).

When Phase 2's turn comes, cut `mu/phase2-turn` and replay this branch's commits onto production's code
(DISPATCH §3). Expect conflicts in `CLAUDE.md` (queued lanes edit it) and none in the new files.

## 6. Replayed onto Phase 1's turn: `mu/p2-base` (lane 1945_lb_mu_31_stack, Oct 16, 2026)

Lane 31 replayed this branch's 14 commits once onto `mu/phase1-turn` (`46538cd`, lane 12), so lanes 15 (Phase 2's
wiring), 17 and 19 start from the same commits and the stitch meets one resolution of each conflict (DISPATCH §3).
`git range-diff mu/phase1..a90104d 46538cd..mu/p2-base` shows all 14, plus one new commit. Patches that changed,
and why:

- `57b3de7`, `5c6d126`, `f7537a1` (`planted-bugs.test.ts`): Phase 1's turn planted the fourth bug (a URL template
  that ignores the uid) in the same file; both sets of plants kept. `f7537a1` (`static.test.ts`): S3 now has both
  halves, db.ts's from Phase 1's turn and app-db.ts's from here, and S7 exists, so the "waits for forUser" notes go.
- `62a3cd5`: `isolation.ts` keeps Phase 1's lazy import of db.ts (the cycle through userCache) and the uid on the
  telemetry row, and adds this branch's awaited `events` row. `token-store-owner.ts` and its test are deleted as
  here, over Phase 1's turn's `forUser` version of them; nothing else called them.
- `89d2fcb`: `identity.ts`'s `ownerUid` comment no longer names the auth.ts shims Phase 1's turn deleted.
- `95a68e2`: db.ts no longer exports its meta token functions, so `token-move.ts` reads and writes the admin's
  plaintext row through `forUser(uid)`, and `copyAdminTokens` / `rollbackAdminTokens` take a `Uid`. Its test's
  admin is `OWNER_UID`, the one uid Phase 1's directory maps to Rem's database.
- `a04b085`: `--verify` runs `verify-derived.mjs --user <OWNER_UID>`, which Phase 1's turn made required.
- `e79e614`: T12's synthetic backup is written through the owner's `UserStore` (it now carries Phase 1's four
  meta keys, the shape a post-Phase-1 backup has); its verify-derived run passes `--user`.
- `fa9ac6b`: `CLAUDE.md`'s file map: Phase 1's turn's cron lines with this branch's token and app-database lines.
- New, `mu p2-base: the authorization suite on Phase 2's identity read and token store`: lane 1947's suite came
  with Phase 1's turn and had never run over this branch. Its harness now seeds the app database as §11.4 leaves
  it (the admin row, his encrypted token, the copy marked done, the plaintext row kept); 65 tests were red without
  it. `AUTHZ_TARGET=1` fails only the P4a and L07 pins, as on `mu/phase1-turn`.

No resolution needed new behaviour. What this base changes in §4's list, for lane 15:

- **Item 1 is where Phase 1's turn's code meets this branch, and logout is the one that breaks a Phase 1 promise
  on this base.** `logout` (Phase 1's turn: `forUser(user.uid).clearSpotifyTokens()`) clears the plaintext row,
  while the token of record is now `user_tokens`: after Log out capture continues and a copied cookie is still
  allowed, against RULINGS Oct 15 1:33 PM and AUTHZ F3/F4's Phase 1 fix. The authorization map cannot see it: its
  `staleLogout` principal deletes both rows itself, and the logout cell counts any change to Rem's database as
  the clear. Wire logout onto the user's `user_tokens` row and have the logout cell read `tokenRow()`, which reads
  both rows. The other two callers are unchanged in kind: `/api/cron/sync`'s "no token" (`store.getSpotifyTokens()`)
  and `getCaptureHealth` with the health route read the plaintext row.
- **Item 2**: Phase 1's turn has `forUserAt(uid, dbName)` (S2 pins that nothing in `src` imports it yet) and
  `readIdentityRow` returns `dbName`; routing each request's store through it is the wiring.
- **Item 8**: Phase 1's turn's health check reads isolation events from telemetry (`isolationEventsAfter`, marked
  with `isolation_seen` in the admin's `meta`); `reportIsolation` still writes that row beside the `events` row,
  so the check works on this base; moving it onto `events` is the wiring.
- **Item 13 is done by Phase 1's turn** (every entry point on `require*User()`, T3's census empty; the owner
  shims gone). What stays for lane 15: a test that Phase 2's unavailable read (`idUnavailable`) reaches each
  `require*User()` form as the retryable answer.
- The authorization harness's scripted `/v1/me` carries no `account_id`, as today's Spotify answer is recorded,
  so Rem's sign-in there is refused (`NoAccountId`) while the callback's `rem` cell still reads allow (its oracle
  counts the code exchange and the `/me` call made with his bearer). The sign-in itself is decision 31's question
  and identity-read.test.ts's T9; the cell proves less than its rule says until the profile carries the field.
