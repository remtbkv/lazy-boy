# CONVENTIONS.md

## Theme — dark, Spotify-flavored

Goal: visually close to the Spotify app (dark, green accent) but a clean web UI. Light on
chrome, content-forward.

Palette (CSS variables in `src/app/globals.css`, mapped to Tailwind/shadcn tokens):

| Token              | Value      | Use                                  |
|--------------------|------------|--------------------------------------|
| `--background`     | `#0a0a0c`  | app background (near-black)          |
| `--card`           | `#16161a`  | cards, panels                        |
| `--popover`        | `#1c1c22`  | dropdowns, dialogs                   |
| `--muted`          | `#26262d`  | subtle surfaces                      |
| `--foreground`     | `#ededed`  | primary text                         |
| `--muted-fore...`  | `#a1a1aa`  | secondary text                       |
| `--primary`        | `#1db954`  | Spotify green — primary actions      |
| `--primary-fore..` | `#0a0a0c`  | text on green                        |
| `--border`         | `#26262d`  | hairlines                            |
| `--ring`           | `#1db954`  | focus ring                           |
| radius             | `0.75rem`  | rounded, modern                      |

- Green is for **primary CTAs and active state only** — don't flood the UI with it.
- Prefer neutral surfaces + one green accent per view.
- Use shadcn components; don't hand-roll buttons/inputs/dialogs.
- **Selection vs hover:** show selection with a subtle **fill** (`bg-white/[0.06]`) and hover
  with a **border change only** (`hover:border-white/20`, no fill). Keeping the fill exclusive
  to the selected item is what keeps selected vs. merely-hovered legible (day strip, all-time
  card).
- **Counts animate, they don't jolt.** Numbers that update live (plays, listened time on the
  day + all-time cards) roll from the old value to the new via `AnimatedNumber` (ease-out,
  reduced-motion aware, no count-up on first paint). Use it for any number that changes under
  the user.
- **Images load over a steady skeleton, then fade in** (`PlaylistThumb`): a reserved
  aspect-square box with a subtle pulse, the image fading in on decode — so covers arriving at
  different times read as a smooth fill, never a broken grid, and the layout never shifts.
  **Eager-load + high-priority the first view** (e.g. the grid's first ~8 covers); lazy-load
  the rest so mobile/cellular doesn't fetch everything up front. Cover URLs are stored in the
  DB and refreshed on library sync.

## Code style

- TypeScript strict. No `any` in the service/domain layers; use the types in
  `src/lib/spotify/types.ts`.
- Server Components by default. Add `'use client'` only for interactivity (forms, polling).
- Server mutations: a `actions.ts` colocated with the feature, `'use server'` at top.
- Names: `camelCase` functions/vars, `PascalCase` components/types, files `kebab-case.tsx`
  except components which are `PascalCase.tsx`.
- Keep domain logic in `domain.ts` pure — no `fetch`, no React, no `next/*` imports.
- Follow the global CLAUDE.md: simplest thing that works, surgical changes, no speculative
  abstraction.

## Spotify specifics

- Always paginate list endpoints via the client's `getAll` helper — never read only the first
  page.
- Batch playlist writes in chunks of 100 (`addItems`/`replaceItems` do this internally).
- Normalize tracks to `Track` (`{ id, artist, title, uri }`) at the resource boundary; UI and
  domain never touch raw Spotify JSON.
- Dedupe key is `(primary artist, title)`, lowercased — see `domain.keyOf`.

## URL & transient UI state

- **Keep the address bar clean.** Don't encode momentary UI focus (which day to open, which
  song to scroll to and highlight) in query params — it clutters the URL and replays the
  animation on refresh. Reserve real routes/params for shareable state. For transient focus:
  - **Same page → a `window` CustomEvent.** Find's "last played" rows dispatch
    `lazyboy:focus-history`; `history-client.tsx` listens, opens that day, scrolls to + flashes
    the song.
  - **Across routes → `sessionStorage`, consumed once.** Find's "found in" rows stash the
    target track id and navigate to the bare `/playlists/[id]`; `track-list.tsx` reads it on
    mount, scrolls + flashes, then clears it.
  Both leave the URL untouched and skip replay on refresh by nature. These are plain web APIs,
  so they behave the same on mobile and desktop.

## Errors

- The client throws `SpotifyError { status, message }`. Actions catch and return a typed
  `{ ok: false, error }` to the UI; pages can show a toast/inline message.
- A `session.error === "RefreshAccessTokenError"` means re-login — the `(app)` layout
  redirects to `/login`.

---

**Related:** [ARCHITECTURE](ARCHITECTURE.md) (the layering these rules enforce) ·
[FEATURES](FEATURES.md) (the `domain.keyOf` dedupe identity) · [GOTCHAS](GOTCHAS.md).
