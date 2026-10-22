// The interim second pinger (docs/multi-user/PLAN.md §7.9; §7.2 steps 0-1; security R14; T13):
// /api/cron/sync takes CRON_SECRET (the Zenbook's timer) and CRON_SECRET_EXT (cron-job.org);
// the owner alarm answers the Zenbook's caller only; cron-job.org always gets a bare
// {"ok":true}; and a 90-second stamp lets one tick's work through per window, whoever calls.
// Real db.ts on the throwaway store (the owner's, named by his users row), the real Spotify client
// against a scripted fetch; one tick's work is one player-state call.
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createTokenCore } from "@/lib/token-core";

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
  // The route's token core, built per test as auth.ts builds it: a fresh core is a fresh
  // process, where the admin's copy of his plaintext row runs at its first read.
  core: null as ReturnType<typeof createTokenCore> | null,
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
// outage. Both ways to a store are wrapped: the route reaches the admin's through adminStore()
// (forUserAt, multi-user Phase 2), the test's own reads through forUser.
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  const flaky = (store: ReturnType<typeof real.forUser>) => ({
    ...store,
    acquireLock: (name: string, ttlMs: number) =>
      spotify.storeDown ? Promise.reject(new Error("store unavailable")) : store.acquireLock(name, ttlMs),
  });
  return {
    ...real,
    forUser: (uid: Parameters<typeof real.forUser>[0]) => flaky(real.forUser(uid)),
    forUserAt: (uid: Parameters<typeof real.forUserAt>[0], dbName: string) => flaky(real.forUserAt(uid, dbName)),
  };
});

// The route's token functions over the core auth.ts runs (auth.ts itself loads next-auth): the
// token core over the admin's token move (token-move.ts) over user_tokens, multi-user Phase 2.
// No refresh is under test here; the admin's copy at a fresh process's first read is.
vi.mock("@/lib/auth", async () => {
  const { createTokenCore } = await import("@/lib/token-core");
  const { appTokenStore } = await import("@/lib/token-store-app");
  const { withAdminTokenMove } = await import("@/lib/token-move");
  const { ownerUid } = await import("@/lib/identity");
  const core = () => (spotify.core ??= createTokenCore(withAdminTokenMove(appTokenStore(), ownerUid)));
  type Uid = Parameters<typeof import("@/lib/db").forUser>[0];
  return {
    getValidAccessTokenFor: async (uid: Uid) => {
      const t = await core().getValidAccessToken(uid);
      return t ? { uid: t.uid, accessToken: t.accessToken } : null;
    },
    hasStoredTokens: async (uid: Uid) => (await core().getStored(uid)) !== null,
  };
});

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
  // currentlyPlaying() reads /me/player alone (NOW_PLAYING_2S L2); 204 = no active device.
  if (url.pathname === "/v1/me/player") {
    if (!spotify.playing) return new Response(null, { status: 204 });
    return Response.json({ is_playing: true, progress_ms: 1000, item: TRACK, context: null, currently_playing_type: "track" });
  }
  if (url.pathname === "/v1/me/player/recently-played") {
    return Response.json({
      items: [{ track: TRACK, played_at: new Date(Date.now() - 60_000).toISOString(), context: null }],
      next: null,
    });
  }
  throw new Error(`unexpected Spotify call ${url.pathname}`);
});

const { ownerStore, ownerUid, seedOwnerApp } = await import("./owner-store");
const { appTokenStore } = await import("@/lib/token-store-app");
const db = ownerStore();
// The admin's users row, which the route's adminStore() reads (multi-user Phase 2).
await seedOwnerApp();
const tokens = appTokenStore();
const { appDatabaseUrl, setAppMeta } = await import("@/lib/app-db");
const { GET } = await import("@/app/api/cron/sync/route");

// The admin's copy marker (token-move.ts, app_meta `token_copy:<uid>`): written by the deploy's
// first read of his tokens, which copied his plaintext row into user_tokens (PLAN §11.4 step 3).
async function copyRan(ran: boolean): Promise<void> {
  const key = `token_copy:${ownerUid()}`;
  if (ran) return setAppMeta(key, `copied:${Date.now()}`);
  const c = createClient({ url: appDatabaseUrl(), intMode: "number" });
  try {
    await c.execute({ sql: "DELETE FROM app_meta WHERE key = ?", args: [key] });
  } finally {
    c.close();
  }
}

const call = (authorization?: string) =>
  GET(new Request("https://lazy-boy.example/api/cron/sync", { headers: authorization ? { authorization } : {} }));
const zen = () => call(`Bearer ${ZEN}`);
// cron-job.org's call as it sees it, then the tick its call started.
const ext = async () => {
  const res = await call(`Bearer ${EXT}`);
  await flushAfter();
  return res;
};
const ticks = () => spotify.paths.filter((p) => p === "/v1/me/player").length;

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
  spotify.core = null;
  // The token of record (user_tokens), the deploy's copy long done. The plaintext meta copy is
  // the rollback week's (PLAN §11.4) and absent here unless a test plants it.
  await tokens.set(ownerUid(), { accessToken: "at-rem", refreshToken: "rt-rem", expiresAt: base + 3_600_000 });
  await copyRan(true);
  await db.clearSpotifyTokens();
  // An idle tick: nothing playing, harvested just now, library fresh. Its work is the
  // player check.
  await db.setHarvestGate({ lastActive: 0, lastHarvest: base });
  await db.setLibrarySyncedAt();
});

// The route swallows a failed player check, so an unscripted call would pass unseen.
const SCRIPTED = new Set(["/v1/me/player", "/v1/me/player/recently-played"]);
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
    await tokens.remove(ownerUid());
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
    await tokens.remove(ownerUid());
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

  it("Phase 2's first Zenbook tick runs the admin's copy before the owner alarm reads (§11.4 step 3)", async () => {
    // The deploy's state: his users row and his plaintext row in lazyboy.meta, no user_tokens
    // row yet, the copy never run. Not "no token": the tick copies the row in and runs.
    await tokens.remove(ownerUid());
    await copyRan(false);
    await db.setSpotifyTokens({ accessToken: "at-plain", refreshToken: "rt-plain", expiresAt: base + 3_600_000 });
    const z = await zen();
    expect({ status: z.status, body: await z.json() }).toEqual({ status: 200, body: { ok: true, added: 0, idle: true } });
    expect(ticks()).toBe(1);
    expect(await tokens.get(ownerUid())).toMatchObject({ accessToken: "at-plain", refreshToken: "rt-plain" });
  });

  it("the owner alarm reads the token of record: a plaintext copy alone is no token, and none is no alarm", async () => {
    // The deploy's copy ran (beforeEach), then a dead grant's clear removed the user_tokens row;
    // the rollback week's plaintext copy is still there. Inside the window cron-job.org's tick
    // opened, the Zenbook must still hear the alarm.
    expect((await ext()).status).toBe(200);
    expect(ticks()).toBe(1);
    await tokens.remove(ownerUid());
    await db.setSpotifyTokens({ accessToken: "at-old", refreshToken: "rt-old", expiresAt: base + 3_600_000 });
    at(30_000);
    const alarm = await zen();
    expect({ status: alarm.status, body: await alarm.json() }).toEqual({ status: 503, body: { ok: false, error: "no token" } });

    // A week on (§11.4 step 6) the plaintext copy is gone and the token of record stays: no
    // alarm, and the tick runs.
    await db.clearSpotifyTokens();
    await tokens.set(ownerUid(), { accessToken: "at-rem", refreshToken: "rt-rem", expiresAt: base + 3_600_000 });
    at(200_000);
    const z = await zen();
    expect(z.status).toBe(200);
    expect(ticks()).toBe(2);
  });

  it("with no owner configured the Zenbook hears 503 and cron-job.org still a bare {\"ok\":true}", async () => {
    // The tick resolves its user first (adminStore: OWNER_UID's users row); that answer is the
    // tick's, so it reaches the Zenbook's caller and never cron-job.org's (lane 33's stitch of
    // lanes 08 and 12; lane 34's of lane 15).
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
