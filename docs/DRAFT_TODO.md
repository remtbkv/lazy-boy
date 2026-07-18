# Draft — outstanding work

Parked items for the `/draft` redesign. Desktop is the active surface; these are not started.

## 1. Mobile pass (NOT STARTED — do this before the draft ships)

Rem, early in the redesign: *"on mobile… everything looks horrible… including the search
playlist functionality button… and the recent section… whether Brave or Safari… super
important that we fix it all."* Later deferred: *"once we confirm it looks good on desktop,
we will make it more robust on mobile."*

Everything in the draft so far has been built and verified at **desktop width only** (every
screenshot/measurement taken at 1280px). Known things to work through at phone widths:

- **Search island vs. bottom nav.** `SearchIsland` is `fixed bottom-6` and `DenBottomNav` is
  a fixed bottom tab bar — on phones they occupy the same space and will collide.
- **Day strip.** Card widths are tuned for desktop (`min-w-[143px]`, 5 full + a cut 6th); on a
  phone that ratio is meaningless.
- **Song table.** Most columns are hidden below `sm`/`md`/`lg`, with time + source folded into
  the song cell. Needs a real look, not just "it doesn't overflow".
- **Action sheets** (dock) — sized for touch already, but unverified on a real viewport.
- **The viewport lock** (`#den-root.den-locked`, `den.css`) is desktop-only by media query;
  confirm mobile keeps natural page scroll.
- Test in **Brave and Safari**, not just Chromium.

## 2. Row windowing (declined, on purpose — revisit only if it actually costs)

Rem asked to load only the first X song rows and background-load the rest. Not done: the
day's play query measures ~17ms, and the slow first paint was the *blocking* page structure
(no `loading.tsx`, no Suspense boundary), which is fixed. Windowing would also break
client-side sorting until the tail arrived. Revisit only if a day's row count ever gets big
enough to measure.

## 3. Capture playback on OTHER devices / Spotify Jams (NOT STARTED — Rem to test)

Rem, 2026-07-18: *"the app can't catch my playback if I'm on a Jam and playing it on some
other device… I'm still listening and it shows up to other people in the friends part where
they see what you're playing. It's just not playing on my device."* Not urgent; Rem will
test more before we act.

What we log now, and why this is the gap:
- **Now-playing** comes from `GET /me/player/currently-playing` (see `resources.ts` →
  `nowPlaying`). That endpoint reports the account's ACTIVE playback session. In a Jam hosted
  by someone else, or when the sound is coming out of a device you're not the active
  controller of, `/me/player` can return 204/empty for you — so we show nothing.
- **History** comes from `GET /me/player/recently-played`. This is per-account and *usually*
  backfills across your own devices, but it excludes some session types and lags; a Jam where
  you're a guest may never land in it.

Open question (Rem's instinct is right — likely a Web API limit): there is no public endpoint
for "what my friends / a Jam are playing." Spotify shows that through the friend-activity
feed, which is a private/undocumented endpoint (`spclient.wg.spotify.com/presence-view/...`,
needs a separate token) — not part of the Web API we're authorized for. So "still counts as
my listening even when it's on someone else's device" may not be reachable at all through
sanctioned APIs.

To test before building anything:
1. Start a Jam on another device, watch whether `/me/player/currently-playing` returns the
   track for OUR account or 204. Quick probe: hit `/api/now-playing` while the Jam plays.
2. Check whether those Jam tracks show up in `/me/player/recently-played` afterward (that
   alone would fix history even if live now-playing can't see it).
3. Only if both fail: evaluate the (unsanctioned, brittle) friend-activity endpoint —
   flag the ToS/stability risk to Rem before touching it.
