// The two kinds of 429 (PLAN.md §7.8, 01c S4), through the real Spotify client: a rate limit is
// the app-wide cooldown, seconds long, and nobody's failure; a QUOTA_EXCEEDED cools its bucket
// until the observed reset (at most the client's 30-minute cap) and backs nobody off, while the
// other buckets carry on (client.ts keeps a cooldown per bucket from Phase 3's turn). Its own
// file because client.ts keeps its cooldowns in module state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppMeta } from "@/lib/app-db";
import { mintUid, type Uid } from "@/lib/identity";
import { runTick } from "@/lib/sync/tick";
import { freshAppDb, seedUser } from "./harness";
import { ZEN, memoryStepStore, stubCronSecrets, tickDeps, tickSpotify } from "./tick-harness";

const R: Uid = mintUid("rrrrrrrrrrrr");
const NOW = Date.UTC(2026, 9, 16, 18, 0);
let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number | null> = {}) => (await db.raw().execute({ sql, args })).rows;
let stores: { [k: string]: ReturnType<typeof memoryStepStore> };

beforeEach(async () => {
  db = freshAppDb();
  await getAppMeta("schema_version");
  await seedUser(db.raw(), { uid: R, status: "active", admin: true });
  await q("INSERT INTO user_tokens (uid, blob, expires_at, granted_at) VALUES (:u, 'v1.x', 0, 0)", { u: R });
  stores = { [R]: memoryStepStore(R) };
  stubCronSecrets();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// In this order: the rate limit leaves the client's cooldown seconds long; the quota ban, last,
// leaves it 30 minutes long.
describe("429s by kind", () => {
  it("a rate limit: the step reports it, nobody backs off, the next due time is the usual one", async () => {
    const spotify = tickSpotify({
      [`at-${R}`]: { player: { trackId: "r-now", isPlaying: true, progressMs: 1 }, recent: { status: 429, body: '{"error":{"status":429,"message":"API rate limit exceeded"}}' } },
    });
    // A short Retry-After, as the rate limit sends.
    const inner = spotify.fetch.getMockImplementation()!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await inner(input, init);
        if (res.status !== 429) return res;
        return new Response(await res.text(), { status: 429, headers: { "Retry-After": "1" } });
      }),
    );
    const { deps } = tickDeps({ now: () => NOW, stores, config: { signups: "owner" } });
    const r = await runTick(deps, ZEN);
    expect(r.body.steps).toEqual([{ uid: R, outcome: "rate-limited", trigger: "backstop" }]);
    expect((await q("SELECT state, failures, last_error FROM sync_state"))[0]).toEqual({ state: "active", failures: 0, last_error: "rate-limited" });
    expect(await getAppMeta("cooldown:recently-played")).toBeNull();
  }, 30_000);

  it("QUOTA_EXCEEDED: the recently-played bucket cools down; the user is not backed off", async () => {
    const quota = '{"error":{"status":429,"message":"Too many requests","reason":"QUOTA_EXCEEDED"}}';
    const spotify = tickSpotify({
      [`at-${R}`]: { player: { trackId: "r-now", isPlaying: true, progressMs: 1 }, recent: { status: 429, body: quota } },
    });
    vi.stubGlobal("fetch", spotify.fetch);
    let t = NOW;
    const { deps } = tickDeps({ now: () => t, stores, config: { signups: "owner" } });
    const r = await runTick(deps, ZEN);
    expect(r.body.steps).toEqual([{ uid: R, outcome: "quota", trigger: "backstop" }]);
    // Until the observed reset (14:51 UTC tomorrow) but no longer than the client's 30-minute cap.
    expect(await getAppMeta("cooldown:recently-played")).toBe(String(NOW + 30 * 60_000));
    expect((await q("SELECT state, failures, last_error FROM sync_state"))[0]).toEqual({ state: "active", failures: 0, last_error: "quota" });
    // The next tick inside the cooldown does not ask recently-played again.
    const recentCalls = () => spotify.calls.filter((c) => c.path === "/v1/me/player/recently-played").length;
    const before = recentCalls();
    t = NOW + 2 * 60_000;
    await runTick(deps, ZEN);
    expect(recentCalls()).toBe(before);
  }, 30_000);

  it("QUOTA_EXCEEDED on recently-played stops neither the player probe nor a library call in the same process", async () => {
    const quota = '{"error":{"status":429,"message":"Too many requests","reason":"QUOTA_EXCEEDED"}}';
    const spotify = tickSpotify({
      [`at-${R}`]: { player: { trackId: "r-now", isPlaying: true, progressMs: 1 }, recent: { status: 429, body: quota } },
    });
    vi.stubGlobal("fetch", spotify.fetch);
    let t = NOW + 86_400_000;
    const { deps } = tickDeps({ now: () => t, stores, config: { signups: "owner" } });
    await runTick(deps, ZEN);
    const probes = () => spotify.calls.filter((c) => c.path === "/v1/me/player").length;
    expect(probes()).toBe(1);
    // A minute later, past the stamp: the user is due again 2 minutes on, so move there. Their
    // probe is the player bucket's, which the recently-played ban does not hold.
    t += 3 * 60_000;
    await runTick(deps, ZEN);
    expect(probes()).toBe(2);
    // The library bucket goes too: a playlist read from the same process reaches Spotify.
    const { spotifyClient } = await import("@/lib/spotify");
    const sp = spotifyClient(R, { uid: R, accessToken: `at-${R}` }, false, "test-library");
    await sp.resources.playlist("pl-x").catch(() => {});
    expect(spotify.calls.some((c) => c.path === "/v1/playlists/pl-x")).toBe(true);
  }, 30_000);
});
