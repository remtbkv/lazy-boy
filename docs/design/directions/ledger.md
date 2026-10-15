# Direction "ledger": Home is the record, and every action sits on what it acts on

Lane 2991, Oct 15, 2026. Read `../COMMON.md` first (in the repo: `docs/design/directions/COMMON.md`);
it holds Rem's rules, Spotify's rules, the words, the fixes, how this plugs into `/design`, and the
capture list. This file is the look and the layout. Folder: `src/app/design/directions/ledger/`. Branch:
`design/ledger`.

## The idea

Rem's Vercel screenshots are all boxes and tables and still read as made by people, and the audit names
how: each box is an object, split inside by dividers and fills rather than more boxes; the largest words
name what sits under them; each area has one white primary and quieter secondaries; actions live on the
object they act on ("Instant Rollback" on the deployment, "Add New" on the project list). Ledger applies
that to lazyboy.

- **Home is the record and nothing else.** The day strip, then one card holding the selected day's songs
  under a band that names the day ("Thursday, October 15"). No greeting, no chores. The first song row
  starts at 35% of a 900px window instead of 46%.
- **The chores move to their objects.** Merge and Subtract make new playlists, so they live behind
  "New playlist" on the Playlists page (the way Spotify's Create sheet holds Blend). Resume and Clean act
  on one playlist: buttons on its page and items in each tile's menu. Save queue acts on what's playing:
  it sits in the now-playing bar. Resume also sits in the bar when nothing plays, because starting a
  playlist again is what you do then.
- **Now playing becomes a bar** along the bottom of the desktop window, with the song, play/pause, the
  progress line, Save queue and Spotify's logo. On the phone it stays the cover in the header, which
  opens a sheet.
- **Desktop search moves to a toolbar at the top of the page**, where every desktop reference puts it
  (the critique's third miss). The phone keeps Rem's capsule at the bottom.

**The greeting leaves Home.** The largest words on Home name the day. Rem's lines are kept for the one
moment they fit, someone coming back: on the sign-in page, a returning visitor (anyone who has signed in
on this browser before) sees one line in place of the description, chosen once per day. A first-time
visitor sees the description, so a friend is never met with "Back for more?".

## Tokens

Neutral black, Vercel's register. Set them on `#den-root[data-direction="ledger"]`.

| token | value | job |
|---|---|---|
| `--page` | `#000000` | the page, the header, inputs' fill |
| `--surface` | `#0a0a0a` | every card and box: the strip, the record, the bottom bar, Usage's sections |
| `--band` | `#111111` | a card's header band, the selected strip cell, the active segment |
| `--overlay` | `#141414` | menus, popovers, sheets, toasts |
| `--line` | `rgba(255,255,255,0.13)` | every border and divider, one colour |
| `--zebra` | `rgba(255,255,255,0.025)` | alternate rows |
| `--ink` | `#ededed` | primary text, primary button fill |
| `--ink-2` | `#a1a1a1` | secondary text |
| `--ink-3` | `#6e6e6e` | placeholders, disabled, the reference line |
| `--hover` | `rgba(255,255,255,0.06)` | hover on rows, cells, tiles, secondary buttons |
| `--selected` | `rgba(255,255,255,0.12)` | the selected row (stays lit under its menu) |
| `--playing` | `#1db954` | the 6px dot before the playing title; the phone's ring around the playing cover |
| `--warn` | `#f5a524` | a notice's glyph |
| `--danger` | `#ff6166` | error text, error glyphs, the Disconnect button |
| `--glass` | `rgba(20,20,20,0.9)` + `backdrop-filter: blur(16px)` | the phone's floating search capsule only |

Type, in px (size / line height / weight); phone after the slash where it differs.

| style | spec | used for |
|---|---|---|
| heading | 20/28/600 · phone 18/24/600 | page titles (Friends, Usage, sign-in), the error card's band |
| object | 24/32/600 · phone 20/28/600 | a playlist's name |
| card-title | 16/24/500 · phone 15/20/500 | a card band's title |
| body | 14/20/400 · phone 15/20/400 | text, menu items, inputs (16 on the phone) |
| row-title | 14/20/500 · phone 15/20/500 | a song or playlist name in a row or tile |
| meta | 13/18/400, `--ink-2` | artists, albums, times, counts |
| label | 12/16/500, `--ink-2` | column headers, Title case |
| cell-label | 13/18/400, `--ink-2` (selected: `--ink`) | strip cell names |
| figure | 20/24/600 tabular · phone 18/22/600 | a cell's play count |
| nav | 14/20/500 · phone 15/20/500 | header tabs |
| small | 12/16/400, `--ink-2` | progress times, key hints, the reference |

Weights 400, 500, 600. Spacing steps 4, 8, 12, 16, 24, 32, 48. Radii: 4 (art, key hints), 6 (every
card, box, button, input, menu, popover, toast, tile hover, phone zebra band), 12 (sheet top corners),
full (avatar, the phone capsule). One shadow, for menus, popovers and the phone capsule only:
`0 8px 30px rgba(0,0,0,0.6)`.

Buttons, 36px tall on desktop and 44px on the phone, 6px radius, label 14/500, 12px side padding:
**primary** `--ink` fill, `--page` label, one per area at most; **secondary** 1px `--line`, no fill,
`--ink` label, hover `--hover`; **tertiary** text or glyph only, `--ink-2`, hover `--ink`; **danger**
`--danger` fill, white label (Disconnect only).

Motion: `quick` 100ms (hover, press, focus ring); `base` 150ms `cubic-bezier(0.16,1,0.3,1)` (menus,
popovers, cross-fades); `row` 200ms `cubic-bezier(0.2,0.8,0.2,1)` (a row arriving); `sheet` 300ms
`cubic-bezier(0.32,0.72,0,1)` in, 200ms `cubic-bezier(0.4,0,1,1)` out. Reduced motion: instant, apart
from opacity fades of 100ms or less.

## Components

**Header (desktop).** 56px, `--page`, opaque, 1px `--line` bottom. Content box 1200px centred with 24px
padding (1152px inside; at 1440px wide it runs x 144–1296). Left: the panda (28px, today's motion), 20px,
the tabs (Home, Playlists, Friends; nav style, 12px side padding, inactive `--ink-2`, hover and active
`--ink`); the active tab has a 2px `--ink` bar under its label sitting on the header's bottom line. Right:
the avatar (28px, 1px `--line` ring, no hover growth or glow) opening the account menu.

**Header (phone).** 56px, the same rules, 16px padding: panda 28px; tabs at 8px side padding with the
same underline; right: the Spotify icon (21px), 8px, the playing cover (32px, 4px radius, the green ring
2.5px off it while playing) which opens the now-playing sheet, 12px, the avatar (28px). Nothing playing:
the icon stays and the cover is absent. The bar slides away on scroll down and returns on scroll up, as
today.

**Toolbar (desktop Home).** 24px under the header (y 80–116). A search field, 360px by 36px: `--page`
fill, 1px `--line`, 6px radius, a 16px magnifier in `--ink-2` at 12px, the input (body, placeholder
"Search your songs"), and at the right inside it a "/" key hint (20×20px, 1px `--line`, 4px radius, small
text). "/" anywhere on Home focuses it; Esc clears and blurs it. Focus: a 2px
`rgba(255,255,255,0.24)` ring over `quick`. 8px to its right, the Songs / Artists switch: a 36px group
with a 1px `--line` border and 6px radius, two segments with 12px padding, label 14/500, the active one
`--band` with `--ink`, the other `--ink-2`.

**Notices.** Between the toolbar and the strip, 12px below the toolbar: a box (1px `--line`, 6px radius,
`--surface`), 12px 16px padding, a 16px warning glyph in `--warn`, 8px, the text (body, `--ink`). Words
in COMMON §5.

**The strip.** 16px below the toolbar (or the notice): two boxes side by side, 12px apart, both 84px
tall (phone 76px), 1px `--line`, 6px radius, `--surface`. The days box fills the width left of All time
and scrolls sideways inside itself, cut by a 32px fade at its right edge. Its cells are 144px wide
(phone 100px) with 12px 16px padding (phone 10px 12px) and 1px `--line` dividers between them, no boxes
inside the box. A cell: cell-label; 4px; the figure and " plays" (meta) on one baseline; 2px; the
listened time (meta). After the last day, a "More days" cell, 96px wide: a 16px chevron and "More days"
(13/500 `--ink-2`), "All days" at the last rung. The All time box holds one cell, 196px wide (phone
104px): "All time"; "6,778 plays"; "449h 56m · since Jun 17" (phone: "449h 56m"). Hover: `--hover` fill.
Selected: `--band` fill, the label in `--ink`, and a 2px `--ink` bar along the cell's bottom edge inside
the box. Both boxes use the same padding, so all text lines share their y.

**The record card (desktop).** 16px below the strip, down to 16px above the bottom bar. 1px `--line`,
6px radius, `--surface`, clipped. A 48px band: `--band`, 1px `--line` bottom, 16px side padding, the
card-title: the selected day written out ("Thursday, October 15"), "All time" for All time, and while
searching 'Songs matching “the”' or 'Artists matching “fr”' followed 12px later by the count in meta
("12 songs"). Under the band, the column header: 32px, label style, 16px side padding, 1px `--line`
bottom: "Song · Artist" (two sort buttons), "Album", "Length", "Plays", "Played" ("Last played" for All
time and results), "From"; the active sort in `--ink` with a 12px arrow. Then the rows, which scroll
inside the card while the band and the header stay. A row: 48px, 16px side padding, art 32px (4px
radius), 12px, row-title over the artist (meta); then album, length, plays, played, from in meta,
numbers tabular and right-aligned; widths Album 220, Length 64, Plays 56, Played 88, From 120 at
≥1024px. No lines between rows: alternate rows take `--zebra`, and the stripe is fixed per play (count
rows from the bottom of the list, so a row arriving at the top changes no other row's stripe). Hover
`--hover`, selected `--selected`, full width, square. When capped, "Showing the first 400 of 1,203
matches." (meta, centred) under the last row.

**The record (phone).** 12px below the strip, down to 12px above the capsule, no outer border: a 40px
band (`--band`, 6px radius, 12px padding) with the card-title ("Thursday, Oct 15"), then one row per
play: 64px, art 48px, row-title over a line with the artist (meta) left and "From · 4:32 PM" (12/16
`--ink-2`) right; zebra bands with 6px radius instead of lines. Bounded, scrolling inside, the bottom
fade while more sits below.

**The bottom bar (desktop).** On every app page, fixed to the window's bottom, full width, 64px,
`--surface`, 1px `--line` top, opaque, its content on the 1152px box; pages that scroll keep 88px of
padding at their foot so their last row clears it. Playing: left, art 40px (4px radius), 12px, a 6px
`--playing` dot, 8px, the title (row-title, one line, `title` attribute) over the artist (meta); the
block is 360px wide at most. Centred in the bar: play/pause (a 32px secondary square holding a 16px
glyph), 12px, the elapsed time (small, tabular, right-aligned in 40px), 8px, the progress line (260px
by 4px, 2px radius, `rgba(255,255,255,0.12)` track, `--ink` fill, information only), 8px, the length
(small, 40px). Right: "Save queue" (secondary), 16px, Spotify's full logo (70px, linking to the track,
12px clear space). Paused: the dot turns `--ink-3`, the glyph shows play, the line stops. Nothing
playing: left, "Nothing playing" in row-title `--ink-2`; centre empty; right, "Resume a playlist"
(secondary), 16px, the logo. The bar never changes height.

**Now-playing sheet (phone).** From the header cover. `--overlay`, 12px top radius, a 36×4px handle,
16px padding: the art (120px) with the title (16/22/600) and artist (meta) stacked to its right; 16px;
the progress line full width with the two times under it; 16px; a row with play/pause (44px secondary
square) and "Save queue" (secondary, filling the rest); 16px; "Listen on Spotify" (14/500 `--ink` link)
on the left and Spotify's full logo (70px) on the right.

**Search capsule (phone).** Today's capsule and phone search mode, drawn in ledger's tokens: 48px, full
width minus 32px, 12px above the safe area, full radius, `--glass`, 1px `--line`, the shadow, the
magnifier, the input (16px, "Search your songs"), the Songs / Artists switch (32px group, full-radius
segments, active `--band`). In search mode the header and notices fold, the strip stays as the scope
filter, the capsule docks to the top, and "Cancel" (text) sits at its right.

**Menus.** `--overlay`, 6px radius, 1px `--line`, the shadow, 4px padding, at least 200px wide. Items
32px (phone 44px), body text, 4px radius, hover `--hover`; a separator is 1px `--line` with 4px margins.
Song menu: "Add to queue", "Save to Liked Songs", the playlists it's in, "Listen on Spotify". Account
menu: the name (body 500, not a button), separator, "Log out", "Disconnect…". Tile menu: "Resume",
"Clean…", separator, "Listen on Spotify".

**Popovers and pickers (desktop).** Anchored to the button that opened them, 8px below it, aligned to
its nearer edge. `--overlay`, 6px radius, 1px `--line`, the shadow. "New playlist" opens a 320px popover
with two rows (56px, 12px padding, 6px radius, hover `--hover`): "Merge playlists" (row-title) over its
sentence (meta), and "Subtract playlists" over its sentence. Choosing one turns the same popover into
the picker, 400px wide and up to 520px tall: a header row (a 28px back chevron, the name in card-title),
the sentence (meta), the playlist list (rows 44px: cover 32px, name in body, "64 songs" in meta at the
right, a 16px pick ring at rest in `rgba(255,255,255,0.45)`; picked rows fill `--selected`; Merge shows
the click order as a 20px `--ink` circle with a 12/600 `--page` digit), and a footer (1px `--line` top,
12px padding) with "Cancel" (tertiary) and the primary ("Merge 3 playlists", "See the difference").
"Resume a playlist" in the bar opens the Resume picker the same way, rising from the bar (anchored above
the button). "Clean…" on a playlist page opens a 320px confirm: 'Clean “late night drive”' (card-title),
the Clean sentence, "Cancel" and "Clean playlist". Save queue opens a 320px confirm above its button:
"Save queue", the sentence from COMMON §5, "Cancel" and "Save queue".

**Sheets (phone).** Every popover above becomes a bottom sheet: `--overlay`, 12px top radius, the
handle, the same content, the primary full width at 44px in a sticky footer, scrim
`rgba(0,0,0,0.5)`. The phone has no bottom bar, so it has no Resume picker: Resume is on each playlist
(its page and its tile menu), and the phone's H18 capture is the tile menu.

**Toasts.** `--overlay`, 1px `--line`, 6px radius, the shadow, body text in `--ink`, 12px 16px padding;
an error adds an 8px `--danger` dot before the text. Desktop: bottom right, their right edge on the
content box's, 16px above the bottom bar. Phone: top, full width minus 32px, 12px below the safe area.

**Skeletons.** Static `rgba(255,255,255,0.06)` blocks in the real shapes: the toolbar's two controls,
both strip boxes with their dividers drawn and blocks in each cell, the record card with its band and
ten zebra rows (a 32px art block, two text bars), the bottom bar's left block and centre line. Phone:
the strip, the band and seven 64px rows.

## Pages

**Home.** Desktop: header (0–56), toolbar (80–116), notice if any, strip (132–216), record card (232 to
820), bottom bar (836–900). The first song row starts at y 312. Phone: header (0–56), strip (68–144),
the record from 156 to 12px above the capsule. First visit (`state=new`): Today and All time cells read
"0 plays" and "0m"; the card's band says "Thursday, October 15"; in place of rows, 24px down and 16px in,
the first-visit heading (card-title) and its sentence (meta, max 520px).

**Playlists.** Desktop: the toolbar row at y 80: the stats line on the left (body; numbers 500 `--ink`,
words `--ink-2`), and on the right a 240px search field ("Search playlists", "/" hint), 8px, the sort
(secondary: "Recent" and a chevron; its menu lists Recent, Name, Songs and a direction toggle), 8px,
"New playlist" (primary). 24px below, the grid: five columns with 24px gaps. A tile: 8px padding, 6px
radius, no fill at rest, `--hover` on hover; the cover (4px radius, nothing around it); 12px; a row with
the name (row-title, one line) and, on hover, a 24px "…" tertiary button at its right end opening the
tile menu; 2px; "64 songs" (meta). No cover: a `--band` square with today's music-note glyph in
`--ink-3`. Phone: the stats line on its own line (13px, may wrap); under it the sort (secondary) and
"New playlist" (primary), 44px, right-aligned; two columns with 16px gaps; the "…" always shown with a
44px tap target; search in the bottom capsule ("Search playlists"), hiding on scroll down as today.
Empty library: "No playlists yet." (meta) 48px below the toolbar, or the loading line for a new account.

**A playlist.** Desktop: at y 80, "Playlists" with a 16px left chevron (tertiary). At y 112: the cover
(160px, 4px radius); 24px to its right, bottom-aligned with it: the name (object), 4px, the meta line,
16px, the buttons: "Resume" (primary), "Clean…" (secondary), "Listen on Spotify" (secondary). 24px
below: the tracks card (1px `--line`, 6px radius, `--surface`): a 40px band (`--band`) with
"1 duplicate" (meta) on the left and the sort ("Custom" and a chevron, tertiary) on the right; the column
header ("#", "Title", "Album", "Length"); rows 48px, zebra fixed per row; the duplicate badge (12/500
`--ink-2`, 1px `--line`, 4px radius, 2px 6px padding) after the title. The page scrolls; the band and the
column header stick under the app header, and the band carries the card's 6px top radius itself, so its
corners stay round when stuck. Phone: the back link, the cover (128px), the name, the meta, a 44px button
row ("Resume" primary, "Clean…" secondary), "Listen on Spotify" (link) under it, then the band (40px,
`--band`, 6px radius) and 64px zebra rows with no outer border.

**Now playing.** The bottom bar (desktop) and the header cover with its sheet (phone).

**Friends.** The heading "Later stuff" at y 80 (phone: 20px below the header); 24px; Rem's three items as
ruled rows (1px `--line` above each, 16px vertical padding, title in row-title, body in body `--ink-2`),
max 640px. No card: the critique of today's page is the words, and those are Rem's call.

**Usage.** Fork `usage-view.tsx`. The heading "Usage" at y 80, the intro in meta (max 640px), then each
section as a card (1px `--line`, 6px radius, `--surface`, max 960px wide) with a 48px band: the section
name in card-title (sentence case, sans) and its note ("last 7 days · typical / slow") in meta on the
right. Inside: today's content with label-style column headers and 40px zebra rows instead of rules.
Mono only for machine strings.

**Sign-in and a friend's way in.** No app chrome. A 400px column centred on `--page`, content vertically
centred. `connect`: the recliner panda (160px); 24px; "Lazy Boy" (heading, centred); 8px; the line
(body `--ink-2`, centred), or for a returning visitor (`returning=1`; in production a long-lived
`lb-returning` cookie set at any successful sign-in) one greeting line (body `--ink`, centred) picked by
the day as in tidy's rule; 32px; "Connect Spotify" (primary, full width, 40px; phone 44px); 12px; the
consent line (12/16 `--ink-2`, centred, links `--ink` underlined); 24px; "New here? Ask for access"
(secondary, full width). States with a message (`not-registered`, `refused`) show it as a notice box
(1px `--line`, 6px radius, 12px padding, a 16px info glyph in `--ink-2`, 13px `--ink` text) between the
line and the buttons, then the buttons COMMON §5 names, primary first. `request`, left-aligned: "Ask for
access" (heading), 8px, the sentence (body `--ink-2`), 24px, "Email" (13/500 `--ink`) 8px over its input
(40px, phone 44px; `--page` fill, 1px `--line`, 6px radius, focus ring as the toolbar's), 16px, "Name
(optional)" the same, 24px, "Send request" (primary, full width), 12px, "Back" (tertiary). The email
error: a `--danger` border on the input and 13px `--danger` text under it. `sent`, `signed-out`,
`dead-grant`: the heading, 8px, the sentence (body `--ink-2`), 32px, the buttons, the consent line.

**Error.** In the app chrome. A card 520px wide, centred in the content area, 40px below the header:
a 48px band ("This page didn't load", card-title); 16px padding with the sentence (body `--ink-2`); a
footer band (`--band`, 1px `--line` top, 12px 16px) with "Reference 2847193650" (small `--ink-3`) on the
left and "Try again" (primary) on the right. The bottom bar stays.

**Loading pages.** The skeletons above, per page.

## Motion, exactly

- **A song lands in Today** (Today selected, list at its top). At t=0 the bar's art, title and artist
  cross-fade to the next song over `base` and the elapsed time restarts; the Today cell's figure and time
  change in place, unanimated. The new row enters at the top of the card: height 0 → 48px (phone 64px)
  over `row`, opacity 0 → 1 over the same 200ms; the rows below ride down with it and keep their stripes.
  Scrolled list: insert with no animation and grow the scroll position by the row's height. Another day
  or All time selected: only the Today cell changes.
- **Switching days or All time.** Instant: the cell's fill and bar move, the band's title and the
  "Played"/"Last played" header change, the rows swap and return to the top, all in one frame.
- **Search (desktop).** Focus draws the ring over `quick`. Each keystroke swaps the rows for results in
  one frame; the band reads 'Songs matching “the”' and the strip's selection moves to All time (COMMON
  §6.18). Esc or clearing swaps back in one frame. **Phone:** today's search mode motion.
- **Popovers and menus.** Opacity 0 → 1 and scale 0.96 → 1 over `base`, `transform-origin` at the edge
  touching the trigger; close by opacity over 100ms. "New playlist" turning into a picker: the popover
  resizes (width and height) over `base` while its old content fades out in 100ms and the new fades in
  over 150ms; it never jumps position.
- **The bottom bar** between playing, paused and idle: its content cross-fades over `base`; the bar
  never moves or resizes.
- **Sheets (phone):** up over `sheet`, scrim in over 200ms; down over 200ms.
- **Phone header and capsule:** today's scroll behaviour.
- **T10 (ledger's own):** "New playlist" → "Merge playlists" → the picker, recorded at both widths.

## What porting it costs

About five lanes. (1) Tokens, header with the tab underline, the bottom bar (a new component reading the
existing now-playing context; the header chip goes) and the phone sheet. (2) Home: toolbar search in
place of the desktop capsule, the two strip boxes, the record card (`den-home.tsx`'s render half
rewritten; its search, day and arrival logic kept), the dock removed from Home. (3) Playlists: toolbar,
"New playlist" hosting the Merge and Subtract pickers (moved out of `dock.tsx`), tile menus with Resume
and Clean; the playlist page's buttons (Resume calls `resumePlaylistAction(id)` directly, no picker).
(4) Sign-in views and copy (the request form's UI; storing requests and showing them to Rem is the
multi-user lanes' backend). (5) Usage cards, error page, skeletons, toasts. Risks: Resume and Save queue
leave Home, which Rem uses daily (Resume gains a home in the idle bar, Save queue sits in the bar while
playing); the desktop list loses 64px to the bar and gains it back from the greeting and chores; the "/"
shortcut must not fire while typing elsewhere.
