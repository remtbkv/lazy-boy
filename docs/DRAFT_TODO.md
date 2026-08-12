# Draft — outstanding work

Parked items for the `/draft` redesign. Desktop is the active surface; these are not started.

## 1. Mobile pass (DONE 2026-08-12 — landed differently than sketched)

Shipped as its own round, per Rem's phone feedback rather than this list: the bottom tab
bar was **removed** (one top bar, panda = Home, avatar in the corner) instead of
reconciled with the island; the whole skin runs at 75% root scale on phones (den.css);
the day strip became fixed portrait cards with All-time inline and a grabbable scrubber;
the dock is one row of five; the header and island hide on scroll-down / return on
scroll-up. Verified at 390×844 in Playwright (overflow 0 on every page).

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
