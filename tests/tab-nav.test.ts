// Known answers for the tab switcher's steps (src/lib/tab-nav.ts): where a run of ←/→ ends, what
// it navigates to, and what a late commit gets. Lane 0597, Oct 26, 2026: Rem's ←/→ run ended on
// Playlists after the last ← asked for Home.
import { describe, expect, it } from "vitest";
import { choose, commit, IDLE, press, tabOf, type TabNav } from "@/lib/tab-nav";

const TABS = ["/home", "/playlists", "/friends"] as const;
const L = -1 as const;
const R = 1 as const;

/** Presses on a router that commits nothing in between (every navigation still loading). */
function run(at: string, dirs: (-1 | 1)[], s: TabNav = IDLE) {
  const go: (string | null)[] = [];
  for (const d of dirs) {
    const step = press(s, TABS, at, d);
    s = step.state;
    go.push(step.go);
  }
  return { s, go };
}

describe("tab-nav", () => {
  it("maps a path to its tab, sub-pages included", () => {
    expect(tabOf(TABS, "/home")).toBe(0);
    expect(tabOf(TABS, "/playlists/abc")).toBe(1);
    expect(tabOf(TABS, "/friends")).toBe(2);
    expect(tabOf(TABS, "/usage")).toBe(-1);
    expect(tabOf(TABS, "/homes")).toBe(-1);
  });

  it("moves from the last choice, not the committed tab, while navigations load", () => {
    // The old handler, from a committed /home: → pushed /playlists, the second → pushed
    // /playlists again (idx still 0), and nothing reached /friends.
    const { s, go } = run("/home", [R, R]);
    expect(go).toEqual(["/playlists", "/friends"]);
    expect(s.target).toBe("/friends");
  });

  it("Rem's run: → then ← on Home navigates back to Home, which stops the pending Playlists", () => {
    // The old handler dropped the ← (0 − 1 < 0) and /playlists landed under the search.
    const { s, go } = run("/home", [R, L]);
    expect(go).toEqual(["/playlists", "/home"]);
    expect(s).toEqual({ target: "/home", left: ["/playlists"] });
  });

  it("the last key decides, for every run of presses from every tab", () => {
    // Brute force: all runs of 1..7 presses from each tab end where clamped steps say.
    for (const start of TABS) {
      for (let n = 1; n <= 7; n++) {
        for (let bits = 0; bits < 1 << n; bits++) {
          const dirs = Array.from({ length: n }, (_, i) => ((bits >> i) & 1 ? R : L));
          let want = TABS.indexOf(start);
          for (const d of dirs) want = Math.max(0, Math.min(2, want + d));
          const { s } = run(start, dirs);
          expect(s.target ?? start).toBe(TABS[want]);
        }
      }
    }
  });

  it("stops at the ends without navigating", () => {
    expect(press(IDLE, TABS, "/home", L)).toEqual({ state: IDLE, go: null });
    expect(press(IDLE, TABS, "/friends", R)).toEqual({ state: IDLE, go: null });
    const s = run("/home", [R, R]).s;
    expect(press(s, TABS, "/home", R).go).toBeNull();
  });

  it("returning to the tab on screen returns to its page, not the tab's root", () => {
    const { go } = run("/playlists/abc", [R, L]);
    expect(go).toEqual(["/friends", "/playlists/abc"]);
  });

  it("a late commit of a place the person left sends them back to their choice", () => {
    const s = run("/home", [R, L]).s; // chose Playlists, then Home
    expect(commit(s, "/playlists")).toEqual({ state: s, go: "/home" });
    // Arriving is not a correction.
    expect(commit(s, "/home")).toEqual({ state: s, go: null });
  });

  it("the hidden-state case: after arriving, a superseded tab surfacing later is still sent back", () => {
    // → → ← ←: Playlists and Friends pushed and left, Home chosen and on screen. Next 16.2 can
    // hold Friends as router state; a server action then renders it.
    let s = run("/home", [R, R, L, L]).s;
    expect(s.target).toBe("/home");
    s = commit(s, "/home").state;
    expect(commit(s, "/friends").go).toBe("/home");
    expect(commit(s, "/playlists").go).toBe("/home");
  });

  it("a commit nobody chose (a redirect) ends the bookkeeping", () => {
    const s = run("/home", [R]).s;
    expect(commit(s, "/usage")).toEqual({ state: IDLE, go: null });
    expect(commit(IDLE, "/playlists")).toEqual({ state: IDLE, go: null });
  });

  it("a link or Back/Forward choice joins the same bookkeeping", () => {
    let s = run("/home", [R]).s; // heading to Playlists
    s = choose(s, "/friends"); // clicked the Friends tab
    expect(s).toEqual({ target: "/friends", left: ["/playlists"] });
    expect(commit(s, "/playlists").go).toBe("/friends");
    s = choose(s, "/playlists"); // Back to Playlists: no longer a place they left
    expect(s).toEqual({ target: "/playlists", left: ["/friends"] });
  });
});
