# ROADMAP.md

Backlog sourced from the prototype's `future.txt`, reprioritized for the rewrite. Update the
status boxes as items land.

Legend: `[x]` done · `[~]` partial / seam in place · `[ ]` not started

## Phase 0 — foundation (this rewrite)

- [x] Next.js 16 + TS + Tailwind v4 + shadcn scaffold
- [x] Auth.js Spotify login with centralized token refresh (fixes the repeated
      `_ensure_token()` smell from `future.txt` low-priority item)
- [x] Typed Spotify service layer with pagination + 429/Retry-After handling
- [x] Pure domain logic (dedupe/merge/clean/compare) — unit-testable
- [x] Header tabs: **Me** (home), **Playlists** (management), **Friends** (placeholder)
      — from `future.txt` "User behavior: tabs in header"
- [x] Background-task registry + progress polling seam (for clean playlist)

## Phase 1 — core playlist tools (ported)

- [x] List playlists + lazy-load detail (addresses "loads slowly because it loads all
      playlists" — detail tracks load on the playlist page, not up front)
- [x] Merge playlists
- [x] Clean playlist (background task with live counter)
- [x] Find duplicates
- [x] Remove songs → new playlist
- [x] Liked songs → mirror playlist
- [x] Save queue (uses the real `GET /v1/me/player/queue` endpoint)

## Phase 2 — high priority (`future.txt`)

- [x] **Compare another user's playlist** — real song diff (saved vs unsaved), savable.
      (Prototype only displayed; this also lets you save the diff.)
- [x] **Logout UX fix** — the prototype's logout button was unreachable (hover gap). Our
      header dropdown has a small `sideOffset` (no gap) and logout is a form-submit menu
      item, so the hover→click path stays connected. Uses Auth.js `signOut`.
- [~] **Persistent song store** — SQLite (`better-sqlite3`, `data/listens.db`) via
      `src/lib/db.ts`. DONE: listen history synced from `/me/player/recently-played`
      (`tracks`/`plays`/`contexts` tables), the `/history` page (per-day cards + searchable
      log with play counts, last-played, album art, duration, resolved "From" playlist
      names). TODO: replace the manual "Sync" button with a ~30s background poll; "where
      saved" (which playlists contain a song) is not implemented yet.

## Phase 3 — user behavior (`future.txt`)

- [~] **Premium gate at login**, not per-action. Login stores `product`; gate playback
      features (save queue) on it. (Scopes + product read wired; enforce in UI.)
- [ ] **Tasks survive refresh** — clean-playlist progress persists across reloads. The task
      registry interface is the swap point (move from in-memory Map to Redis/DB).
- [ ] **Friends** — let them queue songs for you; the song is held server-side and
      delivered to your Spotify queue when you next have an active device (works even
      if you're offline when they send it). DND toggle to block modifications.
      ("See what a friend is playing" is dropped — Spotify already shows that.)
      Needs a backend social model + the persistent store.
- [ ] **Playlist subtracter** — pick your playlist and a friend's; show the set diff
      (unique to you / unique to them / shared) at a glance. Built on `compareUser`.

> **BLOCKER for all "friend" features (subtracter, friend queue, compare):** the Spotify
> app is in **development mode**, so reading any other user's data returns **403** (even the
> official `spotify` account). The user must add each friend to the app's allowlist in the
> Spotify dashboard → User Management (≤25 users), or request extended-quota mode. Not
> fixable in code. See `docs/GOTCHAS.md`.

## Phase 4 — nice to have / unlikely (`future.txt`)

- [ ] **AI playlist** — send playlist track titles to an LLM with formatting rules, get an
      organized playlist back, preview + confirm/retry-with-instructions, then create.
      (Natural fit for the Claude API; see `claude-api` skill.)
- [ ] **Playlist subtracter "visualizer"** — visual diff/subtraction of playlists.
- [ ] **Visual merge-sort ranking** — rank songs by preference via pairwise comparisons.
- [ ] **Synced jam over different wifi** — shared live queue across users (depends on Spotify
      queue API improving; explicitly "future, unlikely").

## Known issues to keep in mind (`future.txt` "issues along the way")

- Mysterious rate limits / immediate 429s → handled centrally in `client.ts`; keep all calls
  going through it and keep writes batched.
- Queue read near ~95 items errored in the prototype's skip-walk approach → avoided by using
  the real queue endpoint.
- Can't mute volume on phone (403 `Cannot control device volume`) → not relevant now that we
  read the queue directly instead of muting + skipping.
