# What every direction shares

Lane 2991, Oct 15, 2026. Three directions for lazyboy's UI overhaul, each built as a dev-only variant
on the `/design` surface so Rem can judge rendered pixels before he picks one:

- **tidy** (`tidy/SPEC.md`): today's structure, every finding of the audit fixed. The cheap one.
- **ledger** (`ledger/SPEC.md`): Home becomes the record and nothing else; each action moves to the thing
  it acts on; structure drawn the way Vercel draws it.
- **room** (`room/SPEC.md`): what's playing becomes the centrepiece; a second column (a bottom island on
  the phone) holds the player and the playlist tools; colour comes from the covers.

This file holds what the three share: Rem's rules, Spotify's rules, how a direction plugs into
`/design`, the words, the fixes, and the list of pages and states to capture. A direction's spec owns
its look and layout; this file wins on everything it states. In the repo the same files are
`docs/design/directions/COMMON.md` and `docs/design/directions/<name>.md`.

Evidence: `AUDIT_v2.md` and `CRITIQUE.md` (only what the critique lets stand), `references/` (Spotify,
ChatGPT, Apple Music, Vercel, Linear, Stripe, GitHub, measured), Rem's Vercel and Spotify screenshots, and
DiveLoop's design study (`~/projects/diveloop/mobile/design-study/`, `mobile/DESIGN_CARD.md`).

## 1. Open questions, and the defaults until Rem answers

Rem was asked on Oct 15 at 4:15 PM and has not answered yet. An answer from him overrides these.

1. **Did he write the 39 greeting lines?** Until he says, the lines in `src/content/greetings.md` are
   content: no direction rewords, drops or adds a line. A direction decides only the greeting's size,
   its slot, and how a line is chosen.
2. **Does his Aug 21 DiveLoop glass rule apply to lazyboy?** Until he says, yes: glass (translucency with
   a backdrop blur) only on a floating control, meaning the search capsule and a floating island; never
   on a page, a card, a bar fixed to an edge, or a header. His July lazyboy rule banned translucent
   chrome outright, so every direction keeps the header and every bar opaque.

## 2. Rem's rules, binding on every direction

- No translucency or blur except §1.2. No gradient used as decoration, no glow, no neon shadow, no
  green-tinted surface. A scroll-edge fade (a mask saying more rows sit below) is allowed.
- No uppercase letter-spaced labels anywhere. Title case for column headers, sentence case elsewhere.
- Figtree only (`var(--font-sans)`, already loaded). Weight and size do the work. Geist Mono
  (`var(--font-geist-mono)`, Tailwind `font-mono`) only for machine strings on the Usage page.
- Selection is neutral: grey fills, lines or inverted ink, never green. Green (`#1db954`) means
  "playing now" and nothing else.
- Hover reveals extra controls on desktop; everything is reachable by touch on the phone; every phone
  control has a 44px tap target even when it draws smaller.
- Switching days is instant: no route change, no fetch, the rows swap in one frame.
- The panda mark keeps today's behaviour (breathes while idle, sways while playing): Rem liked the
  wobble, and whether it stays is his call (audit C4).
- The phone has one top bar, no bottom tab bar (Rem, Aug 12). Bars that hide do so by scroll direction,
  as today.
- Home does not scroll as a page at any width: the list scrolls inside a stable frame, and on the phone
  the search control sits at the bottom of the screen (Rem's iMessage shape, Aug 12).
- On the phone a row is one play; on desktop a row is one song with its count (Rem, Aug 13).
- The Friends page keeps Rem's words exactly (audit C5 is his call).

## 3. Spotify's rules, binding on every direction

From Spotify's Design & Branding Guidelines and Developer Policy, quoted in
`references/SPOTIFY_BRANDING.md`.

- **Attribution.** Every page that shows Spotify data shows Spotify's full logo, white
  (`/design-brand/Full_Logo_White_RGB.svg`), at least **70px wide** (it is then 19px tall). Where a
  direction says there is no room (the phone header), the icon alone
  (`/design-brand/Primary_Logo_White_RGB.svg`), at least **21px** square. Clear space on every side: at
  least half the icon's height (10px around the full logo at 70px, 11px around a 21px icon). Never on
  artwork, never inside a sentence, never recoloured, never at reduced opacity, never stretched. The
  logo and icon may be links (to the playing track, `aria-label="Open Spotify"`).
- **Link back.** Every song reaches Spotify through its menu item **"Listen on Spotify"** (today's track
  menu says "Open in Spotify": fork the menu to change it). Every playlist page has a "Listen on Spotify"
  link to `https://open.spotify.com/playlist/<id>`. The now-playing display links to the track. Link
  words come from Spotify's list: "Listen on Spotify", "Play on Spotify", "Open Spotify".
- **Artwork.** Spotify's images only, square, **4px corner radius at every size**, on desktop and phone.
  Nothing on top of art (no glyph, ring, badge, text or play button), no blur, no crop, no scale or
  rotate animation. An opacity cross-fade when the song changes is allowed. No mat or border around a
  cover. A playlist with no cover shows today's music-note placeholder on a flat fill.
- **Metadata.** Titles and names exactly as Spotify gives them (no case change, no stripping
  "(feat. …)" or "- Remastered"). Truncate with an ellipsis only where the full text is reachable: a
  `title` attribute on the truncated element, plus the menu, the expanded row or the detail page.
- **Playing views.** Play/pause is the only playback control (no next, previous or seek). The progress
  bar is information only: no handle, no hover state, `pointer-events: none`. A background taken from
  the cover's colour is allowed; Spotify's named fallback is `#191414`.
- **Name.** "Lazy Boy" only. The panda mark stays free of Spotify green.

## 4. How a direction plugs into /design

**The branch.** `/design` is not on main (lane 2986's tests were blocked by two date tests that have
since been fixed, and nobody fast-forwarded it). Branch `design/base` holds local main at `d3ac1f7`,
lane 2986's `/design` surface, and the direction registry (commit `bff24d6`). A direction's
branch is `design/<name>`, created from `design/base`, in its own worktree. Never merge it into main.

**Where your code goes.** Only into `src/app/design/directions/<name>/` (replace its placeholder
`index.tsx`, add anything beside it) and `scripts/design-directions/<name>-capture.mjs`. Nothing else
changes: no production component, no shared `/design` file (`stage.tsx`, `config.ts`, `fixture*.ts`,
`directions/registry.ts`, `directions/index.tsx`), no other direction's folder. The three branches then
merge without conflicts.

**The entry point.** `directions/<name>/index.tsx` default-exports a server component
`(props: DirectionPageProps) => ReactNode` (types in `directions/registry.ts`) that renders the whole
page for `props.page`, chrome included. The routes that call it:

| `page` | URL | params the direction reads |
|---|---|---|
| `home` | `/design/home?direction=<name>` | `state=light\|full\|new`, `notice=capture\|ratelimit`, `np=playing\|paused\|off`, `greeting=<n>` (fixed line, for captures) |
| `home-loading` | `/design/home/loading?direction=<name>` | |
| `playlists` | `/design/playlists?direction=<name>` | `state=new` (empty library) |
| `playlists-loading` | `/design/playlists/loading?direction=<name>` | |
| `playlist`, `playlist-loading` | `/design/playlists/<id>?direction=<name>[&loading=1]` | `props.id` |
| `friends`, `friends-loading` | `/design/friends[/loading]?direction=<name>` | |
| `usage` | `/design/usage?direction=<name>` | |
| `error` | `/design/error?direction=<name>` | |
| `login` | `/design/login?direction=<name>` | `view=connect\|request\|sent\|not-registered\|refused\|signed-out\|dead-grant`, `returning=1` |

`props.config` carries the fixture clock and state (already handed to the browser's fixture network by
`stage.tsx`); `props.sp` the first value of each search param. Without `?direction=` the same URLs draw
today's app, which is the compare lane's baseline.

**The root element.** Each page renders `<div id="den-root" data-direction="<name>">` as its outermost
element. The id keeps the hooks that look for `#den-root` working (`LockViewport`, `use-search-mode.ts`,
the phone search mode in `den.css`); `den.css`'s token block also applies, so override every token you
use. Every CSS selector you write starts with `#den-root[data-direction="<name>"]`, so a browser that
visits two directions in one session never mixes them. Put the direction's tokens on that root as CSS
custom properties.

**Reuse and forks.** Import unchanged production modules freely: `lib/*`, `components/now-playing-context`,
the server actions, `fixture.ts`. To change a production component, copy it into your folder and edit
the copy (for example `home/den-home.tsx` → `directions/<name>/record.tsx`). Keep calling the real
server actions from `@/app/(app)/actions` and `@/app/(app)/history-actions`: the fixture network answers
them by their exported name, so an action declared anywhere else silently does nothing. Keep each
original's `"use client"` boundary.

**Data.** The world the baseline draws: `buildWorld`, `initialDayFor`, `PLAYLISTS`, `playlistTracks`,
`TRACKS`, `FRIENDS`, `usageData` from `src/app/design/fixture.ts`. Copy the data assembly from the
baseline page in `src/app/design/<page>/page.tsx`. Anything the fixture lacks is derived inside your
folder.

**Units.** Every size in these specs is CSS px. Write px (Tailwind arbitrary values or px custom
properties), never rem-based utilities: `den.css` sets the phone's root font size to 85%, which shrinks
every rem.

**Driving it.** `window.__design` (in `fixture-net.tsx`): `play(i, frac)`, `endIn(ms)`, `next()`,
`stop()`, `failNext(msg)`, `delay(ms)`. `next()` finishes the playing song, lands it in Today and starts
the next: that is the song-arrival transition.

**Running it.** `df -h /System/Volumes/Data` ≥12 GB free, then `npm ci` once. Cover art and Spotify's
logo files are gitignored: `cp -R ~/.claude/broke/scratch/lazyboy_design/covers/ public/design-covers/`
and `cp ~/.claude/broke/scratch/lazyboy_design/brand/*.svg public/design-brand/` (fallbacks:
`node scripts/design-covers.mjs`, `node scripts/design-brand.mjs`). Node and npm are in
`/opt/homebrew/bin`. Start the dev server with a throwaway secret and no store variables, on a free
port in 3100–3199:
`env -u TURSO_DATABASE_URL -u TURSO_AUTH_TOKEN AUTH_SECRET=$(openssl rand -hex 32) npx next dev -H 127.0.0.1 -p <port>`
(without `AUTH_SECRET`, `/login` silently renders Home). Playwright with downloaded browsers:
`/Users/remtbkv/projects/handy/node_modules/playwright`. `scripts/design-capture.mjs` is the pattern to
copy: it hides Next's dev indicator (`nextjs-portal{display:none!important}`), waits for covers, and
records frame series and video. Delete the worktree's `data/` folder if the dev server created one.

## 5. The words

Every direction uses these strings exactly, so Rem compares structure and look, not copy. Three rules
hold for any string not listed:

- No sentence hinged on " — " (the status voice the critique found in about twenty strings). Two short
  sentences instead.
- The product's nouns: songs (never "tracks"), plays, playlists, your queue.
- Dates "Oct 13" and "Oct 14, 2:29 PM"; relative times "3h ago", "19h ago", "2d ago" (no space before
  the unit); durations "9h 47m", "17m", and "0m" for nothing (never "<1m" for zero); counts with
  separators, "6,778"; no tildes.

**Kept as they are** (the audit praised them, or they are Rem's): three panel sentences from
`home/dock.tsx`, Resume's ("Pick a playlist and it starts from the song right after the last one you
played from it."), Clean's ("Strips out songs already in your library. The original stays put; a new
“Cleaned” playlist holds the rest.") and Merge's ("Combines the playlists you pick into one, kept in the
order you pick them."); "No plays recorded here."; "Showing the first 400 of 1,203 matches."; the
no-results line; the consent line from lane 2011; the Friends page; the greeting lines. Subtract's
sentence carried the dash hinge and becomes "Pick a base playlist, then the playlists to take away from
it, and see which songs only the base has." Save queue's becomes the confirm sentence below.

**Sign-in and a friend's way in** (Rem's rulings of Oct 15, `docs/multi-user/RULINGS.md`):

| view | text |
|---|---|
| `connect` | Title "Lazy Boy". Line: "Every song you play on Spotify, kept day by day, with tools for your playlists." Button "Connect Spotify". Under it, lane 2011's line: "By connecting your Spotify account you agree to the Terms and the Privacy Policy." (links `/terms`, `/privacy`). Then a link: "New here? Ask for access". Today's "We only access your library to manage playlists. Nothing is shared." is removed: it is untrue, since the app keeps every play. |
| `request` | Title "Ask for access". "Spotify lets Lazy Boy work for five accounts, and Rem adds each one by hand. Use the email address on your Spotify account." Field "Email" (required, placeholder "you@example.com"). Field "Name (optional)". Button "Send request". Link "Back". On an empty or malformed email: "Enter the email address your Spotify account uses." under the field. |
| `sent` | Title "Request sent". "Rem will add sam@example.com to Lazy Boy in Spotify. Once Rem tells you it's done, come back here and connect." Then "Connect Spotify" as a secondary button, and the consent line. |
| `not-registered` | "Spotify didn't let this account in yet. Rem adds each account by hand, so ask for access first." Primary "Ask for access"; secondary "Connect Spotify"; the consent line. |
| `refused` | "Sign-in was cancelled at Spotify. Connect again when you're ready." Primary "Connect Spotify"; the consent line. |
| `signed-out` | Title "You're signed out". "Lazy Boy stopped saving your listening when you signed out. Connect again to start saving; songs from the gap come back as far as Spotify's last 50." Primary "Connect Spotify"; the consent line. |
| `dead-grant` | Title "Spotify access ended". "Spotify stopped accepting Lazy Boy's access to your account on Oct 14 at 2:29 PM, so nothing has been saved since. Connect again to pick up from here." Primary "Connect Spotify"; the consent line. |

`sent` uses the email typed into the form when one was typed, else "sam@example.com". Forms in `/design`
submit nowhere: Send request validates, then shows `sent` client-side.

**Home**

- First visit (`state=new`), in the list's place: heading "Your history starts now", then "Lazy Boy saves
  every song you play on Spotify from here on, even with this page closed. Spotify shares only your
  last 50 songs from before today, so earlier days stay empty." Where the direction shows the playlist
  tools, while the library is still empty: "Your playlists are loading. This takes a minute or two."
  The strip shows a Today cell reading "0 plays" and "0m", and All time reading "0 plays" and "0m".
- Capture notice (`notice=capture`): "No new plays saved for 3h. Lazy Boy keeps retrying, and Spotify
  remembers your last 50 songs."
- Rate-limit notice (`notice=ratelimit`): "Spotify is limiting Lazy Boy's requests. New plays will show up
  after 11:54 AM." (the time is the fixture's cooldown end).
- Save queue confirm: "Saves the songs in your Spotify queue as a new playlist, “Saved queue · 4:32 PM”,
  then puts you back where you were." (the clock time is now). Button "Save queue". Success toast:
  "Saved 23 songs to “Queue · Oct 15”" (count and name from the action's result).
- Other toasts say what happened to which object, names in curly quotes: "Merged 148 songs into
  “merged mix”", "Resuming “late night drive”", "Added to queue". Error toasts are two sentences:
  "No active device. Start playing on Spotify first." / "Couldn't save the playlist. Log out and back
  in to allow library changes." / "Couldn't reach Lazy Boy. Try again." For a forced failure
  (`failNext(msg)`) show msg.
- Account menu: the person's name, then "Log out", then "Disconnect…". Disconnect opens a confirm, a
  centred 400px dialog in the direction's overlay style: "Disconnect Spotify? Lazy Boy stops saving your
  plays and deletes your history within five days." Buttons "Cancel" and "Disconnect" (white text on
  red) (Rem's rulings 19 and 21). In `/design`, Log out shows the `signed-out` view and Disconnect's
  confirm closes without doing anything.

**Elsewhere**

- Playlists stats line: "26 playlists · 2,174 total songs · 1,299 unique songs" (the total is the sum of
  the fixture playlists' song counts; unique as the baseline computes it), numbers in full ink, words
  in the secondary ink (Rem's draft ruling).
- A playlist: "64 songs · 4h 28m"; a playlist Spotify owns adds "Spotify · " before it. The duplicate
  badge says "Duplicate"; the count above the list "1 duplicate".
- Error page: title "This page didn't load". "Lazy Boy couldn't reach its database in time. Try again in
  a moment." Button "Try again". Then "Reference 2847193650" in the smallest size, quietest ink. No
  exception text. "Sign in again" appears only for an auth error, which the fixture's error is not.
- Usage: section headings in sentence case and sans: "Load speed", "Once it's open", "Spotify calls",
  "Recently-played daily quota", "What each read path costs the store". The intro becomes "What each
  page costs to open, measured in the browser that opened it. Then what each read path costs the store."

## 6. Fixes every direction includes

From the critique's list of fixes that are not a direction:

1. Toasts never cover the search control, a bar or an island (each spec says where they go).
2. Each loading skeleton draws its page's real layout at that width, in that direction's shapes.
3. Search results use the day list's row anatomy and left edge, and the column header stays.
4. No sticky header inside a rounded frame squares off its corners.
5. A long-press on any phone row never selects text (`user-select: none`,
   `-webkit-touch-callout: none` on rows, Home and playlist pages alike).
6. Hover and selected never look alike.
7. "total songs" in the stats line, and "songs", never "tracks".
8. The phone's song list is bounded but has no outline box.
9. "Sign in again" only for an auth error.
10. Pick lists show their pick control at rest, at 3:1 contrast or more.
11. The dates and units of §5.
12. Phone controls have 44px tap targets, the sign-in button included.
13. The phone search exit is the word "Cancel", never an undo glyph.
14. The avatar never grows or glows.
15. A desktop panel or menu opens from the control that opened it (motion and position).
16. When a song lands in Today, the rows below it never jump: they move with it, or hold still under a
    scroll adjustment when the list is scrolled.
17. Spotify's attribution and links (§3).
18. While a query stands, the strip's selection describes what the results cover (the audit's F11). On
    desktop, typing selects All time (results cover everything, as today); clicking a day narrows the
    results to that day; clearing the query restores the day selected before. The phone keeps today's
    rule, where the selected day scopes the results (Rem's Aug 13 amendment).

## 7. Pages and states to capture

Desktop is 1440×900 in Chromium. Phone is 390×844 in WebKit with an iPhone user agent, touch on, device
scale 2. Every screenshot is the viewport (not the full page) unless marked "full page". Files go to
`/Users/remtbkv/lazyboy-review/2026-10-15_design-audit/directions/<name>/captures/` named
`<id>_<page>_<state>_<desktop|phone>.png`, plus `CAPTURES.md` indexing every file. The ids below are
fixed so the compare lane can line the directions up.

| id | page and state | how |
|---|---|---|
| H01 | Home, today light (3 plays) | `/design/home?direction=<name>&greeting=0` |
| H02 | Home, full day (150 plays) | `&state=full` |
| H03 | Home, a friend's first visit | `&state=new` |
| H04 | Home, All time | select All time |
| H05 | Home, search songs "the" | type in the search control |
| H06 | Home, a search result expanded | open the first result |
| H07 | Home, search artists "fr" | |
| H08 | Home, search with no results "zzz" | |
| H09 | Home, capture notice | `&notice=capture` |
| H10 | Home, rate-limit notice | `&notice=ratelimit` |
| H11 | Home, paused | `&np=paused` |
| H12 | Home, nothing playing | `&np=off` |
| H13 | Home, row hover (desktop only) | |
| H14 | Home, day cell hover (desktop only) | |
| H15 | Home, song menu | right-click / long-press a row |
| H16 | Home, account menu | |
| H17 | Merge picker, three playlists picked | wherever the direction puts Merge |
| H18 | Resume picker | wherever the direction puts Resume |
| H19 | Save queue confirm | |
| H20 | Toast, success | after Save queue |
| H21 | Toast, error | `__design.failNext("Couldn't save the playlist. Log out and back in to allow library changes.")`, then an action |
| H22 | Home loading | `/design/home/loading?direction=<name>` |
| P01 | Playlists grid | `/design/playlists?direction=<name>`, full page too |
| P02 | Playlists, tile hover or tile menu | |
| P03 | Playlists, sort menu | |
| P04 | Playlists, search "s" | |
| P05 | Playlists, empty library | `&state=new` |
| P06 | Playlists loading | |
| L01 | A playlist you own | `/design/playlists/<PLAYLISTS[0].id>?direction=<name>` |
| L02 | A playlist Spotify owns | the first fixture playlist with `ownerId === "spotify"` |
| L03 | A playlist, row hover (desktop only) | |
| L04 | A playlist, song menu | |
| L05 | A playlist loading | `&loading=1` |
| L06 | Clean confirm | wherever the direction puts Clean |
| F01 | Friends | |
| F02 | Friends loading | |
| U01 | Usage, full page | |
| E01 | Error page | |
| A01–A07 | Sign-in views | `/design/login?direction=<name>&view=` connect, request, sent, not-registered, refused, signed-out, dead-grant |
| A08 | Request form with the email error | submit it empty |
| A09 | Sign-in for a returning visitor | `&returning=1` (only directions that use it) |

Transitions, recorded as Playwright video (`.webm`) and as a frame series (one frame every 50–80ms,
laid out on a strip PNG with timestamps), at both widths, into `directions/<name>/motion/`:

| id | transition |
|---|---|
| T01 | A song finishes and lands in Today (`__design.next()` while Today is selected) |
| T02 | Switching days (Today → Yesterday) |
| T03 | Switching to All time |
| T04 | Search: open, type "the", clear, close (on the phone: enter and leave the search mode) |
| T05 | The Merge panel or sheet opening and closing |
| T06 | The song menu opening |
| T07 | The account menu opening |
| T08 | Playback starting from nothing playing (`__design.stop()`, then `__design.play(3, 0.1)`) |
| T09 | Phone only: Playlists scrolled down 500px and back up 150px (what hides and returns) |
| T10 | The direction's own transition, if its spec names one |

## 8. The check before calling a page done

From DiveLoop's design card (§9), adapted. Run it on every page and write the answers into the
direction's `NOTES.md`:

1. **Card check.** Any value not in the spec's tokens (a size, colour, radius, spacing step, duration)?
   Record it in `NOTES.md` with the job it does, or remove it. The spec files themselves stay as written.
2. **Attention plan.** Name the one thing the eye lands on first, and check size and ink rank it first.
3. **Signal audit.** For each use of colour, weight and motion, one sentence on its job. A job that
   repeats on every sibling is decoration; cut it.
4. **Invariants.** Content starts on the spec's line; titles sit at the reserved geometry; selection is
   neutral; the way back is always there.
5. **Semantics.** No child out-inks its parent; one big number per cell or card.
6. **Agency.** Nothing asks the person for anything.
7. **Time.** Every wait shows its skeleton or progress at once; a known-empty state renders at once.
8. **Author test.** Put the page beside two others of the same direction: one author?

## 9. What each builder hands the compare lane

In `directions/<name>/`: `captures/` with `CAPTURES.md`, `motion/`, `NOTES.md` (the §8 answers, every
place the build departed from the spec and why, and anything that did not work), and `PORT.md`: which
production files a port into the real app would change, which fork replaces which component, the new
tokens, the risks, and an estimate in lanes.
