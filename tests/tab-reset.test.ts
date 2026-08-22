// The "pressing Home clears the search" signal. The React wiring is one useEffect either
// side of this; what can actually be wrong is the routing of the event, so that is what is
// pinned.
import { describe, expect, it } from "vitest";
import { announceTabReset, subscribeTabReset } from "@/lib/tab-reset";

describe("tab reset", () => {
  it("reaches the listener for its own tab and no other", () => {
    const hits: string[] = [];
    const offHome = subscribeTabReset("home", () => hits.push("home"));
    const offPlaylists = subscribeTabReset("playlists", () => hits.push("playlists"));

    announceTabReset("home");
    expect(hits).toEqual(["home"]);

    announceTabReset("playlists");
    expect(hits).toEqual(["home", "playlists"]);

    // A tab nobody listens for is not an error — /friends has no search to clear.
    announceTabReset("friends");
    expect(hits).toEqual(["home", "playlists"]);

    offHome();
    offPlaylists();
  });

  it("stops on unsubscribe, so an unmounted page cannot be reset", () => {
    let hits = 0;
    const off = subscribeTabReset("home", () => hits++);
    announceTabReset("home");
    off();
    announceTabReset("home");
    expect(hits).toBe(1);
  });

  it("delivers to every listener of a tab", () => {
    const seen: string[] = [];
    const a = subscribeTabReset("home", () => seen.push("a"));
    const b = subscribeTabReset("home", () => seen.push("b"));
    announceTabReset("home");
    expect(seen).toEqual(["a", "b"]);
    a();
    b();
  });
});
