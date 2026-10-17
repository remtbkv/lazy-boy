// R2 (docs/STORE_MIGRATION.md §2): with the telemetry store down or frozen, no user path gets
// slower or fails. The telemetry URL is an https host whose fetch either never answers (a
// frozen Zenbook: the connection hangs until the store fetch's 4 s deadline aborts it) or
// rejects at once (the Funnel unreachable). The sync and the Home payload read must finish in
// their normal time either way.
import { beforeAll, describe, expect, it, vi } from "vitest";

// Hoisted: db.ts reads the env and binds `fetch` when it is imported.
const tel = vi.hoisted(() => {
  process.env.TELEMETRY_DATABASE_URL = "https://telemetry.invalid";
  const state = { mode: "hang" as "hang" | "reject", calls: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!u.startsWith("https://telemetry.invalid")) return realFetch(input, init);
    state.calls++;
    if (state.mode === "reject") return Promise.reject(new TypeError("fetch failed"));
    return new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
    });
  }) as typeof fetch;
  return state;
});

import { syncRecentPlays } from "@/lib/sync/history";
import { getHomePayload, ledgerAdd, logSpotifyRequest, recordClientMetrics } from "@/lib/db";

type FakeSp = Parameters<typeof syncRecentPlays>[0];
let n = 0;
function oneNewPlay(): FakeSp {
  n++;
  return {
    recentlyPlayed: async () => [
      {
        track: {
          id: `d${n}`,
          title: `Song ${n}`,
          artist: "Artist",
          uri: `spotify:track:d${n}`,
          album: null,
          albumImage: null,
          durationMs: 180_000,
        },
        playedAt: new Date(Date.now() - n * 600_000).toISOString(),
        contextType: null,
        contextUri: null,
      },
    ],
    contextName: async () => null,
  } as unknown as FakeSp;
}

// What a sync + payload read costs against a local file with nothing else going on. Generous:
// the bound it checks is "did not wait on telemetry" (4 s), not a benchmark.
const NORMAL_MS = 1_500;

async function userPath(): Promise<number> {
  const t0 = Date.now();
  const { added } = await syncRecentPlays(oneNewPlay());
  const payload = await getHomePayload();
  const took = Date.now() - t0;
  expect(added).toBe(1);
  expect(payload).not.toBeNull();
  return took;
}

describe("telemetry store unreachable", () => {
  // Order matters: a hung telemetry init is ONE shared promise until its 4 s deadline, so a
  // test that runs while one is pending joins it instead of fetching. The hang cases go last.
  beforeAll(async () => {
    // Warm the core store (schema init) so the timing below measures the path, not the
    // first CREATE TABLE; let the warm-up's own telemetry rejections settle.
    tel.mode = "reject";
    await userPath();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("telemetry calls themselves fail fast: one attempt, 4 s cap", async () => {
    tel.mode = "reject";
    const before = tel.calls;
    const t0 = Date.now();
    await expect(recordClientMetrics([{ session: "s", page: "/", event: "pageview" }])).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1_000);
    // One attempt for the schema init, none retried (the core store's ladder would make it 3).
    expect(tel.calls - before).toBe(1);

    tel.mode = "hang";
    const t1 = Date.now();
    await expect(recordClientMetrics([{ session: "s", page: "/", event: "pageview" }])).rejects.toThrow();
    const hung = Date.now() - t1;
    expect(hung).toBeGreaterThanOrEqual(3_900);
    expect(hung).toBeLessThan(6_000);
  });

  for (const m of ["reject", "hang"] as const) {
    it(`a sync and the Home payload read succeed in normal time (telemetry fetch: ${m})`, async () => {
      tel.mode = m;
      const before = tel.calls;
      // Telemetry traffic the path itself fires, plus the kind the rest of the app fires
      // alongside it: none of it may be awaited by the user path.
      void logSpotifyRequest({ method: "GET", path: "/me/player", status: 200, retryAfter: null }).catch(() => {});
      void ledgerAdd("day_strip", 1);
      const took = await userPath();
      expect(took).toBeLessThan(NORMAL_MS);
      // The test is only meaningful if telemetry was actually attempted.
      expect(tel.calls).toBeGreaterThan(before);
    });
  }
});
