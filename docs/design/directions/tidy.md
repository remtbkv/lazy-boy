# Direction "tidy": today's structure, every value chosen once

Lane 2991, Oct 15, 2026. Read `../COMMON.md` first (in the repo: `docs/design/directions/COMMON.md`);
it holds Rem's rules, Spotify's rules, the words, the fixes, how this plugs into `/design`, and the
capture list. This file is the look and the layout. Folder: `src/app/design/directions/tidy/`. Branch:
`design/tidy`.

## The idea

Rem's app as it stands: the same pages, the same nav, the chores on Home, now-playing in the header,
search at the bottom. What changes is how it is drawn, which is where the audit found most of the
machine-made look: a greeting at display size that heads nothing, five equal icon pills, a framed tray of
framed cards at shadcn's default radius, a line and a mat around every cover, tracked capitals, stock
text. Tidy answers each one in place. It is the cheapest port and the control for the other two: if Rem
picks it, the overhaul was mostly a drawing problem.

**The greeting stays, at title size, and holds still for a day.** It becomes Home's title: 22px, the same
slot and style every other page uses for its title, with room above it. One line per calendar day
instead of one per load, so the top of the page is learned and changes tomorrow. The lines are Rem's and
are not touched. On a row of its own with the chores beside it, it no longer pushes the music down by a
band.

## Tokens

All colours are the ink palette Rem picked in July (`den.css`), named by job. Set them on
`#den-root[data-direction="tidy"]`.

| token | value | job |
|---|---|---|
| `--page` | `#0b0b0e` | the page, the header, the phone status-bar area |
| `--well` | `#111115` | the day strip's tray |
| `--raised` | `#16161b` | day cells, All time, inputs, tile hover |
| `--raised-hover` | `#1b1b21` | a day cell under the pointer |
| `--raised-selected` | `#222229` | the selected day cell (with `--sel-ring`) |
| `--sel-ring` | `#71717c` | 1px inset ring on the selected day cell only |
| `--overlay` | `#1b1b21` | menus, popovers, sheets |
| `--line` | `#26262d` | the header's bottom rule, the column header's rule, button and input borders |
| `--row-line` | `rgba(255,255,255,0.06)` | between song rows |
| `--ink` | `#ececf1` | primary text, primary button fill |
| `--ink-2` | `#a0a0aa` | secondary text |
| `--ink-3` | `#6b6b75` | placeholders, disabled, the error reference line |
| `--hover` | `rgba(255,255,255,0.07)` | row and button hover |
| `--selected` | `rgba(255,255,255,0.16)` | selected row (stays lit under its menu) |
| `--playing` | `#1db954` | the phone's ring around the playing cover; nothing else |
| `--warn` | `#d4a72c` | the 6px dot before a notice; nothing else |
| `--glass` | `rgba(27,27,33,0.92)` + `backdrop-filter: blur(16px)` | the floating search capsule only |

Type, in px (size / line height / weight). Desktop first, phone after the slash where it differs.

| style | spec | used for |
|---|---|---|
| title | 22/28/600, letter-spacing -0.01em · phone 20/26/600 | Home's greeting, every page title (Friends, Usage, error, sign-in) |
| object | 28/34/600 · phone 24/30/600 | a playlist's name on its page |
| body | 15/20/400 | row titles, menu items, panel text, inputs (16 on the phone, iOS zoom floor) |
| meta | 13/18/400, `--ink-2` | artists, albums, times, counts in rows |
| label | 12/16/500, `--ink-2` | column headers (Title case) |
| cell-label | 13/18/500, `--ink` | "Today", "Yesterday", "Oct 13", "All time" |
| figure | 20/24/600 tabular · phone 18/22/600 | a cell's play count |
| nav | 15/20/500 | header tabs |
| button | 13/18/500 · phone 15/20/500 | button labels |

Weights: 400, 500, 600 only. Spacing steps: 4, 8, 12, 16, 24, 32, 48. Radii: 4 (art, the duplicate
badge), 6 (buttons, inputs, menu items), 8 (day cells, tiles, menus, popovers), 12 (the strip's well,
the All time block, sheet top corners), full (avatar, the search capsule and its segmented switch).
One shadow, for floating layers only (menus, popovers, the capsule): `0 8px 24px rgba(0,0,0,0.5)`.

Motion: `quick` 120ms (hover colour, press), `base` 160ms (menus, popovers), `row` 240ms (a row
arriving), `sheet` 300ms in / 230ms out. Curves: `out` `cubic-bezier(0.2,0.8,0.2,1)`; `sheet`
`cubic-bezier(0.32,0.72,0,1)`; `exit` `cubic-bezier(0.4,0,0.7,0.95)`. With `prefers-reduced-motion`,
everything is instant except opacity fades of 120ms or less.

## Components

**Header (desktop).** 64px, `--page`, opaque, 1px `--line` bottom. Content box 1024px wide centred,
24px padding. Left: the panda (36px, today's motion), 24px gap, nav: Home, Playlists, Friends, 15/500,
active `--ink`, others `--ink-2`, hover `--ink`, 8px between tabs, no boxes. Right, from the left: the
now-playing chip, 16px, Spotify's full logo (70px wide, links to the playing track, 12px clear space),
16px, the avatar (32px, 2px ring in `--line`; hover turns the ring `--ink-2`; no scale, no glow).

**Now-playing chip (desktop).** Today's chip, kept: art 36px (4px radius), title 13/500 `--ink` over
artist 12/400 `--ink-2` in a 158px box (long titles slide on hover, as today), a 2px progress line under
them (`rgba(255,255,255,0.15)` track, `--ink` fill, information only). Clicking toggles play/pause, as
today. Paused: the art at 60% opacity, the line stops. Nothing playing: the chip is absent and the logo
stays.

**Header (phone).** 56px, `--page`, 1px `--line` bottom, 16px side padding. Panda 32px; nav 15/500 with
6px side padding per tab; right: Spotify icon 21px, 8px, the playing cover 32px with today's green ring
(2.5px off the art, breathing; audit C4 is Rem's call), 12px, avatar 32px. Nothing playing: the icon
stays, the cover is absent. The bar slides away on scroll down and back on scroll up, as today.

**Home's title row.** Desktop: 32px below the header (y = 96), height 32. Left: the greeting in the
title style, one line, truncating at the chores. Right: the five chores. Phone: the greeting 20px below
the header, then the chores on their own row 12px below it.

**The greeting line.** Index = (whole days since 1970-01-01 on the person's local date) modulo the
number of lines in `greetings.md`; `{name}` becomes the first name ("Sam"). Pick it on the server so the
first paint has it: in production from the `tzoffset` cookie (`lib/tz.ts`), in `/design` from
`config.anchor` in UTC. `?greeting=<n>` pins a line for captures. Read the file through
`loadGreetings()` from `src/app/(app)/home/greetings.ts`.

**Chores.** Resume, Clean, Save queue, Merge, Subtract, in that order, text only (the lucide glyphs go).
Desktop: 32px tall, 12px side padding, 6px radius, 1px `--line`, no fill, label 13/500 `--ink-2`; hover
`--hover` fill and `--ink` label; pressed `--selected`; 8px gaps. Phone: one horizontal row that scrolls,
40px tall (44px tap target), 16px side padding, label 15/500, 8px gaps, today's edge fades (right fade at
rest, both once scrolled).

**The day strip.** A well: `--well`, 12px radius, 4px padding, no border. Inside, the day cells: 140px
wide (phone 96), 12px padding (phone 10px 12px), 8px radius, `--raised`, no border, 4px apart. Cell
content, top to bottom: cell-label; 6px; the figure followed by " plays" in meta (one line, baseline
aligned); 2px; the listened time in meta. Five cells stand full on desktop and the sixth is cut by the
well's right-edge fade (Rem's clip); the phone shows two and a slice. The "more days" chevron sits after
the last cell inside the well, 32px wide, `--ink-2`, reading "See all" beside it at the last rung.
States: hover `--raised-hover` (no ring); selected `--raised-selected` plus a 1px inset `--sel-ring`.
Hover and selected never look alike.

All time is a block beside the well, 8px to its right: same height as the well, 184px wide (phone
112px), `--raised`, 12px radius, 16px padding (phone 14px), so its three lines sit at exactly the y of
the cells' three lines (well padding 4 + cell padding 12 = 16). Lines: "All time"; "6,778 plays";
"449h 56m · since Jun 17" (phone: "449h 56m"). Selected: `--raised-selected` and the ring.

**The song table (desktop).** Starts 24px below the strip. Its text edge is 16px in from the content
edge, the same x as the cells' text (well padding 4 + cell padding 12): one variable,
`--text-inset: 16px`. Its right text edge is 16px in from the content's right edge, the same x as All
time's text. Column header row: 32px, label style, Title case: "Song · Artist", "Album", "Length",
"Plays", "Played" ("Last played" for All time), "From"; the active sort column in `--ink` with a 12px
arrow; 1px `--line` under it; sticky at the top of the scrolling list on `--page`. Rows 56px: art 40px
(4px radius), 12px, title (body, `--ink`) over artist (meta); album, length, plays, played, from in meta,
numbers tabular and right-aligned as today; `--row-line` between rows; hover `--hover`, selected
`--selected`, both with 6px-rounded ends (today's cells). Column widths as today (Album 224, Length 64,
Plays 56, Played 96, From 120 at ≥1024px).

**The song list (phone).** One row per play: 64px, art 48px, title (16/21/400) over a line holding the
artist (meta) on the left and "From · 4:32 PM" (12/16 `--ink-2`) on the right. `--row-line` between rows.
The list is bounded (it fills to the search capsule and scrolls inside) with no outline and no radius,
and the bottom fade shows while more rows sit below.

**Search capsule.** Desktop: floating, centred, 20px above the bottom, 440px wide, 40px tall, full
radius, `--glass`, 1px `rgba(255,255,255,0.08)` border, the one shadow. Inside: a 16px magnifier in
`--ink-2`, the input (14px, placeholder "Search your songs"), then the Songs / Artists switch: a 32px
group of two full-radius segments, label 12/500, the active one `--raised-selected` with `--ink`, the
other `--ink-2`. Focus: the border goes to 16% white over `quick`. Phone: 48px tall, full width minus
32px, 12px above the bottom safe area; the phone search mode is today's (header and Home's title, chores
and notices fold away, the strip stays as the scope filter, the capsule docks to the top, the list
follows the keyboard), with "Cancel" as a text button at the capsule's right replacing the undo glyph.

**Search results.** The same table (desktop) or list (phone), the same columns, the same left edge, the
header row staying. A song result is one row with its total plays and "Last played" in relative time;
opening it inserts its plays as 40px sub-rows indented to the title's x (date and time, then the source
playlist, in meta). An artist result: the artist as the title, "12 songs · 87 plays" as the second line;
opening lists its songs as sub-rows. "Showing the first 400 of 1,203 matches." under the last row when
capped.

**Notices.** One line between the title row and the strip: a 6px `--warn` dot, 8px, the notice text in
meta `--ink`. Words in COMMON §5.

**Menus** (song menu, account menu, sort menu). `--overlay`, 8px radius, 1px `rgba(255,255,255,0.08)`,
the shadow, 4px padding, min width 200. Items 32px tall on desktop and 44px on the phone, body text,
6px radius, hover `--hover`. A separator is 1px `--line` with 4px around it. The song menu: "Add to
queue", "Save to Liked Songs", the playlists the song is in, "Listen on Spotify". The account menu: name
(14/500, not a button), separator, "Log out", "Disconnect…".

**Panels (Resume, Clean, Merge, Subtract).** Desktop: a popover under the chore that opened it, its left
edge on the chore's left edge (right edge on the chore's right edge when it would cross the content
edge), 8px below it, 360px wide, at most 480px tall. `--overlay`, 8px radius, the border, the shadow.
Inside: the action's name (15/600), 4px, its sentence (meta, kept words), 12px, the playlist list
(scrolling): rows 44px, cover 32px, name (body), "64 songs" (meta) at the right; at rest each row shows a
16px pick control, a 1.5px ring in `rgba(255,255,255,0.45)`; picked rows fill `--selected` and Merge
replaces the ring with the click-order number (20px circle, `--ink` fill, 12/600 digit in `--page`).
Footer: 12px padding, 1px `--line` top, "Cancel" (text button) and the confirm (primary: 32px, `--ink`
fill, `--page` label 13/500, 6px radius) at the right: "Resume", "Clean playlist", "Merge 3 playlists",
"See the difference". Phone: a bottom sheet with today's mechanics: `--overlay`, 12px top radius, a
36×4px handle, the same content, the confirm full width and 44px tall in a sticky footer, scrim
`rgba(0,0,0,0.5)`.

**Save queue.** Desktop: the same popover, 300px wide: "Save queue" (15/600), the sentence from COMMON
§5, "Cancel" and "Save queue". Phone: today's bubble at the chore (Rem's Aug 13 call: no sheet), with
the sentence (13/400, max 260px wide) above its button.

**Toasts.** Today's soft pill, at 8px radius: `--ink` fill, `--page` text 13/500, error fill `#f3c6c6`
with `#2a0d0d` text. Desktop: centred, 12px above the search capsule. Phone: centred at the top, 12px
below the safe area, above the header. Never over the capsule.

**Buttons elsewhere.** Primary: `--ink` fill, `--page` label, 6px radius, 36px tall on desktop and 44px
on the phone. Secondary: 1px `--line`, no fill, `--ink` label. Text buttons: `--ink-2`, hover `--ink`.

**Skeletons.** Static blocks of `rgba(255,255,255,0.05)` in the real layout's shapes and radii: Home has
the title bar (22px tall, 260px wide), five 32px chore blocks at the right, the well with six cells and
All time, the column header line and eight rows (a 40px art block and two text bars). The phone: title
bar, three chore blocks, two cells and a slice beside All time, six 64px rows. No shimmer.

## Pages

**Home.** Desktop, top to bottom: header (0–64); title row (96–128); notice line if any (144); strip
(152–252, or 24px lower with a notice); column header (276); rows from 308 to 16px above the capsule
(about nine rows on a 900px window, against today's first row at 413). Phone: header (0–56); greeting
(76); chores (114–158); strip (174–264); list from 280 to 12px above the capsule (about seven rows).
First visit (`state=new`): the strip shows Today and All time with zeros, and the list's place holds
the first-visit heading (15/600 `--ink`) and sentence (meta, max 520px wide) 24px below the column
header, left on the text inset; the playlists-loading line goes in the panels when they open.

**Playlists.** Content box 1024px (phone: 16px gutters). Top, 32px below the header: the stats line
(15px, numbers 500 `--ink`, words 400 `--ink-2`) left, and the sort control right ("Recent" with a
chevron, 13/500 `--ink-2`, then a direction arrow button), both 32px tall. 24px below: the grid, four
columns with 24px gaps on desktop, two with 16px on the phone. A tile: 8px padding (phone 6px), 8px
radius, no fill at rest and `--raised` on hover; the cover square at 4px radius with nothing around it;
12px; the name (14/500, one line); 2px; "64 songs" (meta). No cover: `--raised` square with today's
music-note glyph in `--ink-3`. Search: the capsule, placeholder "Search your playlists", hiding on scroll
down on the phone as today. Empty: "No playlists yet." in meta, 48px below the stats line; a new account
shows the loading line instead.

**A playlist.** 24px below the header: "Playlists" with a 16px left chevron, 14/500 `--ink-2`, hover
`--ink` (no pill). 24px below: the cover (160px, 4px radius) and, 24px to its right and bottom-aligned
with it, the name (object style), 6px, the meta line, 12px, "Listen on Spotify" (14/500 `--ink`,
underlined on hover). Phone: cover 120px above the name. 32px below: a 32px row with "1 duplicate"
(meta) left and "Custom" with a chevron right; then the song table with "#" (desktop only), "Title",
"Album", "Length"; the header sticky under the app header; rows 56px (phone 64px, art 48px); the
duplicate badge after the title: 11/500 `--ink-2` on `--raised`, 4px radius, 2px 6px padding. The page
scrolls normally.

**Now playing.** The chip (desktop) and the ring cover (phone) in the header, as above.

**Friends.** The title "Later stuff" at Home's title geometry (y = 96; phone 20px below the header).
Below it 32px, Rem's three rows as today's ruled list: 1px `--line` above each row, 20px vertical
padding, title 15/500, body 14/400 `--ink-2`, max 640px wide.

**Usage.** Fork `src/app/(app)/usage/usage-view.tsx`. The title "Usage" at the title geometry; the
intro in meta, max 640px. Section headings in sans, 15/600 `--ink`, sentence case (COMMON §5), each over
a 1px `--line`, with its right-side note in meta. Mono (`var(--font-geist-mono)`, 13px) stays only for machine
strings: read path names, source names, routes. Everything else as today.

**Sign-in and a friend's way in.** No app chrome. A 360px column centred on the page, its content
vertically centred. `connect`: the recliner panda (`/lazyboy-recliner.svg`, 176px wide); 24px; "Lazy Boy"
(title); 8px; the line (body, `--ink-2`, centred); 32px; the primary "Connect Spotify" (44px, full
width); 12px; the consent line (12/16 `--ink-2`, links `--ink` underlined, centred); 32px; "New here? Ask
for access" (14/500 `--ink-2` text link, centred). Messages (`not-registered`, `refused`) sit between the
line and the button as 14/400 `--ink` text, centred, no box, and the state's buttons follow COMMON §5:
the primary first, the secondary (44px, 1px `--line`) under it. `request` is the same column, left-
aligned: title, 8px, the sentence (14/400 `--ink-2`), 24px, the email label (13/500) 8px over its input
(44px, `--raised`, 1px `--line`, 6px radius, focus border `--ink-2`), 16px, the name field the same way,
24px, "Send request" (primary, full width), 16px, "Back" (text button). The email error is 13/400
`#f87171` under the email input, which gets a 1px `#f87171` border. `sent`, `signed-out`, `dead-grant`:
title, 8px, the sentence (body `--ink-2`, centred), 32px, the buttons, the consent line.

**Error.** Inside the app chrome, at the title geometry: "This page didn't load" (title), 8px, the
sentence (body `--ink-2`), 24px, "Try again" (primary), 24px, the reference (12/16 `--ink-3`).

**Loading pages.** The skeletons above, per page.

## Motion, exactly

- **A song lands in Today** (Today selected, list at the top). At t=0 the row is inserted at the top with
  height 0. Over `row` (240ms, `out`) its height opens to 56px (phone 64px) and its content goes from
  opacity 0 and 6px up to opacity 1 at rest; the rows below ride down with the opening, never jumping.
  At the same t=0 the chip's art and text cross-fade to the next song over 280ms (today's `np-swap`) and
  the Today cell's figure and time change in place with no animation. If the list is scrolled, the row is
  inserted with no animation and the scroll position grows by the row's height, so nothing visible moves.
  If another day or All time is selected, only the Today cell changes.
- **Switching days or All time.** Instant: the ring and fills change, the rows swap, the list returns to
  its top, in one frame. Nothing fades.
- **Search (desktop).** Focus brightens the capsule's border over `quick`. The first character swaps the
  rows for results in one frame (and the strip's selection moves to All time, COMMON §6.18); clearing
  swaps back in one frame. **Search (phone)** keeps today's tuned motion (the 320ms height glide and the
  row reveal).
- **Panels and the Save queue popover (desktop).** Scale 0.97 → 1 and opacity 0 → 1 over `base` with
  `transform-origin` at the chore's corner nearest the popover; close: opacity to 0 and scale 0.98 over
  120ms. **Sheets (phone):** up over `sheet`, the scrim fading in over 250ms; down over 230ms `exit`.
- **Menus.** Opacity 0 → 1 and a 4px slide from the trigger's side over 120ms; close 100ms opacity.
- **Hover** colours over `quick`. The phone header's scroll behaviour is today's.

## What porting it costs

About three lanes: the tokens and the header, chip and avatar (`den.css`, `chrome.tsx`); Home's title
row, chores, strip and table (`home-view.tsx`, `dock.tsx`, `day-cards.tsx`, `den-home.tsx`'s render
half, `home/loading.tsx`); the other pages, sign-in, error and the copy (`playlists-grid.tsx`,
`playlist-view.tsx`, `track-list.tsx`, the menus, `login/page.tsx`, `error.tsx`, `usage-view.tsx`, the
status strings across `actions.ts`, `client.ts`, `service.ts`). No data or behaviour changes except the
greeting's daily pick, the desktop search's All time selection, and the row arrival.
