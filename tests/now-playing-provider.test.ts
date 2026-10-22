// The provider's fresh flag (code review 0156 H2; review 0158 finding 5): every poll that follows
// an in-app play, a pause, a Save Queue hold's release or an empty-answer hold asks
// /api/now-playing?fresh=1, past the server's memo, and a plain poll does not. The route's side is
// tests/isolation/now-playing-memo.test.ts; this is the browser's. The REAL NowPlayingProvider runs
// under react-dom against stubbed browser globals (no DOM library: it renders no element), with a
// fetch stub that records each URL. No Web Locks, so the tab polls on its own (the fallback path).
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UID = "aaaaaaaaaaaa";
const actions = vi.hoisted(() => ({ setPlaying: vi.fn(async (_playing: boolean) => ({ ok: true })) }));
vi.mock("@/app/(app)/actions", () => ({ playerSetPlayingAction: actions.setPlaying }));
vi.mock("@/lib/metrics-client", () => ({ recordAppEvent: () => {} }));
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

beforeEach(async () => {
  vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  urls = [];
  replies = [];
  fallback = song("A");
  actions.setPlaying.mockClear();
  actions.setPlaying.mockImplementation(async () => ({ ok: true }));
  const doc = { visibilityState: "visible", activeElement: null, body: null, ...listeners() };
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
  const container = { nodeType: 1, tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument: doc, textContent: "", ...listeners() };
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(NowPlayingProvider, null, createElement(Probe))));
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
