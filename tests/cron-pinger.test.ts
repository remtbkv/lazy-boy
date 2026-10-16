// The interim second pinger (docs/multi-user/PLAN.md §7.9; §7.2 steps 0-1; security R14; T13):
// /api/cron/sync takes CRON_SECRET (the Zenbook's timer) and CRON_SECRET_EXT (cron-job.org);
// the owner alarm answers the Zenbook's caller only; cron-job.org always gets a bare
// {"ok":true}; and a 90-second stamp lets one tick's work through per window, whoever calls.
// Real db.ts on the throwaway store (the owner's, through forUser), the real Spotify client
// against a scripted fetch; one tick's work is one currently-playing call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ZEN = "zen-s3cret";
const EXT = "ext-s3cret";
process.env.CRON_SECRET = ZEN;
process.env.CRON_SECRET_EXT = EXT;

const spotify = vi.hoisted(() => ({
  paths: [] as string[],
  playing: false,
  storeDown: false,
  hold: null as Promise<void> | null,
  after: [] as Promise<unknown>[],
}));

// after() outside a real request: run the task and let the test await it.
vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    spotify.after.push(Promise.resolve().then(task));
  },
}));
const flushAfter = async () => {
  while (spotify.after.length) await Promise.all(spotify.after.splice(0));
};

// The real db.ts, except that the stamp on the user's store can be made to fail like a store
// outage.
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...real,
    forUser: (uid: Parameters<typeof real.forUser>[0]) => {
      const store = real.forUser(uid);
      return {
        ...store,
        acquireLock: (name: string, ttlMs: number) =>
          spotify.storeDown ? Promise.reject(new Error("store unavailable")) : store.acquireLock(name, ttlMs),
      };
    },
  };
});

// The route's token getter, reduced to the stored row: no refresh is under test here.
vi.mock("@/lib/auth", () => ({
  getValidAccessTokenFor: async (uid: Parameters<typeof import("@/lib/db").forUser>[0]) => {
    const t = await (await import("@/lib/db")).forUser(uid).getSpotifyTokens();
    return t ? { uid, accessToken: t.accessToken } : null;
  },
}));

const TRACK = {
  id: "t1",
  name: "Song",
  uri: "spotify:track:t1",
  duration_ms: 200_000,
  artists: [{ name: "Artist" }],
  album: { name: "Album", images: [] },
  type: "track",
};

vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "https://api.spotify.com") throw new Error(`unexpected fetch ${url}`);
  spotify.paths.push(url.pathname);
  if (spotify.hold) await spotify.hold;
  if (url.pathname === "/v1/me/player/currently-playing") {
    if (!spotify.playing) return new Response(null, { status: 204 });
    return Response.json({ is_playing: true, progress_ms: 1000, item: TRACK, context: null, currently_playing_type: "track" });
  }
  // currentlyPlaying()'s fallback when the first read is empty: no active device.
  if (url.pathname === "/v1/me/player") return new Response(null, { status: 204 });
  if (url.pathname === "/v1/me/player/recently-played") {
    return Response.json({
      items: [{ track: TRACK, played_at: new Date(Date.now() - 60_000).toISOString(), context: null }],
      next: null,
    });
  }
  throw new Error(`unexpected Spotify call ${url.pathname}`);
});

const { ownerStore } = await import("./owner-store");
const db = ownerStore();
const { GET } = await import("@/app/api/cron/sync/route");

const call = (authorization?: string) =>
  GET(new Request("https://lazy-boy.example/api/cron/sync", { headers: authorization ? { authorization } : {} }));
const zen = () => call(`Bearer ${ZEN}`);
// cron-job.org's call as it sees it, then the tick its call started.
const ext = async () => {
  const res = await call(`Bearer ${EXT}`);
  await flushAfter();
  return res;
};
const ticks = () => spotify.paths.filter((p) => p === "/v1/me/player/currently-playing").length;

// Each test starts an hour after the last, so no stamp carries over; the clock moves only when
// a test moves it.
let base = Date.parse("2026-10-16T06:00:00Z");
const at = (ms: number) => vi.setSystemTime(base + ms);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  base += 3_600_000;
  at(0);
  spotify.paths.length = 0;
  spotify.playing = false;
  spotify.storeDown = false;
  spotify.hold = null;
  await db.setSpotifyTokens({ accessToken: "at-rem", refreshToken: "rt-rem", expiresAt: base + 3_600_000 });
  // An idle tick: nothing playing, harvested just now, library fresh. Its work is the
  // currently-playing check.
  await db.setHarvestGate({ lastActive: 0, lastHarvest: base });
  await db.setLibrarySyncedAt();
});

// The route swallows a failed player check, so an unscripted call would pass unseen.
const SCRIPTED = new Set(["/v1/me/player/currently-playing", "/v1/me/player", "/v1/me/player/recently-played"]);
afterEach(() => {
  expect(spotify.paths.filter((p) => !SCRIPTED.has(p))).toEqual([]);
});

describe("/api/cron/sync, two pingers", () => {
  it("no secret and a wrong one get 401 and do nothing; each caller's secret gets 200", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call(EXT)).status).toBe(401);
    expect(spotify.paths).toEqual([]);
    const z = await zen();
    expect(z.status).toBe(200);
    at(91_000);
    const e = await ext();
    expect(e.status).toBe(200);
    expect(ticks()).toBe(2);
  });

  it("cron-job.org's reply is a bare {\"ok\":true} whatever the tick did: harvested, guarded, signed out", async () => {
    spotify.playing = true;
    const lastSync = await db.getLastSync();
    const harvested = await ext();
    expect(harvested.status).toBe(200);
    expect(await harvested.text()).toBe('{"ok":true}');
    expect(spotify.paths).toContain("/v1/me/player/recently-played");
    expect(await db.getLastSync()).not.toBe(lastSync); // the tick ran and harvested

    at(30_000);
    const guarded = await ext();
    expect(guarded.status).toBe(200);
    expect(await guarded.text()).toBe('{"ok":true}');

    at(200_000);
    await db.clearSpotifyTokens();
    const signedOut = await ext();
    expect(signedOut.status).toBe(200);
    expect(await signedOut.text()).toBe('{"ok":true}');
  });

  it("cron-job.org's reply does not wait for the tick, so its timing says nothing about anyone's listening (security R14)", async () => {
    spotify.playing = true;
    let release = () => {};
    spotify.hold = new Promise<void>((r) => (release = r));
    try {
      // The tick is stuck on Spotify; the reply must not be.
      const reply = await Promise.race([
        call(`Bearer ${EXT}`),
        new Promise<string>((r) => setTimeout(() => r("waited for the tick"), 1_000)),
      ]);
      expect(reply).toBeInstanceOf(Response);
      expect({ status: (reply as Response).status, body: await (reply as Response).text() }).toEqual({
        status: 200,
        body: '{"ok":true}',
      });
    } finally {
      release();
      await flushAfter();
    }
    // The tick still ran in full, after the reply: it harvested.
    expect(spotify.paths).toContain("/v1/me/player/recently-played");
  });

  it("three calls within 90 s do one tick's work, a burst does one, and a call 91 s on does another", async () => {
    expect((await zen()).status).toBe(200);
    at(30_000);
    expect((await ext()).status).toBe(200);
    at(90_000);
    const guarded = await zen();
    expect(guarded.status).toBe(200);
    expect(ticks()).toBe(1);

    at(91_000);
    expect((await ext()).status).toBe(200);
    expect(ticks()).toBe(2);

    at(400_000);
    const burst = await Promise.all([zen(), ext(), zen(), ext()]);
    expect(burst.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(ticks()).toBe(3);
  });

  it("a stamp that fails skips the tick: no call gets past the guard without the window", async () => {
    spotify.storeDown = true;
    const z = await zen();
    expect(z.status).toBe(200);
    expect(await z.json()).toEqual({ ok: true, skipped: "store unavailable" });
    expect(await (await ext()).text()).toBe('{"ok":true}');
    expect(ticks()).toBe(0);
  });

  it("the Zenbook caller still sees the owner alarm inside the window cron-job.org's tick opened", async () => {
    expect((await ext()).status).toBe(200);
    expect(ticks()).toBe(1);
    await db.clearSpotifyTokens();
    at(30_000);
    const alarm = await zen();
    expect(alarm.status).toBe(503);
    expect(await alarm.json()).toEqual({ ok: false, error: "no token" });
    at(60_000);
    const quiet = await ext();
    expect(quiet.status).toBe(200);
    expect(await quiet.text()).toBe('{"ok":true}');
    expect(ticks()).toBe(1);
  });

  it("with no owner configured the Zenbook hears 503 and cron-job.org still a bare {\"ok\":true}", async () => {
    // The tick resolves its user first (phase1Owner, forUser); that answer is the tick's, so it
    // reaches the Zenbook's caller and never cron-job.org's (lane 33's stitch of lanes 08 and 12).
    const owner = process.env.OWNER_UID;
    delete process.env.OWNER_UID;
    try {
      const z = await zen();
      expect({ status: z.status, body: await z.json() }).toEqual({ status: 503, body: { ok: false, error: "no owner" } });
      const e = await ext();
      expect({ status: e.status, body: await e.text() }).toEqual({ status: 200, body: '{"ok":true}' });
      expect(ticks()).toBe(0);
    } finally {
      process.env.OWNER_UID = owner;
    }
  });
});
