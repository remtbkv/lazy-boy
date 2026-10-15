# lazyboy design audit, second pass: what reads as machine-made, tested against structured products

> Copy of `~/lazyboy-review/2026-10-15_design-audit/AUDIT_v2.md` without its images. The paths it cites
> (`captures/`, `audit/`, `audit_v2/`, `references/`) are relative to that folder, not to this repo.

Lane 2987, Oct 15, 2026. For Rem, and for whoever turns it into directions. Findings only: nothing in the app changed.
The first audit (`AUDIT.md`, lane 2990) stays as it is; this pass tests it.

**Evidence.** lazyboy as lane 2986 captured it from the dev-only `/design` fixture (`captures/`), re-measured for this
pass from the same fixture on branch `lane/2986` (`audit_v2/measured/`). The references: Rem's five Vercel dashboard
screenshots, measured off the pixels; Vercel, Linear, Stripe's docs and GitHub, loaded live and logged out; Spotify,
ChatGPT and Apple Music re-measured with the same probe; Rem's Spotify phone screenshots. All of it is written up in
`references/STRUCTURE_MEASURED.md`, which this file leans on throughout. Comparison renders are in
`audit_v2/renders/`.

---

## What changed from the first audit, and why

**Counting stopped being evidence.** The first audit ranked lazyboy by how many values it uses (borders, text sizes,
weights, radii, durations) against Spotify, ChatGPT and Apple Music, the three sparsest products available. Measured
the same way, the structured products Rem calls human-made sit at or above lazyboy: GitHub's issues page has 62 boxed
elements to Home's 24, GitHub's releases page uses 7 text sizes, Stripe's docs home 4 weights and 9 text colours,
Linear's header is translucent with a 20px blur, Stripe sets its sidebar groups and its table headers in capitals. So
a count cannot be the reason something reads generated. What the human-made pages share is how they use structure, and
that is now the yardstick (STRUCTURE_MEASURED, "What the structured products do with structure").

**Generated and hand-made are separated.** Rem's own verdicts, from the DiveLoop design study he narrated, distinguish
two failures. Hudl's account panel, a "Hi, Bro" greeting in the title slot over tiles, a grouped card and a separate
card, "got one shotted by [Claude]": stock components with no decision about which to use. Heja's inconsistencies read
to him as "made probably personally, not with Claude". The first audit filed both under machine-made. Here the
greeting, the five equal chips, the boxed day cards, the error page and the login's sentences are the generated set;
the Friends notes, the operator notices, the four row anatomies and the "20 created by you" line read hand-made and
unfinished. Both matter before friends arrive; only the first set answers "why does it look AI'd".

**The ranking changed.** "Lines around everything" (first audit, second place) becomes a narrower finding: a box whose
only content is more boxes of the same kind, at a radius rounder than any card in the references. GitHub, Stripe and
Spotify nest no containers on the pages measured; Vercel's dashboard nests two, a screenshot of the deployed site and
one info notice. "Three bands of chrome" is corrected: the day strip is data, so only the greeting and the five chips
sit above the music without being data. Glass and the tracked capitals stay as breaches of Rem's own lazyboy rules, no
longer as evidence of machine-made design.

**The tally.** Of the first audit's 29 findings, 16 stand (some narrowed or with stronger evidence), 11 are reframed
and 2 are dropped (§4). New observations include: the error page is the Next.js documentation's example verbatim; the
day strip has the silhouette of shadcn's stock dashboard; on a phone every toast lands on top of the search pill; the
phone loading screen still draws the July layout Rem rejected; and the Usage page, which the first audit set aside as
an operator page, is the page in the app built most like Vercel's dashboard.

**Rem has ruled since.** Log out and Disconnect as separate actions, logging out stopping capture and saying so, a
helpful error for a dead Spotify grant, sign-up by request form, and the privacy and terms pages with a consent line
on the login page (main, `130cb13`). They settle parts of F4, F27 and F28 and of a friend's first visit (§7), noted
where they apply.

---

## 1. What Rem would notice first

Ranked by how fast it shows and how strongly it reads as a stock answer where a decision belonged. Each item names the
counterexample it was tested against.

### 1.1 The greeting is the largest thing on Home and says nothing about it

"Back for more?" at 48px/700 (30.6px on a phone), a random line from 39 on every load, is the largest and heaviest
type in the app. Measured off Rem's screenshots, Vercel's dashboard sets nearly everything at about 14px and its
largest words, about 20px, name what sits under them: "Overview", "Networking", "Active Branches", "Project Name".
GitHub's largest word on the issues page is "Issues". The only display-size type above data in the references is a
name, Spotify's 96px playlist title; otherwise 48–64px type appears only on marketing heroes (Vercel's pricing,
Linear's home). The closest thing in Rem's own corpus is the Hudl panel he called one-shotted, which opens with a "Hi,
Bro" greeting in its title slot, top left (`design-study/obs/v7.md` §2.9; there it is title-sized, 17pt, where
lazyboy's is display-sized). His study also files copy that "performs personality" under the instrument-stance
dislikes (SYNTHESIS §1.6), and 29 of the 39 lines are "Returns" and "Roasty" lines aimed at the reader ("Back for
more?", "You could be doing literally anything else."). Rem's own Oct 14 read, "a good joke of a few years ago",
matches. Cost on screen, measured by the first audit and re-checked: 84px of a 900px desktop window, 52–90px of a
phone's, before any data. The lines are his, so what replaces the slot is his call (§8, C1); a page title naming the
content, or nothing, are the two shapes the references use.

### 1.2 Five equal chips, with glyphs that don't say what they do

Resume, Clean, Save queue, Merge and Subtract are five identical outlined pills, each with a lucide icon, evenly
spaced, none more important than another. The pill shape is not the problem: Spotify's filters and ChatGPT's buttons
are pills. What the references do that this row doesn't: Vercel gives each area one white primary and makes the rest
bordered or icon-only by importance ("Upgrade to Pro", "Visit", "Add New"); GitHub's bordered buttons carry their own
data ("Fork 34.9k", "Star 143k"); Spotify's outlined pills are filters of the list below them and carry no icon. The
glyphs are a developer's vocabulary (`GitMerge` for Merge, `Diff` for Subtract, `Eraser` for Clean). Rem's verdict on
CoachNow's feed, "this looks like pretty AI", came as he pointed at "that lightning thing in the top right", a glyph
whose meaning (pending uploads) it does not signal (obs/v2 §2.12), and the July brief names "evenly spaced icon+label
chips" as the default dark-shadcn look (`docs/DRAFT_BRIEF.md`). On a phone the row scrolls and Merge is cut mid-word
at the edge, Subtract off screen. Where these actions could live instead: §6.

### 1.3 Boxes inside a box, rounder than anything in the references

The day strip is a bordered, faintly tinted tray holding bordered cards; All time is one more card outside the tray.
The cards themselves are sound: they hold figures, which Rem's own rule allows ("cards are for figures, not for
prose"), and Vercel's usage meters do the same job. Two things in how they are drawn have no counterpart in the
human-made references, and a third is a plain slip:

- **Nesting.** The probe counts 14 containers inside another container on Home, all of them day cards inside a tray
  that holds nothing else. GitHub, Stripe, Vercel's docs and Spotify nest none on the pages measured; Vercel's
  dashboard tells rows apart inside a card by fill alone, splits a card into bands with 1px dividers, and nests a box
  twice: a screenshot of the deployed site, and one info notice in the toolbar setting. Elsewhere the nested boxes
  also hold a picture of something else (Vercel's template previews, Linear's mock of its own app). None is a frame
  whose only content is more frames.
- **Radius.** 16.8px on 143×106 cards (14.3px on the phone's 104×78). Card radii in the references run 2–12px, and the
  12px ones sit on cards at least 160px tall; Vercel's dashboard cards are about 6–8px. (ChatGPT's composer, a single
  input, is 28px.)

- **A sibling that doesn't line up.** All time's label sits 7px above Today's on desktop and 6px on the phone, because
  the day cards are inset by the tray and All time is not (`align.js`).

The shape is also the stock one. shadcn/ui, the library lazyboy's primitives come from, opens its own dashboard
example with a row of four bordered metric cards, each a label over a large figure
(`references/structure/checks/shadcn_dashboard_example.png`). lazyboy's cards carry real figures where the example's
carry invented ones and captions like "Trending up this month", which is the difference that matters most; the row of
rounded boxes is still the example's silhouette, and Rem's July complaints about the live app ("AI sloppy", the phone
"horrible") already included a "crammed 7-card stat row". The tray, with All time outside it, is his own July design
(`lazyboy-draft-redesign.md`), so whether the second box stays is his call (§8, C6); the radius and the offset are
drift.

### 1.4 On a phone, a fixed frame that is mostly empty

Rem chose the bounded list on the phone (the iMessage shape, Aug 12), and GitHub frames its phone issue list the same
way, so the frame is not the problem. GitHub's box hugs its content and starts with the list's own header bar.
lazyboy's frame runs to the search pill whatever the list holds: on a three-play morning it is about 490px tall and
about 330px of it is empty bordered box (`captures/123`), and on a new account the whole screen below the strip is one
empty frame with "No plays recorded here." at its top (`captures/126`). Rem's own rule: "empty space is fine; an empty
FOLD is not" (`rem-design-taste-and-mindset.md`). A frame that ends where the rows end, with the pill still docked
below, keeps his iMessage shape.

### 1.5 Stock text where the product's own words belong

- **The error page is the framework's example.** "Something went wrong" over "Try again" is the error boundary in
  Next.js's own documentation, word for word
  (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`: `<h2>Something went
  wrong!</h2>` and a Try again button), with the raw exception string and a ten-digit digest under it (`captures/047`,
  `159`). Vercel's notices say what changed and where to go ("Top paths have moved to Observability inside each
  project."). Rem has ruled that a dead Spotify grant gets "a short, helpful error saying what happened and what to
  do" (RULINGS, decision 20); the same standard fits this page.
- **The login's two sentences are onboarding boilerplate.** "Connect your Spotify account to get started." and "We
  only access your library to manage playlists. Nothing is shared." are the reassurance lines of a template sign-in,
  the register Rem called "basically what like Claude told me to write" when he met an empty-state line that restated
  its title (obs/v2 §2.12). The first half of the footnote is also untrue: the app reads and keeps every play, which
  the new privacy policy (main, `130cb13`) says plainly while the footnote still doesn't. GitHub's, Linear's and
  Vercel's sign-in pages are a title ("Sign in to GitHub", "Log in to Linear", "Log in to Vercel") and the buttons,
  with no pitch and no reassurance line (`references/structure/checks/`, viewed logged out).
- **Save queue confirms itself.** Pressing it opens a bubble whose only content is a second "Save queue" button and a
  close glyph, over the day cards (`captures/027`, `141`). Nothing in it says what will be saved (how many songs,
  under what name), which the panels beside it do for their own actions ("Combines the playlists you pick into one,
  kept in the order you pick them.").

### 1.6 Playlist covers drawn twice

Each Playlists tile is a bordered #15151a card around a cover with its own 9.6px rounding: two edges for one object,
26 times on the page. A border earns its place where nothing else draws the edge, which is why Vercel's project cards
have one (they have no picture). Where there is a picture Spotify drops the line: its tiles are a fill step with the
cover flush, and its library rows are a cover and two lines of text (Rem's `spotify-mobile-1.png`, `-4.png`). (The
first audit also counted the music-note placeholders against the page; Spotify's own apps show the same placeholder
for a playlist without a cover, so that part is dropped.)

### Breaches of Rem's own lazyboy rules that are not AI tells

Both stay because his binding rules of 2026-07-03 ban them; neither is evidence of machine-made design, since
human-made references do the same.

- **Tracked capitals as table headers.** `SONG · ARTIST  ALBUM  LENGTH  PLAYS  PLAYED  FROM` at 11px, and `# TITLE
  ALBUM` on a playlist. Stripe heads its own data tables in capitals (BRAND, NUMBER, CVC, DATE, 13px/500, untracked)
  and sets its nav groups that way; Vercel, Spotify and Apple Music use Title case. lazyboy's are smaller, tracked,
  and dimmed to 70% of the grey ink. The rule: "no uppercase tracking-wide micro-labels".
- **Glass on the chrome.** The header (70% opaque, `backdrop-blur-xl`) and the search pill (95%, blurred) let covers
  show through as Playlists scrolls (`captures/113`, frame 10). Linear's header blurs the page under it, Apple Music
  blurs its player, and Rem praised Strava's scroll-under blur on its one long-feed tab (obs/v9 16:27) and Slack's
  floating bar (v10). The rule: "no backdrop-blur / translucent chrome". Which of his positions wins is his call (§8,
  C7). Two smaller things ride along: the pill's shadow is Tailwind's `shadow-2xl` as shipped (`0 25px 50px -12px`) at
  black 50%, a stock value; and the avatar grows 1.1× with a glow tinted from the photo on hover, a glow his rule also
  names.

### What reads hand-made, not generated

These don't make the app look AI-made; they make it look unfinished, and a friend sees them first:

- **Friends is Rem's notes.** "Later stuff", "Kinda fun ... DND and whatnot", "More stuff I forgot about", under
  Home's 48px display size (`captures/044`). The ruled-row layout is sound; the words are his (C5).
- **Notices written to the owner.** "History capture stopped 3 h ago — check the Zenbook pinger." in amber
  (`captures/015`). Plain one-liners, which is the right form; the wording names a machine in Rem's apartment.
- **"26 playlists · 20 created by you"** where Rem chose total songs during the draft, and "64 tracks" one tap after
  "64 songs".
- **The loading screen is the July layout.** The phone skeleton draws the five chips wrapping into two rows and six
  narrow cards across the full width, the "wrapped pill soup" and "crammed 7-card stat row" Rem rejected in July, then
  every band moves when the page lands (`captures/127` beside `123`).
- **Four drawings of one song.** A day row, a search result, a playlist row and a panel row differ in art size, title
  weight and column order (`audit/renders/rows_compared_desktop.png`). It shows the moment you type: the list's left
  edge moves 22px, the album column moves, the header disappears (`captures/010` beside `003`).
- **Toasts on the pill.** On a phone the success and error toasts land on top of the search pill, in WebKit and
  Chromium (`captures/145`, `088`, `089`); on desktop they sit above it.

---

## 2. What is good and stays

Each item from the first audit's list, tested; it stays only where the references support it.

- **Colour comes from the covers.** Greys for the chrome, no green text, green only where something plays. Same as
  Vercel (saturated colour only in data and status) and Spotify. Stays.
- **Selection is neutral.** A lighter border and a 5% fill, never green; Vercel's selected nav row is a grey fill.
  Stays.
- **Two inks carry the text.** Vercel's dashboard runs on about #eaeaea and #969696 (measured off the screenshots).
  Stays.
- **The strip clips its sixth card.** Linear's phone tabs clip the same way ("Fr…"), and Rem praised it in Strava.
  Stays.
- **One family, weight doing the work.** Figtree only; Vercel is Geist only, GitHub its own Mona Sans, Linear Inter.
  Stays.
- **Row states from Spotify** (7% hover, 16% selected that stays lit under its menu). Stays.
- **Instant swaps where geometry holds** (day and All time switching). Stays.
- **The data grammar.** Tabular numerals, `6:09`, `9h 47m`, `×127`, clock times in a day and relative times in All
  time: the same thing Vercel does with "9.54 MB" and "16h ago". One slip: All time prints "6778" while Playlists
  prints "1,299".
- **Quiet empty lines.** "No plays recorded here." is the right whisper; the state around it on a new account is not
  (1.4).
- **The phone's mechanics.** The top bar sliding away, bottom sheets on the UIKit curve, the search pill docking to
  the top while typing, one row per play. Stays; the toast collision sits in this area.
- **The panda.** It holds up even at favicon size among Rem's other projects in his Vercel screenshot
  (`vercel-projects.png`, the lazy-boy card), and as the project avatar in his settings screenshot. Stays.
- **Duplicates surfaced in place.** Stays.
- **Nothing asks for anything.** Stays as Rem's taste. It doesn't separate human from generated (Vercel's dashboard
  carries an upsell card and still reads human).

Added on this pass:

- **The Usage page.** Rules between sections instead of boxes, right-aligned figures in columns, mono only for machine
  names, red only for errors, one sentence saying what the page measures (`captures/046`). It is the most Vercel-like
  page in the app and the in-house proof that structure isn't the problem.

- **The table aligned to the cards' text.** The song list's first column is indented 22px so its text lines up with
  the day cards' text, derived in one variable in `den.css`. That is an alignment decision of the kind the references
  make. (The right side was not given the same care: the table's last text ends at 1200px, the All time card at 1208.)
- **The panels' sentences.** "Combines the playlists you pick into one, kept in the order you pick them." "Pick a
  playlist and it starts from the song right after the last one you played from it." Precise, in the product's own
  nouns, Vercel's register; and the numbered picks show the click order.
- **The search expansion.** One song opened into every play with its date, time and source playlist (`captures/012`):
  dense, real, specific.

---

## 3. lazyboy, page by page: good structure and bad structure

**Home.** Good: the song table (one row anatomy per width, real art, tabular figures, hover and selection states from
Spotify), the strip as an index of days with figures in it, the table indented to the cards' text, the instant day
switch. Bad: the greeting slot (1.1), the chip row (1.2), the tray-in-card drawing (1.3); the caps headers and the
floating pill's glass and stock shadow, which break Rem's rules (§1, rule breaches); search results drawn as a
different list (§1, hand-made); and hovering a day card draws nearly the selected card's border (#5b5b63 against
#646974, `captures/019`), so two cards read as selected while the pointer rests on one. On a phone add the empty frame
(1.4) and the toasts on the pill.

**Playlists.** Good: the stats line as the page's only heading (Rem's call to drop a "Playlists" title), real covers,
the sort beside the count it orders. Bad: covers drawn twice (1.6), "20 created by you", and on a phone the
translucent header with covers under the nav labels, which is also text over artwork, against Spotify's partner rules
(SPOTIFY_BRANDING §3).

**A playlist.** Good: an index column, one row per track, durations, duplicates badged in place; the framed table is
what GitHub does. Bad: a third header shape across the app (the first audit's F25 stands: the title is 48px on Home,
15px on Playlists, 30px here), "tracks" for "songs", an owner id where Spotify shows a name. On a phone the sticky
header squares off the frame's rounded top corners, and in WebKit the long-press that opens a song's menu also selects
the word under the finger (`captures/155`; Chromium's `098` doesn't), which on an iPhone would bring up the
text-selection handles.

**Friends.** Ruled rows with a title and a sentence, which is sound structure; the content is Rem's notes (C5).

**Usage.** The model page (§2).

**Login.** A centered column is how GitHub's, Linear's and Vercel's sign-ins are built, and the recliner panda is the
best illustration in the app. Bad: the two sentences (1.5), a 36px button below the 44px floor on a phone, and after a
refused sign-in a red box with the same green button under it.

**Error.** The framework's example text with the raw error under it (1.5).

---

## 4. The first audit's findings, tested

"Kept" means the finding holds against the references; "reframed" means the observation holds but its cause or its
standing as an AI tell changed; "dropped" means a reference does the same thing and reads human.

| # | First audit | Verdict | Counterexample checked | What stands |
|---|---|---|---|---|
| §1.1 | Three bands of chrome before any music | Reframed | GitHub's issues list starts ~39% down a 900px window, under bands that are navigation or filters for that list | The strip is data; the greeting and the chips are the bands that aren't (1.1, 1.2) |
| §1.2 | Lines around everything (22 vs Spotify's 2) | Reframed | GitHub issues 62 boxes, Vercel templates 46, Rem's Vercel shots a box per section | Nesting, radius, covers drawn twice (1.3, 1.6) |
| §1.3 | One song drawn three ways | Kept, lower | Spotify, Vercel and GitHub repeat one row anatomy | Coherence; Rem's corpus reads this as hand-made |
| §1.4 | Small caps where tables start | Reframed | Stripe heads its data tables in capitals | Not a tell; stays as Rem's rule |
| §1.5 | Glass and glow on the chrome | Reframed | Linear's blurred header, Apple Music's player, Strava praised by Rem | Not a tell; his rule vs his praise (C7); the shadow is a stock value |
| §1.6 | Copy that is a draft | Reframed | Vercel's notice and empty-state copy; Rem's Heja verdict | Hand-made, not generated; the error page is stock and moves up (1.5) |
| §1.7 | Motion without a system (~20 durations vs 6) | Reframed | Spotify's own CSS carries more values than its six tokens (300, 100, 200, 500, 150 commonest across 84 sheets) | Count dropped; F12's jump and F13's panel origin stand |
| F1 | Translucent header and pill, glows | Reframed | as §1.5 | Rule breach, his call; shadow-2xl is a default |
| F2 | Phone controls under 44px | Kept | GitHub's and Vercel's phone buttons are 32–36px too | Rem's 44px rule (DRAFT_BRIEF) and iOS's; not a look issue |
| F3 | Now-playing chip is a label | Kept | Spotify's mini player is a control | Product gap |
| F4 | Account menu: name and Log out | Kept, ruled | Settled by Rem's ruling, not by a reference | Rem ruled Log out + Disconnect; logging out stops capture and says so |
| F5 | Two token files | Dropped | Vercel's lines come out as five near-identical greys (translucent white on two surfaces) | Invisible; hygiene only |
| F6 | The greeting is the attention plan | Kept, stronger | Vercel's largest words name content; Rem's Hudl verdict | 1.1 |
| F7 | Five outlined pills with icons | Reframed | Spotify and ChatGPT pills; Vercel/GitHub bordered buttons with icons | Equal weight and stock glyphs, not the shape (1.2) |
| F8 | A framed tray of framed cards | Reframed | Vercel's meters are figures in a card | Nesting, radius, the 7px offset; the tray is Rem's design (1.3, C6) |
| F9 | Three row anatomies plus a fourth | Kept | as §1.3 | Hand-made list |
| F10 | Uppercase tracked headers | Reframed | as §1.4 | Rule breach, not a tell |
| F11 | Desktop search keeps Today selected | Kept | Vercel states a control's scope beside the data (the date range next to "Last 30 Days") | Selection that describes something other than the list |
| F12 | A song's arrival moves four things, jumps a fifth | Kept, narrowed | No reference was captured mid-update; the jump is a layout shift either way | The rows below the new one jump 59px in one frame |
| F13 | Motion has no vocabulary | Reframed | as §1.7 | The desktop panel rises from mid-screen, not from its button (Rem's CoachNow verdict on a menu blooming away from its "+") |
| F14 | Notices written to the operator | Reframed | Vercel's notice says what moved and where | Hand-made; friend-facing wording |
| F15 | The faint end of the ink ramp is crowded | Dropped | Vercel docs 5 inks, GitHub 5, Stripe 9 | Within the range |
| F16 | The skeleton is a different layout | Kept, stronger | lazyboy's own Playlists skeleton matches its grid (`captures/035`) | The phone skeleton is the July layout Rem rejected |
| F17 | The phone list is a frame inside the page | Reframed | GitHub frames its phone list | The frame never shrinks to its content (1.4) |
| F18 | Menus differ by page | Kept | Not testable logged out; mechanism 1 (one component per kind of thing) | Low |
| F19 | Two toasts in two colours | Reframed | An error colour is ordinary (Vercel's red delete glyph, lazyboy's own Usage page) | The phone toasts cover the pill |
| F20 | The phone search exit is an undo arrow | Kept | Spotify's Cancel; Rem's CoachNow glyph verdict | A glyph that doesn't say what it does |
| F21 | "20 created by you" | Kept | Rem's draft ruling | His wording |
| F22 | Bordered tiles around rounded covers | Reframed | Vercel's cards have no picture; Spotify's tiles drop the line | Covers drawn twice (1.6); the placeholder note dropped |
| F23 | Art under the nav labels | Kept | Spotify's partner rule on text over art | Policy, not look |
| F24 | "tracks" vs "songs"; owner id | Kept | Mechanism 7 (one set of nouns) | Low |
| F25 | A third header species | Kept | Vercel keeps one title slot in its top bar on every page | Rem's most-repeated praise is a fixed header skeleton |
| F26 | A nav tab opens Rem's notes | Reframed | Rem's Heja verdict on hand-made inconsistency | Hand-made (C5) |
| F27 | The raw error and its digest | Kept, stronger | Next.js's own docs | The page is the docs' example verbatim (1.5) |
| F28 | Pitch and promise don't match | Kept, partly settled | Rem's ruling and `130cb13` | Privacy and terms pages exist now; the footnote still says "Nothing is shared." |
| F29 | A form-template login | Reframed | GitHub's, Linear's and Vercel's sign-ins are centered columns too | The layout stands; the copy (1.5), the 36px button and the refusal state don't |
| §3 | The register table | Dropped as evidence | STRUCTURE_MEASURED's count table | Counts sit inside the human-made range |
| §8 | The 8-question grid | Replaced | The count table above | Its fails rested mostly on the counts; §1 and §3 here replace it |

---

## 5. The greeting, revisited

The first audit's measurements hold (`audit/measured/*_greeting.json`): 84px of a 900px desktop window; 52px of a
phone's on one line and 90px when one of four lines wraps; one song row on a full day; and a friend's first visit
greeted with "Back for more?". What this pass adds is evidence about why it reads generated rather than only costing
space:

- **Its slot.** In every structured reference the largest words name the content under them (1.1). The greeting
  occupies that slot with a line unrelated to the page.
- **Its genre.** A greeting in the title slot is how the Hudl panel Rem called one-shotted opens; lazyboy's is the
  same move at display size. Spotify's one question on Rem's phone, "Слушаем дальше?" ("Keep listening?"), is about
  22px and heads the shelf it asks about.
- **Its randomness.** Every other band holds still between visits; this one changes on each load, so the top of the
  page is never learned (SYNTHESIS §1.1).

What it gives is real: it is the app's one voice, and the lines are Rem's. The references keep a voice in places that
don't compete with data: Vercel's empty states, Spotify's shelf questions, ChatGPT's one sentence over its only input.
A line of his at body size on an empty state, a first visit, or the sign-out page Rem has just ruled on, keeps the
voice without the slot.

---

## 6. Where Home's parts could live

Vercel puts each action on the object it acts on: Instant Rollback and Visit sit on the deployment card, Save sits in
each setting's own footer, Add New sits on the projects list, Open in Observability on the metric's card. GitHub puts
New issue on the issues list and Code on the file table. By that rule:

- Clean, Merge and Subtract act on playlists: the Playlists page.
- Resume acts on one playlist: on its tile or its page.
- Save queue acts on what is playing: beside now playing.
- All time is a mode of the list, so it could sit with the sort control rather than as a card competing with the days.
- Search and the day strip are how the history is read: they stay on Home.

With the greeting and the chips gone from the top, Home's first screen is the history: the strip, then the list.

---

## 7. What a friend meets

Rem's Oct 15 rulings (`docs/multi-user/RULINGS.md`) settle the flow: a friend asks by a request form (email required,
name optional), Rem adds the email in Spotify's User Management (four friends at most), then the friend connects; the
privacy policy and terms exist with a consent line on the login page (`130cb13`); Log out and Disconnect are separate,
logging out stops capture and the next page says so; a dead grant gets a short, helpful error before the sign-in page.

The fast path written this afternoon (`docs/multi-user/FASTPATH.md`) recommends a schedule with the first friend on
Tue Oct 20 or Wed Oct 21 (its estimate), so this is what a friend could see within the week. What the pixels show a
friend today, in order:

1. The login's two boilerplate sentences, one of them untrue (1.5); after a refusal, a red box above the same green
   button.
2. "Back for more?" on a first visit, five chips acting on a library still being scanned, an empty tray holding a lone
   chevron, All time reading "0 plays" and "<1m" (`format.ts` returns "<1m" for zero), then one empty frame the height
   of the screen (`captures/069`, `126`).
3. Nothing saying that history starts at sign-in, that the app records while closed, or why yesterday is missing; the
   multi-user plan's "What a friend gets" text (PLAN §12.6) has no place in the UI yet.
4. The Friends tab: Rem's notes.

The first audit's Spotify-rules table (its §7) was not re-tested here; its items are conditions of using Spotify's
data rather than look, and stand as written.

---

## 8. Rem's calls

- **C1, the greeting.** Keep, move it to a place that doesn't compete with data (an empty state, the first visit, the
  sign-out page), or cut it. The evidence is in 1.1 and §5; the lines are his.
- **C2, pills.** Rem's July rule says no pills, the shipped dock is pills, and his references disagree with each
  other: Spotify and ChatGPT use pills, Vercel, GitHub and Stripe use small-radius buttons. Neither shape reads
  generated by itself.
- **C3, a row per play on the phone, per song on desktop.** His Aug 13 ruling. It costs one anatomy per object.
- **C4, the panda's sway and the phone's pulsing ring.** Both loops carry state: the panda sways while music plays and
  breathes while idle, and the ring marks the playing cover, the way Spotify animates bars beside the playing track.
  His Heja verdict ("kind of distracting") was on a loop that carried nothing. On the reference pages measured (logged
  out, nothing playing) no animation runs forever except a loading spinner. The cost is motion in the corner of the
  eye on every page; he liked the wobble.
- **C5, the Friends copy.** Rewrite, hide the tab until it does something, or keep it.
- **C6, the day tray.** His July design. The cards can stay; the question is whether they sit in a second box, and at
  what radius (1.3).
- **C7, glass.** His lazyboy rule bans it; his Strava and Slack verdicts praised it on long-scrolling and floating
  chrome. One position, written down, either way.

---

## 9. Method and limits

- References: `references/STRUCTURE_MEASURED.md`, with raw JSON and screenshots under `references/structure/`. The
  structure probe (`probe.js`) counts box-shadow rings and `::before`/`::after` overlays as borders, which the first
  audit's census did not; the same probe ran on every reference and on lazyboy, so the comparisons are like for like.
- lazyboy: the `/design` fixture on branch `lane/2986`, dev server on 127.0.0.1:3187 with a throwaway AUTH_SECRET and
  no store; `audit_v2/measured/` holds this pass's census, structure and alignment numbers. The main states were read
  at full size twice, the second time against the first pass's notes, with long pages cropped to full resolution; the
  remaining states and the Chromium phone duplicates were read from contact sheets and zoomed where something showed;
  transition frames were sampled, not read one by one.
- Vercel's dashboard is measured from Rem's screenshots only (logged out it can't be loaded); browser zoom is unknown,
  so its absolute sizes carry about ±10% and its ratios and colours are exact.
- Linear's app needs an account; its marketing page's mock of the app stood in. Stripe's docs home and testing page
  serve light only.
- Two references are from Spotify's apps rather than captures: the music-note placeholder for a playlist without a
  cover, and the general shape of its tiles beyond Rem's two screenshots. Lane 2985 captured Apple Music one viewport
  deep, so its shelves of tiles are not in evidence here.
- Fixture artifacts are not findings: the empty library's "20 created by you", a playlist header of 64 tracks over 65
  rows, the "currently" playlist name in the From column.
- "What Rem would notice first" is a judgment, ordered by how visible each item is and how directly his own recorded
  verdicts bear on it. The scripts: `~/.claude/broke/scratch/lazyboy_design/2987/`.
