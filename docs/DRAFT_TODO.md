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
