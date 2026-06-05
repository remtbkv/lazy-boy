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
src/app/(app)/           authed shell: layout calls auth(), header tabs, feature pages
                         home/, playlists/, playlists/[id]/, compare/, friends/, history/
src/app/api/auth/        Auth.js route handler (NextAuth catch-all)
src/app/api/tasks/       background-task progress polling endpoint
src/app/api/playlists/sync  one full library scan → DB (client fires when stale)
src/app/api/history/     listen-history search (reads the DB)
src/app/api/now-playing/ live "what's playing"; null when idle (never stale)
src/app/api/sync/        on-load listen-history sync (POST; debounced server-side)
src/app/api/cron/sync/   scheduled history sync (GitHub Actions every 5m + Vercel cron)
src/lib/auth.ts          Auth.js config + Spotify token refresh (centralized)
src/lib/session.ts       getSpotify(): server-only authed Spotify client
src/lib/spotify/         client.ts (fetch+pagination+429/403), resources.ts, domain.ts, types.ts
src/lib/tasks/           in-memory task registry (clean-playlist progress); swappable iface
src/lib/db.ts            libSQL/Turso store (listen-history + tokens); async; file: fallback in dev
src/lib/format.ts        duration/time/day formatting (shared)
src/lib/filter.ts        fuzzyFilter — substring+prefix name search (shared)
src/components/ui/       UI primitives — Base UI under the hood, NOT Radix (see GOTCHAS.md)
src/components/          app components + shared: album-thumb, sort-menu, floating-bar,
                         now-playing, track-context-menu, playlists-client, playlist-grid,
                         merge-panel, track-list, clean-panel, history-client, header
docs/                    ARCHITECTURE, FEATURES, ROADMAP, CONVENTIONS, GOTCHAS, SECURITY
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
   server-side and is never sent to the browser.

## Next.js 16 gotchas (differs from older training data — see AGENTS.md)

- `params` and `searchParams` are **Promises** — `const { id } = await params`.
- `cookies()` and `headers()` are **async** — `await cookies()`.
- Route handler 2nd arg: `{ params }: { params: Promise<{ id: string }> }`.
- Middleware is renamed **Proxy** (`src/proxy.ts`). We avoid it: route protection is done
  server-side in the `(app)` layout via `auth()`.
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
