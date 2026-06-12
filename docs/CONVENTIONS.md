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

## Errors

- The client throws `SpotifyError { status, message }`. Actions catch and return a typed
  `{ ok: false, error }` to the UI; pages can show a toast/inline message.
- A `session.error === "RefreshAccessTokenError"` means re-login — the `(app)` layout
  redirects to `/login`.

---

**Related:** [ARCHITECTURE](ARCHITECTURE.md) (the layering these rules enforce) ·
[FEATURES](FEATURES.md) (the `domain.keyOf` dedupe identity) · [GOTCHAS](GOTCHAS.md).
