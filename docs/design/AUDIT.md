# lazyboy design audit — what reads as machine-made, measured

> Copy of `~/lazyboy-review/2026-10-15_design-audit/AUDIT.md` without its images. The paths it cites
> (`captures/`, `audit/`, `references/`) are relative to that folder, not to this repo.

Lane 2990, Oct 15, 2026. Written for Rem, and for lane 2991, which turns it into directions. Findings only: nothing
in the app was changed, and each finding carries at most one line of direction.

**Evidence.** Today's app as lane 2986 captured it from the dev-only `/design` fixture surface (branch `lane/2986`,
which has not landed on main), in `captures/` with its index `captures/CAPTURES.md`; the reference apps lane 2985
measured live, in `references/REFERENCES_MEASURED.md` and `references/SPOTIFY_BRANDING.md`; Rem's five Spotify
phone screenshots (`~/.claude/broke/scratch/lazyboy_design/refs/`). For this audit I ran lane 2985's census on
lazyboy's own pages, in the same format, plus geometry, motion, row and link probes, from the same fixture surface
(1440×900 Chromium; 390×844 WebKit and Chromium). The raw numbers are in `audit/measured/`; the renders made for
this audit are in `audit/renders/`. Every point names the capture that shows it.

**The bar it is judged against.** Rem's own recorded rules (the memory files `lazyboy-draft-redesign.md`,
`spotify-ui-taste.md`, `spotify-minimal-green-aesthetic.md`, `lazyboy-panda-brand.md`,
`rem-design-taste-and-mindset.md`; `docs/DRAFT_BRIEF.md`, `docs/CONVENTIONS.md`), DiveLoop's design study
(`mobile/design-study/SYNTHESIS.md` and its 8-question test, `README.md`, `APP_AUDIT.md`, `mobile/DESIGN_CARD.md`,
`web/docs/DESIGN_RULES.md`) for the mechanisms, and the measured registers of Spotify, ChatGPT, Apple Music and
Last.fm.

Contents: 1 what Rem would notice first · 2 what is good and must stay · 3 the register, measured · 4 screen by
screen · 5 the greeting header · 6 Home's information architecture · 7 what a friend meets · 8 the 8-question test,
page by page · 9 drift to fix, and Rem's calls · 10 method and limits.

---

## 1. What Rem would notice first

Ranked by how fast it shows at the pixels, beside Spotify.

1. **Before any music, three bands of chrome.** A 48px bold random quip, a row of five outlined pills with icons, and
   a framed tray of framed day cards. The first song row starts 412px down a 900px desktop window (46%) and 288px
   down an 844px phone viewport (34%). In Rem's Spotify phone screenshots the first cover sits at about 13% of the
   screen on Home and 24% in the Library, status bar included. (`audit/renders/home_bands_phone-webkit.png`,
   `home_bands_desktop.png`; findings F6, F7, F8.)

2. **Lines around everything.** 22 bordered boxes on Home and 27 on Playlists, desktop; Spotify's playlist page has 2,
   ChatGPT's 4, Apple Music's 1. Boxes sit inside boxes: cards inside the tray, covers inside bordered tiles, the
   phone song list inside a frame, a playlist's table inside a frame. (F8, F17, F22.)
3. **The same song drawn three ways, and a fourth in a panel.** A day row, a search result and a playlist row differ
   in art size, art radius, title weight, column order and type size, and the Subtract result lists songs a fourth
   way; on the phone a playlist's titles are 11.9px while Home's are 15px. (`audit/renders/rows_compared_desktop.png`,
   `rows_compared_phone-webkit.png`; F9.)
4. **Small caps everywhere a table starts.** `SONG · ARTIST  ALBUM  LENGTH  PLAYS  PLAYED  FROM` at 11px uppercase,
   tracked; `# TITLE ALBUM` at 12px on a playlist. Rem's binding rules ban exactly this; Spotify's headers are Title
   case in the rows' grey. (F10.)
5. **Glass and glow on the chrome.** The header and the search pill are translucent and blurred, so covers show
   through the nav labels as the Playlists grid scrolls; the pill wears a black shadow with a 50px blur, the avatar a
   glow on hover. All banned by his rules. (`captures/113_playlists_transition-header-hide-on-scroll_phone-chromium/10_4525ms.png`;
   F1.)
6. **Copy that is a draft.** A nav tab opens "Later stuff… Kinda fun… More stuff I forgot about"; a Home notice says
   "check the Zenbook pinger"; the error page prints `fetch failed: store request timed out` and a 10-digit digest;
   the login page promises "compare" and says "We only access your library to manage playlists", while the app
   records every play. (F14, F26, F27, F28.)
7. **Motion without a system.** About 20 durations and 11 easing curves; three looping animations (the panda's sway,
   the phone's pulsing green ring, the marquee in a hovered cell); dock panels on desktop rise from below the
   screen's middle instead of from the button pressed. Spotify runs on six durations and three curves. (F12, F13.)

---

## 2. What is good and must stay

These hold up beside the references, and several are Rem's own rulings; a redesign that loses them is worse.

- **Colour comes from the covers.** The chrome is two greys on near-black and green is almost absent: no green text
  anywhere in the app; green fills only the login button, and on the phone a ring marks the playing song. That is
  Spotify's own register (REFERENCES_MEASURED rule 5) and his minimal-green rule (`spotify-minimal-green-aesthetic.md`).
  (`captures/004_home_full-day_desktop-chromium.png`)
- **Selection is neutral.** The selected day card is a lighter border and 5% white fill, the Songs/Artists switch a
  grey thumb; nothing selected turns green (`docs/CONVENTIONS.md` § selection vs hover; DESIGN_CARD §2).
- **Two inks carry the text.** `#ececf1` and `#a0a0aa` (the ink at about two thirds) carry 83–99% of the
  characters on every page, Spotify's two-ink pattern. The problem is at the faint end (F15), not here.
- **The strip clips its sixth card at the edge**, the scroll cue Rem praised in Strava (design-study README §1,
  "affordances worth keeping").
- **One family, weight doing the work.** Figtree only, no imported display face (his rule, 2026-07-03).
- **Row states copied from Spotify.** 7% white on hover, 16% on a selected row that stays lit under its context menu
  (`den.css` § Row states). (`captures/018_home_row-hover_desktop-chromium.png`)
- **Instant swaps where geometry holds.** Switching day or All time replaces the list in the same frame; only the
  card's border and fill ease (150ms). Spotify and Apple Music swap pages the same way, and it keeps his "day
  switching must not re-render the page" rule.
- **The data grammar.** Tabular numerals, `6:09`, `9h 47m`, `×127` with a real multiplication sign, clock times in a
  day and relative times in All time.
- **Quiet empty and no-result lines.** "No plays recorded here.", "No songs match “zzqx”.", "No playlists yet." — one
  line, no illustration, Figma's whisper (SYNTHESIS §5.5). (`captures/013_…`, `034_…`)
- **The phone's mechanics.** One top bar that slides away on scroll-down; dock actions as bottom sheets on a
  UIKit-like curve (300ms, `cubic-bezier(.32,.72,0,1)`); the search pill docking to the top while typing, so no
  keyboard covers it; one row per play (his 2026-08-13 ruling). (`captures/082_…`, `072_…`)
- **The panda.** An owned mark, legible at 31–36px, no green in it (Spotify's naming rule, SPOTIFY_BRANDING §10).
- **Duplicates surfaced in place** on a playlist ("1 duplicate", and the later copy badged) — useful and honest.
- **Nothing asks for anything.** No streaks, badges, upsells or onboarding modals (SYNTHESIS §1.6).

---

## 3. The register, measured

Desktop, first ~2,200px of each page, characters weighted (lane 2985's census, run on lazyboy). Reference columns
are copied from `references/REFERENCES_MEASURED.md`.

| | lazyboy Home | lazyboy app-wide | Spotify | ChatGPT | Apple Music |
|---|---|---|---|---|---|
| Text sizes | 7 (11 12 13 14 15 20 48) | 12 desktop, 14 phone | 5 on a playlist page | 3 | 4–5 |
| Dominant size | 15px (rows) | 14–15px | 14px desktop, 16px phone | 14px | 13px |
| Smallest common size, phone | 10.2px (19% of Home's text) | 10.2px (32% of Playlists) | 11–13px meta only | 11px small print | 13px |
| Weights | 400 500 600 700 | same | 400, 700 | 400, 500 | 400–700 |
| Text colours | 4 | 12 (incl. two near-identical greys and two near-identical inks from two token files) | 2 (+1 phone) | 2 | 3–4 |
| Bordered boxes | 22 | 27 on Playlists | 2 | 4 | 1 |
| Shadows | 3 (incl. 0 25px 50px black/50 on the search pill) | — | 1 | 1 | 2–4 |
| Radii | 9.6, 16.8, pill, 6 (row ends) | 7: 4, 6, 9.6, 12, 16.8, 31.2, pill | 4 / 6 / 8 + pills | 10 / 28 + pills | 5 / 8 / 12 |
| Song row | 59px, 40px art at 9.6px, title 15/400, artist 13 | 3 for a song, plus the panels' rows (F9) | 56px, 40px art at 4px, 16/400 + 14 | — | 54px, 40px art |
| Phone song row | 55px, 41px art at 8.2px | playlist row: 48px, 34px art, 11.9px title | 64px, 48px art at 4px, 16 + 13 | — | 54px |
| Motion durations | ~20 (100–1400ms + four that never end) | — | 50–300ms tokens | 150–300ms | 100ms hover, 560ms nav |
| Spacing | bands 24px apart on desktop, 13.6px on the phone; phone gutter 14px | — | phone gutter ~16px; tokens 8 12 16 24 32 48 64 | — | — |

Sources: `audit/measured/desktop_census.json`, `phone-webkit_census.json`, `*_rows.json`, `*_motion.json`.

Across the app lazyboy uses more than twice Spotify's text sizes (12 against 5), twice its weights, eleven times its
borders on Home and nearly twice its radii, and every extra value is one more thing the eye has to parse (SYNTHESIS
§1.1: the user learns the rulebook; a value that repeats nothing is never learned).

---

## 4. Screen by screen

Each finding: what, measured; the capture; the rule it breaks, with its file; one line of direction; whether it is
plain drift (fix it) or a collision between two of Rem's own rulings (his call, collected in §9).

### 4.1 Chrome (every page)

**F1 · Translucent, blurred chrome, and glows.** The header is `#0b0b0e` at 70% with `backdrop-blur-xl`
(`chrome.tsx:126`); the search pill is the popover colour at 95% with `backdrop-blur`, a `0 25px 50px -12px` black/50
shadow and a white/5 ring (`search-island.tsx`). On a scrolling page the covers show through the nav labels
(`captures/113_…phone-chromium/10_4525ms.png`). The avatar's ring is tinted from the photo's average colour and grows
a 6px glow and a 1.1× scale on hover (`chrome.tsx` AccountMenu). The code comment wants the art to "pass under" the
header; Rem's rules: "no backdrop-blur / translucent chrome, no ambient gradients or glows/neon shadows"
(`lazyboy-draft-redesign.md`, 2026-07-03, "binding for ALL lazyboy UI"). Of the four references only Apple Music blurs
anything, its floating player. Direction: opaque bars, one shadow at most. Drift.

**F2 · The phone bar is all undersized controls.** Measured hit areas on a 390px phone: nav links 32px tall, the
avatar 27×27, the now-playing art 39×39, the mark 31×31. `docs/DRAFT_BRIEF.md` mission 1 sets tap targets at ≥44px.
(`audit/measured/extra.json`; `captures/066_…`) Direction: 44px boxes around the same glyphs. Drift.

**F3 · The now-playing chip is a label, not a door.** Desktop: a small cover, title 12px, artist 11px, a 2px progress
line; phone: the cover alone in a green ring that pulses every 2.6s, forever. It links nowhere (not to the song, not
to Spotify) and carries no Spotify mark (§7). Its text is the smallest in the header while it is the one live thing on
the page. (`captures/003_…` top right; `066_…`) Direction: decide what tapping it does. Drift.

**F4 · The account menu holds a name and Log out.** No way to disconnect Spotify or ask for deletion, which Spotify's
policy requires for every user (SPOTIFY_BRANDING §13), and it opens on hover after a 180ms delay. (`captures/024_…`,
`081_…`) Direction: give disconnect a home before a friend signs in. Drift.

**F5 · Two token sets.** The login page runs on `globals.css` (`#0a0a0c`, ink `#ededed`, grey `#a1a1aa`), the app on
`den.css` (`#0b0b0e`, `#ececf1`, `#a0a0aa`, plus a "bamboo" steel `#9aa3b2` for the selected card). The skin was
scoped to `#den-root` for the July draft and never folded back. Invisible at a glance (1–4 RGB steps); it is how drift
starts (SYNTHESIS §5.1, the index card). (`captures/001_…` beside `003_…`) Direction: one token file. Drift.

### 4.2 Home

**F6 · The greeting is the page's attention plan.** 48px/700 on desktop (30.6px on the phone), the largest and
heaviest type in the app, and it is a random line from 39 that changes on every load. Nothing below it relates to it.
Full measurement in §5. (`captures/003_…`, `066_…`) Rule: SYNTHESIS §4 Q2 — "name the one thing the eye should land on
first; check that ink and size rank it first". His call (§9, C1).

**F7 · Five outlined pills with icons, evenly spaced.** Resume, Clean, Save queue, Merge, Subtract: 40px pills (37px
on the phone), 1px border, card fill, a lucide icon on each at stroke 1.9 (the other icons on Home draw at 2). The
icons are a developer's vocabulary: `GitMerge` for Merge, `Diff` for Subtract, `Eraser` for Clean. The redesign's own
brief names this exact pattern as the generated look: "uniform gray cards, evenly spaced icon+label chips"
(`docs/DRAFT_BRIEF.md`, mission 2). On the phone the row scrolls, so Merge is cut at the edge and Subtract is off
screen. (`captures/021_home_dock-button-hover_desktop-chromium.png`, `066_…`) Direction: see §6 for where these live;
the pill shape itself is C2. Drift (icons, chip row) and his call (pill shape).

**F8 · A framed tray of framed cards.** The day strip is a bordered, faintly tinted tray holding bordered cards, with
All time as one more bordered card outside it. Desktop cards are 143×106 with label 14/600, number 20/600, unit 12px,
radius 16.8px; on the phone 104×78 with the unit and time at 10.2px. Rem's taste memo: "no little info things in boxes
… a border must earn its place" (`rem-design-taste-and-mindset.md`); DRAFT_BRIEF's "uniform gray cards".
(`captures/003_…`, `067_…`) Direction: separate cards by surface step, not by line, or drop the tray's frame. Drift.

**F9 · Three anatomies for one object, a song, and a fourth in a panel.** Measured on desktop: the day row is 59px,
40px art at 9.6px radius, title 15/400, album 15px grey at x≈436; the same song as a search result is 61px, 44px art,
title 15/**500**, album **13px** at x≈530, with `×145` in full ink and "16h ago" stacked at the right; a playlist row
is 56px, 40px art at **4px**, title **14**, artist **12**, with an index column; the Subtract panel's result lists
songs a fourth way, 40px art at 9.6px, title 14/500, artist 12 (`dock.tsx:453`). The panels' playlist rows are a fifth
list row with the same parts. On the phone the split widens: Home rows keep fixed px sizes (15/13) while the playlist
row inherits the 85% root and drops to 11.9px titles and 10.2px artists. (`audit/renders/rows_compared_desktop.png`,
`rows_compared_phone-webkit.png`) Spotify draws every track row with one anatomy at every list length
(REFERENCES_MEASURED rule 7). Rule: SYNTHESIS §1.1 and §2 "broken invariant"; Heja's "same label, different shapes"
lesson (design-study README §1). Direction: one row component, two densities at most. Drift.

**F10 · Uppercase, tracked micro-labels in the table headers.** Home: 11px/500, uppercase, +0.275px tracking, grey at
70% (`den-home.tsx:1391`); playlist: 12px/500 uppercase +0.3px (`track-list.tsx:166`). Rem's rule: "no uppercase
tracking-wide micro-labels" (`lazyboy-draft-redesign.md`, binding). Last.fm's "SCROBBLES" is the reference that does
this, and lane 2985 lists it among Last.fm's weaknesses; Spotify's header is "# Title Album Date added", Title case in
the rows' grey. (`captures/004_…`, `039_…`) Direction: sentence case at the row's meta size. Drift.

**F11 · Desktop search keeps "Today" selected while showing all of history.** Typing "the" with Today selected lists
"The Motto ×127, 19h ago" — results from every day — under a highlighted Today card. The scoped search mode exists on
the phone only (`den-home.tsx:552`, `searchMode = phone && …`). Selection that describes something other than what the
list shows is a lie the user has to discover (SYNTHESIS §2, "broken invariant"). (`captures/010_…` vs `072_…`, where
the phone selects All time) Direction: one scope rule for both widths. Drift.

**F12 · The arrival of a song moves four things at once, and jumps a fifth.** When a song ends: the chip's text swaps
(280ms ease-out), the finished song's row drops 6px and fades in at the top of Today (the first 490ms of a 1.4s
animation), Today's and All time's numbers roll, the panda keeps swaying — and every row below the new one jumps down
59px in one frame. (`captures/048_…desktop-chromium/21_5407ms.png` → `24_6408ms.png`;
`audit/measured/desktop_motion.json`) Rule: SYNTHESIS §1.5 — motion explains what changed; layout-stable or don't
animate; Strava's whole budget is "two sheet directions, one dissolve, one native pop, and a great deal of nothing".
Direction: one motion for the handoff, and the rows below move with it or not at all. Drift.

**F13 · Motion has no vocabulary.** Measured and read from the CSS: 100, 150, 170, 180, 200, 230, 250, 260, 280, 300,
320, 340, 360 (+22ms a row), 450, 500, 1400ms, plus 2.6s, 3.2s, 4.5s and 6s loops; 11 curves (Tailwind's default,
`ease`, `ease-in`, `ease-out`, `ease-in-out`, `linear`, and five hand-tuned beziers). Three animations loop: the
panda's sway or breathe, the phone ring's pulse, the marquee in a hovered cell. On desktop the dock panel is a centred
dialog that animates as a bottom sheet (`den-sheet-up`, from 100% below), so it rises from the middle of the screen
rather than from the pill pressed at the top left (`captures/062_…`); Save queue alone opens as a popover by its
button (170ms), the one anchored motion. Spotify's Encore: 50/100/150/200/250/300ms, three curves; DiveLoop's card:
three lengths and four named transitions (DESIGN_CARD §5). A `?reveal=` URL switch for three row-reveal variants still
ships in production code (`den.css` § Search reveal). Direction: a written motion budget, each motion anchored to its
cause. Drift; the panda's loop is C4.

**F14 · Notices written to the operator.** "History capture stopped 3 h ago — check the Zenbook pinger." in amber
(`capture-health.ts:36`), and "Spotify is rate-limiting this app — new plays are held up; next retry ~11:54 AM." Both
are true and useful to Rem; to a friend the first names a machine in his apartment and neither says what the reader
should do. Amber appears nowhere else in the app. (`captures/015_…`, `014_…`) Rule: DESIGN_CARD §7, "If the user
doesn't need to see it, they should not be seeing it". Direction: user-facing wording for others; the diagnostic for
the owner. Drift.

**F15 · The faint end of the ink ramp is crowded.** The app sets text in the grey at full strength and at 70, 60, 50
and 40%, plus the ink at 90% (and the grey at 80% in search): six or seven steps where DESIGN_RULES' measured register
is "one ink, 1–2 alpha-dims". The 70% grey carries the phone row meta (12px) and the table headers. (`captures/067_…`;
`audit/measured/*_census.json`) Direction: ink, one dim, one faint. Drift.

**F16 · The loading skeleton is a different layout.** Desktop skeleton: dock at y=157, six equal 104px-tall cards with
no tray, rows from y=349 at a 52px pitch; real: dock at 173, a 126px tray, rows from 412 at 59px, so the list drops
63px when content lands. Phone skeleton: five pills wrapping into two rows, six portrait cards across the full width,
rows from 341; real: one scrolling row, a tray plus All time, rows from 288 — every band moves and the list jumps 53px
up. (`captures/007_…` vs `003_…`, `070_…` vs `066_…`; `audit/measured/*_skeleton.json`) Rule: CONVENTIONS § images,
"the layout never shifts"; SYNTHESIS §5.6 "skeletons that match the real layout". Direction: the skeleton is the page
with its text removed. Drift.

**F17 · The phone list is a frame inside the page.** On the phone the song list sits in a rounded, bordered box that
runs to the search pill; with three plays the box is 492px tall and about 325px of it is empty frame.
(`captures/066_…`, `069_…`) Rem chose the bounded box (iMessage reference, 2026-08-12); the border is the drift: the
box can be bounded without a line. Drift.

**F18 · Menus differ by page.** Right-clicking a song on Home: "Play now", "Add to queue". On a playlist: "Add to
queue", "Save to Liked Songs", "Remove from playlist", "Share" — no Play now. Same object, two menus, neither
complete. (`captures/022_…`, `043_…`) Direction: one song menu, items added by context. Drift.

**F19 · Two toasts in two colours.** Success is a soft-white pill; failure a pink `#f3c6c6` block with dark red text
(`globals.css`), a hue used nowhere else, wider and on two lines. (`captures/031_…`, `032_…`) Direction: one toast,
the failure said in words. Drift.

**F20 · The phone search exit is an undo arrow.** While searching, the pill's exit is lucide's `Undo2` (↶), which
reads as "undo the last thing". Spotify's search uses the word Cancel in a pill (Rem's screenshot 3).
(`captures/072_…`) Direction: the word. Drift.

### 4.3 Playlists grid

**F21 · The stats line regressed.** It reads "26 playlists · 20 created by you · 1,299 unique songs". Rem changed the
middle term to total songs during the draft ("NOT 'created by you' (Rem changed his mind: total songs)",
`lazyboy-draft-redesign.md`); the July 13 port (`8ea32b7`) brought the old main-app wording back. (`captures/033_…`)
Direction: his wording back. Drift. (The empty-library capture's "0 playlists · 20 created by you" is a fixture
artifact: the real page counts from the same list.)

**F22 · Bordered tiles around rounded covers.** Each tile is a 232×280 card, 12px radius, 1px border, `#15151a` fill,
with a 206px cover at 9.6px inside it; 27 borders on one screen. Spotify's tiles are borderless, the art flush at
4–6px with title and owner below; Apple Music the same. Four of 26 fixture playlists show a large music-note glyph on
grey, the biggest icon in the app. On the phone tile titles are 11.9px and counts 10.2px. (`captures/033_…`, `090_…`)
Direction: covers on the page, no card. Drift.

**F23 · The header's art bleeds through the nav.** See F1; this is the page where it shows
(`captures/113_…/10_4525ms.png`), and it is the one place lazyboy puts text over artwork, which Spotify's partner
rules forbid (SPOTIFY_BRANDING §3). Drift.

### 4.4 A playlist

**F24 · "tracks" here, "songs" everywhere else.** The header says "64 tracks · 4h 28m"; the tile that opened it says
"64 songs", as do the dock panels and the stats line. A followed playlist shows the owner's account id in lowercase
("spotify · 50 tracks"), not the name Spotify shows. (`captures/039_…`, `040_…`) Direction: one noun. Drift.

**F25 · A third header species and a pill back button.** A 34px outlined pill "← All playlists" (28px tall on the
phone), a 160px cover, a 30px/700 title — a size used nowhere else — and the table in a bordered frame. The h1 across
the app measures 48 (Home), 15 (Playlists), 30 (a playlist), 48 (Friends), 48 (Usage), 20 (error) and 24px (login);
the first ink sits at 72px on Home and 79px on the other phone pages. (`captures/003_…`, `033_…`, `039_…`, `044_…`;
`audit/measured/extra.json`) Rule: SYNTHESIS §3 — the header is reserved geometry: one title slot, one content-start
line, occupancy may vary. Direction: one title slot and one start line for every page. Drift.

### 4.5 Friends

**F26 · A nav tab opens Rem's notes.** "Later stuff", then "Compare libraries … Can do stuff with this like save the
difference straight to a playlist", "Queue song for friend — Kinda fun … DND and whatnot", and an empty "More stuff I
forgot about", under the same 48px/700 display type as Home's greeting. For Rem this is a roadmap; for a friend it is
the third of three tabs, and it promises a feature the plan says will not exist for friends ("Comparing with friends
does not exist", `docs/multi-user/PLAN.md` §12.6). (`captures/044_…`, `099_…`) The words are his (C5).

### 4.6 Usage (owner page, no nav link)

Its own register — Geist Mono section labels in lowercase, red for errors, 10.2–12px numbers on the phone — which is
fine for an operator page. Two things to know: the nav highlights Home while on /usage (deliberate, per the comment in
`chrome.tsx`), and the page checks only for a session, so in a multi-user build any friend could open Rem's
telemetry by URL. (`captures/046_…`) Adjacent risk, not a design finding.

### 4.7 Error page

**F27 · The raw error and its digest.** "Something went wrong", then `fetch failed: store request timed out` and
`2847193650` in mono, then two pills. Rule: DESIGN_CARD §6 — "what did not happen stated as a fact, and one way out.
No error code, no apology". The auto-reload before it is good. (`captures/047_…`, `102_…`) Direction: say what didn't
load and offer Try again; keep the digest for the beacon. Drift.

### 4.8 Login

**F28 · The pitch and the promise don't match the product.** "Merge, clean, and compare your playlists" — compare is
the Friends page's "Later stuff" — and "We only access your library to manage playlists. Nothing is shared." while the
app reads every play from Spotify and keeps it, which is what Home leads with. A friend reads this sentence before
granting access. (`captures/001_…`, `064_…`) Rule: SPOTIFY_BRANDING §13, a privacy policy that "clearly describes" use
of data. Direction: one honest sentence about the history it keeps. Drift.

**F29 · A form-template layout.** 176px illustration, 24px/600 title, 14px grey paragraph, a full-width green pill
36px tall (below the 44px floor on a phone), a 12px footnote, centred in the viewport; on a sign-in failure the error
is a red-bordered box and the green button stays under it, inviting the same failure again. The illustration is the
best thing on the page. (`captures/001_…`, `002_…`, `065_…`) Direction: lead with what the app shows you. Drift.

---

## 5. The greeting header

The line is a random pick from `src/content/greetings.md` (39 lines written for the June 3 `/me` page; one punctuation
mark has changed since), swapped into the real h1 for each measurement. The band's cost is its own height plus the gap
below it.

| Viewport | Type | Lines across the 39 | Band + gap | First song row, with → without | Full rows visible, with → without |
|---|---|---|---|---|---|
| Desktop 1440×900 | 48/60px, 700, −0.72px | 1 for all 39 | 60 + 24 = 84px (9% of the window) | 412 → 328px | 7 → 8 |
| Phone WebKit 390×844 | 30.6/38.25px, 700 | 1 for 35; 2 for 4 | 38 + 14 = 52px; 90px on two lines | 288 → 236px (326 on two lines) | 8 → 9 |
| Phone Chromium 390×844 | same | same | same | 291 → 239px (329 on two lines) | 8 → 9; 7 on two lines |

The four lines that wrap on a phone: "Can't get enough, can you...", "What's it been, five minutes?", "You could be
doing literally anything else.", "Some things never change." On a light day (3 plays) the greeting costs no rows;
on a full day it costs one, and in phone Chromium a wrapped line costs a second. Measured in `audit/measured/*_greeting.json`; renders
`audit/renders/greeting_with_*.png`, `greeting_without_*.png`, `greeting_longest_*.png`.

What it gives. It is the app's only voice: the lazy panda talking back, Rem's own lines, and the one element that
says this was made by a person with a sense of humour rather than generated. Two of the reference apps also put a
sentence at the top: ChatGPT's "Where should we begin?" and Spotify's "Слушаем дальше?" (Rem's screenshot 1). Both
are 20–24px, and both label the thing under them — ChatGPT's sits on its only input, Spotify's heads a shelf of
things to resume.

What it costs.
- **Attention.** It is the largest and boldest text in the app and carries no information; by size and weight it
  ranks first on Home, ahead of the music (F6). DiveLoop's audit found the same fault in a count pill: "the strongest
  ink on the screen for the least load-bearing fact" (APP_AUDIT §3; SYNTHESIS §1.4 on why it reads unauthored).
- **Stability.** It changes on every load, so the top of the page never settles into something learned; every other
  band is the same from visit to visit (SYNTHESIS §1.1).
- **Fit for others.** The file's largest section, 21 lines, is titled "Returns" ("Back for more?", "Knew you'd be
  back", "There's the regular"), 8 more are filed under "Roasty" ("You could be doing literally anything else."), and
  several of the 10 named lines assume a return too ("Welcome back, {name}"). A friend on a first visit, with no
  history, is told "Back for more?" (`captures/006_…`, `069_…`).
- **Space.** 84px on desktop and 52–90px on a phone, as measured above. It also sits 24px under the header rule on
  desktop and 17px on a phone: the top-left, tight placement Rem called "way too high … too cramped" twice in
  DiveLoop's study (README §3 delta 2).
- **The type slot.** 48px/700 is shared only with "Later stuff" and "Usage", so the app's display size is spent on a
  joke, a placeholder and an operator page (F25).

Rem's own words on Oct 14 — "speaks out of the olden times … as a good joke of a few years ago … it's not horrible" —
match the measurement: it is cheap in pixels and expensive in attention. Whether it stays, shrinks to a line under
something useful, or goes is his call (C1).

---

## 6. Home's information architecture

**What Home carries today**, top to bottom, with its share of the first screen:

| Band | Desktop (900px) | Phone (844px) | Job |
|---|---|---|---|
| App header | 65px | 55px | mark, three tabs, now playing, account |
| Greeting | 60 + 24px | 38 + 14px | none (F6) |
| Dock | 40 + 24px | 37 + 14px | five playlist actions |
| Notices (when present) | +44px | + one line | sync health, written for Rem (F14) |
| Day strip + All time | 126 + 16px | 98 + 14px | 14 days (7 on phone) of plays and hours |
| Song list | 412–824px, 7 rows | 288–779px, 8 rows | the selected day, sortable on desktop |
| Search pill | 840–880px | 786–834px | songs or artists across all history |

Five jobs share one screen, and the screen gives the music 46% (desktop) to 58% (phone) of its height, starting at
the 46% and 34% marks.

**What a person needs first.** I have no click counts — `/usage` records page loads, not dock presses — so this rests
on what the app's own work has prioritised and on the references. The live list is what gets watched: the newest
engineering (lane 2290, this morning) made a finished song land within about a second. Search is the second: it has
its own performance harness and Han-script folding. The day strip is how you move through history. The five dock
actions are chores done now and then, and four of them take playlists as input while sitting on a page that shows no
playlists. Last.fm, the one reference whose subject is a person's listening history, puts an identity line, one
total and the dated list, in that order, and nothing else (REFERENCES_MEASURED, Last.fm).

**Where the rest could live** (one line each; lane 2991 owns the designs):
- Clean, Merge, Subtract → the Playlists page, where the playlists they act on are.
- Resume → on a playlist (tile or page); it acts on one playlist.
- Save queue → beside now playing; it acts on the live queue.
- All time → a mode of the list rather than one more card competing with the days.
- The greeting → Rem's call (§5).
- Search and the day strip → stay on Home; they are how the history is read.

---

## 7. What a friend meets

The plan for friends is `docs/multi-user/PLAN.md` §12.6: up to five people, history starting with their last 50
plays, the first library scan taking one to two minutes, no comparing with friends. Today the owner guard refuses
every account but Rem's.

**The login page.** F28 and F29: a promise of "compare", a privacy sentence the app contradicts, no privacy policy,
a 36px button. After a refused sign-in the page shows "Lazy Boy is single-user for now: only its owner's Spotify
account can connect." in a red box with the same green button below it (`captures/002_…`, `065_…`).

**The first visit, no history** (`captures/006_…`, `069_…`, `126_…`):

- "Back for more?" to someone who has never been here (§5).
- An empty, framed tray holding a single chevron, "Show more days", which has nothing to show (`day-cards.tsx`
  renders the chevron whenever a longer span exists, even at zero days).
- All time: "0 plays", "<1m" — `formatListenTime(0)` returns "<1m", so a zero reads as "a little" (`format.ts:23`).
- "No plays recorded here." with no word on where plays will come from or when.
- The dock's five actions, live, against a library still being scanned; the panels say "Loading your playlists…"
  until it lands.

**How the history fills in.** By the plan, the first harvest brings the last 50 plays — about three hours of
listening — so the strip shows one to three day cards and the rest of the frame is empty; earlier listening exists
only through Spotify's export. Nothing on screen says history starts at sign-in, that the app records while closed,
or why yesterday is missing. The plan's "What a friend gets" text (§12.6) is written for an invite; none of it has
a place in the UI yet.

**Friends tab.** F26: the notes page.

**Where the app falls short of Spotify's rules** (`references/SPOTIFY_BRANDING.md`; measured in
`audit/measured/*_links.json`):

| Rule | lazyboy today | Capture |
|---|---|---|
| §1 Attribution: the Spotify logo must accompany any Spotify metadata or art | no Spotify logo or icon on any page (0 found on Home, Playlists, a playlist, Login) | 003, 033, 039, 001 |
| §2 Link back to Spotify from metadata and art | 0 links to `open.spotify.com` or `spotify:` on those pages; "Share" on a playlist row copies one to the clipboard; Home's menu has none | 022, 043 |
| §3 Art radius 4px on phones and laptops, 8px on large screens | 9.6px on Home rows and tiles' covers (8.2px phone); 4px only on playlist rows | 004, 033 |
| §3 No text over artwork | the translucent header shows covers under the nav labels | 113 frame 10 |
| §5 Playing views carry the logo or icon and link to the Spotify app | the chip has neither (F3) | 003 |
| §5 Restricted controls for Free users disabled or hidden | Play now, Add to queue and Resume show to everyone; the app cannot know a friend's tier (dev mode no longer returns `product`, PLAN §12.6) | 022, 025 |
| §6 Liking: "Added to Liked Songs" | the toast says "Saved to Liked Songs" | 043 |
| §13 Policy: disconnect and delete, privacy policy | only Log out (F4); no policy linked from login (F28) | 024, 001 |
| §13 "derived listenership metrics" | plays and hours per day, all-time totals: the day strip is literally that; small exposure at five users, larger in public | 004 |

Clear: the name, the panda (no green, no circle-and-waves), playback controls (none beyond the menus), the progress
line (information only, no seek).

---

## 8. The 8-question test, page by page

SYNTHESIS §4: 1 card check (any value outside the system), 2 attention plan, 3 signal audit, 4 invariants, 5
semantics, 6 agency, 7 time honesty, 8 author test.

| Page | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Login | fail | pass | part | fail | pass | pass | part | part |
| Home | fail | fail | fail | fail | part | fail | fail | fail |
| Playlists | fail | pass | fail | fail | part | pass | pass | fail |
| A playlist | fail | pass | part | fail | fail | pass | pass | fail |
| Friends | part | fail | pass | fail | pass | fail | n/a | fail |
| Usage (owner) | fail | pass | pass | part | pass | pass | pass | n/a |
| Error | fail | pass | pass | pass | fail | pass | pass | part |

The reasons, failures and partials only:
- **Login.** 1: its own palette, the only 24px/600 title, the only green fill. 3: the green note in the art repeats
  the button's green as decoration. 4: the 36px button. 7: after a refusal the same button invites a retry that will
  fail. 8: beside Home it reads as a default form template.
- **Home.** 1: 7 sizes, 4 weights, 4 radii, 22 borders, values found only here (48/700, 20/600, 11px caps, amber). 2:
  the random greeting outranks the music, which starts at 46%/34%. 3: an icon on every pill, a line around every
  card and around the tray of cards, a ring that pulses forever. 4: the title slot matches no other page; desktop
  search leaves Today selected over all-history results (F11). 5: the same song is 15/400 in the list and 15/500 in
  search; album 15px in one, 13px in the other. 6: a quip at the user on every load; notices addressed to Rem. 7: the
  skeleton moves every band (F16); zero listening reads "<1m". 8: next to Playlists, a different header, row and
  radius.
- **Playlists.** 1: 12px tiles, a radius shared only with the playlist table's frame. 3: a border on all 26 tiles. 4: covers bleed through the header
  (F23). 5: "songs" here, "tracks" one tap later. 8: "uniform gray cards", DRAFT_BRIEF's own definition of generated;
  10.2–11.9px text on the phone.
- **A playlist.** 1: 30px/700 title, 4px art, a 10px pill badge — each found only here. 3: a bordered table frame
  and caps header. 4: a third header species, a 28px back pill on the phone. 5: "tracks"; the owner's id for a
  name. 8: row anatomy unlike Home's; 11.9px titles on the phone against Home's 15px.
- **Friends.** 1: Home's display size for a placeholder. 2: "Later stuff" is the first read. 4: a tab that leads to
  no function. 6: internal notes as copy. 8: reads as a README.
- **Usage.** 1: mono labels and red text found only here. 4: Home is highlighted while on Usage.
- **Error.** 1: the only centred 20px/600 title, a mono digest. 5: a raw exception string and code. 8: pill buttons
  unlike the dock's.

---

## 9. Drift to fix, and Rem's calls

**Plain drift** — the app breaks a rule Rem recorded, or breaks its own consistency with no ruling behind it. In the
order I'd fix them, by what shows most:

1. F1, F23 — translucent, blurred header and pill; glow and 50px shadow (anti-slop rules).
2. F10 — uppercase tracked table headers (anti-slop rules).
3. F9, F18 — four song-row anatomies, two song menus.
4. F8, F17, F22 — borders on every card, tray and tile.
5. F16 — skeletons that are a different layout.
6. F7 (icons and chip row), F13, F12 — the developer icons, the motion vocabulary, the song-arrival jump.
7. F11 — search scope that disagrees with the selected card.
8. F14, F27, F28 — operator notices, raw errors, the login's privacy sentence.
9. F21, F24, F20, F19 — "created by you", tracks/songs, the undo-arrow exit, the pink toast.
10. F2, F25, F15, F5, F3, F4 — undersized phone targets, header species, the faint inks, two token files, the
    chip as a dead end, the account menu.
11. §7's Spotify table — logo, links, art radius, the Liked toast, restricted controls; mostly additive, and the
    logo and links are conditions of using Spotify's data at all.

**Collisions between Rem's own rulings** — his call, with what each side costs:

- **C1, the greeting.** His ruling kept "just the greeting" over Home (comment in `home-view.tsx`; memory: no
  subline repeating Today's numbers), and its lines are his. Against it: the attention plan, a friend's first visit,
  and his own Oct 14 verdict. Measured cost in §5.
- **C2, pills.** Three written rules say no pills — "avoid pill-shaped containers (rounded-full chips)"
  (`spotify-ui-taste.md`), "no chip-pills" (`docs/DRAFT_BRIEF.md`), "bordered … rounded-lg … still not pills"
  (`lazyboy-draft-redesign.md`; the July 4 draft had `rounded-lg`) — but the dock became pills before the July 13
  port, which Rem shipped as "the draft, exactly", and the references he now holds up are pill-heavy: Spotify's
  every button and filter chip, ChatGPT's every button. Today pills are the dock, the search, the Songs/Artists
  switch, the back link, the duplicate badge, the login and error buttons; cards and tiles are 12–17px rectangles.
- **C3, rows per play on the phone, per song on desktop.** His 2026-08-13 ruling made the phone list one row per
  play while desktop counts plays per song in a sortable table; the same day reads as 3 rows on a phone and 2 on a
  laptop (`captures/066_…` vs `003_…`). It works against one anatomy per object (F9), and it was his decision.
- **C4, the panda's idle motion and the pulsing ring.** He liked the wobble (`lazyboy-draft-redesign.md`). Both loop
  forever in the corner of the eye, and every page is in motion while music plays; the study's rule is that motion
  without new information is cost (SYNTHESIS §1.5).
- **C5, the Friends copy.** The words are his ("copy is his", `rem-design-taste-and-mindset.md`), and they are the
  page a friend reaches with the third tab. Keep the tab and rewrite, hide the tab until it does something, or keep
  it as is.

---

## 10. Method and limits

- Everything was rendered from the `/design` fixture: real components, an invented listener with real music. Two
  things in the captures are fixture artifacts, not app defects: the empty library's "20 created by you", and a
  playlist header of 64 tracks over 65 rows. The fixture has no state between "no history" and a full week, so the
  friend's 50-play first day (§7) is described from the plan, not rendered.
- Logged-out references: Spotify's player bar, library and menus were not measurable live; Rem's phone screenshots
  stand in for them, measured off the image (status bar included).
- Lane 2986's frame series run at 200–800ms between frames, enough for end states only; the motion numbers come from
  `document.getAnimations()` during each trigger and from the CSS (`audit/measured/*_motion.json`). JS-driven motion
  (the header's scroll-hide, the search pill's travel) moves 1:1 with the finger and has no duration to measure.
- Phone numbers are a 390×844 viewport in WebKit and Chromium at 2×, not a device; Safari's own bars would take more.
- No usage data for which Home controls get pressed (§6).
- The scripts that produced `audit/` are in `~/.claude/broke/scratch/lazyboy_design/2990/` (`measure.js`,
  `render.js`, `extra.js`), against a dev server of branch `lane/2986`.
