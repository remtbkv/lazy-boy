// The np-change beacon (NOW_PLAYING_2S.md L1, §4.1): for every song change a visible tab renders,
// an upper bound on change → render in ms, all on the browser's clock. The change happened
// p_new ms before Spotify sampled (the new song's own progress), the sample lies inside the
// request, so latency ≤ p_new + (reply received − request sent) + (render − received).
import { describe, expect, it } from "vitest";
import { npChange, npChangeMeta, npInApp, playThenShow } from "@/lib/np-change";

const T = 1_000_000;
const song = (id: string, progressMs: number, durationMs = 200_000, isPlaying = true) => ({
  track: { id },
  isPlaying,
  progressMs,
  durationMs,
});

describe("npChange", () => {
  it("a new song at p_new 400 ms with a 300 ms round trip and 30 ms to paint files 730 ms", () => {
    const c = npChange({
      shown: song("A", 60_000),
      shownAt: T - 6_000,
      next: song("B", 400),
      sentAt: T,
      receivedAt: T + 300,
      renderedAt: T + 330,
      inAppAt: null,
    });
    expect(c).toMatchObject({ value: 730, kind: "skip", pNew: 400, rtt: 300, render: 30 });
  });

  it("the same song is not a change", () => {
    const c = npChange({ shown: song("A", 1_000), shownAt: T, next: song("A", 7_000), sentAt: T, receivedAt: T + 300, renderedAt: T + 310, inAppAt: null });
    expect(c).toBeNull();
  });

  it("a song that ran out is 'natural'; one that left with time to spare is 'skip'", () => {
    // A had 2 s left 6 s ago: it ended ~4 s before the request; B's progress says it began then.
    const ran = npChange({ shown: song("A", 198_000), shownAt: T - 6_000, next: song("B", 3_900), sentAt: T, receivedAt: T + 300, renderedAt: T + 320, inAppAt: null });
    expect(ran?.kind).toBe("natural");
    const left = npChange({ shown: song("A", 100_000), shownAt: T - 6_000, next: song("B", 3_900), sentAt: T, receivedAt: T + 300, renderedAt: T + 320, inAppAt: null });
    expect(left?.kind).toBe("skip");
  });

  it("from nothing or a pause it is 'start'; right after an in-app play it is 'in-app'", () => {
    expect(npChange({ shown: null, shownAt: T - 6_000, next: song("B", 400), sentAt: T, receivedAt: T + 300, renderedAt: T + 320, inAppAt: null })?.kind).toBe("start");
    expect(npChange({ shown: song("A", 5_000, 200_000, false), shownAt: T - 6_000, next: song("B", 400), sentAt: T, receivedAt: T + 300, renderedAt: T + 320, inAppAt: null })?.kind).toBe("start");
    expect(npChange({ shown: song("A", 5_000), shownAt: T - 6_000, next: song("B", 400), sentAt: T, receivedAt: T + 300, renderedAt: T + 320, inAppAt: T - 2_000 })?.kind).toBe("in-app");
  });

  it("lag: the last answer still showing the old song came after the new one began", () => {
    // B began 2 s before this reply landed; the previous reply (the old song) landed 1 s before it.
    const c = npChange({ shown: song("A", 100_000), shownAt: T - 1_000, next: song("B", 2_000), sentAt: T, receivedAt: T + 300, renderedAt: T + 310, inAppAt: null });
    expect(c?.lagHint).toBe(700);
  });
});

// A tab that was hidden at any point between the state it showed and the frame that painted the
// change did not watch the change happen: its bound is the time away, not the app's latency, so
// the row is filed as kind=return and reported apart (code review 0156 M5).
describe("a tab coming back is not a song change's latency", () => {
  const base = { shown: song("A", 60_000), shownAt: T - 600_000, next: song("B", 590_000, 900_000), sentAt: T, receivedAt: T + 300, renderedAt: T + 330, inAppAt: null };

  it("hidden for 10 minutes since it last showed a song: kind=return", () => {
    expect(npChange({ ...base, hiddenAt: T - 590_000 })?.kind).toBe("return");
  });

  it("hidden between the receipt and the frame (requestAnimationFrame waited): kind=return", () => {
    const c = npChange({ ...base, shownAt: T - 6_000, next: song("B", 400), renderedAt: T + 120_000, hiddenAt: T + 310 });
    expect(c?.kind).toBe("return");
  });

  it("hidden and back before the state it showed: an ordinary change", () => {
    const c = npChange({ ...base, shownAt: T - 6_000, next: song("B", 400), hiddenAt: T - 60_000, visibleAt: T - 30_000 });
    expect(c?.kind).toBe("skip");
  });

  // Review 0158 finding 1: a hidden tab keeps applying states (the hidden leader's boundary poll,
  // a follower's relayed state), so the state it showed can postdate the moment it went hidden.
  it("a state applied while hidden, then a skip on the phone, then back: kind=return", () => {
    // Hidden at T−300 s; its boundary poll applies A at T−100 s; the user skips to B at T−80 s
    // and comes back at T; the return poll finds B 80 s in.
    const c = npChange({ ...base, shown: song("A", 0), shownAt: T - 100_000, next: song("B", 80_000), hiddenAt: T - 300_000, visibleAt: T });
    expect(c?.kind).toBe("return");
  });

  it("a tab opened in the background (never hidden, visible after the state it showed): kind=return", () => {
    expect(npChange({ ...base, shownAt: T - 6_000, next: song("B", 400), hiddenAt: null, visibleAt: T - 1_000 })?.kind).toBe("return");
  });

  it("in-app: a click → render that spans a hidden spell is kind=return", () => {
    expect(npInApp({ startedAt: T, shownAt: T + 600, renderedAt: T + 90_000, hiddenAt: T + 650 }).kind).toBe("return");
    expect(npInApp({ startedAt: T, shownAt: T + 600, renderedAt: T + 630, hiddenAt: T - 1 })).toMatchObject({ kind: "in-app", value: 630, rtt: 600, render: 30 });
    // The same rule as a poll's: a hidden spell that ends inside the bound counts, whenever it began.
    expect(npInApp({ startedAt: T, shownAt: T + 600, renderedAt: T + 90_000, hiddenAt: T - 5_000, visibleAt: T + 89_000 }).kind).toBe("return");
  });
});

describe("npChangeMeta", () => {
  it("names the path, kind, the terms of the bound and a per-tab sequence number", () => {
    const meta = npChangeMeta(
      { value: 730, kind: "skip", pNew: 400, rtt: 300, render: 30, lagHint: 0, tsDelta: 12 },
      "poll",
      7,
    );
    expect(meta).toBe("path=poll|kind=skip|p_new=400|rtt=300|render=30|lag=0|ts_delta=12|seq=7");
  });
});

describe("playThenShow: an in-app play flips the bar on success only", () => {
  it("success: shown once, stamped with when the action went out", async () => {
    const shown: number[] = [];
    let clock = 5_000;
    const r = await playThenShow(async () => { clock += 400; return { ok: true }; }, (at) => shown.push(at), () => clock);
    expect(r.ok).toBe(true);
    expect(shown).toEqual([5_000]);
  });

  it("failure: the bar is not touched", async () => {
    const shown: number[] = [];
    const r = await playThenShow(async () => ({ ok: false, error: "No active device" }), (at) => shown.push(at));
    expect(r).toEqual({ ok: false, error: "No active device" });
    expect(shown).toEqual([]);
  });
});
