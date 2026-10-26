// The top tabs' arrow-key and click navigation as pure steps: chrome.tsx drives them and
// tests/tab-nav.test.ts holds the known answers.
//
// Two causes made ←/→ end somewhere the last key did not ask for (lane 0597, Oct 26, 2026):
//   1. The handler moved from the route the router had COMMITTED. While a navigation was still
//      loading, a second → pushed the same tab again and a ← from Home was dropped as "already at
//      the left end", while the first push carried on and landed seconds later: Playlists, under
//      someone typing in Home's search.
//   2. Next 16.2's router queue lets a superseded navigation settle after a newer one when a third
//      starts in between (runRemainingActions advances `pending` past the live navigation; fixed
//      upstream in 16.3.0, tests/next-router-queue.test.ts). Its tree is then the router's state
//      without being on screen, and the next server action or refresh renders it.
// So a press moves from the place the person last CHOSE, and every place they chose and then left
// is remembered: when the router commits one of those, the person is sent back to their choice.

/** A pathname. */
export type Place = string;

export type TabNav = {
  /** The place the person last chose: an arrow, a tab, a link to a tab's page, Back/Forward.
   *  Null until they choose one, and after a commit of a place nobody chose. */
  target: Place | null;
  /** Places chosen and then left. A navigation to one of them can still be in flight. */
  left: readonly Place[];
};

export const IDLE: TabNav = { target: null, left: [] };

/** The index of the tab `path` belongs to (the tab's own path or one under it), or -1. */
export function tabOf(tabs: readonly Place[], path: Place): number {
  return tabs.findIndex((t) => path === t || path.startsWith(t + "/"));
}

/** The person chose `to`; the place they were heading to before is now one they left. */
export function choose(s: TabNav, to: Place): TabNav {
  const left = s.left.filter((p) => p !== to);
  if (s.target !== null && s.target !== to && !left.includes(s.target)) left.push(s.target);
  return { target: to, left };
}

/** An arrow press (`dir` −1 = ←) while the router shows `at`. `go` is where to navigate, or null
 *  at either end of the row. Returning to the tab on screen returns to the page on screen (a
 *  playlist, not the grid): that navigation is what stops the one still loading. */
export function press(
  s: TabNav,
  tabs: readonly Place[],
  at: Place,
  dir: -1 | 1,
): { state: TabNav; go: Place | null } {
  const from = tabOf(tabs, s.target ?? at);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= tabs.length) return { state: s, go: null };
  const place = tabOf(tabs, at) === to ? at : tabs[to];
  return { state: choose(s, place), go: place };
}

/** The router committed `at`. `go` is the place to send the person back to, or null. A commit of a
 *  place nobody chose (a server action's redirect) ends the bookkeeping. */
export function commit(s: TabNav, at: Place): { state: TabNav; go: Place | null } {
  if (s.target === null || at === s.target) return { state: s, go: null };
  if (s.left.includes(at)) return { state: s, go: s.target };
  return { state: IDLE, go: null };
}
