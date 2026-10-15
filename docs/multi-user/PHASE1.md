# Multi-user Phase 1, built ahead of its turn

Lane 0226_lb_mu_phase1, Oct 15, 2026, branch `mu/phase1` (worktree
`~/projects/lazyboy-wt/mu-phase1`), cut from `main` at `6577f4b`. Nothing here is merged, pushed or
deployed, and nothing touched production data, the Zenbook store or Vercel.

Status: in progress. Sections are filled in as each piece lands; a section still reading "pending"
was not reached.

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
- **Docs**: `.env.example` (`OWNER_UID`), `CLAUDE.md`'s file map, two `GOTCHAS.md` bullets that
  this branch made wrong (the per-process playlist cache, where `refreshShared` lives).

## 3. The tests, and what each proves

pending

## 4. Left for Rem's decisions, or for the phase's turn

pending

## 5. How to review the branch

pending
