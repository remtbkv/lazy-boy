// The one-line defects from burn lazyboy-review 2026-10-03, L1, that carry logic:
// - playerControl logged every transport command as "action:removeFromPlaylist" in api_log,
//   so /usage merged player commands into removals;
// - a removal Spotify had already applied was reported as a failure when the cache write threw;
// - the closed-app Home payload kept bucketing with the pre-DST offset until a browser posted
//   the new one;
// - instrumentation imported db.ts in the Edge build too, burying real build warnings.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sources: [] as string[],
  removeCache: (async () => {}) as () => Promise<void>,
  recorded: 0,
}));

vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("next/navigation", () => ({ unstable_rethrow: () => {} }));
vi.mock("@/lib/auth", () => ({}));
// The gate as the owner's session would pass it (multi-user Phase 1).
vi.mock("@/lib/require-user", async () => {
  const { ownerUid } = await import("./owner-store");
  return { requireActionUser: async () => ({ uid: ownerUid(), admin: true }) };
});
vi.mock("@/lib/session", () => ({
  getSpotify: async (_uid: string, source: string) => {
    state.sources.push(source);
    return {
      resumePlayback: async () => {},
      pausePlayback: async () => {},
      playContext: async () => {},
      removeFromPlaylist: async () => {},
    };
  },
}));
vi.mock("@/lib/db", async (orig) => {
  const real = await orig<typeof import("@/lib/db")>();
  return {
    ...real,
    forUser: (uid: Parameters<typeof real.forUser>[0]) => ({
      ...real.forUser(uid),
      removeCachedPlaylistTrack: () => state.removeCache(),
    }),
    recordClientMetrics: async () => {
      state.recorded++;
    },
  };
});

const actions = await import("@/app/(app)/actions");
const db = await import("@/lib/db");
const payloadTzOffset = (s: number | null, z: number) => db.payloadTzOffset(s, z);

beforeEach(() => {
  state.sources = [];
  state.removeCache = async () => {};
  state.recorded = 0;
});

describe("playerControl api_log source", () => {
  it("labels each transport command with its own source", async () => {
    await actions.playerSetPlayingAction(true);
    await actions.playPlaylistAction("p1");
    await actions.playPlaylistTrackAction("p1", "spotify:track:t1");
    expect(state.sources).toEqual([
      "action:playerSetPlaying",
      "action:playPlaylist",
      "action:playPlaylistTrack",
    ]);
  });
});

describe("removeFromPlaylistAction", () => {
  it("reports ok when Spotify removed the track but the cache write threw", async () => {
    state.removeCache = async () => {
      throw new Error("store down");
    };
    const r = await actions.removeFromPlaylistAction("p1", "spotify:track:t1", 0);
    expect(r).toEqual({ ok: true });
  });
});

describe("payloadTzOffset", () => {
  it("uses the zone's offset when nothing was published", () => {
    expect(payloadTzOffset(null, -300)).toBe(-300);
  });
  it("keeps the browser's offset when it agrees with the zone", () => {
    expect(payloadTzOffset(-240, -240)).toBe(-240);
  });
  it("follows the zone across a DST change the browser has not reported yet", () => {
    expect(payloadTzOffset(-240, -300)).toBe(-300); // fall back, Nov 1
    expect(payloadTzOffset(-300, -240)).toBe(-240); // spring forward
  });
  it("keeps a browser that is genuinely elsewhere (not a 60-min DST step)", () => {
    expect(payloadTzOffset(60, -240)).toBe(60);
    expect(payloadTzOffset(-420, -240)).toBe(-420);
  });
});

describe("instrumentation onRequestError", () => {
  const err = Object.assign(new Error("boom"), { digest: "d1" });
  const req = { path: "/x" } as never;
  const ctx = {} as never;

  it("records nothing outside the Node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const { onRequestError } = await import("@/instrumentation");
    await onRequestError(err, req, ctx);
    expect(state.recorded).toBe(0);
    vi.unstubAllEnvs();
  });

  it("records the server error under the Node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { onRequestError } = await import("@/instrumentation");
    await onRequestError(err, req, ctx);
    expect(state.recorded).toBe(1);
    vi.unstubAllEnvs();
  });
});
