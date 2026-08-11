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
src/app/(auth)/          login page (unauthenticated shell)
src/app/(app)/           authed shell: layout calls auth() + owns the chrome (chrome.tsx,
                         den.css skin, now-playing provider); pages bring their own <main>
                         home/ (greeting, action dock, day strip, song table), playlists/,
                         playlists/[id]/, friends/, usage/ (per-page load speed, then the
                         rows-read ledger below it; no nav link)
                         history-actions.ts  Home's listen-history reads + the Spotify sync
src/app/api/auth/        Auth.js route handler (NextAuth catch-all)
src/app/api/tasks/       background-task progress polling endpoint
src/app/api/playlists/sync  one full library scan → DB, as a background task (the cron tick
                         keeps the store fresh; the client only fires this on a cold/empty store)
src/app/api/search/       the two payloads Home filters in the browser (authed, private,
                         ETag'd): library/ = every track in a playlist or Liked Songs,
                         history/ = every played track + every play. Both load on idle after
                         Home paints; the history half also feeds the day list, which is
                         grouped out of it client-side instead of fetched per day
src/app/api/now-playing/ live "what's playing"; null when idle (never stale)
src/app/api/build/       this deployment's build id, unauthenticated, no DB — fetched with
                         credentials omitted so it escapes Vercel's deployment pinning
src/app/api/sync/        on-load listen-history sync (POST; debounced server-side)
src/app/api/cron/sync/   scheduled history sync (external pinger e.g. cron-job.org; daily Vercel cron
                         backstop) + the library rescan, self-gated to every 30 min
src/app/api/cron/usage-check/  DORMANT Turso quota guard: real usage vs month pace, 500 on
                         breach (daily cron-job.org job e-mails on failure). Only relevant if
                         production ever falls back to Turso — the store is self-hosted and
                         meters nothing. Its reconciliation still feeds /usage. docs/READ_QUOTA.md
src/lib/auth.ts          Auth.js config + Spotify token refresh (centralized)
src/lib/session.ts       getSpotify(): server-only authed Spotify client
src/lib/spotify/         client.ts (fetch+pagination+429/403), resources.ts, domain.ts, types.ts
src/lib/tasks/           in-memory task registry (clean-playlist progress); swappable iface
src/lib/db.ts            libSQL store (listen-history + tokens) — self-hosted sqld on the
                         Zenbook over a Tailscale Funnel; async; file: fallback in dev. ONE
                         client, getClient(): every read, every write, all of `meta`. The
                         embedded replica is gone (2026-08-11). GOTCHAS.md
src/lib/read-costs.ts    the MODELED rows-read cost of every named read path + the residual
                         alarm rule; what db.ts's usage_ledger records. docs/READ_QUOTA.md
src/lib/build-skew.ts    when a tab running an old bundle reloads itself (debounce/throttle/
                         defer). The unpinned /api/build probe overrules the cheaper
                         now-playing beacon, which a pinned tab can fake. GOTCHAS.md
src/lib/format.ts        duration/time/day formatting (shared)
src/lib/filter.ts        fuzzyFilter — substring+prefix name search (shared)
src/components/ui/       UI primitives — Base UI under the hood, NOT Radix (see GOTCHAS.md)
src/components/          app components + shared: album-thumb, sort-menu, floating-bar,
                         now-playing, track-context-menu, playlists-client, playlist-grid,
                         merge-panel, track-list, clean-panel
docs/                    ARCHITECTURE, FEATURES, ROADMAP, CONVENTIONS, GOTCHAS, SECURITY,
                         READ_QUOTA (the read-cost ledger + the retired Turso quota's forensics)
scripts/backfill-from-backstop.mjs  replay the Zenbook backstop recorder's captured plays
                         into the primary (the loss-repair path; recorder lives on the
                         Zenbook at ~/lazyboy-recorder, lazyboy-recorder.timer, every 15 min)
```

**Reuse before adding:** formatting → `lib/format.ts`; name search → `lib/filter.ts`; album
art → `album-thumb`; sort dropdown → `sort-menu`; bottom search pill → `floating-bar`.

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
   `spotifyAccessToken()` (`src/lib/auth.ts`), called **after** `auth()` in the same request.
   It is deliberately not a field on the session — anything on the `Session` interface is
   serialized to the browser at `GET /api/auth/session`. See `docs/SECURITY.md`.

## Next.js 16 gotchas (differs from older training data — see AGENTS.md)

- `params` and `searchParams` are **Promises** — `const { id } = await params`.
- `cookies()` and `headers()` are **async** — `await cookies()`.
- Route handler 2nd arg: `{ params }: { params: Promise<{ id: string }> }`.
- Middleware is renamed **Proxy** (`src/proxy.ts`). We avoid it: route protection is done
  server-side **in each page** via `auth()` + `redirect()`, before that page's first read. The
  `(app)` layout also calls `auth()`, but a layout is NOT a gate — it renders in parallel with
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
```

Spotify redirect URI registered in the dashboard. Local default:
`http://127.0.0.1:3000/api/auth/callback/spotify`. Env in `.env.local` (see `.env.example`).

## Status

`docs/ROADMAP.md` holds the prioritized backlog (from the prototype's `future.txt`) and
tracks implemented vs. pending.
