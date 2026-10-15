# Direction "room": what's playing first, the record beside it, colour from the covers

Lane 2991, Oct 15, 2026. Read `../COMMON.md` first (in the repo: `docs/design/directions/COMMON.md`);
it holds Rem's rules, Spotify's rules, the words, the fixes, how this plugs into `/design`, and the
capture list. This file is the look and the layout. Folder: `src/app/design/directions/room/`. Branch:
`design/room`.

## The idea

Spotify and Apple Music, measured, carry all their colour in the content: the page around a playlist
takes the cover's colour, the chrome stays grey, there are almost no borders, and weight is binary
(regular rows under bold names). lazyboy already gets its colour from the covers; room makes that the
look. It also answers Rem's "most of the stuff is on the home page, maybe there are different ways to do
it" with a layout instead of a list of moves:

- **Desktop is two columns on every page.** Left, the page itself (on Home, the record). Right, a 320px
  rail that never changes place: the now-playing card on top, and under it the three tools that make a
  new playlist (Clean, Merge, Subtract). Opening a tool turns the rail into that tool's picker; nothing
  else on the page moves.
- **The now-playing card is the one vivid thing**: a large cover on a ground tinted from that cover
  (Spotify's guidelines name this treatment for playing views), the song, play/pause, the progress line,
  Save queue, Spotify's logo.
- **On the phone the same controls become a floating island at the bottom**: the playing cover, the
  search capsule, and a "+" for a new playlist, each opening a sheet. Rem's search capsule stays where his
  thumb has it.
- **When a song ends, its cover travels from the player into the record** and becomes the top row. The
  one motion that says where a row came from (the audit found today's arrival jumps the rows below).

**The greeting moves to the idle player.** When nothing is playing, the card (the sheet on the phone)
shows the recliner panda with one of Rem's lines under it at body size, chosen once per day, and a
"Resume a playlist" button. That is the moment a line about coming back fits, the lines stay as written,
and nothing competes with data there because there is none. While music plays, the card shows the song.

## Tokens

Set on `#den-root[data-direction="room"]`.

| token | value | job |
|---|---|---|
| `--page` | `#101012` | the page and header |
| `--raised` | `#18181b` | day cells, the search field, the idle card, tile hover, skeleton blocks |
| `--raised-2` | `#26262b` | hover on raised things, the active segment |
| `--overlay` | `#1c1c20` | menus, sheets |
| `--rule` | `rgba(255,255,255,0.08)` | the one line: under a list's column header |
| `--ink` | `#f2f2f4` | primary text; the selected day cell's fill; primary buttons' fill |
| `--ink-2` | `#a7a7ad` | secondary text |
| `--ink-3` | `#6f6f76` | placeholders, disabled, the reference line |
| `--on-ink` | `#101012` | text on `--ink` fills |
| `--hover` | `rgba(255,255,255,0.07)` | row hover |
| `--selected` | `rgba(255,255,255,0.14)` | selected row |
| `--np-bg` | computed, fallback `#191414` | the playing card's and a playlist header's ground |
| `--on-tint` | `#ffffff` / `rgba(255,255,255,0.72)` | text on a tinted ground, primary / secondary |
| `--playing` | `#1db954` | the ring around the island's playing cover; nothing else |
| `--glass` | `rgba(28,28,32,0.86)` + `backdrop-filter: blur(20px)` | the phone island's three controls only |

**The tint.** In the browser, draw the cover into a 16×16 canvas and average the opaque pixels (the
method `chrome.tsx` uses for the avatar ring). Mix it with black, `color-mix(in oklab, <average> 40%,
#000)`; if the result's relative luminance is above 0.08, mix further toward black until it is not, so
white text on it stays above 7:1. Cache the result per image URL in `sessionStorage` so a page seen
before paints with it at once. Until it is known, and whenever the canvas cannot be read, use `#191414`.
A playlist page's header uses the same average mixed at 35% into `--page`. A green cover gives a dark
green ground. Rem's July rules ban green-tinted cards as decoration; this ground is the cover's own
colour, which Spotify's guidelines recommend for playing views, but it is the closest room comes to that
rule, so the captures include the card under the fixture cover whose average is the most green
(`__design.play(i)` on that track; name it in `NOTES.md`) for Rem to judge.

Type, in px (size / line height / weight); phone after the slash where it differs. Two weights, 400 and
700, as Spotify's rows and headings use them.

| style | spec | used for |
|---|---|---|
| heading | 24/30/700 · phone 20/26/700 | page titles |
| object | 32/38/700 · phone 24/30/700 | a playlist's name |
| np-title | 20/26/700 | the song on the card and in the phone sheet |
| np-artist | 15/20/400, `--on-tint` secondary | its artist |
| section | 16/22/700 | the rail's "New playlist" heading, Usage's section headings |
| row-title | 16/22/400 | a song in a row |
| row-meta | 14/20/400, `--ink-2` · phone 13/18 | artist, album, times, counts |
| label | 14/20/400, `--ink-2` | column headers, Title case |
| cell-label | 14/20/700 · phone 13/18/700 | "Today", "Oct 13", "All time" |
| figure | 22/28/700 tabular · phone 20/24/700 | a cell's play count |
| nav | 15/20/400 `--ink-2`, active 700 `--ink` | header tabs |
| button | 14/20/700 · phone 15/20/700 | button labels |
| small | 12/16/400 | progress times, the reference |

Spacing steps 4, 8, 12, 16, 24, 32, 48. Radii: 4 (art, the duplicate badge), 8 (cells, fields, buttons,
cards, tiles, menus, the island's square control), 16 (sheet top corners), full (avatar, the island's
capsule and "+" circle, the card's play button). One shadow, for menus and the island:
`0 8px 24px rgba(0,0,0,0.5)`. No borders anywhere except `--rule` under column headers, focus rings, and
secondary buttons on a tinted ground.

Buttons: **primary** `--ink` fill, `--on-ink` label, 40px (phone 48px), 8px radius; **secondary**
`--raised-2` fill, `--ink` label; **on tint** 1px `rgba(255,255,255,0.32)`, no fill, `--on-tint` label,
hover `rgba(255,255,255,0.08)`; **ghost** text only, `--ink-2`, hover `--ink`.

Motion: `quick` 100ms (hover, press, focus); `enter` 250ms `cubic-bezier(0,0,0.2,1)`; `exit` 200ms
`cubic-bezier(0.4,0,1,1)`; `flight` 420ms `cubic-bezier(0.3,0,0,1)`; `tint` 400ms `ease`; `sheet`
300ms `cubic-bezier(0.32,0.72,0,1)` in, 220ms `exit` out. Reduced motion: no flight, no slides; opacity
fades of 100ms or less.

## The frame

**Desktop.** The window is the frame at every width ≥1024px: a 64px header, then the two columns, each
scrolling inside itself; the page body never scrolls. Content box 1280px centred with 32px padding
(1216px inside; at 1440px it runs x 112–1328). Left column 864px, 32px gap, rail 320px. Both columns
start at y 80 and end 24px above the window's bottom.

**Header.** 64px, `--page`, opaque, no line (the columns clip beneath it). Left: the panda (32px, today's
motion), 24px, the tabs (nav style, 20px apart). Right: the avatar (32px, no ring growth or glow) and its
menu. Phone: 56px, 16px padding, panda 28px, tabs 16px apart, and at the right the Spotify icon (21px),
12px, the avatar (28px). It slides away on scroll down and back on scroll up on pages that scroll.

**The rail (desktop).** Top to bottom:

1. *The now-playing card*, 320px wide and 505px tall in every state, 8px radius, 16px padding, ground
   `--np-bg`. Spotify's full logo (70px, linking to the track) at the top left; 12px; the cover, 288px
   square, 4px radius; 16px; the title (np-title, `--on-tint`, one line, a link to the track on Spotify,
   underlined on hover, `title` attribute); 2px; the artist (np-artist); 12px; the progress line (4px,
   2px radius, `rgba(255,255,255,0.24)` track, white fill, information only); 6px; the elapsed time and
   the length (small, `--on-tint` secondary) at its two ends; 12px; a row with play/pause (a 40px white
   circle holding an 18px black glyph) on the left and "Save queue" (on tint, 32px) on the right.
   Paused: the glyph shows play and the line stops; the ground stays. Idle (nothing playing): ground
   `--raised`; the logo; 24px; the recliner panda (`/lazyboy-recliner.svg`, 200px wide, centred); 16px;
   the day's greeting line (15/20/400 `--ink`, centred, at most two lines); 4px; "Nothing playing on
   Spotify." (13/18/400 `--ink-2`, centred); then, pinned to the card's bottom padding, "Resume a
   playlist" (secondary, full width).
2. 24px, then *New playlist*: the heading (section), 8px, three rows, each 56px, 8px 12px padding, 8px
   radius, hover `--hover`: the tool's name (15/20/700 `--ink`) over one line (13/18/400 `--ink-2`):
   "Clean", "A copy without the songs already in your library."; "Merge", "One playlist from several,
   in the order you pick."; "Subtract", "What one playlist has that the others don't." While the library
   is still empty (a first visit), the three rows are replaced by the loading line from COMMON §5.

**The rail as a picker.** Choosing a tool, "Resume a playlist" or "Save queue" replaces the rail's
content with that tool, full rail height: a header row (a 32px back button holding a chevron, 8px radius,
hover `--hover`; then the tool's name in section style), 12px, the tool's sentence (13/18/400 `--ink-2`;
COMMON §5's kept words), 16px, then the list: rows 52px, cover 40px, the name (15/20/400), "64 songs"
(13/18 `--ink-2`), and at the right an 18px pick ring (1.5px `rgba(255,255,255,0.45)`); picked rows fill
`--selected`, and Merge shows the click order as a 20px `--ink` circle with a 12/700 `--on-ink` digit.
Subtract adds today's Base / Subtract switch above the list (a 32px segmented control, active
`--raised-2`). A footer sticks to the rail's bottom with the primary at full width: "Clean playlist",
"Merge 3 playlists", "See the difference", "Resume". Save queue's picker is a confirm: the sentence from
COMMON §5 and the primary "Save queue". The back button or Esc returns to the card.

**The island (phone).** Floating 12px above the bottom safe area, 16px from both edges, 48px tall, three
controls 8px apart, each `--glass` with a 1px `rgba(255,255,255,0.08)` border and the shadow:

- *Now playing*, a 48px square with 8px radius holding the cover at 36px (4px radius); while playing,
  today's green ring breathes 2.5px off the cover (audit C4 is Rem's call); idle, the panda mark (28px)
  in place of the cover. It opens the now-playing sheet.
- *Search*, a capsule filling the middle: a 16px magnifier and the input (16px, placeholder "Search").
- *New playlist*, a 48px circle with a 20px "+" in `--ink`, `aria-label="New playlist"`. It opens the
  New playlist sheet.

On pages that scroll, the island slides away on scroll down and returns on scroll up, like today's
capsule. In search mode (focusing the capsule) the two side controls fade out and the capsule widens to
the full width and docks to the top, as today's does, with the Songs / Artists switch inside it (32px
group, full-radius segments, active `--raised-2`) and "Cancel" (text) at its right; today's phone search
behaviour otherwise holds.

**Sheets (phone).** `--overlay` unless tinted, 16px top radius, a 36×4px handle, 16px padding, scrim
`rgba(0,0,0,0.5)`. The *now-playing sheet* is the desktop card at phone size: ground `--np-bg`; the logo
top left; 16px; the cover 260px, centred; 20px; title and artist; 16px; the progress line and times;
20px; play/pause as a 56px white circle, centred; 16px; "Save queue" (on tint, full width, 44px); 12px;
"Listen on Spotify" (14/700 `--on-tint`, centred). Idle, it shows the recliner, the greeting line (16px),
"Nothing playing on Spotify." and "Resume a playlist" (secondary, full width), which swaps the sheet's
content to the Resume picker. The *New playlist sheet*: "New playlist" (20/26/700), then the three rows of
the rail at 64px each; choosing one swaps the sheet's content to that picker, with the back chevron at
its top left and the primary in a sticky footer.

## Components on the left

**Search field (desktop).** At the top of Home's column (y 80–124): 44px, `--raised`, 8px radius, no
border; a 18px magnifier (`--ink-2`) 14px from the left; the input (15/20/400, placeholder "Search your
songs", "Search artists" in Artists mode); at its right, inside, the Songs / Artists switch (32px group,
6px-radius segments, active `--raised-2` with 14/700 `--ink`, the other 14/400 `--ink-2`). Focus: fill
`--raised-2` and a 1px inset `rgba(255,255,255,0.18)` ring, over `quick`. Esc clears it.

**The strip.** 16px below the search field (y 140–232; phone y 68–150), no tray. Day cells: 148px wide
(phone 100px), 92px tall (phone 82px), 12px 14px padding (phone 10px 12px), 8px radius, `--raised`, 8px
apart, scrolling sideways with a 32px fade at the right and today's "more days" chevron after the last
cell ("See all" at the last rung). Cell: cell-label; 6px; the figure with " plays" (13/18/400
`--ink-2`) on its baseline; 2px; the listened time (13/18/400 `--ink-2`). All time is a cell pinned
outside the scroller, 16px to its right, 184px wide (phone 112px): "All time"; "6,778 plays";
"449h 56m · since Jun 17" (phone: "449h 56m"). Hover: `--raised-2`. Selected: inverted, `--ink` fill
with every line in `--on-ink` (secondary lines at 70%). Hover never looks like it.

**The list (desktop).** 16px below the strip, to the column's bottom. A 36px column header (label style:
"Title", "Album", "Length", "Plays", "Played" or "Last played", "From"; the sort arrow on the active one)
with `--rule` under it; then rows of 56px: the cover 40px (4px radius), 16px, the title (row-title,
`--ink`) over the artist (row-meta); album, length, plays, played, from in row-meta, numbers tabular and
right-aligned (Album 200, Length 64, Plays 56, Played 88, From 120). No lines between rows. Hover
`--hover`, selected `--selected`, both with 6px radius.

**The list (phone).** 12px below the strip, down to 12px above the island: one row per play, 64px, cover
48px, the title (16/21/400) over the artist (13/18 `--ink-2`) on the left and "From · 4:32 PM" (12/16
`--ink-2`) on the right; no lines; bounded, the bottom fade while more sits below.

**Menus.** `--overlay`, 8px radius, no border, the shadow, 4px padding, at least 200px wide; items 36px
(phone 44px), 15/20/400, 6px radius, hover `--hover`. Song menu: "Add to queue", "Save to Liked Songs",
the playlists it's in, "Listen on Spotify". Account menu: the name (15/700, not a button), then "Log
out" and "Disconnect…" (with COMMON §5's confirm as a centred dialog: `--overlay`, 8px radius, 400px).

**Notices.** A line between the search field and the strip: 14/20/400 `--ink`, no glyph, no box, the
words from COMMON §5, the strip moving 28px down.

**Toasts.** `--ink` pill with 8px radius, 14/20/400 `--on-ink`, 12px 16px padding; an error adds an 8px
`#e5534b` dot before the text. Desktop: centred on the left column, 24px above the window's bottom.
Phone: centred, 12px above the island.

**Skeletons.** Static `--raised` blocks in the real shapes: the search field, the cells, the column
header line, rows (a 40px block and two bars); the rail's card as a 288px square and three bars, the
tools as three 56px blocks. Phone: the cells, seven rows, and the island drawn as it is.

## Pages

**Home.** Desktop: header 0–64; left column: search field 80–124, notice if any, strip 140–232, list
from 248 (first row at y 284, 32% of the window; about ten rows); the rail at the right. Phone: header,
strip, list, island. First visit (`state=new`): the Today and All time cells read "0 plays" and "0m";
the list's place holds the first-visit heading (16/22/700) and sentence (14/20/400 `--ink-2`, max 520px)
24px below the column header; the rail's tools show the loading line.

**Playlists.** Desktop, in the left column: a 44px row with the stats line (15px; numbers 700 `--ink`,
words 400 `--ink-2`) on the left and, on the right, a search field (280px, as Home's but "Search
playlists") and the sort (ghost: "Recent" and a chevron; its menu lists Recent, Name, Songs and the
direction). 24px below, four columns with 24px gaps. A tile: 8px padding and radius, no fill at rest,
`--raised` on hover; the cover (4px radius, nothing around it); 12px; the name (15/20/700, one line);
2px; "64 songs" (13/18 `--ink-2`). A tile is only a link to its playlist: the tools live in the rail.
No cover: a `--raised-2` square with today's music-note glyph in `--ink-3`. Phone: the stats line, the
grid in two columns with 16px gaps, the island's capsule searching playlists. Empty: "No playlists yet."
or the loading line.

**A playlist.** Desktop, in the left column: at y 80 "Playlists" with a 16px left chevron (ghost); at y
112 the header block, full column width, 8px radius, ground = the cover's tint at 35% over `--page`, 24px
padding: the cover (200px, 4px radius) and, 24px to its right and bottom-aligned, the name (object,
`--on-tint`), 8px, the meta line (14/20 `--on-tint` secondary), 16px, "Resume" (primary) and "Listen on
Spotify" (on tint). 24px below: the column header ("#", "Title", "Album", "Length") and 56px rows with the
index (14px `--ink-2`, tabular, 32px column); the duplicate badge (12/16/700 `--ink-2` on `--raised`, 4px
radius, 2px 6px padding) after the title; "1 duplicate" and the sort ("Custom") on a 36px row above the
column header. The column scrolls; the header block scrolls away with it. Phone: the block full width
minus 32px with the cover (160px) centred above the name, then the buttons at 48px, then 64px rows.

**Now playing.** The rail's card (desktop) and the island with its sheet (phone).

**Friends.** In the left column: "Later stuff" (heading) at y 80 (phone: 20px under the header); 24px;
Rem's three items 24px apart with no rules: title 16/22/700, body 14/20/400 `--ink-2`, max 600px.

**Usage.** Fork `usage-view.tsx` into the left column: "Usage" (heading), the intro (14/20 `--ink-2`, max
640px), section headings in section style and sentence case with their notes (14px `--ink-2`) at the
right, tables in 14px with label-style headers over `--rule`, rows without lines. Mono only for machine
strings. The rail stays.

**Sign-in and a friend's way in.** No app chrome, no rail. A 360px column centred on `--page`.
`connect`: the recliner panda (200px); 24px; "Lazy Boy" (heading, centred); 8px; the line (15/20/400
`--ink-2`, centred); 32px; "Connect Spotify" (primary, 48px, full width); 12px; the consent line (12/16
`--ink-2`, links `--ink` underlined, centred); 24px; "New here? Ask for access" (secondary, 48px, full
width). Messages (`not-registered`, `refused`) are 15/20/400 `--ink` text, centred, no box, between the
line and the buttons. `request`, left-aligned: "Ask for access" (heading), 8px, the sentence (15/20
`--ink-2`), 24px, "Email" (13/18/700) 8px over its input (48px, `--raised`, 8px radius, no border, focus
ring 1px inset `rgba(255,255,255,0.3)`), 16px, "Name (optional)" the same, 24px, "Send request"
(primary, full width), 12px, "Back" (ghost). The email error: a 1px inset `#e5534b` ring on the input and
13px `#e5534b` text under it. `sent`, `signed-out`, `dead-grant`: heading, 8px, the sentence, 32px, the
buttons, the consent line.

**Error.** In the left column at y 80: "This page didn't load" (heading), 8px, the sentence (15/20
`--ink-2`), 24px, "Try again" (primary), 24px, the reference (small `--ink-3`). The rail stays.

**Loading pages.** The skeletons above, per page; the rail draws its skeleton too.

## Motion, exactly

- **A song lands in Today** (T01; Today selected, the list at its top, the card showing). At t=0: the
  finished song's row is inserted at the top of the list at height 0, its cover hidden and its text at
  opacity 0, and opens to 56px (phone 64px) over `flight`, the rows below riding down with it. A clone of
  the card's cover (a fixed-position `<img>` at the cover's exact rect) is laid over it; under the clone
  the card's cover switches to the next song, the card's title and artist cross-fade to it (out 150ms,
  in 250ms) and the ground moves to the new tint over `tint`. Over `flight` the clone travels and scales
  from the card's 288px cover to the new row's 40px cover rect (its final rect: the list's first row
  position at full height). At t=420ms the clone is removed and the row's own cover shows in the same
  place, its text fades in over 160ms, and the Today cell's figure and time change, unanimated. Phone:
  the clone starts from the island's 36px cover and rises into the row's 48px cover. Skip the flight
  (the row opens over 240ms with a plain fade) when the list is scrolled (then insert with no animation
  and grow the scroll position by the row's height), when the rail is showing a picker, or when a sheet
  is open; when another day is selected, only the Today cell changes, at t=0.
- **Switching days or All time.** Instant: the inverted cell moves, the rows swap and return to the top,
  in one frame.
- **Search (desktop).** Focus over `quick`; rows swap to results per keystroke in one frame, the strip's
  selection moving to All time (COMMON §6.18); Esc restores. **Phone:** the side controls fade out over
  150ms while the capsule widens over `enter`, then docks to the top as today's does; leaving reverses
  (the capsule narrows over `exit`, the side controls fade back in over 150ms).
- **The rail's picker** (T05, T10). The card and tools fade out over 150ms; from 100ms the picker slides
  in 16px from the right with opacity 0 → 1 over `enter`. Back: the picker fades out over 150ms, the card
  and tools fade in over `enter`. The rail's width never changes. On the phone, a sheet's content swaps
  the same way inside the sheet.
- **Playback starting** (T08). The idle card's content cross-fades to the playing layout over `enter`
  while the ground moves from `--raised` to the tint over `tint`; the card keeps its height, so nothing
  below moves.
- **Menus.** Opacity 0 → 1 and scale 0.96 → 1 from the trigger's edge over `enter`; close by opacity
  over 120ms.
- **Sheets (phone):** up over `sheet`, the scrim in over 250ms; down over 220ms.
- **Phone header and island:** hide on scroll down and return on scroll up, today's logic.

## What porting it costs

About six lanes. (1) The two-column frame on every `(app)` page (`layout.tsx`, `chrome.tsx`, each page's
`<main>`), the left column as the scroll container, and the phone island replacing the capsule.
(2) The now-playing card, the phone sheet and the tint. In production the cover colour should be computed
once on the server and stored with the track or playlist; reading `i.scdn.co` images into a canvas in the
browser depends on Spotify's CDN sending CORS headers, which nobody has checked. (3) Home's record
(search field, inverted cells, 56px rows; `den-home.tsx`'s render half). (4) The rail's pickers (moving
the panels out of `dock.tsx`) and the phone's two sheets. (5) The flight, built on the Web Animations
API with the fallbacks above; the most fragile piece. (6) Playlists, a playlist's tinted header, sign-in,
Usage, copy. Risks: the largest change to where Rem's tools are (Resume and Save queue sit in the player,
Clean, Merge and Subtract in the rail); the rail takes 352px of every desktop page; a persistent
now-playing panel on the right resembles Spotify's own, and Spotify's policy asks partners not to
replicate its core experience, so the card stays lazyboy's (no queue, lyrics or credits; Save queue and
the greeting are its own); the flight must be judged in motion, not in a still.
