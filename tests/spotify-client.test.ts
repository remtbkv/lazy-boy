// Simulation: the Spotify HTTP client against a scripted fetch — 429 ladders, Retry-After
// parsing, hard-ban persistence, retry idempotency rules, pagination caps. No real network:
// global fetch is stubbed, and the store side (request logging, cooldown persist) hits the
// throwaway local SQLite file from tests/setup.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Scripted = { status: number; headers?: Record<string, string>; body?: string };

function scriptFetch(script: Scripted[]) {
  const calls: { url: string; method: string }[] = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const s = script[Math.min(i++, script.length - 1)];
    return new Response(s.body ?? "", { status: s.status, headers: s.headers });
  });
  return calls;
}

async function fresh() {
  vi.resetModules();
  const mod = await import("@/lib/spotify");
  const db = await import("@/lib/db");
  const { ownerUid } = await import("./owner-store");
  const owner = ownerUid();
  return {
    sp: mod.spotifyClient(owner, { uid: owner, accessToken: "test-token" }, false, "sim"),
    SpotifyError: mod.SpotifyError,
    db,
  };
}

describe("spotify client (scripted fetch)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("empty Retry-After reads as 'no answer' (1s wait), not retry-in-250ms", async () => {
    const calls = scriptFetch([
      { status: 429, headers: { "Retry-After": "" } },
      { status: 200, body: JSON.stringify({ id: "me" }) },
    ]);
    const { sp } = await fresh();
    const req = sp.resources.me();
    await vi.advanceTimersByTimeAsync(5_000);
    await req;
    expect(calls.length).toBe(2);
  });

  it("a hard ban (Retry-After 3600) stops after ONE call and persists its bucket's cooldown", async () => {
    const calls = scriptFetch([{ status: 429, headers: { "Retry-After": "3600" } }]);
    const { sp } = await fresh();
    const app = await import("@/lib/app-db");
    // `/me` is the recently-played bucket's (PLAN §7.1).
    const before = Number(await app.getAppMeta("cooldown:recently-played")) || 0;
    const req = sp.resources.me().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const out = await req;
    expect(out).toBeInstanceOf(Error);
    expect(calls.length).toBe(1);
    expect(Number(await app.getAppMeta("cooldown:recently-played"))).toBeGreaterThan(before);
  });

  it("a QUOTA_EXCEEDED 429 is logged with its reason and cools its own bucket in app_meta, nothing else", async () => {
    const quota = JSON.stringify({ error: { status: 429, message: "Too many requests", reason: "QUOTA_EXCEEDED" } });
    const calls = scriptFetch([{ status: 429, headers: { "Retry-After": "3600" }, body: quota }]);
    const { sp } = await fresh();
    const app = await import("@/lib/app-db");
    const t0 = Date.now();
    const out = await sp.recentlyPlayed(50).catch((e: Error) => e);
    expect(out).toBeInstanceOf(Error);
    expect(calls.length).toBe(1);
    // The bucket's cooldown, capped at 30 minutes; the other buckets are untouched.
    expect(Number(await app.getAppMeta("cooldown:recently-played"))).toBe(t0 + 30 * 60_000);
    expect(await app.getAppMeta("cooldown:player")).toBeNull();
    expect(await app.getAppMeta("cooldown:library")).toBeNull();
    // api_log carries the body's reason (PLAN §4.3, §7.9: how the quota is counted is found
    // from these rows). The log write is fired, not awaited: let it land.
    vi.useRealTimers();
    const { createClient } = await import("@libsql/client");
    const c = createClient({ url: process.env.TURSO_DATABASE_URL as string, intMode: "number" });
    const read = () => c.execute("SELECT status, reason FROM api_log WHERE path = '/me/player/recently-played' ORDER BY ts DESC LIMIT 1");
    let rows = await read();
    for (let i = 0; i < 50 && !rows.rows[0]; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await read();
    }
    c.close();
    expect(rows.rows[0]).toMatchObject({ status: 429, reason: "QUOTA_EXCEEDED" });
  });

  it("player PUTs are never blind-retried after a network error", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("network reset");
      return new Response("", { status: 200 });
    });
    const { sp } = await fresh();
    const req = sp.resources.seek(1000).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await req).toBeInstanceOf(TypeError);
    expect(attempts).toBe(1);
  });

  it("playlist PUTs ARE retried after a network error (idempotent write)", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("network reset");
      return new Response("", { status: 200 });
    });
    const { sp } = await fresh();
    const req = sp.resources.replaceItems("x", []);
    await vi.advanceTimersByTimeAsync(10_000);
    await req;
    expect(attempts).toBe(2);
  });

  it("a non-empty non-JSON 200 surfaces as SpotifyError, not a downstream TypeError", async () => {
    scriptFetch([{ status: 200, body: "<html>edge error page</html>" }]);
    const { sp, SpotifyError } = await fresh();
    const req = sp.resources.me().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await req).toBeInstanceOf(SpotifyError);
  });

  it("pagination refuses a self-referencing next link instead of spinning forever", async () => {
    scriptFetch([
      {
        status: 200,
        body: JSON.stringify({ items: [], total: 1, next: "https://api.spotify.com/v1/loop" }),
      },
    ]);
    const { sp, SpotifyError } = await fresh();
    const req = sp.resources.playlistTracks("x").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await req).toBeInstanceOf(SpotifyError);
  });
});
