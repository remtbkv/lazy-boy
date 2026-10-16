// The fetch every store query rides. Both properties here were production bugs on
// 2026-08-22: brotli on the Zenbook's CPU (26s for the history payload) and a retry ladder
// that threw on the second attempt instead of retrying.
import { describe, expect, it, vi } from "vitest";
import { makeStoreFetch } from "@/lib/store-fetch";

/** What hrana hands the fetch: a Request whose body is a one-shot stream. */
const hranaRequest = (body = '{"requests":[]}') =>
  new Request("https://store.example/v2/pipeline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

const ok = () => new Response("{}", { status: 200 });

describe("makeStoreFetch", () => {
  it("asks for gzip, never brotli", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const f = makeStoreFetch(async (_u, init) => {
      seen.push(init);
      return ok();
    });
    await f(hranaRequest());
    expect(new Headers(seen[0]!.headers).get("accept-encoding")).toBe("gzip");
  });

  it("retries a rejected attempt and re-sends the SAME body", async () => {
    const bodies: string[] = [];
    let calls = 0;
    const f = makeStoreFetch(async (_u, init) => {
      calls++;
      bodies.push(new TextDecoder().decode(init!.body as ArrayBuffer));
      if (calls === 1) throw new TypeError("fetch failed"); // the DNS blip
      return ok();
    });
    const res = await f(hranaRequest('{"requests":["a"]}'));
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    // The bug: attempt 2 used to see a consumed stream and throw "Response body object
    // should not be disturbed or locked", so the ladder never actually retried.
    expect(bodies).toEqual(['{"requests":["a"]}', '{"requests":["a"]}']);
  });

  it("gives up after three attempts and surfaces the last error", async () => {
    let calls = 0;
    const f = makeStoreFetch(async () => {
      calls++;
      throw new TypeError("fetch failed");
    });
    await expect(f(hranaRequest())).rejects.toThrow("fetch failed");
    expect(calls).toBe(3);
  });

  it("retries gateway statuses but not a 500 from sqld", async () => {
    let calls = 0;
    const gateway = makeStoreFetch(async () => {
      calls++;
      return new Response("", { status: calls < 3 ? 503 : 200 });
    });
    expect((await gateway(hranaRequest())).status).toBe(200);
    expect(calls).toBe(3);

    let five = 0;
    const sqldError = makeStoreFetch(async () => {
      five++;
      return new Response("", { status: 500 });
    });
    expect((await sqldError(hranaRequest())).status).toBe(500);
    expect(five).toBe(1);
  });

  it("bounds each attempt with its own timeout, so a slow first try leaves the rest usable", async () => {
    const deadlines: (AbortSignal | null | undefined)[] = [];
    let calls = 0;
    const f = makeStoreFetch(async (_u, init) => {
      deadlines.push(init?.signal);
      calls++;
      if (calls === 1) {
        await new Promise((r) => setTimeout(r, 30));
        throw new TypeError("fetch failed");
      }
      return ok();
    });
    await f(hranaRequest());
    expect(calls).toBe(2);
    // Two DIFFERENT signals: one shared deadline is the bug this replaced.
    expect(deadlines[0]).not.toBe(deadlines[1]);
    expect(deadlines[1]!.aborted).toBe(false);
  });

  it("a caller-supplied signal wins", async () => {
    const mine = new AbortController().signal;
    let seen: AbortSignal | undefined;
    const f = makeStoreFetch(async (_u, init) => {
      seen = init?.signal as AbortSignal;
      return ok();
    });
    await f("https://store.example/v2/pipeline", { method: "POST", body: "{}", signal: mine });
    expect(seen).toBe(mine);
  });

  it("leaves a GET without a body", async () => {
    let seen: RequestInit | undefined;
    const f = makeStoreFetch(async (_u, init) => {
      seen = init;
      return ok();
    });
    await f(new Request("https://store.example/health"));
    expect(seen!.body).toBeUndefined();
    expect(seen!.method).toBe("GET");
  });

  it("options: one attempt surfaces the first failure, rejected or gateway", async () => {
    let calls = 0;
    const once = makeStoreFetch(
      async () => {
        calls++;
        throw new TypeError("fetch failed");
      },
      { attempts: 1 },
    );
    await expect(once(hranaRequest())).rejects.toThrow("fetch failed");
    expect(calls).toBe(1);

    let gw = 0;
    const onceGateway = makeStoreFetch(
      async () => {
        gw++;
        return new Response("", { status: 503 });
      },
      { attempts: 1 },
    );
    expect((await onceGateway(hranaRequest())).status).toBe(503);
    expect(gw).toBe(1);
  });

  it("defaults: each attempt's deadline is 15 s (the core store's), an option overrides it", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await makeStoreFetch(async () => ok())(hranaRequest());
      expect(timeout.mock.calls).toEqual([[15_000]]);
      timeout.mockClear();
      await makeStoreFetch(async () => ok(), { attempts: 1, attemptTimeoutMs: 4_000 })(hranaRequest());
      expect(timeout.mock.calls).toEqual([[4_000]]);
    } finally {
      timeout.mockRestore();
    }
  });

  it("options: attemptTimeoutMs bounds a fetch that never answers", async () => {
    // A frozen host: the connection is accepted and nothing comes back. Only the signal ends it.
    const hang = makeStoreFetch(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
        }),
      { attempts: 1, attemptTimeoutMs: 50 },
    );
    const t0 = Date.now();
    await expect(hang(hranaRequest())).rejects.toThrow();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(40);
    expect(took).toBeLessThan(1_000);
  });
});
