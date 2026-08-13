# Phone search mode — approved plan (2026-08-13)

Rem approved this spec verbally ("I will put fable on this") after the 2026-08-13 mobile
rounds. Build it as written; delete this file when it ships.

## The problem

In search on a phone, the page is still the full Home layout: greeting, action pills and
the day strip stay mounted above the results box, and the box's height was sized for the
no-keyboard page. With the keyboard up only ~40% of the layout is visible, Safari pans
around a box never sized for that window → dead black space below the results (Rem's
11:43 AM screenshot), scrolling required to see anything.

## The design

A real search MODE on phones (<640px). Desktop untouched.

1. **Enter** — tapping the pill docks it to the top (already shipped) AND collapses the
   home bands (greeting, action pills, day strip). Search owns the screen.
2. **While typing** — the results box is the only thing between the pill and the
   keyboard; its height is driven live off the visual viewport (CSS var `--lb-vvh`
   updated from `visualViewport` resize/scroll events), so its bottom hugs the keyboard
   top exactly. No dead zone; only the list scrolls.
3. **Browsing** — a scroll gesture in the results dismisses the keyboard (blur on touch
   scroll start — the iOS-native pattern); the box grows into the freed space; the pill
   stays docked with the query.
4. **Cancel** — a "Cancel" affordance beside the top-docked pill (phone only): clears
   the query, blurs, pill returns to the bottom, bands return. Clearing text + keyboard
   dismissal does the same.

## Mechanics

- `DenHome` flips a `den-searching` class on `#den-root` (same pattern as
  `LockViewport`); `den.css` hides the band wrappers under 640px. Tag the greeting +
  dock wrappers in `home/page.tsx` (they're outside DenHome) with a `den-home-band`
  class so CSS can reach them.
- Search-mode state = phone && (input focused || query non-empty). SearchIsland already
  owns `focused` — lift it via an `onFocusChange` callback prop.
- A small hook publishes `visualViewport.height` as `--lb-vvh` on `#den-root`; in
  search mode the results container gets `height: calc(var(--lb-vvh) - <pill band>)`.
- Playlists page: same island, but no bands to hide — verify it degrades sanely.

## Verification protocol (the part that made this round work)

Static frames: Playwright at 390×844 + desktop 1280 regression.
Dynamic/keyboard: the iOS Simulator harness — see memory
`lazyboy-ios-simulator-testing` and `/kbtest` (a full home lookalike with a live
vv/zoom/layout/pill trace burned into recordings). Non-obvious traps, learned hard:

- Drive typing with `idb ui tap` on key coordinates ONLY. `idb ui text`/`ui key` are
  HID → iOS latches "hardware keyboard", the on-screen QWERTY stops rendering and stays
  gone across reboots; `xcrun simctl erase <udid>` resets it.
- iOS 26.5 Safari ignores `interactive-widget=resizes-content` (layout stayed 714pt
  with keyboard up). The shipped mechanism is top-dock + a ~700ms rAF scroll-pin at
  focus (cancels Safari's pan to the input's old position). Do NOT dock on pointerdown
  — the input moves out from under the finger, iOS drops the click, focus never lands.
- Inputs on phones must be raw `text-[16px]` — under 16px iOS zooms the page on focus
  (the 85% root scale makes `text-sm` ≈ 12px).
- Devices: iPhone 17 Pro / iOS 26.5 UDID `E37237AA-2A44-4A6C-B77B-FEF08FE5DDCD`
  (liquid glass), iPhone 16 Pro / iOS 18.6 `94B60D54-3705-4A84-B880-CFDE456F00F4`.
  Rem wants dynamic checks on MULTIPLE sizes when it's cheap. Simulator taps are in
  points (17 Pro: 402×874). Rem's on-device recordings remain the final word.

## Session state (post-compact context)

- Prod = `0e7eb3a` lineage, all 2026-08-13 mobile rounds shipped: one top bar (Home tab
  restored), 85% phone scale, portrait day cards + inline All-time + hairline
  scrubbers, 7-day strip ladder, gutter pills, From column = play context (membership
  lives only in search's expanded "In …" line), iMessage-shape locked Home, song box
  clips corners, full-width titles (table-fixed width hint on the plays td), search
  pill top-docks on focus with scroll-pin + 16px font.
- GitHub SSH auth broke mid-session (key rejected); origin now points at HTTPS with
  `gh` credentials (`gh auth setup-git` ran). SSH key state on GitHub unresolved.
- Deploy flow: `npx vercel --prod --yes`, verify `curl /api/build` matches HEAD.
