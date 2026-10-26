# CLAUDE.md — Lazy Boy

Project context for AI coding sessions. Read this first. Keep it current.
Role/persona prompts and the Next 16 API notes live in `AGENTS.md`.

**Before debugging, read `docs/GOTCHAS.md`** — hard-won traps (Base UI's broken
primitives, Spotify's `/tracks`→`/items` migration, the `allowedDevOrigins`
hydration trap, Spotify dev-mode 403). It will save you the investigation. Access
the app only at `http://127.0.0.1:3000`.

## What this is

A Next.js web app to manage a user's Spotify library: merge/clean/compare playlists,
save the live queue, mirror liked songs, and (roadmap) friends + AI playlists. It is a
clean rewrite of a half-finished Flask/Django prototype (`../spotify-manager`). The
original Python core logic in `../spotify-manager/PlaylistManager.py` is the reference for
the dedupe/clean/queue-save algorithms — they are re-specified in `docs/FEATURES.md`.

## Stack

- **Next.js 16** (App Router, RSC) + **TypeScript** + **Tailwind v4** + **shadcn/ui**.
- **Auth.js v5 (NextAuth)** with the Spotify provider; access-token refresh in the JWT callback.
- **Spotify Web API** via a typed service layer (`src/lib/spotify/`), never called directly
  from components.
- Dark, Spotify-flavored theme (green `#1DB954` accent). See `docs/CONVENTIONS.md`.

## Where things live

```
src/app/(auth)/          login page (unauthenticated shell; its consent line links the two below);
                         /join, and the pages after Log out (/signed-out), Disconnect
                         (/disconnected) and a dead Spotify grant (/reconnect, decision 20)
src/app/(legal)/         /privacy and /terms, public, no session or data reads: the privacy policy
                         and end-user agreement Spotify's Developer Terms §V require. Every line
                         must stay true of the code; change what the app stores, change /privacy
src/app/(app)/           authed shell: layout gates (requirePageUser), renders the uid for the
                         browser (components/user-context.tsx) + owns the chrome (chrome.tsx,
                         den.css skin, now-playing provider); pages bring their own <main>
                         home/ (greeting, action dock, day strip, song table), playlists/,
                         playlists/[id]/, friends/, usage/ (per-page load speed, then the
                         rows-read ledger below it; no nav link)
                         history-actions.ts  Home's listen-history reads (store only)
src/app/api/auth/        Auth.js route handler (NextAuth catch-all)
src/app/api/tasks/       background-task progress polling endpoint
src/app/api/playlists/sync  one full library scan → DB, as a background task (the cron tick
                         keeps the store fresh; the client only fires this on a cold/empty store)
src/app/api/search/       the two payloads Home filters in the browser (gated; private,
                         no-store; the uid in the ETag and as `u` in the body): library/ = every track in a playlist or Liked Songs,
                         history/ = every played track + every play. Both load on idle after
                         Home paints; the history half also feeds the day list, which is
                         grouped out of it client-side instead of fetched per day. The last
                         good body of each sits in IndexedDB (lib/search-cache.ts) so a repeat
                         visit searches before the network answers
src/app/api/now-playing/ live "what's playing"; null when idle (never stale)
src/app/api/build/       this deployment's build id, unauthenticated, no DB — fetched with
                         credentials omitted so it escapes Vercel's deployment pinning
src/app/api/sync/        the open app's sync (POST): the cron's step for the session's user,
                         on a load or a return to the tab, or every 2 min when no tick has run
                         in 5 (multi-user PLAN §7.6); writes the browser's zone when it changes
src/app/api/cron/sync/   the tick (lib/sync/tick.ts, wired in tick-deps.ts): two pingers, the
                         Zenbook's timer on even minutes and cron-job.org on odd ones, one tick
                         per 45 s; Vercel cron at 07:00 UTC as the last-resort backstop
src/app/api/cron/daily/  the daily chores (lib/daily-chores.ts; Vercel cron, 09:00 UTC, or a tick
                         when app_meta.daily_at is 26 h old): all-time heal + Home payload
                         rebuild, api_log/client_metrics prunes, the played_at convention check,
                         the usage check, the budget record, then Phase 4a's (daily-4a.ts:
                         deletion retries, day 4 of revoked, invite expiry, sweeps, the
                         cron-job.org jobs). Each isolated; answers 200; notifies nobody
src/app/api/cron/probe/  the planted probe (CRON_SECRET only): one forged cache entry, read back,
                         exactly one isolation event (PHASE4A.md §5)
src/app/api/cron/usage-check/  Turso quota guard (logic in lib/usage-check.ts): real usage vs
                         month pace, 500 on breach. Its reconciliation feeds /usage; the daily
                         route runs it every day. docs/READ_QUOTA.md
src/app/api/cron/store-bench/  store round-trip timings from a production function (?store=
                         core|telemetry; STORE_MIGRATION R1). All cron routes: lib/cron-auth.ts
src/app/api/cron/health/ the hourly health check (cron-job.org, failure e-mail): the owner's
                         capture, isolation events (lazyboy-app's `events`, each reported once),
                         the daily stamp, Turso's pace, the budget mode, a quiet CPU meter
                         (lib/health.ts)
src/lib/auth.ts          Auth.js config; the session names a uid (multi-user Phases 1-2)
src/lib/token-core.ts    Spotify token refresh (centralized), keyed by uid, writes conditional on
                         the row read; token-store-app.ts is its store (user_tokens, encrypted by
                         token-crypto.ts under TOKEN_KEYS, checked by token-keys.ts's sentinels);
                         token-move.ts copies the admin's plaintext row in once (and back on
                         LB_TOKEN_ROLLBACK=1)
src/lib/app-db.ts        every statement on the app database `lazyboy-app` (users, user_tokens,
                         sync_state, events, app_meta, requests); its schema is app-schema.ts
src/lib/sync/            the cron tick (tick.ts: the stamp, the claim, per-user steps, the 20-s
                         reply, one rescan, the daily chores when overdue), each user's step
                         (step.ts: token, /me/player probe, harvest when harvest-policy.ts says
                         so, counted by brake.ts), history.ts (a harvest's record), library.ts
                         (the rescan: no /me, Liked read from the top, liked-diff.ts).
                         capture-read.ts + capture-health.ts: Home's capture line from sync_state
src/app/(auth)/join/     the request form (Phase 4a): /join, POST /api/join, /api/join/link; the
                         signed request cookie is request-cookie.ts, the claim app-db claimInvite
src/lib/deletion.ts      the deletion job (PLAN §12.3), statements as data so scripts/user.mjs runs
                         the same SQL; deletion-runtime.ts binds it in the runtime; account.ts is
                         Log out and Disconnect; daily-4a.ts the chores 4a adds
scripts/invite.mjs       --list / --approve / --revoke / --decline (Rem runs it: e-mails);
scripts/user.mjs         --disable / --enable / --remove; both via turso-mac.mjs (Keychain token)
src/lib/identity.ts      the uid, the branded Uid, the identity check, phase1Owner() (the owner
                         for the session-less paths); identity-read.ts reads it (and sign-in's
                         account_id link) from the app database, naming the user's database
                         for forUser, and adminStore() reads the admin's row for the paths
                         with no session (the cron routes); session-gate.ts and
                         require-user.ts turn it into each entry point's answer. EVERY entry
                         point gates with require*User() before its first read
src/lib/user-cache.ts    the only caller of unstable_cache (uid + owner stamp); isolation.ts
                         records an event when a check catches a cross-user value
src/lib/session.ts       getSpotify(uid): server-only Spotify client for the gated user
src/lib/user-storage.ts  per-user browser storage names, sign-out clearing, the signed-out 401
src/lib/spotify/         client.ts (fetch+pagination+429/403), resources.ts, domain.ts, types.ts
src/lib/tasks/           in-memory task registry (clean-playlist progress); swappable iface
src/lib/db.ts            libSQL store (listen history + library); async; file: fallback in dev.
                         A DATABASE PER USER: forUser(uid) is the only way to a user's data,
                         at the db_name the identity read or the claim last read from the
                         user's `users` row (forUserAt records it; a changed name is rebuilt;
                         Rem's `lazyboy` is on Turso since 2026-10-16); its first open checks
                         the database's owner_uid and schema version. The plaintext token row
                         is token-move.ts's alone (the rollback copy). getTelemetryClient()
                         holds api_log, client_metrics and usage_ledger (sqld on the Zenbook
                         over the Funnel), never awaited on a user path. Unset
                         TELEMETRY_DATABASE_URL = the log tables in Rem's database.
                         docs/multi-user/PHASE1.md, STORE_MIGRATION.md, GOTCHAS.md
src/lib/store-fetch.ts   the fetch every store query rides: pins accept-encoding to gzip
                         (brotli on the Zenbook's CPU cost the history payload 26s) and owns
                         the retry ladder, rebuilding the Request per attempt (core: 3 x 15 s;
                         telemetry: 1 x 4 s). GOTCHAS.md
src/lib/han-fold.ts      traditional → simplified Han folding for name MATCHING (search,
                         fuzzyFilter). GENERATED by scripts/gen-han-fold.py — GOTCHAS.md
src/lib/read-costs.ts    the MODELED rows-read cost of every named read path + the residual
                         alarm rule; what db.ts's usage_ledger records. docs/READ_QUOTA.md
src/lib/budget/          the Vercel/Turso budget (CAPACITY.md §6): request-meter.ts meters each
                         invocation's CPU at requireUser and the cron secret check, flushed to the
                         telemetry store's cpu_meter; budget.ts projects the month per limit and
                         sets normal/economy/freeze; daily.ts records it (the daily chores) and
                         writes app_meta.budget_mode; modes.ts is what each mode slows. ARCHITECTURE.md
src/lib/build-skew.ts    when a tab running an old bundle reloads itself (debounce/throttle/
                         defer). The unpinned /api/build probe overrules the cheaper
                         now-playing beacon, which a pinned tab can fake. GOTCHAS.md
src/lib/np-change.ts     the np-change beacon (change → render bound per song change, NOW_PLAYING_2S
                         §4.1) and playThenShow for in-app plays; handoff.ts is Home's verdict on a
                         finished song (how long it was current, the store's rule)
src/lib/dock-motion.ts   Home's dock motion: the pressed control as transform-origin, the exit's end
                         (den.css "The dock's motion"; tests/dock-motion.test.ts)
src/lib/tab-nav.ts       the top tabs' ←/→ and click navigation as pure steps (chrome.tsx): a press
                         moves from the last choice, and a late commit of a place left is undone
src/lib/format.ts        duration/time/day formatting (shared)
src/lib/filter.ts        fuzzyFilter — substring+prefix name search (shared)
src/components/ui/       UI primitives — Base UI under the hood, NOT Radix (see GOTCHAS.md)
src/components/          app components + shared: album-thumb, playlist-thumb, sort-menu,
                         now-playing(-context), track-context-menu, identity-track-menu,
                         track-list, clean-progress, hover-tip, sync-on-load, playlists-sync
                         (the playlists grid is app/(app)/playlists/playlists-grid.tsx; the
                         bottom search pill is app/(app)/search-island.tsx)
docs/                    ARCHITECTURE, FEATURES, ROADMAP, CONVENTIONS, GOTCHAS, SECURITY,
                         READ_QUOTA (the read-cost ledger, the Turso quota guard + August's forensics),
                         STORE_MIGRATION (the app's data moved to Turso on 2026-10-16: the
                         contract the 19xx lanes work from, and their outcomes in section 12)
ops/zenbook-meter/       the store meter deployed on the Zenbook (proxy on 8090 in front of
                         sqld on 8092; exact per-statement rows read/written; telemetry only
                         since the move) + the core fence (503 for core statements while
                         /srv/lazyboy-sqld/FENCE_CORE exists; on since 2026-10-16). Runs as
                         its own account, lbsvc, sandboxed: ops/zenbook-meter/README.md.
                         READ_QUOTA.md, GOTCHAS.md
ops/zenbook-backup/      the nightly backup deployed on the Zenbook (~/lazyboy-backup/backup.py):
                         Rem's rows only (RULINGS Oct 15 6:21 PM): every lb-u-* copy deleted
                         first, friends never dumped, the app and telemetry copies filtered to
                         his uid, then a check that no file names a friend's database.
                         test_backup.py (in npm test); README.md is the install
scripts/backfill-from-backstop.mjs  replay the Zenbook backstop recorder's captured plays
                         into the primary (the loss-repair path; recorder lives on the
                         Zenbook at ~/lazyboy-recorder, lazyboy-recorder.timer, hourly from
                         Phase 3's deploy; every 15 min before it)
scripts/import-extended-history.mjs  refill outage gaps from Spotify's Extended Streaming
                         History export; both importers close with scripts/import-tail.mjs
scripts/np-latency.mjs   read-only: np-change percentiles by path and kind, Home's verdicts joined to
                         the store's plays (NOW_PLAYING_2S §4.4)
scripts/patch-next-router-queue.mjs  postinstall: Next 16.3.0's router-queue fix applied to the
                         installed 16.2.x (a superseded navigation became router state). GOTCHAS.md
scripts/script-user.mjs  every store script's required --user <uid> (OWNER_UID in Phase 1)
scripts/phase1-meta-keys.mjs  writes owner_uid, schema_version, min_reader, store_epoch into a
                         database's meta (Phase 1's deploy step on Rem's `lazyboy`)
```

**Reuse before adding:** formatting → `lib/format.ts`; name search → `lib/filter.ts` (which
folds Han scripts via `lib/han-fold.ts` — any new name match should too); album
art → `album-thumb`; sort dropdown → `sort-menu`; bottom search pill → `search-island`.

## Core rules for this repo (in addition to global CLAUDE.md)

1. **All Spotify calls go through `src/lib/spotify/`** — it owns pagination, 429/Retry-After
   backoff, typing. No raw `fetch` to `api.spotify.com` elsewhere.
2. **Domain logic is pure** in `src/lib/spotify/domain.ts` — dedupe/merge/clean/compare are
   pure functions over plain track arrays. No network, no React. Unit-testable.
3. **Token refresh is centralized** in `src/lib/auth.ts`. Never re-implement the
   `_ensure_token()` sprinkling that plagued the prototype.
4. **Long-running work uses the task registry** (`src/lib/tasks/`), polled by the client.
   The interface is swappable for a DB/queue later (ROADMAP: persist tasks across refresh).
5. **Mutations are server actions or route handlers.** The Spotify access token stays
   server-side and is never sent to the browser: server code gets it from
   `spotifyAccessTokenFor(uid)` (`src/lib/auth.ts`), called **after** the gate in the same
   request.
   It is deliberately not a field on the session — anything on the `Session` interface is
   serialized to the browser at `GET /api/auth/session`. See `docs/SECURITY.md`.
6. **Agents stay off friends' rows.** No agent session reads another user's rows from
   the store, its backups or its logs. Debugging uses Rem's own rows. Spotify's Developer
   Policy forbids ingesting Spotify Content into an AI model, and /privacy promises it.
   Rem's ruling: `docs/multi-user/RULINGS.md` (Oct 15, 6:21 PM).

## Next.js 16 gotchas (differs from older training data — see AGENTS.md)

- `params` and `searchParams` are **Promises** — `const { id } = await params`.
- `cookies()` and `headers()` are **async** — `await cookies()`.
- Route handler 2nd arg: `{ params }: { params: Promise<{ id: string }> }`.
- Middleware is renamed **Proxy** (`src/proxy.ts`). We avoid it: route protection is done
  server-side **in each page** via `requirePageUser()`, before that page's first read. The
  `(app)` layout gates too, but a layout is NOT a gate — it renders in parallel with
  its page, so the page's payload ships inside the layout's 307 (docs/SECURITY.md).
  Host canonicalization (`localhost` →
  `127.0.0.1`, needed so the Spotify OAuth round-trip + cookies stay on one host) is done
  **client-side** by an inline script in the root layout — a server redirect can't do it
  because Next's dev server normalizes the two hosts to one origin and just loops.
- We do **not** enable Cache Components. Data is user-specific and fetched fresh per request.

## Build / run

```bash
npm run dev      # local dev (http://127.0.0.1:3000)
npm run build    # production build — MUST pass before declaring done
npm run lint
npm test         # MUST pass before declaring done — the simulated environment (tests/):
                 # real lib code against a throwaway local SQLite file + a scripted fetch
                 # standing in for Spotify. Touches NO real store, NO Spotify, NO Vercel.
                 # Every audit-class bug fix gets a regression test here (vitest), plus the
                 # node:test known-answer suites (store-diff, build-skew, ledger, meter fence).
```

Spotify redirect URI registered in the dashboard. Local default:
`http://127.0.0.1:3000/api/auth/callback/spotify`. Env in `.env.local` (see `.env.example`).

## Status

`docs/ROADMAP.md` holds the prioritized backlog (from the prototype's `future.txt`) and
tracks implemented vs. pending.
