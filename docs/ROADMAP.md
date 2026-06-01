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
- [ ] **Logout UX fix** — the prototype's logout button was unreachable (hover gap). Our
      header uses a shadcn dropdown with no gap; verify the hover/click path. (Seam done via
      Auth.js `signOut`; confirm UX when iterating on the header.)
- [ ] **Persistent song store** — SQL table of all songs + listen counts + where saved /
      where listened. Plus search. Needs a DB (Postgres/SQLite via Prisma or Drizzle). The
      task registry and service layer are structured to add this without rework.

## Phase 3 — user behavior (`future.txt`)

- [~] **Premium gate at login**, not per-action. Login stores `product`; gate playback
      features (save queue) on it. (Scopes + product read wired; enforce in UI.)
- [ ] **Tasks survive refresh** — clean-playlist progress persists across reloads. The task
      registry interface is the swap point (move from in-memory Map to Redis/DB).
- [ ] **Friends** — see what a friend is playing; let them queue songs for you; DND toggle to
      block modifications. Needs a backend social model + the persistent store.

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
