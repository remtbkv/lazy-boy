// The provider's fresh flag (code review 0156 H2; review 0158 finding 5): every poll that follows
// an in-app play, a pause, a Save Queue hold's release or an empty-answer hold asks
// /api/now-playing?fresh=1, past the server's memo, and a plain poll does not. The route's side is
// tests/isolation/now-playing-memo.test.ts; this is the browser's. The REAL NowPlayingProvider runs
// under react-dom against stubbed browser globals (no DOM library: it renders no element), with a
// fetch stub that records each URL. No Web Locks, so the tab polls on its own (the fallback path).
// Below it, the provider's wiring of review 0158's findings 1 and 2 (review 0161 L3): the np-change
// beacons get when the tab came back into view, and Home's fold gets when the state on the bar
// was sampled (playingAt).
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UID = "aaaaaaaaaaaa";
const actions = vi.hoisted(() => ({ setPlaying: vi.fn(async (_playing: boolean) => ({ ok: true })) }));
// What the provider files to client_metrics, in order.
const recorded = vi.hoisted(() => ({ events: [] as { event: string; meta?: string }[] }));
vi.mock("@/app/(app)/actions", () => ({ playerSetPlayingAction: actions.setPlaying }));
vi.mock("@/lib/metrics-client", () => ({
  recordAppEvent: (event: string, meta?: string) => void recorded.events.push({ event, meta }),
}));
vi.mock("@/components/user-context", () => ({ useUid: () => UID }));

const { NowPlayingProvider, useNowPlaying } = await import("@/components/now-playing-context");
const { STEADY_MS } = await import("@/lib/now-playing-poll");
const STEADY = STEADY_MS + 500;
type Ctx = ReturnType<typeof useNowPlaying>;

const song = (id: string, progressMs = 30_000) => ({
  track: { id, title: id, artist: "x", albumImage: null },
  isPlaying: true,
  progressMs,
  durationMs: 600_000,
  context: null,
});
type Reply = ReturnType<typeof song> | null | "503" | "throw";

let urls: string[] = [];
let replies: Reply[] = [];
let fallback: Reply = song("A");
let ctx: Ctx;
let root: Root;
// The stub document dispatches its events (a test flips visibilityState and fires visibilitychange).
let doc: { visibilityState: string; dispatchEvent: (e: Event) => boolean };
let container: Element;

function Probe() {
  const v = useNowPlaying();
  useEffect(() => {
    ctx = v;
  });
  return null;
}

const listeners = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
const storage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
};

/** Let `ms` pass, running the timers and the promises and renders they start. */
const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
/** The URLs asked from now on. */
const asked = () => urls.splice(0);
/** The tab goes hidden or comes back. */
const show = (visible: boolean) =>
  act(() => {
    doc.visibilityState = visible ? "visible" : "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
  });
const mount = () => {
  root = createRoot(container);
  return act(async () => root.render(createElement(NowPlayingProvider, null, createElement(Probe))));
};

beforeEach(async () => {
  vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  urls = [];
  replies = [];
  fallback = song("A");
  actions.setPlaying.mockClear();
  actions.setPlaying.mockImplementation(async () => ({ ok: true }));
  recorded.events = [];
  const events = new EventTarget();
  doc = {
    visibilityState: "visible",
    activeElement: null,
    body: null,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  } as typeof doc;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { ...listeners(), HTMLIFrameElement: class {}, document: doc });
  vi.stubGlobal("navigator", {}); // no Web Locks: this tab polls on its own
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  vi.stubGlobal("location", { reload: () => {} });
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16));
  vi.stubGlobal("fetch", async (input: string) => {
    if (input.startsWith("/api/build")) return Response.json({});
    urls.push(input);
    const r = replies.length ? replies.shift()! : fallback;
    if (r === "throw") throw new TypeError("network");
    if (r === "503") return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json({ playing: r, u: UID });
  });
  container = { nodeType: 1, tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument: doc, textContent: "", ...listeners() } as unknown as Element;
  await mount();
  await pass(0);
  expect(asked()).toEqual(["/api/now-playing"]); // the mount's poll is a plain one
  expect(ctx.playing?.track.id).toBe("A");
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the provider's fresh flag", () => {
  it("a steady poll is plain", async () => {
    await pass(STEADY);
    expect(asked()).toEqual(["/api/now-playing"]);
  });

  it("an in-app play: the poll it suppresses keeps the flag, the first one after asks fresh, the next is plain", async () => {
    fallback = song("B", 1_000);
    act(() => ctx.playOptimistic({ id: "B", title: "B", artist: "x", albumImage: null }, 600_000, Date.now()));
    act(() => ctx.refresh()); // kicked inside the 2 s window: skipped, not sent
    await pass(0);
    expect(asked()).toEqual([]);
    await pass(2_100);
    expect(asked()).toEqual(["/api/now-playing?fresh=1"]);
    expect(ctx.playing?.track.id).toBe("B");
    await pass(STEADY);
    expect(asked()).toEqual(["/api/now-playing"]);
  });

  it("a pause: the poll after it asks fresh", async () => {
    fallback = { ...song("A"), isPlaying: false };
    await act(async () => void (await ctx.toggle()));
    expect(actions.setPlaying).toHaveBeenCalledWith(false);
    await pass(STEADY); // no kick on success: the next scheduled poll
    expect(asked()).toEqual(["/api/now-playing?fresh=1"]);
  });

  it("a failed pause drops the flip and asks fresh at once", async () => {
    actions.setPlaying.mockImplementation(async () => ({ ok: false }));
    await act(async () => void (await ctx.toggle()));
    await pass(0);
    expect(asked()).toEqual(["/api/now-playing?fresh=1"]);
    expect(ctx.playing?.isPlaying).toBe(true);
  });

  it("a Save Queue hold: no poll during the walk, a fresh one at its release", async () => {
    let finish!: () => void;
    const walk = new Promise<void>((r) => (finish = r));
    let held!: Promise<void>;
    act(() => void (held = ctx.holdDuring(() => walk)));
    await pass(20_000);
    expect(asked()).toEqual([]);
    await act(async () => {
      finish();
      await held;
    });
    await pass(0);
    expect(asked()).toEqual(["/api/now-playing?fresh=1"]);
  });

  it("an empty answer is held and re-asked fresh", async () => {
    replies = [null];
    await pass(STEADY);
    expect(asked()).toEqual(["/api/now-playing"]); // the empty answer, held
    expect(ctx.playing?.track.id).toBe("A");
    await pass(2_000);
    expect(asked()).toEqual(["/api/now-playing?fresh=1"]);
  });

  it("a fresh poll that fails (non-OK, then thrown) is retried fresh", async () => {
    replies = ["503", "throw"];
    act(() => ctx.playOptimistic({ id: "B", title: "B", artist: "x", albumImage: null }, 600_000));
    await pass(STEADY);
    expect(asked()).toEqual(["/api/now-playing?fresh=1"]); // 503
    await pass(60_000); // the backoff ladder: 12 s, then 24 s
    const retries = asked();
    expect(retries.length).toBeGreaterThanOrEqual(2);
    expect(retries.slice(0, 2)).toEqual(["/api/now-playing?fresh=1", "/api/now-playing?fresh=1"]); // thrown, then answered
    expect(retries.slice(2).every((u) => u === "/api/now-playing")).toBe(true);
  });
});

// Review 0158 finding 1: a hidden spell that began before the bound's start and ended inside it
// files kind=return only if the beacon hears when the tab came back (np-change.ts `away`, its
// own cases in tests/np-change.test.ts). These pin that the provider passes it.
describe("the np-change beacons get visibleAt", () => {
  /** The np-change metas filed from now on. */
  const beacons = () =>
    recorded.events
      .splice(0)
      .filter((e) => e.event === "np-change")
      .map((e) => e.meta);

  it("a poll's change seen first on the return is kind=return, though the bar's state is newer than the hide", async () => {
    await pass(20);
    beacons(); // the mount's own (kind=start)
    await show(false);
    await pass(1_000);
    act(() => ctx.refresh()); // a poll while hidden: A again, applied after the hide
    await pass(0);
    expect(asked()).toEqual(["/api/now-playing"]);
    await pass(60_000);
    fallback = song("B", 5_000);
    await show(true); // the return wakes the loop: its poll finds B
    await pass(100);
    expect(asked()).toEqual(["/api/now-playing"]);
    expect(ctx.playing?.track.id).toBe("B");
    expect(beacons()).toEqual([expect.stringMatching(/^path=poll\|kind=return\|/)]);
  });

  it("an in-app play whose bound holds the end of a hidden spell is kind=return", async () => {
    await pass(20);
    beacons();
    await show(false);
    await pass(1_000);
    const startedAt = Date.now(); // after the hide: hiddenAt alone does not make it a return
    await pass(5_000);
    await show(true);
    await pass(100);
    asked(); // the return's poll: A still, no change
    act(() => ctx.playOptimistic({ id: "B", title: "B", artist: "x", albumImage: null }, 600_000, startedAt));
    await pass(20); // the frame
    expect(beacons()).toEqual([expect.stringMatching(/^path=in-app\|kind=return\|/)]);
  });
});

// Review 0158 finding 2: Home's fold bounds a song's start by when the state on the bar was
// sampled, not when Home received it (foldHandoff's `sampledAt`, its probe in
// tests/handoff-fold.test.ts). The provider's half: playingAt() is the cache's or the relay's
// `at`. Home's half: den-home hands it to the fold. No DOM library here renders DenHome, so that
// half is read from the source with the TypeScript compiler API (as browser-forgets.test.ts does).
describe("Home's fold gets playingAt()", () => {
  it("playingAt() is when a painted state was sampled: the shared cache's `at`, then a relay's", async () => {
    await act(async () => root.unmount());
    const channels: { onmessage: ((e: { data: unknown }) => void) | null }[] = [];
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage = null;
        constructor() {
          channels.push(this);
        }
        postMessage() {}
        close() {}
      },
    );
    vi.stubGlobal("navigator", { locks: { request: () => new Promise(() => {}) } }); // never granted: a follower, no poll
    const cachedAt = Date.now() - 20_000;
    localStorage.setItem(`lb-nowplaying@${UID}`, JSON.stringify({ playing: song("C"), at: cachedAt }));
    await mount();
    await pass(0);
    expect(ctx.playing?.track.id).toBe("C");
    expect(ctx.playingAt()).toBe(cachedAt);
    await pass(5_000);
    const relayedAt = Date.now() - 3_000;
    act(() => channels[0].onmessage!({ data: { type: "state", playing: song("D"), at: relayedAt } }));
    expect(ctx.playing?.track.id).toBe("D");
    expect(ctx.playingAt()).toBe(relayedAt);
    expect(asked()).toEqual([]);
  });

  it("den-home.tsx passes playingAt() from useNowPlaying() as foldHandoff's sampledAt", () => {
    const rel = "src/app/(app)/home/den-home.tsx";
    const text = readFileSync(path.resolve(__dirname, "..", rel), "utf8");
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const folds: string[][] = [];
    const fromContext: string[][] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.getText(sf) === "foldHandoff") folds.push(n.arguments.map((a) => a.getText(sf)));
      if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer?.getText(sf) === "useNowPlaying()") {
        fromContext.push(n.name.elements.map((e) => e.name.getText(sf)));
      }
      n.forEachChild(visit);
    };
    visit(sf);
    expect(folds).toEqual([["lastPlayingRef.current", "playing", "Date.now()", "lastChangeAtRef.current", "playingAt()"]]);
    expect(fromContext.some((names) => names.includes("playingAt"))).toBe(true);
  });
});
