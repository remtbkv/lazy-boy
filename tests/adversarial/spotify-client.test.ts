// ADVERSARIAL — src/lib/spotify/client.ts, driven entirely by a scripted global fetch.
// ZERO network. Expectations from the file's own comments: the retry budgets (lines 8-30),
// the shared cooldown (43-47), Retry-After parsing (129-139), the hard-ban rule (168-185),
// the 403 rule (17-20, 194-199), the POST/player-mutation rule (114-125), the body rules
// (204-223) and the pagination guard (238-264).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  logSpotifyRequest: vi.fn(async () => {}),
  setSpotifyCooldownUntil: vi.fn(async () => {}),
  getApiLogSummary: vi.fn(async () => ({ windows: [] as { seconds: number; calls: number }[] })),
}));
vi.mock("@/lib/db", () => db);

import { HttpClient, SpotifyError } from "@/lib/spotify/client";

type Step = () => Response | Promise<Response>;

const fetchCalls: { url: string; method: string }[] = [];

function script(...steps: Step[]) {
  let i = 0;
  const fn = vi.fn(async (url: unknown, init: unknown) => {
    const opts = (init ?? {}) as { method?: string };
    fetchCalls.push({ url: String(url), method: opts.method ?? "GET" });
    const step = steps[i++];
    if (!step) return new Response("unscripted call", { status: 599 });
    return step();
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

const ok = (body: unknown): Step => () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const rl =
  (retryAfter: string | null): Step =>
  () =>
    new Response("rate limited", {
      status: 429,
      headers: retryAfter === null ? {} : { "Retry-After": retryAfter },
    });
const status =
  (code: number, body = ""): Step =>
  () =>
    new Response(body || null, { status: code });
const boom = (): Step => () => Promise.reject(new TypeError("fetch failed"));
const times = (n: number, s: Step): Step[] => Array.from({ length: n }, () => s);

// Each test starts hours ahead of the last so the module-scoped `cooldownUntil` (and any
// persisted cap, max 30 min) from a previous test cannot leak into it.
let clock = Date.UTC(2026, 7, 20, 0, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  clock += 6 * 60 * 60 * 1000;
  vi.setSystemTime(clock);
  fetchCalls.length = 0;
  db.logSpotifyRequest.mockClear();
  db.setSpotifyCooldownUntil.mockClear();
  db.getApiLogSummary.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Settle-tracking wrapper so "still in flight" is assertable. */
function track<T>(p: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
  const done = p.then(
    (v) => {
      state.settled = true;
      state.value = v;
    },
    (e) => {
      state.settled = true;
      state.error = e;
    },
  );
  return { state, done };
}

// ------------------------------------------------------------ Retry-After parsing

describe("429 Retry-After parsing", () => {
  it('"0" is a real immediate-retry answer: retried after the 250ms floor, logged as 0', async () => {
    // "`Number(x) || null` read 'Retry-After: 0' as null; 0 is a real (immediate-retry)
    //  answer and now passes through." (client.ts:130-133)
    script(rl("0"), ok({ v: 1 }));
    const c = new HttpClient("tok");
    const p = c.get<{ v: number }>("/x");
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchCalls).toHaveLength(2);
    expect(await p).toEqual({ v: 1 });
    expect(db.logSpotifyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, retryAfter: 0 }),
    );
  });

  it('"  " (whitespace) reads as NO answer, not as 0', async () => {
    // "Empty/whitespace headers must read as 'no answer' too — Number('') is 0, which the
    //  429 branch would treat as 'retry immediately'" (client.ts:134-135)
    script(rl("  "), ok({ v: 2 }));
    const c = new HttpClient("tok");
    const p = c.get<{ v: number }>("/x");
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchCalls).toHaveLength(1); // the 1s default, not an immediate retry
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchCalls).toHaveLength(2);
    expect(await p).toEqual({ v: 2 });
    expect(db.logSpotifyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, retryAfter: null }),
    );
  });

  it('an HTTP-date Retry-After parses to "no answer" and uses the 1s default', async () => {
    // "HTTP-date forms still parse to NaN -> null ('no answer' -> 1s default)" (client.ts:131-133)
    script(rl("Wed, 21 Oct 2015 07:28:00 GMT"), ok({ v: 3 }));
    const c = new HttpClient("tok");
    const p = c.get<{ v: number }>("/x");
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toEqual({ v: 3 });
    expect(db.logSpotifyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, retryAfter: null }),
    );
    expect(db.setSpotifyCooldownUntil).not.toHaveBeenCalled();
  });

  it("a missing Retry-After header uses the 1s default", async () => {
    script(rl(null), ok({ v: 4 }));
    const c = new HttpClient("tok");
    const p = c.get<{ v: number }>("/x");
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toEqual({ v: 4 });
  });

  it("a NEGATIVE Retry-After still imposes the backoff floor", async () => {
    // A 429 always "sets this window" so that "every request ... should back off"
    // (client.ts:43-47); the `+ 0.25` in the retry sleep (client.ts:188) is the floor that
    // stops a tight loop. `Math.min(rawRetryAfter, cap)` passes a negative straight through,
    // so a junk header removes both the sleep and the shared window.
    script(rl("-5"), ok({ v: 5 }));
    const c = new HttpClient("tok");
    const p = c.get<{ v: number }>("/x");
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
  });
});

// ------------------------------------------------------------ hard-ban boundary

describe("the hard-ban boundary (HARD_BAN_S = 120)", () => {
  it("Retry-After 121 stops immediately and persists the cooldown", async () => {
    // "If Spotify is asking us to wait far longer than we'd ever usefully retry ... stop now"
    // + "AWAITED: this write is the entire cross-invocation mechanism" (client.ts:168-185)
    script(rl("121"), ok({ never: true }));
    const c = new HttpClient("tok");
    const err = await c.get("/x").catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyError);
    expect((err as SpotifyError).status).toBe(429);
    expect(fetchCalls).toHaveLength(1); // no retry at all
    expect(db.setSpotifyCooldownUntil).toHaveBeenCalledTimes(1);
    expect(db.setSpotifyCooldownUntil).toHaveBeenCalledWith(clock + 121_000);
  });

  it("Retry-After 120 is NOT a hard ban: no persisted cooldown, and it retries", async () => {
    script(rl("120"), ok({ v: 1 }));
    const c = new HttpClient("tok");
    const t = track(c.get("/x"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.state.settled).toBe(false); // still sleeping out the per-wait cap
    expect(db.setSpotifyCooldownUntil).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await t.done;
    expect(t.state.error).toBeInstanceOf(SpotifyError);
    expect(String((t.state.error as Error).message)).toMatch(/try again shortly/);
    expect(fetchCalls).toHaveLength(1);
  });

  it("the persisted cooldown is capped at 30 minutes", async () => {
    // PERSIST_COOLDOWN_CAP_MS (client.ts:24-27)
    script(rl("86400"));
    const c = new HttpClient("tok");
    await c.get("/x").catch(() => {});
    expect(db.setSpotifyCooldownUntil).toHaveBeenCalledWith(clock + 30 * 60 * 1000);
  });
});

// ------------------------------------------------------------ shared cooldown

describe("the cooldown is shared across ALL Spotify requests", () => {
  it("a ban raised by one client instance blocks a second instance in the same module", async () => {
    // "Shared cooldown across ALL Spotify requests (module-scoped)." (client.ts:43-47)
    script(rl("121"), ok({ never: true }), ok({ never: true }));
    const a = new HttpClient("tok-a", false, "srcA");
    await a.get("/x").catch(() => {});
    expect(fetchCalls).toHaveLength(1);

    const b = new HttpClient("tok-b", false, "srcB");
    const err = await b.get("/y").catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyError);
    expect((err as SpotifyError).status).toBe(429);
    expect(String((err as Error).message)).toMatch(/try again shortly/);
    expect(fetchCalls).toHaveLength(1); // B never reached the network
  });

  it("a patient client bails on a cooldown longer than 2 minutes instead of poking through", async () => {
    // "the old patient behavior slept its 30s cap and then SENT ANYWAY — one poke per 30s
    //  for the whole ban" (client.ts:80-85); PATIENT_MAX_COOLDOWN_WAIT_MS (client.ts:28-30)
    script(rl("121"), ok({ never: true }));
    await new HttpClient("tok-a").get("/x").catch(() => {});
    expect(fetchCalls).toHaveLength(1);

    const patient = new HttpClient("tok-b", true);
    const err = await patient.get("/y").catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyError);
    expect(String((err as Error).message)).toMatch(/long cooldown/);
    expect(fetchCalls).toHaveLength(1);
  });

  it("a patient client sleeps out a SHORT cooldown in slices and then sends", async () => {
    script(rl("10"), ok({ v: 1 }));
    const c = new HttpClient("tok", true);
    const t = track(c.get<{ v: number }>("/x"));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(fetchCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await t.done;
    expect(t.state.value).toEqual({ v: 1 });
    expect(fetchCalls).toHaveLength(2);
  });
});

// ------------------------------------------------------------ retry budgets

describe("retry budgets", () => {
  it("an interactive caller gives up after RATE_LIMIT_RETRIES.fast = 3 retries", async () => {
    script(...times(4, rl("1")), ok({ never: true }));
    const c = new HttpClient("tok");
    const t = track(c.get("/x"));
    await vi.advanceTimersByTimeAsync(30_000);
    await t.done;
    expect(t.state.error).toBeInstanceOf(SpotifyError);
    expect((t.state.error as SpotifyError).status).toBe(429);
    expect(fetchCalls).toHaveLength(4); // the original + 3 retries, and no 5th
  });

  it("403 is retried exactly once, then surfaces", async () => {
    // "retry only ONCE — enough to ride out a transient blip, but a real 'forbidden' fails
    //  fast" (client.ts:17-20)
    script(status(403, "forbidden"), status(403, "forbidden"), ok({ never: true }));
    const c = new HttpClient("tok");
    const t = track(c.get("/x"));
    await vi.advanceTimersByTimeAsync(5_000);
    await t.done;
    expect((t.state.error as SpotifyError).status).toBe(403);
    expect(fetchCalls).toHaveLength(2);
  });

  it("a transient 403 recovers on the single retry", async () => {
    script(status(403, "forbidden"), ok({ v: 1 }));
    const c = new HttpClient("tok");
    const t = track(c.get<{ v: number }>("/x"));
    await vi.advanceTimersByTimeAsync(1_000);
    await t.done;
    expect(t.state.value).toEqual({ v: 1 });
    expect(fetchCalls).toHaveLength(2);
  });

  it("403 and 429 budgets are independent within one call", async () => {
    script(status(403), rl("1"), status(403), ok({ v: 1 }));
    const c = new HttpClient("tok");
    const t = track(c.get("/x"));
    await vi.advanceTimersByTimeAsync(10_000);
    await t.done;
    // The second 403 has no retry left, so the call ends there.
    expect((t.state.error as SpotifyError).status).toBe(403);
    expect(fetchCalls).toHaveLength(3);
  });

  it("a 5xx is not retried at all", async () => {
    script(status(500, "boom"), ok({ never: true }));
    const c = new HttpClient("tok");
    const err = await c.get("/x").catch((e) => e);
    expect((err as SpotifyError).status).toBe(500);
    expect(fetchCalls).toHaveLength(1);
  });
});

// ------------------------------------------------------------ network errors

describe("network errors and non-idempotent methods", () => {
  it("a GET is retried MAX_RETRIES times then surfaces the network error", async () => {
    script(...times(4, boom()));
    const c = new HttpClient("tok");
    const t = track(c.get("/x"));
    await vi.advanceTimersByTimeAsync(10_000);
    await t.done;
    expect(t.state.error).toBeInstanceOf(TypeError);
    expect(fetchCalls).toHaveLength(4);
  });

  it("a GET recovers on a retry", async () => {
    script(boom(), boom(), ok({ v: 1 }));
    const c = new HttpClient("tok");
    const t = track(c.get<{ v: number }>("/x"));
    await vi.advanceTimersByTimeAsync(10_000);
    await t.done;
    expect(t.state.value).toEqual({ v: 1 });
    expect(fetchCalls).toHaveLength(3);
  });

  it("a POST is NEVER retried on a network error", async () => {
    // "Never blind-retry a POST: a timeout doesn't mean Spotify didn't apply it" (client.ts:114-119)
    script(boom(), ok({ never: true }));
    const c = new HttpClient("tok");
    const t = track(c.post("/playlists/p/tracks", { uris: ["a"] }));
    await vi.advanceTimersByTimeAsync(10_000);
    await t.done;
    expect(t.state.error).toBeInstanceOf(TypeError);
    expect(fetchCalls).toHaveLength(1);
  });

  it("a player PUT is NEVER retried on a network error", async () => {
    // "Player PUTs aren't idempotent either: a re-sent /me/player/play restarts the track
    //  from 0, a re-sent seek yanks the head back (audit 2026-08-19, T2.11)" (client.ts:117-119)
    for (const path of ["/me/player/play", "/me/player/seek?position_ms=1000", "/me/player"]) {
      fetchCalls.length = 0;
      script(boom(), ok({ never: true }));
      const t = track(new HttpClient("tok").put(path, {}));
      await vi.advanceTimersByTimeAsync(10_000);
      await t.done;
      expect(t.state.error, path).toBeInstanceOf(TypeError);
      expect(fetchCalls, path).toHaveLength(1);
    }
  });

  it("a player DELETE is NEVER retried on a network error", async () => {
    script(boom(), ok({ never: true }));
    const t = track(new HttpClient("tok").delete("/me/player/queue"));
    await vi.advanceTimersByTimeAsync(10_000);
    await t.done;
    expect(fetchCalls).toHaveLength(1);
  });

  it("a playlist PUT/DELETE IS retried on a network error", async () => {
    // "Everything else (GET, playlist PUT/DELETE) is safe to re-send." (client.ts:119)
    script(boom(), ok({ v: 1 }));
    const t = track(new HttpClient("tok").put<{ v: number }>("/playlists/p/tracks", { uris: [] }));
    await vi.advanceTimersByTimeAsync(10_000);
    await t.done;
    expect(t.state.value).toEqual({ v: 1 });
    expect(fetchCalls).toHaveLength(2);
  });
});

// ------------------------------------------------------------ response bodies

describe("response bodies", () => {
  it("204 resolves to undefined", async () => {
    script(status(204));
    expect(await new HttpClient("tok").put("/me/player/pause")).toBeUndefined();
  });

  it("a 200 with an empty or whitespace body resolves to undefined", async () => {
    // "an EMPTY body means a bodyless mutation and undefined is right" (client.ts:211-215)
    script(() => new Response("", { status: 200 }));
    expect(await new HttpClient("tok").get("/x")).toBeUndefined();
    fetchCalls.length = 0;
    script(() => new Response("   \n ", { status: 200 }));
    expect(await new HttpClient("tok").get("/x")).toBeUndefined();
  });

  it("a 200 with a NON-EMPTY non-JSON body is a SpotifyError, not undefined", async () => {
    // "silently widening it to undefined surfaced later as a bare TypeError deep in a caller
    //  instead of a SpotifyError here (audit 2026-08-19, T2.11)" (client.ts:212-222)
    script(() => new Response("<html>edge error</html>", { status: 200 }));
    const err = await new HttpClient("tok").get("/x").catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyError);
    expect((err as Error).message).toMatch(/non-JSON 200 body from GET \/x/);
  });

  it("an error status carries its body text into the SpotifyError", async () => {
    script(status(404, "not found"));
    const err = await new HttpClient("tok").get("/x").catch((e) => e);
    expect((err as SpotifyError).status).toBe(404);
    expect((err as Error).message).toBe("not found");
  });

  it("a JSON literal null body is preserved, not widened", async () => {
    script(() => new Response("null", { status: 200 }));
    expect(await new HttpClient("tok").get("/x")).toBeNull();
  });
});

// ------------------------------------------------------------ pagination

describe("getAll", () => {
  const page = (items: unknown[], next: string | null, total: number) =>
    ok({ items, next, total });

  it("collects across pages and reports progress against the total", async () => {
    script(
      page([1, 2], "https://api.spotify.com/v1/x?offset=2", 5),
      page([3, 4], "https://api.spotify.com/v1/x?offset=4", 5),
      page([5], null, 5),
    );
    const seen: [number, number][] = [];
    const out = await new HttpClient("tok").getAll<number>("/x", (c, t) => seen.push([c, t]));
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(seen).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
  });

  it("an empty collection with total 0 returns [] and reports (0, 0)", async () => {
    script(page([], null, 0));
    const seen: [number, number][] = [];
    const out = await new HttpClient("tok").getAll("/x", (c, t) => seen.push([c, t]));
    expect(out).toEqual([]);
    expect(seen).toEqual([[0, 0]]);
  });

  it("a later page reporting total 0 does not erase a known total", async () => {
    // `total = page.total || total` (client.ts:259)
    script(page([1, 2], "https://api.spotify.com/v1/x?offset=2", 5), page([3], null, 0));
    const seen: [number, number][] = [];
    await new HttpClient("tok").getAll("/x", (c, t) => seen.push([c, t]));
    expect(seen).toEqual([
      [2, 5],
      [3, 5],
    ]);
  });

  it("a page with no items array is a 502, not a silent empty result", async () => {
    script(ok({ next: null, total: 3 }));
    const err = await new HttpClient("tok").getAll("/x").catch((e) => e);
    expect((err as SpotifyError).status).toBe(502);
    expect((err as Error).message).toMatch(/malformed page/);
  });

  it("a null page body is a 502", async () => {
    script(() => new Response("null", { status: 200 }));
    const err = await new HttpClient("tok").getAll("/x").catch((e) => e);
    expect((err as SpotifyError).status).toBe(502);
  });

  it("a 204 mid-pagination is a 502, not an early stop", async () => {
    script(page([1], "https://api.spotify.com/v1/x?offset=1", 2), status(204));
    const err = await new HttpClient("tok").getAll("/x").catch((e) => e);
    expect((err as SpotifyError).status).toBe(502);
  });

  it("items not being an array (a string) is a 502", async () => {
    script(ok({ items: "nope", next: null, total: 1 }));
    const err = await new HttpClient("tok").getAll("/x").catch((e) => e);
    expect((err as SpotifyError).status).toBe(502);
  });

  it("a self-referencing next link terminates with a 508 after 500 pages", async () => {
    // "Termination was delegated entirely to Spotify's `next` — a self-referencing link would
    //  loop forever. 500 pages ~ 25k items" (client.ts:249-253)
    script(...times(600, page([1], "https://api.spotify.com/v1/x?offset=0", 10_000)));
    const err = await new HttpClient("tok").getAll("/x").catch((e) => e);
    expect((err as SpotifyError).status).toBe(508);
    expect(fetchCalls).toHaveLength(500);
  });
});

// ------------------------------------------------------------ request shape

describe("request shape", () => {
  it("resolves a token getter per attempt so a mid-run refresh is picked up", async () => {
    // "long-running background work passes a getter so a token that expires mid-run is
    //  refreshed, not used dead" (client.ts:50-53)
    const tokens = ["t1", "t2", "t3"];
    let i = 0;
    const headers: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        const h = (init as { headers: Record<string, string> }).headers;
        headers.push(h.Authorization);
        fetchCalls.push({ url: String(_url), method: "GET" });
        return fetchCalls.length < 2
          ? new Response("", { status: 403 })
          : new Response(JSON.stringify({ v: 1 }), { status: 200 });
      }) as unknown as typeof fetch,
    );
    const c = new HttpClient(async () => tokens[Math.min(i++, tokens.length - 1)]);
    const t = track(c.get("/x"));
    await vi.advanceTimersByTimeAsync(5_000);
    await t.done;
    expect(headers.slice(0, 2)).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("sends the API base for a relative path and the link verbatim for an absolute one", async () => {
    script(ok({ items: [], next: null, total: 0 }));
    await new HttpClient("tok").get("/me/player");
    expect(fetchCalls[0].url).toBe("https://api.spotify.com/v1/me/player");
    fetchCalls.length = 0;
    script(ok({ items: [], next: null, total: 0 }));
    await new HttpClient("tok").get("https://api.spotify.com/v1/other?x=1");
    expect(fetchCalls[0].url).toBe("https://api.spotify.com/v1/other?x=1");
  });
});
