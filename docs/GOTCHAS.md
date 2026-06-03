# GOTCHAS.md — hard-won lessons for this repo

Read this before debugging. Each item below cost real time to discover; trust it
instead of re-investigating. (Pairs with `CLAUDE.md`, `AGENTS.md`, and the other
`docs/`.)

## Runtime / dev environment

- **Access the app at `http://127.0.0.1:3000`, never `localhost`.** The Spotify
  redirect URI is the loopback IP, and the session cookie is bound to it. Cookies
  do **not** cross `localhost` ↔ `127.0.0.1`, so opening `localhost` looks logged
  out and breaks the OAuth PKCE cookie.
- **`next.config.ts` must keep `allowedDevOrigins: ["127.0.0.1", "localhost"]`.**
  Without it, Next 16 blocks `/_next` dev resources as cross-origin, the client
  runtime never hydrates, and **every interactive element silently does nothing**
  (dead buttons, dead inputs). If you ever see "buttons do nothing," check this
  and hydration FIRST — it's almost never the component.
- **Project location: `~/projects/spotify_claude_manager`.** It used to live in a
  OneDrive cloud-synced folder, where file watching was unreliable and the dev
  server served stale compiled code; it was moved to `~/projects` on 2026-06-01 to
  fix that, so HMR is now reliable. If a change still "isn't taking effect" (e.g.
  HMR websocket noise in a sandbox), the hard reset is:
  `pkill -f "next dev"; rm -rf .next/dev; PORT=3000 npm run dev`.
- **Never run `npm run build` while `next dev` is running** — both write `.next`,
  so the dev server starts returning 500s / `ERR_INCOMPLETE_CHUNKED_ENCODING` and
  client navigation (`router.push`) silently fails. Symptom: arrow-key/link nav
  "doesn't work" even though the code is fine. Fix: stop dev, build (or not), then
  restart dev clean. To just typecheck without disturbing dev, prefer `npx tsc --noEmit`.
- **Session is a 30-day persistent JWT** (`src/lib/auth.ts`); the cookie just marks
  who's logged in. **Spotify tokens live in the DB** (`meta.spotify_tokens`), which
  is the source of truth, NOT the cookie. This exists because Spotify's PKCE refresh
  token **rotates on every use**: with tokens in the cookie, a page refresh fires
  several concurrent requests that each refresh with the same (soon-invalidated)
  token, and the losers get `invalid_grant` → forced re-login. Now an in-process
  lock (`refreshShared`) coordinates one refresh, writes the new tokens to the DB,
  and everyone reads the latest from there. Refresh retries transient failures
  (429/5xx/network) and only forces re-login on a genuinely dead refresh token
  (`invalid_grant`). Older cookie-stored tokens are migrated into the DB on first
  request. If you ever wipe `data/listens.db` you'll need to reconnect once.

## Base UI primitives — NOT Radix

The `src/components/ui/*` components are generated against **`@base-ui/react`**
(v1.x), not Radix. Base UI differs in ways that broke things here:

- **Controlled `Checkbox` / `Input` `onChange` does not propagate** in this
  React 19 setup — the controlled value snaps back / never updates. Both were
  rewritten to **native** `<input>` elements (`ui/checkbox.tsx`, `ui/input.tsx`).
  Do **not** reintroduce Base UI controlled form inputs.
- **A native `<input>` nested in a `<label>` double-fires `onChange`** here (one
  click → two toggles → net zero). For clickable rows, put a single `onClick` on
  a `<div role="checkbox">` and keep the checkbox **visual-only** (see
  `merge-panel.tsx`, `track-list.tsx`, `ui/checkbox.tsx`).
- **`DropdownMenuLabel` must sit inside a `Menu.Group`** or Base UI throws
  `MenuGroupContext is missing` (crashed the profile menu → "page couldn't
  load"). It's a plain `<div>` now.
- **Base UI `Menu` has no `openOnHover` prop.** Hover-to-open is done with
  controlled `open` state + a close-delay bridge in `header.tsx`.
- Triggers use the **`render`** prop, not Radix's `asChild`.

## Spotify Web API — changed since model training data

- **Playlist tracks moved from `/playlists/{id}/tracks` to
  `/playlists/{id}/items`.** The old `/tracks` endpoint now returns **403** for
  GET (and writes). Use `/items` everywhere (GET list, POST add, PUT replace).
- **Response key renames** (see `resources.ts`):
  - Playlist object: the track-paging object is under **`items`**, not `tracks`.
    Read the count as `raw.tracks?.total ?? raw.items?.total`.
  - Playlist item rows: the track is under **`item`**, not `track`. Read
    `i.item ?? i.track`.
- The HTTP client (`client.ts`) retries **403** (transient rate-limit) with
  backoff, like 429.
- **Development-mode restriction:** the Spotify app is in dev mode, so reading
  **any other user's** profile/playlists returns **403** (confirmed even for the
  official `spotify` account). This blocks **Compare-a-friend, the playlist
  subtracter, and all friend features** until the user adds those people to the
  app's allowlist in the Spotify dashboard → User Management. **Not fixable in
  code.** Don't keep retrying or assume the user ID is wrong — it's a dashboard
  setting the user controls.

## Architecture added recently

- **Persistent playlist library (DB-backed):** the full library is stored in
  SQLite (`playlists` table in `src/lib/db.ts`, native order). `/me` and
  `/playlists` read it **synchronously on render — no Spotify call**, so pages are
  instant and never block/rate-limit on a library scan. `playlists-sync.tsx`
  (client) fires `POST /api/playlists/sync` when the store is empty or >15 min
  stale; the sync does the one full scan off the render path, then `router.refresh()`
  shows fresh data. `me_id` + `playlists_synced_at` live in the `meta` table. The
  old per-page `/api/playlists?offset=` waterfall is gone (the route file remains
  but is unused). `playlist-grid.tsx` still collapses to 3 rows with see-more +
  fuzzy search; thumbnails are lazy.
- **Listen-history backend (`src/lib/db.ts`):** local **SQLite** via
  `better-sqlite3` at `data/listens.db` (gitignored; `serverExternalPackages`
  lists it in `next.config.ts`). Synced on demand from
  `/me/player/recently-played` in `history/actions.ts`. Tables: `tracks`,
  `plays` (deduped on `played_at`), `contexts` (resolved playlist/album names for
  the "From" column). The `/history` page shows per-day cards + a searchable log.
  **The "Sync recent plays" button is temporary** — slated to become a ~30s
  background poll (the user asked to be reminded).

## Verifying UI with Playwright

- The dev server is usually already running in the background; HMR is reliable now
  that the project is outside OneDrive (see Runtime / dev environment above).
- Auth expires ~hourly → re-auth in the browser: `/login` → "Connect Spotify" →
  "Agree" (the Spotify account stays logged in, so it's two clicks).
- Save screenshots to `~/.claude/screenshots/` (user rule), never the project.

## Player simulation (now-playing + track menu)

- **Now-playing must never show stale data.** Use live player state, NOT `recently-played`
  (that's history). `currentlyPlaying()` reads `/me/player/currently-playing` (204 → `null`
  when idle), then **falls back to `/me/player`** when that returns 204 — the
  currently-playing endpoint intermittently 204s *during* active playback (right after a
  track change / slow desktop client), which read as "the site doesn't recognize my player."
  `/me/player` still reports the active device's track in that window and itself 204s when
  there's truly no active device, so the fallback stays live. The bar (`now-playing.tsx`,
  mounted in the `(app)` layout) renders only when a track comes back.
- **Add to queue** needs an active device; Spotify 404s otherwise → the action returns a
  friendly "no active device" message. Same dev-mode caveats don't apply (it's your own player).

## Reuse, don't recreate (post-refactor)

Shared helpers were extracted — use them instead of re-writing:
`lib/format.ts` (durations/times/day labels), `lib/filter.ts` (`fuzzyFilter`),
`components/album-thumb.tsx`, `components/sort-menu.tsx`, `components/floating-bar.tsx`.
The `(app)` pages stream their data (Suspense) so a slow/rate-limited Spotify call never
blocks the whole page — keep that pattern.

## Production security

See `docs/SECURITY.md` before any public deploy. Biggest item: the listen-history DB is
**not user-scoped** (single-user). Baseline security headers are in `next.config.ts`.
