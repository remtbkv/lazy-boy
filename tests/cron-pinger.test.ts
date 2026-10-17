// The two pingers on Phase 3's tick (docs/multi-user/PLAN.md §7.2 steps 0-1 and 5, §7.9; security
// R14; T13 through the real route). This file replaces the interim pinger's (lane 07/08 on main,
// the 90-second `lock:tick` stamp), case for case and in the same order, against Phase 3's route:
// /api/cron/sync takes CRON_SECRET (the Zenbook's timer) and CRON_SECRET_EXT (cron-job.org); the
// owner alarm answers the Zenbook's caller only; cron-job.org always gets a bare {"ok":true} at
// once, its tick running after the reply; and the stamp, `app_meta.tick_at` with a 45-second
// window, lets one tick's work through per window, whoever calls. The real route, app-db.ts on
// the throwaway app database, the admin's encrypted token, his store (the throwaway file) and the
// real Spotify client against a scripted fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ZEN = "zen-s3cret";
const EXT = "ext-s3cret";
process.env.CRON_SECRET = ZEN;
process.env.CRON_SECRET_EXT = EXT;
process.env.TOKEN_KEYS = `v1:${Buffer.alloc(32, 3).toString("base64")}`;

const spotify = vi.hoisted(() => ({
  paths: [] as string[],
  playing: false,
  stampDown: false,
  hold: null as Promise<void> | null,
  after: [] as Promise<unknown>[],
}));

// after() outside a real request: run the task and let the test await it.
vi.mock("next/server", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  after: (task: (() => unknown) | Promise<unknown>) => {
    spotify.after.push(Promise.resolve().then(() => (typeof task === "function" ? task() : task)));
  },
}));
const flushAfter = async () => {
  while (spotify.after.length) await Promise.all(spotify.after.splice(0));
};

// The real app database, except that the stamp can be made to fail like a store outage.
vi.mock("@/lib/app-db", async (orig) => {
  const real = await orig<typeof import("@/lib/app-db")>();
  return {
    ...real,
    stampTick: (now: number, windowMs: number) =>
      spotify.stampDown ? Promise.reject(new Error("store unavailable")) : real.stampTick(now, windowMs),
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
  // A refresh the test makes fail the way a Spotify outage does.
  if (url.href === "https://accounts.spotify.com/api/token") return new Response("upstream", { status: 503 });
  if (url.origin !== "https://api.spotify.com") throw new Error(`unexpected fetch ${url}`);
  spotify.paths.push(url.pathname);
  if (spotify.hold) await spotify.hold;
  // The probe (PLAN §7.3): /me/player alone; 204 when no device is active.
  if (url.pathname === "/v1/me/player") {
    if (!spotify.playing) return new Response(null, { status: 204 });
    return Response.json({ is_playing: true, progress_ms: 1000, item: TRACK });
  }
  if (url.pathname === "/v1/me/player/recently-played") {
    return Response.json({
      items: [{ track: TRACK, played_at: new Date(Date.now() - 60_000).toISOString(), context: null }],
      next: null,
    });
  }
  throw new Error(`unexpected Spotify call ${url.pathname}`);
});

const appDb = await import("@/lib/app-db");
const { createClient } = await import("@libsql/client");
const { appTokenStore } = await import("@/lib/token-store-app");
const { forUser } = await import("@/lib/db");
const { mintUid } = await import("@/lib/identity");
const { GET } = await import("@/app/api/cron/sync/route");

const OWNER = mintUid(process.env.OWNER_UID as string);
const owner = forUser(OWNER);

const call = (authorization?: string) =>
  GET(new Request("https://lazy-boy.example/api/cron/sync", { headers: authorization ? { authorization } : {} }));
const zen = () => call(`Bearer ${ZEN}`);
// cron-job.org's call as it sees it, then the tick its call started.
const ext = async () => {
  const res = await call(`Bearer ${EXT}`);
  await flushAfter();
  return res;
};
const probes = () => spotify.paths.filter((p) => p === "/v1/me/player").length;
const tickAt = () => appDb.getAppMeta("tick_at");

// Each test starts an hour after the last, so no stamp carries over; the clock moves only when
// a test moves it.
let base = Date.parse("2026-10-16T06:00:00Z");
const at = (ms: number) => vi.setSystemTime(base + ms);

let raw: import("@libsql/client").Client;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  base += 3_600_000;
  at(0);
  spotify.paths.length = 0;
  spotify.playing = false;
  spotify.stampDown = false;
  spotify.hold = null;
  await appDb.getAppMeta("schema_version"); // the first open creates the app database
  raw ??= createClient({ url: appDb.appDatabaseUrl(), intMode: "number" });
  for (const t of ["user_tokens", "sync_state", "events", "users"]) await raw.execute(`DELETE FROM ${t}`);
  await raw.execute("DELETE FROM app_meta WHERE key NOT IN ('schema_version', 'min_reader') AND key NOT LIKE 'sentinel:%'");
  // The admin as Phase 2 leaves him: his row, his encrypted token, the runtime's copy done.
  await raw.execute({
    sql: `INSERT INTO users (uid, account_id, spotify_id, db_name, status, status_at, is_admin, session_epoch, invited_at)
          VALUES (?, 'acct-rem', 'rem-spotify', 'lazyboy', 'active', 0, 1, 0, 0)`,
    args: [OWNER],
  });
  await appTokenStore().set(OWNER, { accessToken: "at-rem", refreshToken: "rt-rem", expiresAt: Math.floor(base / 1000) + 3_600 });
  await appDb.setAppMeta(`token_copy:${OWNER}`, "copied");
  // The daily chores ran a moment ago and the library is not due: one tick's work is the probe,
  // and a harvest when the policy says so.
  await appDb.setAppMeta("daily_at", String(base));
  await raw.execute({
    sql: "INSERT INTO sync_state (uid, state, next_probe_at, next_rescan_at) VALUES (?, 'idle', 0, ?)",
    args: [OWNER, base + 86_400_000],
  });
});
afterEach(async () => {
  await flushAfter();
  vi.useRealTimers();
});

describe("/api/cron/sync, two pingers, Phase 3's tick", () => {
  it("no secret and a wrong one get 401 and do nothing; each caller's secret gets 200 and a tick", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call(EXT)).status).toBe(401);
    expect(spotify.paths).toEqual([]);
    expect(await tickAt()).toBeNull();
    const z = await zen();
    expect(z.status).toBe(200);
    expect(await tickAt()).toBe(String(base));
    at(46_000);
    const e = await ext();
    expect(e.status).toBe(200);
    expect(await tickAt()).toBe(String(base + 46_000));
  });

  it("cron-job.org's reply is a bare {\"ok\":true} whatever the tick did: harvested, guarded, signed out", async () => {
    spotify.playing = true;
    const lastSync = await owner.getLastSync();
    const harvested = await ext();
    expect(harvested.status).toBe(200);
    expect(await harvested.text()).toBe('{"ok":true}');
    expect(spotify.paths).toContain("/v1/me/player/recently-played");
    expect(await owner.getLastSync()).not.toBe(lastSync); // the tick ran and harvested

    at(30_000);
    const guarded = await ext();
    expect(guarded.status).toBe(200);
    expect(await guarded.text()).toBe('{"ok":true}');

    at(200_000);
    await raw.execute({ sql: "DELETE FROM user_tokens WHERE uid = ?", args: [OWNER] });
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

  it("calls within 45 s do one tick's work, a burst does one, and a call 46 s on ticks again", async () => {
    expect((await zen()).status).toBe(200);
    at(30_000);
    expect((await ext()).status).toBe(200);
    at(45_000);
    const guarded = await zen();
    expect(guarded.status).toBe(200);
    expect(await guarded.json()).toEqual({ ok: true, skipped: "recent tick" });
    expect(await tickAt()).toBe(String(base));
    expect(probes()).toBe(1);

    at(46_000);
    expect((await ext()).status).toBe(200);
    expect(await tickAt()).toBe(String(base + 46_000));

    at(400_000);
    const burst = await Promise.all([zen(), ext(), zen(), ext()]);
    expect(burst.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    await flushAfter();
    expect(await tickAt()).toBe(String(base + 400_000));
    // Rem was due once more since the first tick (2 minutes on): one probe for the burst.
    expect(probes()).toBe(2);
  });

  it("a stamp that fails skips the tick: no call gets past the guard without the window", async () => {
    spotify.stampDown = true;
    const z = await zen();
    expect(z.status).toBe(200);
    expect(await z.json()).toEqual({ ok: true, skipped: "store" });
    expect(await (await ext()).text()).toBe('{"ok":true}');
    expect(spotify.paths).toEqual([]);
  });

  it("the Zenbook caller still sees the owner alarm inside the window cron-job.org's tick opened", async () => {
    expect((await ext()).status).toBe(200);
    expect(probes()).toBe(1);
    await raw.execute({ sql: "DELETE FROM user_tokens WHERE uid = ?", args: [OWNER] });
    at(30_000);
    const alarm = await zen();
    expect(alarm.status).toBe(503);
    expect(await alarm.json()).toEqual({ ok: false, error: "no-token" });
    at(60_000);
    const quiet = await ext();
    expect(quiet.status).toBe(200);
    expect(await quiet.text()).toBe('{"ok":true}');
    expect(probes()).toBe(1);
  });

  it("a token that cannot be refreshed right now is no alarm: 200 to the Zenbook, the admin's step backs off", async () => {
    // Carried from tests/capture-health.test.ts's single-user pair ("signed out → 503" is the
    // case above): a token row whose refresh fails at Spotify, not a signed-out admin.
    await appTokenStore().set(OWNER, { accessToken: "at-rem", refreshToken: "rt-rem", expiresAt: Math.floor(base / 1000) - 60 });
    const res = await zen();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, steps: [{ uid: OWNER, outcome: "token-error" }] });
    expect(spotify.paths).toEqual([]);
    const row = await raw.execute({ sql: "SELECT state, failures FROM sync_state WHERE uid = ?", args: [OWNER] });
    expect(row.rows[0]).toMatchObject({ state: "backoff", failures: 1 });
  });
});

