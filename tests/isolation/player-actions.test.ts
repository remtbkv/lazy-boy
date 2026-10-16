// The player actions as Phase 4a ships them (PLAN.md §6.6, §12.6; security R13), through the real
// Auth.js and actions.ts over the authz harness:
//   - a 403 from a player endpoint says the account needs Spotify Premium (a friend on a free
//     account), from every player action, where three of them used to say "no active device";
//   - every player action of one user shares one per-user window (thirty a minute): past it, the
//     action answers without a Spotify call.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./authz-context")).nextHeadersMock());
vi.mock("next/server", async (orig) => (await import("./authz-context")).nextServerMock(await orig()));

import { REM_PLAYLIST, become, installSpotify, seedRem, spotifyCalls } from "./authz-harness";

type Result = { ok: boolean; error?: string };
const actions = async () => (await import("@/app/(app)/actions")) as unknown as Record<string, (...a: unknown[]) => Promise<Result>>;
const PLAYER: [string, unknown[]][] = [
  ["addToQueueAction", ["spotify:track:rem-t1"]],
  ["playTrackAction", ["spotify:track:rem-t1"]],
  ["playFromPlaylistAction", [REM_PLAYLIST, "spotify:track:rem-t1"]],
  ["playPlaylistAction", [REM_PLAYLIST]],
  ["playerSetPlayingAction", [true]],
  ["playPlaylistTrackAction", [REM_PLAYLIST, "spotify:track:rem-t1"]],
  ["resumePlaylistAction", [REM_PLAYLIST]],
];
const isPlayerCommand = (url: string, method: string) => method !== "GET" && /\/v1\/me\/player\//.test(url);

beforeAll(() => installSpotify());
beforeEach(async () => {
  const { clearUserBuckets } = await import("@/lib/user-bucket");
  clearUserBuckets();
  await seedRem();
  await become("rem");
});
afterEach(() => installSpotify());

describe("a free account's 403", () => {
  for (const premiumBody of [
    JSON.stringify({ error: { status: 403, message: "Player command failed: Premium required", reason: "PREMIUM_REQUIRED" } }),
    JSON.stringify({ error: { status: 403, message: "Forbidden" } }),
  ]) {
    it(`every player action says Spotify Premium (${premiumBody.includes("PREMIUM") ? "PREMIUM_REQUIRED" : "a bare Forbidden"})`, async () => {
      const harness = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (isPlayerCommand(url, (init?.method ?? "GET").toUpperCase())) return new Response(premiumBody, { status: 403 });
        return harness(input, init);
      });
      const a = await actions();
      for (const [name, args] of PLAYER) {
        const r = await a[name](...args);
        expect(r.ok, name).toBe(false);
        expect(r.error, name).toMatch(/Spotify Premium/);
      }
    });
  }
});

describe("the player window", () => {
  it("thirty player commands a minute per user; the thirty-first makes no Spotify call", async () => {
    const a = await actions();
    for (let i = 0; i < 30; i++) {
      const [name, args] = PLAYER[i % PLAYER.length];
      expect((await a[name](...args)).ok, `${name} (call ${i + 1})`).toBe(true);
    }
    spotifyCalls.length = 0;
    const r = await a.addToQueueAction("spotify:track:rem-t1");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Too many player commands/) });
    expect(spotifyCalls.filter((c) => c.url.startsWith("https://api.spotify.com/"))).toEqual([]);
  });
});
