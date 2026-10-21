# Multi-user Phase 1

Built ahead of its turn by lane 0226_lb_mu_phase1 (Oct 15, 2026, branch `mu/phase1`, cut from `main`
at `6577f4b`; §1-§3), then finished in its turn by lane 1945_lb_mu_12_p1_build (Oct 16, 2026, branch
`mu/phase1-turn`, `mu/phase1` rebased onto `origin/main` `7aeb438`; §6). Nothing here is merged,
pushed or deployed, and nothing touched production data, the Zenbook store or Vercel.

Status: Phase 1's turn complete, Oct 16, 2026, about 3 AM, except the two pieces left to lane
1945_lb_mu_33_p1_stitch (§4, §7). Review it as one diff (§5): lane 13 reviews after lane 33's stitch,
lane 14 deploys (§4's deploy steps).

Stitched, Oct 16, 2026, about 2:15 PM: lane 33 put this branch on production's code as `mu/s-p1`
(`origin/main` `1eac835`, after lanes 1906, 1911 and 11 deployed) and finished §4's two pieces (§8).
Lane 13 reviews `origin/main..mu/s-p1`.

## 1. What this branch is

PLAN.md §13.1 puts Phase 1 after P3; §13.4 lets a lane build a phase early on its own branch, but
only in new files and in files no queued lane edits. §18's last table names the Phase 1 work no
decision of Rem's holds. This branch builds the intersection of the two.

The files queued lanes edit, and which this branch therefore leaves alone (§13.4, STORE_MIGRATION
§6 and §10): `src/lib/db.ts`, `src/lib/store-fetch.ts`, the cron routes that exist today
(`/api/cron/sync`, `/api/cron/usage-check`), `/api/metrics`, the two search routes,
`usage/page.tsx`, `instrumentation.ts`, `vercel.json`, the `(app)` layout, Home's load path
(`home/*`, `history-actions.ts`), the import scripts and the Zenbook meter. One exception, flagged:
`src/app/(app)/actions.ts`, where the Phase 0 lane gates `logout`; this branch changes two other
hunks there (the task owner on the two `runTask` calls), which rebase cleanly against a change at
lines 63-69.

That boundary decides most of what is left for the phase's turn (§4): the mechanical `forUser`
edit through `db.ts`, the seven cached reads moving onto `userCache`, the uid in the search ETags
and bodies, and the reads and gates inside Home and the search routes.

## 2. What is built

What lane 0226 built ahead of the turn (§6 is what the turn added; where they differ, §6 holds).
Each item names the PLAN.md section it implements. Behaviour Rem would notice on a deploy of this
branch: every existing session cookie is refused once (it carries no uid), so he signs in once;
and with `OWNER_UID` unset or malformed every sign-in is refused (`.env.example` says how to
generate one). Nothing else changes for a single user.

- **The uid and the identity check** (§4.4, §5.1, §6.2 layer 2): `src/lib/identity.ts`. A random
  12-character base32 uid, the branded `Uid` type, `mintUid` as the only cast, and
  `checkIdentity`, which turns a cookie's `uid`, `ep` and `auth_time` into allowed, refused (no
  uid, unknown, wrong status, stale epoch, sign-in over 30 days old or stamped in the future,
  `SIGNUPS=owner` and not the admin) or unavailable (the lookup threw). Phase 1's lookup is
  `ownerOnlyLookup(OWNER_UID)`: the owner alone, active, epoch 0, admin. Phase 2 swaps in the
  app-database read with the same signature.
- **The session names its user** (§5.1, §11.4): `src/lib/session-gate.ts` holds the callbacks'
  decisions without a next-auth import, so they are tested; `src/lib/auth.ts` uses them. The
  sign-in branch puts `uid`, `ep` and `auth_time` on the cookie from the owner constant, never from
  the incoming cookie or the profile. Every later request runs the identity check once (a
  `cache()` box keyed by the cookie's claims): refused returns null, which Auth.js answers by
  clearing the cookie; unavailable keeps the cookie and sets no uid; allowed puts `uid` and
  `admin` on the session. `src/types/next-auth.d.ts` types them.
- **`requireUser()`** (§5.1): `src/lib/require-user.ts`, with page, route and action forms. A
  refused route answers 401 with the `x-lb-signed-out` marker; an unavailable one answers 503 with
  `retry-after`, never a redirect or a 401. Wired into `/api/tasks/[id]`, `/api/playlists/sync`,
  `/api/playlists/[id]/tracks`, `/api/now-playing` (unavailable is a 503 there too, never
  `playing: null`, which would make Home finish the current song) and both playlists pages.
- **The token core, per user** (§5.2): `src/lib/token-core.ts`. `auth.ts`'s refresh code moved out
  unchanged in its rules and keyed by uid throughout: the in-flight refresh is a
  `Map<Uid, Promise>`, the lock, the row and every write go through a `TokenStore` per uid, and
  token objects carry their owner (`setTokens` and `assertTokenOwner` refuse a mismatch). Phase 1's
  store, `src/lib/token-store-owner.ts`, is the owner's plaintext `meta` row as today; any other uid
  reads null and cannot write, clear or lock. It keeps the lock name `spotify_refresh`, so a build
  of this branch and the previous build coordinate during a deploy. `auth.ts` exports
  `spotifyAccessTokenFor(uid)` and `getValidAccessTokenFor(uid)`; `spotifyAccessToken()` and
  `getValidAccessToken()` remain as owner-bound shims for the callers in queued files, which
  Phase 1's mechanical edit moves onto the uid forms.
- **Process state** (§6.2 layer 4): the 60-second process-wide playlist-list cache in
  `src/lib/spotify/resources.ts` is deleted; the running library sync is a `Map<Uid, task id>`
  and `startLibrarySync` takes the gated user as an argument; tasks record their owner
  (`src/lib/tasks/registry.ts`), `getTaskFor(id, uid)` answers another user's task as missing, and
  the two `runTask` calls in `actions.ts` pass the owner.
- **`userCache`** (§6.2 layer 4): `src/lib/user-cache.ts`, the one wrapper around
  `unstable_cache`. The uid and the store epoch go into the key parts and the uid is the
  callback's first argument; each wrapper has a unique name in its key, because the inner callback
  has the same source text for every wrapper and Next keys on that text; the value is stored as
  `{ o: uid, v }` and a mismatch on return records an isolation event and serves the right user's
  data uncached. No caller yet: db.ts's seven cached reads move onto it in Phase 1's turn.
- **Isolation events** (§6.5): `src/lib/isolation.ts`. Phase 1 has no app database, so an event is
  a log line with a fixed prefix and a telemetry row (`client_metrics`, event `isolation`, meta
  `<code>|<uid>`).
- **Browser storage per user** (§6.2 layer 6): `src/lib/user-storage.ts`. `userStorageName` puts the
  uid in every storage, channel and lock name that holds user data; `clearUserStorage` removes
  every user's entries, prefixed or legacy, and keeps device-level keys; `isSignedOutResponse`
  clears only on the app's own 401 with the marker, never on a 5xx, a 503 or a network error;
  `bodyIsFor` drops a payload whose `u` is not the page's user. Not wired into components yet: the
  uid reaches the browser through the `(app)` layout, a queued file.
- **The health check** (§7.10): `src/app/api/cron/health/route.ts` over the pure
  `src/lib/health.ts`, opened by `CRON_SECRET` or `CRON_SECRET_EXT` (`src/lib/cron-auth.ts`,
  constant time, an unset secret matches nobody). It answers 500 with one-word reasons and lists
  the checks it cannot measure yet. One deviation from §7.10: the owner's capture uses
  capture-health's two-hour rule, since before Phase 3 the only stamp is `last_sync`, which moves
  only on a harvest and which the harvest gate holds back up to an hour; 30 minutes would e-mail
  Rem on a quiet evening.
- **`cache: "no-store"`** on the two direct Spotify fetches: the sign-in profile read
  (`src/lib/spotify/userinfo.ts`, §5.1: a cached profile would bind one sign-in to another's
  account) and the token refresh. Static check S5 found the first.
- **`/playlists/[id]`'s cold path** (PLAN.md T3's note): the Spotify fetch and the
  `storePlaylistTracks` write moved out of the nested `Tracks` component into `loadColdTracks`,
  which the gated page body starts and hands to `Tracks` as a promise. The list still streams
  under Suspense; no nested component reads user data on its own.
- **Docs**: `.env.example` (`OWNER_UID`), `CLAUDE.md`'s file map, two `GOTCHAS.md` bullets that
  this branch made wrong (the per-process playlist cache, where `refreshShared` lives).

## 3. The tests, and what each proves

All in the simulated environment (`npm test`): local SQLite files and scripted fetches, no store,
no Spotify, no Vercel. 61 tests in `tests/isolation/`, plus three changed elsewhere. The baseline
on `main` at `6577f4b` already fails two tests, the date time-bombs in `store-plays.test.ts` and
`sync-history.test.ts` (QUEUE.md T1, assigned to STORE_MIGRATION lane 1901), and because vitest
fails first, `npm test`'s `&&` chain never reaches its three node suites. Each commit on this
branch was gated on: `tsc --noEmit` clean, lint clean, vitest failing on exactly those two and no
others, and the three node suites run separately and passing. `npm run build` passes with no store
variables set.

**Red first.** Tests of behaviour that already existed were run against `main`'s code before the
fix and failed:

| test | failed on main because |
|---|---|
| `process-state`: B's library read within 60 s of A's | B got `A-only list`: the process-wide playlist cache |
| `process-state`: a task is visible to its owner only | no owner existed (`getTaskFor` absent) |
| `process-state`: `/api/tasks/[id]` as B with A's task id | 200 with A's result, where 404 is required |
| `static` S4 | `playlistsCache` and `currentSyncId`, module state keyed by nobody |
| `static` S5 | the sign-in `/v1/me` fetch had no `cache: "no-store"` |
| `static` S8 | `/playlists/[id]`'s nested `Tracks` called `getSpotify` and `storePlaylistTracks` |

Tests of new modules were red by absence first. What proves those checks have teeth is the
planted-bug self-test, which stays in the suite for good (PLAN.md §6.4, completeness M2): each
check runs against a deliberately broken implementation and must fail there, and against the real
one and must pass.

| file | what it proves |
|---|---|
| `identity.test.ts` | uids are uid-shaped and do not repeat (2,000 draws); `mintUid` refuses anything else. `checkIdentity`: allowed for a live cookie; refused with no uid or a malformed one (with zero lookups), an unknown uid, a stale epoch, `auth_time` over 30 days old, missing or in the future, every status but `active` and `needs_reconnect`, and a non-admin under `SIGNUPS=owner`; unavailable when the lookup throws. The callbacks' decisions: sign-in stamps the owner's uid, epoch 0 and `auth_time`; refused signs out (null); allowed and unavailable keep the cookie; only allowed puts a uid on the session; `gateFromSession` mints only from a uid-shaped session |
| `token-core.test.ts` | two users' expired tokens refreshed at once in one process each end with their own token after one token call each; four concurrent calls for one user share one refresh; A's lock held elsewhere does not delay B (under 1 s); `invalid_grant` for A clears A's row and writes nothing of B's; no row means no Spotify call; a fresh token returns with its owner and no call; a token object naming another user is refused |
| `token-store-owner.test.ts` | over the real `meta` row: the owner's uid reads it; another uid reads null and cannot write, clear or lock it; no owner configured means nobody has a row; the owner's lock is today's `spotify_refresh` lease |
| `process-state.test.ts` | the red rows above, now green; `requireRouteUser` answers 401 with the signed-out marker when refused, 503 without it when unavailable, and the gate otherwise |
| `user-cache.test.ts` | over a cache stub keyed the way Next 16.2.6 keys: with equal version counters A and B each get their own value and each is cached; uid and epoch are in every key; a forged entry under B's key stamped with A is refused, B served uncached, one `cache-stamp` event recorded for B; two wrappers cannot share a name; two wrappers whose callbacks differ only in their closures are told apart |
| `planted-bugs.test.ts` | the equal-counter check fails over an `unstable_cache` keyed without the user (uid in a closure) and passes over `userCache`; the forged-entry check fails over the pass-through stub and passes over the faithful one; the concurrent-refresh check fails over a core whose in-flight promise is shared by everyone (today's `auth.ts` shape) and passes over the real core |
| `user-storage.test.ts` | per-user names differ between users; sign-out clears every user's entries, prefixed or legacy, and keeps the device-level keys; only the app's signed-out 401 clears, never a 503, a 500 or a plain 401; a body naming another user is not used |
| `health.test.ts` | each condition turns the verdict red on its own and unmeasurable ones are listed, never read as healthy; the route refuses no secret, a wrong one and an empty bearer when a secret is unset, accepts either pinger's; red with no token row, green with a token and a recent harvest; the reply carries only `ok`, `reasons`, `unchecked` |
| `static.test.ts` | S1 `unstable_cache` only in `user-cache.ts` (db.ts pending); S2 no `as Uid` outside `identity.ts`, `mintUid` imported only by the gate and `auth.ts`; S4 every mutated module-scope binding in `src/` on a reviewed list saying how it is keyed (db.ts's four pending); S5 every direct Spotify fetch `no-store`; S6 every browser storage name built by `userStorageName`, device-level, or pending (12 pending); S8 no async component nested in a page calls the store, the session or the Spotify client (red on main's `/playlists/[id]`, whose `Tracks` called `getSpotify` and `storePlaylistTracks`). A pending entry that disappears fails the check, so the lists shrink only on purpose |
| `entry-points.test.ts` | T3's census: every page, layout, route and `"use server"` module under `src/app` is gated (and its source calls `require*User`), exempt by name, or pending with a reason; a new entry point with no entry fails |
| `now-playing-route.test.ts` (changed) | its session mock carries a uid; new: an unavailable identity check is a 503 |
| `spotify-userinfo.test.ts` (changed) | the profile fetch's pinned arguments now include `cache: "no-store"` |

## 4. What is left

Lane 0226's list (Rem's decisions, and the work in files queued lanes edited) is done in Phase 1's turn
(§6), apart from:

**Left for lane 1945_lb_mu_33_p1_stitch**, which rebases this branch onto `main` once lanes 1905-1906
and 1910-1911 have merged (§7 lists every place this branch meets their files; both done, §8):

- lane 1905's IndexedDB store (STORE_MIGRATION §10) keyed by the uid: its user key is the uid the
  `(app)` layout renders (`useUid()`), its database and store names come from `userStorageName`, its
  stored bodies pass `bodyIsFor` like the network's, and its sign-out clear joins this branch's in the
  same form. Static check S6 now reads `indexedDB.open` names, so 1905's constant key fails `npm test`
  until it is the uid;
- lane 1910's scoped orphan pass and identity-first predicate (`recomputeOrphanFlags`,
  `storePlaylists`, `store-diff.ts`, `read-costs.ts`) through `forUser`: its bodies go inside this
  branch's signatures (the user's database first), as §7 says.

**Deploy steps, lane 14's** (each changes production; PLAN §11.4, §13.1):

1. `OWNER_UID` in Production (generated once, `.env.example` says how) and the same value in
   `.env.local`, so a dev server pointed at Rem's database is its owner (GOTCHAS "Multi-user Phase 1").
2. Before the deploy: `node --env-file=.env.local scripts/phase1-meta-keys.mjs --user <OWNER_UID>
   --dry-run`, then `--apply`, on Rem's `lazyboy`. Without the four keys every request is refused
   ("the database has no owner_uid or store_epoch"). They are the only writes Phase 1 makes to his data.
3. The second `AUTH_SECRET` rotation with the deploy (every older cookie is refused anyway: it names
   no uid), and a day later the production deployments built before it deleted (SECURITY.md,
   "Rollback").
4. After the deploy: Rem signs in once; the fault injection (STORE_MIGRATION §8 step 14); the rollback
   rehearsed (revert the merge, never Instant Rollback across the rotation); the hourly health job on
   cron-job.org with failure e-mail is Rem's step (decision 14, `rem_health_job`).
5. Every store script now takes `--user <OWNER_UID>` (`verify-derived.mjs`, the backstop replay, the
   importers, `bench-reads.mjs`, `migrate-skip-rule.mjs`, `backfill-scan.mjs`); a runbook step that runs
   one after the merge adds it.

## 5. How to review the branch

```bash
git log --oneline origin/main..mu/phase1-turn   # lane 0226's commits, the authz map, then the turn's
git diff origin/main...mu/phase1-turn --stat
npx vitest run tests/isolation                  # the isolation suite alone
AUTHZ_TARGET=1 npx vitest run tests/isolation/authz-   # fails only P4a (3) and L07 (2): what later phases owe
npm test && npx tsc --noEmit && npm run lint && npm run build
```

Read in this order: `src/lib/identity.ts` and `src/lib/session-gate.ts` (the rules), the
callbacks at the bottom of `src/lib/auth.ts` (where they run), db.ts's "Clients" section (the
URL rule, the open, `guardedClient`) and `forUser` at its bottom, `src/lib/token-core.ts` against
`main`'s `auth.ts` (`git diff main...mu/phase1 -- src/lib/auth.ts` shows what moved; the refresh
rules are meant to be identical apart from the uid), then `tests/isolation/planted-bugs.test.ts`
and `static.test.ts`. To see a check fail on purpose, copy `main`'s version of a fixed file over
this one (`git show main:src/lib/spotify/resources.ts > src/lib/spotify/resources.ts`), run the
suite, and copy it back from `git show mu/phase1:…`; §3's red table lists which tests that turns
red.

Still owed before this reaches production, by PLAN.md §13.1's Phase 1 row: lane 33's stitch
(§4, §7); an adversarial review of the whole Phase 1 diff in a fresh context told to find a
cross-user path (lane 13); the rollback rehearsal and STORE_MIGRATION step 14's fault injection
(lane 14). The turn's rebase met conflicts in `src/lib/cron-auth.ts` (both exports kept:
`cronAuthorized` CRON_SECRET-only, `cronCaller` for the health check), the now-playing route's
imports and `CLAUDE.md`'s file map; `actions.ts` merged clean (the Phase 0 `logout` gate never
landed on `main`, so this branch's `requireActionUser` is the first).

## 6. Phase 1's turn (lane 1945_lb_mu_12_p1_build, Oct 16, 2026)

`mu/phase1` rebased onto `origin/main` `7aeb438` (the store split), lane 1947's authorization map
cherry-picked (`82b360b`), then one commit per piece. Every gate green: `tsc --noEmit`, `npm run lint`,
`npm test` (65 vitest files, 1,584 tests, and the node suites), `npm run build`.

What landed, by PLAN section:

- **`forUser(uid)` over a database per user** (§4.2, §6.2 layer 3; commit `3f1d889`). db.ts's per-user
  functions take the user's database as their first argument and none is exported; `forUser` binds
  them into a `UserStore` (62 methods). The edit kept every function body where it was, so a rebase
  over db.ts conflicts only where both sides changed a body. Clients come from one factory
  (`makeStoreClient`, every one on `makeStoreFetch`); `lazyboy` is `TURSO_DATABASE_URL`, every other
  db_name `STORE_URL_TEMPLATE` with `{db}`; no template, no URL. Phase 1's directory maps `OWNER_UID`
  to `lazyboy` and throws for anything else. `forUserAt(uid, db_name)` is what Phase 2's identity read
  calls; nothing in `src` imports it (S2). The app-wide cooldown stays module-level, in the admin's
  database until Phase 2's `app_meta`. The telemetry functions stay module-level; their rows carry
  `user_id`.
- **The versioned open** (§4.5). The first use of (uid, db_name) in a process reads the four keys in
  one statement: batched with a first plain read (whose result is used only once the owner matches),
  or on its own round trip before a first write. Refusals: another owner (an `owner-mismatch` event),
  `min_reader` above the code ("updating"), a schema behind that this process may not bring up to date
  (only `VERCEL_ENV=production` or a local file may), a remote database without the keys. A local file
  without them is provisioned for its first opener (dev, the tests). Schema version 1 is
  `CORE_SCHEMA` plus `migrateCore`, so a database at the current version pays none of `init()`'s eight
  serial round trips. `scripts/phase1-meta-keys.mjs` writes the keys (lane 14, §4).
- **Caches and state** (§6.2 layer 4). The seven cached reads ride `userCache` (the uid and the store
  epoch in every key, the owner stamped on every entry; S1's pending entry closed); the two `cache()`
  boxes and the two module memos are keyed by (uid, db_name) (S4's pending list closed).
- **`requireUser` on every entry point** (§5.1, §5.4; T3's census has no pending row). Home's reads
  start after its gate; `/usage` is the admin's (404 otherwise); a session whose grant is gone is
  refused everywhere, as the pages always did (AUTHZ F2); `logout` clears only the gated user's token
  row (F4).
- **The browser** (§6.2 layer 6; `fd72cf4`). The search ETags carry the uid and the store epoch, the
  bodies `u`, served `private, no-store`; the `(app)` layout renders the uid; every user-data storage
  name is built by `userStorageName` (S6's twelve pending names closed); sign-out clears them; the
  fetchers clear on the signed-out 401; Home drops a payload whose `u` is not its user.
- **`/api/metrics`** takes the uid from the session and drops server-only event names (`isolation`).
- **The health check** reads isolation events (each red once), the daily chores' `daily_at` and the
  pace verdict the chores record; with every input measurable nothing is unchecked.
- **The Spotify client is made for a user** (§5.2's last row): a token naming anyone else is refused
  before the request (`TokenOwnerError`, a `token-owner` event); `api_log` carries the user. S7: no
  user path awaits telemetry.
- **Scripts** (`797e91e`): `scripts/script-user.mjs`, a required `--user` on the six store scripts,
  the backstop replay admin-only, a database naming another owner refused.
- **The authorization map at Phase 1's targets** (`5c8dcfe`): every P1 cell and red-team check meets
  its target; `/api/cron/health` is in the map.
- **Tests** (`cea5ae0`): T1 (every `UserStore` method as A and as B over two users' files, one fixture
  per method), T2 over the seven real cached reads, T7 through the search routes with two users, T8
  and the versioned open, the fourth planted bug (a URL template that ignores the uid), T10, T15's
  client half, the health inputs, token owners. Each was shown failing first against a plant or the
  pre-turn code; the commit messages say which.

Choices where PLAN or the brief left one open, and why:

- **Function bodies stay in place** (a first parameter, not a class): the mechanical edit is a
  signature and a `getClient()` per function, which keeps lane 33's rebase over lanes 1910's db.ts
  changes to the bodies both sides touched.
- **A local file without the four keys is provisioned for whoever opens it first**; a remote one is
  refused. PLAN §4.5 lets dev migrate its own local files and has the harness provision through the
  production code; claiming an unowned local file is what both need.
- **The open's verdict is cached per process** (PLAN §4.5): a restore that writes a new `store_epoch`
  reaches a warm instance at its next deploy.
- **The health check marks isolation events reported** with `isolation_seen` in the admin's `meta`, and
  the daily chores' `daily_at` and pace verdict sit there too: Phase 2's `app_meta` is where they go.
  These are bookkeeping keys, not data; the four open keys stay the only data Phase 1 writes for Rem.
- **A refused token is not retried**: the Spotify client resolves its bearer before the fetch's retry
  block, so a token naming someone else fails at once instead of three times as a network error.
- **`/usage` answers a non-admin `notFound()`**, which the map counts as refused.

## 7. For lane 33: where this branch meets lanes 1905, 1906, 1910 and 1911

- `src/lib/db.ts`, every per-user function: the user's database `u: UserDb` is the first parameter,
  `getClient()` is `u.client()`, and every call to another per-user function passes `u` (`getMeta(u,
  …)`, `setMeta(u, …)`, `bumpWriteSeq(u)`, `dropWriteSeqCache(u)`, `ledgerAddLinear(u, …)`,
  `recomputeOrphanFlags(u, …)`, `recomputeSkipFlags(u)`). Lane 1910's bodies of
  `recomputeOrphanFlags` and `storePlaylists`, and any helper it adds that touches the store, go in
  that shape; nothing per-user is exported. A new method callers need goes in `USER_FNS` (bottom of
  db.ts) and in static check S3's snapshot only if it is module-level (it should not be).
- `recordPlays`, `storePlaylistTracks`, `deletePlaylistFromDb` and `storePlaylists` call
  `recomputeOrphanFlags(u, { … })`: lane 1910's scoped pass changes what those calls pass.
- `src/lib/read-costs.ts` and `src/lib/store-diff.ts`: untouched here. A new ledgered reader that is
  linear in history size uses `ledgerAddLinear(u, …)`, whose size lookup is per user.
- Tests lanes 1910-1911 add call db.ts through `ownerStore()` (`tests/owner-store.ts`) or
  `forUserAt(uid, db)` with `useUserFiles()` (`tests/isolation/user-dbs.ts`); a new `UserStore`
  method needs a T1 fixture (`tests/isolation/user-store.test.ts`), or T1 fails. `resetStore()` keeps
  the four open keys.
- `src/app/(app)/layout.tsx`: lane 1905 renders a constant user key; this branch renders
  `<UserProvider uid>`. Use the uid (`useUid()`).
- `src/app/(app)/chrome.tsx`, the sign-out form: this branch's `onSubmit={() => clearThisBrowser()}`;
  lane 1905 adds its IndexedDB clear to the same form. Both run.
- `src/app/(app)/home/den-home.tsx`: `fetchPayload(url, uid, ok)` drops a body whose `u` is not the
  page's and clears on the signed-out 401. Lane 1905's stored copy is checked the same way
  (`bodyIsFor`) and keyed `(uid, epoch, kind, segment, version, shape)`; the store epoch is in both
  ETags (`"lib-<shape>-<uid>-<epoch>-<version>-<day>"`), not yet in the body, so lane 33 either reads
  it from the ETag or adds it to the body as `e`.
- `src/lib/user-storage.ts`: `USER_DATA_NAMES` lists every user-data name `clearUserStorage` removes;
  1905's IndexedDB name joins it (its clear is 1905's own, since `clearUserStorage` covers Storage
  only). Static check S6 fails on an `indexedDB.open` name not built by `userStorageName`.
- `src/app/api/search/{library,history}/route.ts`: gated by `requireRouteUser`, bodies `private,
  no-store` with `u`; if lane 1905-1906 change them, keep both.
- `src/app/api/cron/sync/route.ts` and `src/lib/cron-auth.ts` meet lane 07 (`mu/pinger`), not 1905 or
  1910: this branch runs the tick for `phase1Owner()` through `forUser` and keeps both
  `cronAuthorized()` and `cronCaller()`; lane 07's guard and `CRON_SECRET_EXT` go on top.

## 8. The stitch (lane 1945_lb_mu_33_p1_stitch, Oct 16, 2026)

`mu/s-p1` is `mu/phase1-turn` (`46538cd`) replayed onto `origin/main` `1eac835`, then four commits.
`git range-diff 7aeb438..46538cd origin/main..mu/s-p1` shows every replayed commit; the five whose
patch changed are below, and each says so in its message.

- **Dropped:** `58f71bf`, lane 1947's authorization map cherry-picked by lane 12: the same patch is
  on `main` as `0233916`, with lanes 08 and 1906's later edits on top.
- **`886a947` the health check route:** no longer touches `cron-auth.ts`. Lane 07 had put the same
  `cronCaller` on `main` (`1165010`), and the hunk applied without a conflict as a second copy of
  `cronCaller`, `CronCaller` and `safeEqual`. The replay was split around this commit to fix it there.
- **`3f1d889` forUser:** lane 1910's `recomputeOrphanFlags` (the `playlistIds` and `identities`
  scopes, chunked) and `storePlaylists`' RETURNING-scoped purge pass take the user's database first,
  `u.client()`, and `u` on every per-user call; their bodies are 1910's. `/api/cron/sync` keeps lanes
  07 and 08's pinger as `main` has it (`cronCaller`, the bare `{"ok":true}` with the tick in
  `after()`, the owner alarm before the stamp, the 90-second stamp); the tick resolves
  `phase1Owner()` and `forUser(uid)` first, after cron-job.org's reply, and the alarm and the stamp go
  through that store.
- **`fd72cf4` the uid in the browser:** the `(app)` layout renders `<UserProvider uid>` beside lane
  1905's `data-user-key` (still the constant until the next commit below), the sign-out form runs
  both clears, and Home's `fetchPayload` takes both the uid and 1905's `keep`: clear on the
  signed-out 401, drop a body for another user, check the shape, then keep the text.
- **`5c8dcfe` the authorization map:** the registry and red-team files merged over lane 08's L07
  flips; `AUTHZ.md` regenerated, not merged by hand.
- **`5d853f1` docs:** CLAUDE.md's `db.ts` entry keeps both sides' facts.

Then, each shown failing first (the commit messages say how):

- **The IndexedDB copy on the uid** (`0292c32`): the user key is `useUid()`; the database is
  `userStorageName(uid, "lb-search")`; `readStored` drops a body whose `u` is not the page's;
  `"lb-search"` is in `USER_DATA_NAMES`, and `clearThisBrowser` (the sign-out form and the signed-out
  401) deletes every user's database, per-user ones through `indexedDB.databases()` and the bare
  pre-Phase-1 one by name. S6 has no pending name; S4 reviews 1906's `ended`.
- **The orphan pass's suite through forUser** (`fa89d59`): `tests/orphan-scope.test.ts` runs as the
  owner, plus a two-user test over per-user files (B's library change re-rules only B's plays,
  scoped equals full on B's file, A's file unchanged). The purge pass's ledger line was priced with
  the calibration's playlist count (180) for every user; it now uses the user's own (the list before
  the rewrite, at least the purged count).
- **S3** (`44fda6a`) reads `export { … }` declarations, which it skipped: lane 1905's re-export of the
  shape tokens was invisible to it, and so would a re-exported per-user function have been.
  `ORPHAN_PREDICATE` (1910) is in its snapshot.
- **The pinger's suite through forUser** (`4fbdf8e`), and a test that pins the owner lookup after
  cron-job.org's reply: with `OWNER_UID` unset the Zenbook hears 503 "no owner" and cron-job.org
  still a bare `{"ok":true}`.

`cron-auth.ts` is `main`'s unchanged: `cronAuthorized()` (CRON_SECRET only: the daily, store-bench
and usage-check routes) on top of `cronCaller()` (both secrets: `/api/cron/sync` and
`/api/cron/health`), one constant-time compare. With `AUTHZ_TARGET=1` only P4a's three pins fail.


## 9. The review (lane 1945_lb_mu_13_p1_review, Oct 16, 2026)

`mu/rv-p1` is `mu/s-p1` (`c4a9f02`) and the review's commits. Each finding was shown failing first
(the commit messages say how); every gate is green on the branch.

- **A tab rendered for one user kept acting for the next** (M7). After a sign-in in another tab
  hands the browser's cookie to another user, that tab's soft navigations, server actions and
  now-playing poll answer for the new user, so it showed their data under the old user's chrome,
  cached and relayed their player under the old user's names, and kept their day rows in its
  sessionStorage. `/api/now-playing` now names its user (`u`); a reply naming someone else clears
  this browser's user storage and reloads the page (`user-storage.ts` `leaveForAnotherUser`).
  Until the next poll the stale tab can still show the new user's answers to the person using it.
- **The IndexedDB clear** deletes the page user's own database by name, so a browser without
  `indexedDB.databases()` loses it on the signed-out 401 too.
- **The shared telemetry init** (no `TELEMETRY_DATABASE_URL`: the log tables in Rem's database)
  applies its DDL only where `mayApplySchema` allows. Production sets the variable.
- **Tests added for gaps the mutants found:** Phase 1's directory and the no-default-URL rule
  (`tests/isolation/directory.test.ts`), and a census of the planted-bug self-test's plants
  (`static.test.ts`).

For lane 14: production has no `SPOTIFY_OWNER_ID` (`vercel env ls`, names only), so the sign-in's
owner guard (`src/lib/owner.ts`) rests on the stored `me_id`, and on an empty store it lets the
first sign-in through. Setting `SPOTIFY_OWNER_ID` beside `OWNER_UID` in step 1 removes that.
