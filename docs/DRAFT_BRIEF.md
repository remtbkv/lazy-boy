# /draft redesign — working brief

The operating prompt for the visual redesign staged at `/draft`. Written per the Fable
prompt guidelines (mission as invariant, per-deliverable verification, defect-class
thinking). Delete this file when the redesign ships or is abandoned.

## Mission (invariant, not a task list)

When this work is done, the following holds:

1. **Every screen holds up on a 390px phone and a 1440px desktop** — no horizontal body
   scroll, no wrapped-pill soup, no crammed stat cards, tap targets ≥ 44px, thumb-reach
   navigation on mobile. "Holds up" is judged in a real browser at both widths, not in
   the imagination.
2. **The app reads as designed, not generated.** Concretely: a committed direction
   (below), not the default dark-shadcn look — uniform gray cards, evenly spaced
   icon+label chips, one font at one weight, decoration-free sameness.
3. **Nothing behind the UI gets worse.** The draft route adds zero Spotify API calls,
   touches none of the sync/poll guards, and changes nothing outside `src/app/draft/` +
   its own components. Strict-increase rule: any perf change must be defensible with a
   mechanism (e.g. windowing a 1000-row list), or it doesn't happen.

Symptom list (evidence the invariant currently breaks, NOT the scope): 6 action pills
wrap into ragged rows on phones; 7-day stat cards cram a 390px row; the floating search
pill fights the iOS toolbar; header tabs never collapse; no logout on mobile; 5 action
panels have zero responsive classes; hover-only tooltips and hover-reveal controls are
dead weight on touch.

## Design direction (committed — execute, don't re-litigate)

**"Night den."** Lazy Boy is a sleepy panda doing your playlist chores. The app should
feel like a warm, dim room where music data is ambient, not a dashboard.

- **Type**: Bricolage Grotesque for display (greeting, headings, big numbers), Figtree
  stays for body. Loaded via `next/font` in the draft layout only.
- **Color**: warm the neutrals (charcoal with a faint green-black cast, softer off-white)
  and make green *semantic*: green = alive, now (playing, syncing, today). Everything
  static stays neutral. One warm secondary (bamboo tan) in micro-doses.
- **Show, don't tell**:
  - The panda mark sleeps when nothing plays; it perks up while music is playing (SVG
    state off the existing now-playing context). No label ever says "playing".
  - Ambient background tint follows local time of day (night/dawn/day/dusk) — felt, not
    announced.
  - The day strip becomes a listening-rhythm spine (compact per-day bars) instead of
    seven identical stat boxes; the numbers live one level down.
- **Rem's standing taste** (from memory, binding): minimal green, neutral outlines, no
  chip-pills, never obscure album art, hover-to-reveal on desktop but everything
  reachable on touch.
- **Mobile chrome**: ~~bottom tab bar~~ (built, then removed 2026-08-12 — one top bar
  carries everything on phones now), action panels open as bottom sheets, day strip
  snap-scrolls with edge fade, history rows become compact cards under 640px, safe-area
  insets respected.

## Verification bar (per deliverable)

- Every layout state: rendered in Playwright at 390×844 AND 1440×900 with real DB data,
  screenshot inspected, before it counts as done. One frame is not verification — check
  empty-search, open-panel, and long-list states too.
- `npx tsc --noEmit` + `npm run lint` clean. No `npm run build` while dev runs.
- iOS traps re-checked per screen: 16px input floor, visualViewport pinning,
  `env(safe-area-inset-bottom)`, no fixed element under the home indicator.
- The draft page makes zero requests to api.spotify.com (DB reads only) — verify in the
  network log once.

## Serial edges / ownership

- `globals.css` and everything under `(app)`/`(auth)` are NOT touched; draft styles are
  scoped to the draft layout. The main app must render pixel-identical after this work.
- `src/lib/db.ts` is reused read-only. New queries only if a view needs one, additive.
- Auth: in production the draft route requires a session like `(app)`; in dev it renders
  without one (that's what makes unattended iteration possible).

## Found-work grant

Adjacent defects found while working (dead `compare-results.tsx`, `.ui-backup/` corpses,
unused `next-themes`, unvirtualized `track-list`) get *reported*, and fixed only when the
fix is cheap, in-reach, and provably strict-increase. The missions are the spine, not the
fence; the pinned constraints above (no main-app edits, no new API volume, no deploys
without Rem) bound everything.

## Budget posture

Ample session — parallelize freely, but the thinking (layout decisions, type/color calls,
what makes it feel designed) stays in the main session; mechanical file production can be
delegated with a tight spec.
