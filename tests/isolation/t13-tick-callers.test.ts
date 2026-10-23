// T13 (PLAN.md §6.4, §7.2 steps 0-1, security R14): who may call the tick and what each caller is
// told. No secret and a wrong one are refused; the Zenbook's caller alone hears the owner alarm and
// the per-user outcomes; cron-job.org's always gets a bare {"ok":true}, whatever happened; and a
// burst of calls inside the stamp's window does one tick's work.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppMeta } from "@/lib/app-db";
import { mintUid, type Uid } from "@/lib/identity";
import { ownerAlarm, runTick, type TickReply } from "@/lib/sync/tick";
import { freshAppDb, seedUser } from "./harness";
import { EXT, ZEN, memoryStepStore, stubCronSecrets, tickDeps, tickSpotify, tokenSource, type Script } from "./tick-harness";

const A: Uid = mintUid("aaaaaaaaaaaa");
const ADMIN: Uid = mintUid("rrrrrrrrrrrr");
const NOW = Date.UTC(2026, 9, 16, 18, 0);
const BARE = { status: 200, body: { ok: true } };
// What the caller hears; `detail` is the tests' own view of the steps and is never sent.
const said = ({ status, body }: TickReply) => ({ status, body });

let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number | null> = {}) => (await db.raw().execute({ sql, args })).rows;
let stores: { [k: string]: ReturnType<typeof memoryStepStore> };
let spotify: ReturnType<typeof tickSpotify>;

const healthy = (uid: string): Script => ({
  player: { trackId: `${uid}-now`, isPlaying: true, progressMs: 1_000 },
  recent: [{ trackId: `${uid}-t1`, playedAt: "2026-10-16T17:55:00.000Z" }],
});

beforeEach(async () => {
  db = freshAppDb();
  await getAppMeta("schema_version");
  await seedUser(db.raw(), { uid: ADMIN, status: "active", admin: true });
  await seedUser(db.raw(), { uid: A, status: "active" });
  for (const u of [A, ADMIN]) await q("INSERT INTO user_tokens (uid, blob, expires_at, granted_at) VALUES (:u, 'v1.x', 0, 0)", { u });
  stores = { [A]: memoryStepStore(A), [ADMIN]: memoryStepStore(ADMIN) };
  spotify = tickSpotify({ [`at-${A}`]: healthy(A), [`at-${ADMIN}`]: healthy(ADMIN) });
  vi.stubGlobal("fetch", spotify.fetch);
  stubCronSecrets();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("T13: the caller, named by its secret", () => {
  it("no secret, a wrong one, a near miss, or either secret unset and sent empty: 401, and nothing runs", async () => {
    const { deps } = tickDeps({ now: () => NOW, stores });
    for (const h of [null, "", "Bearer", "Bearer nope", "Bearer zen-secret ", "zen-secret", "Bearer ext-secretx"]) {
      expect(await runTick(deps, h)).toEqual({ status: 401, body: { ok: false, error: "forbidden" } });
    }
    vi.stubEnv("CRON_SECRET_EXT", "");
    expect((await runTick(deps, "Bearer ")).status).toBe(401);
    expect(spotify.calls).toEqual([]);
    expect(await getAppMeta("tick_at")).toBeNull();
  });

  it("the Zenbook's caller gets one outcome per user: codes and counts, no data", async () => {
    const { deps } = tickDeps({ now: () => NOW, stores });
    const r = await runTick(deps, ZEN);
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    for (const leak of ["-t1", "-now", "name ", "artist ", "at-"]) expect(body).not.toContain(leak);
    expect((r.body.steps as unknown[]).length).toBe(2);
  });

  it("cron-job.org's caller (CRON_SECRET_EXT) does the same work and hears only {\"ok\":true}", async () => {
    const { deps, afters } = tickDeps({ now: () => NOW, stores });
    expect(await runTick(deps, EXT)).toEqual(BARE);
    await Promise.all(afters); // its tick runs after the reply
    expect(stores[A].plays.size).toBe(1);
    expect(stores[ADMIN].plays.size).toBe(1);
  });
});

describe("T13: what each caller's reply can say about anyone's listening (security R14, RULES 11)", () => {
  it("cron-job.org hears {\"ok\":true} before the tick starts: a step hanging on Spotify does not hold its reply", async () => {
    spotify = tickSpotify({ [`at-${A}`]: { player: "hang" }, [`at-${ADMIN}`]: healthy(ADMIN) });
    vi.stubGlobal("fetch", spotify.fetch);
    const { deps, afters } = tickDeps({ now: () => NOW, stores, config: { stepMs: 300 } });
    const t0 = Date.now();
    expect(await runTick(deps, EXT)).toEqual(BARE);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(afters.length).toBe(1);
    await Promise.all(afters);
    expect(stores[ADMIN].plays.size).toBe(1); // the tick ran in full after the reply
  });

  it("the Zenbook hears the admin's step in full and a friend's by its code alone", async () => {
    const { deps } = tickDeps({ now: () => NOW, stores });
    const r = await runTick(deps, ZEN);
    expect(r.body.steps).toEqual(
      expect.arrayContaining([
        { uid: ADMIN, outcome: "ok", trigger: "backstop", added: 1 },
        { uid: A, outcome: "ok" },
      ]),
    );
    // The tick did harvest A: only the reply leaves it out.
    expect(r.detail?.steps).toContainEqual({ uid: A, outcome: "ok", trigger: "backstop", added: 1 });
  });
});

describe("T13: the owner alarm, for the Zenbook's caller only", () => {

  it("the admin needs to reconnect: the Zenbook hears 503, cron-job.org a bare 200", async () => {
    await q("UPDATE users SET status = 'needs_reconnect' WHERE uid = :u", { u: ADMIN });
    const { deps } = tickDeps({ now: () => NOW, stores });
    expect(said(await runTick(deps, ZEN))).toEqual({ status: 503, body: { ok: false, error: "admin-status" } });
    const later = tickDeps({ now: () => NOW + 60_000, stores });
    expect(await runTick(later.deps, EXT)).toEqual(BARE);
  });

  it("the admin has no token row: 503 to the Zenbook, even on a tick the stamp skips", async () => {
    await q("DELETE FROM user_tokens WHERE uid = :u", { u: ADMIN });
    const { deps } = tickDeps({ now: () => NOW, stores });
    await runTick(tickDeps({ now: () => NOW - 10_000, stores }).deps, EXT);
    expect(await runTick(deps, ZEN)).toEqual({ status: 503, body: { ok: false, error: "no-token" } });
  });

  it("two users failed to decrypt in the last tick: 503 to the Zenbook, read before anything else", async () => {
    const { DecryptError } = await import("@/lib/token-crypto");
    const bad = () => {
      throw new DecryptError("bad tag");
    };
    // cron-job.org's tick meets the bad blobs; the events land in the app database.
    await q("INSERT INTO events (at, uid, code) VALUES (:t, :a, 'decrypt'), (:t, :b, 'decrypt')", { t: NOW + 1, a: A, b: ADMIN });
    const ext = tickDeps({ now: () => NOW, stores, tokenFor: tokenSource({ [A]: bad, [ADMIN]: bad }) });
    expect(await runTick(ext.deps, EXT)).toEqual(BARE);
    await Promise.all(ext.afters);
    // The Zenbook's tick a minute later answers from them, whichever pinger did the work.
    const zen = tickDeps({ now: () => NOW + 60_000, stores });
    expect(said(await runTick(zen.deps, ZEN))).toEqual({ status: 503, body: { ok: false, error: "decrypt" } });
  });

  it("…and in its own tick, when the admin's blob fails", async () => {
    const { DecryptError } = await import("@/lib/token-crypto");
    const bad = () => {
      throw new DecryptError("bad tag");
    };
    const { deps } = tickDeps({ now: () => NOW, stores, tokenFor: tokenSource({ [ADMIN]: bad }) });
    expect(said(await runTick(deps, ZEN))).toEqual({ status: 503, body: { ok: false, error: "decrypt" } });
  });

  it("one friend failing to decrypt is not the owner's alarm", async () => {
    const { DecryptError } = await import("@/lib/token-crypto");
    const bad = () => {
      throw new DecryptError("bad tag");
    };
    const { deps } = tickDeps({ now: () => NOW, stores, tokenFor: tokenSource({ [A]: bad }) });
    expect((await runTick(deps, ZEN)).status).toBe(200);
  });

  it("the verdict's known answers", () => {
    const ok = { adminStatus: "active", adminHasToken: true, decryptUsers: 0, adminDecrypt: false };
    expect(ownerAlarm(ok)).toBeNull();
    expect(ownerAlarm({ ...ok, adminStatus: null })).toBe("no-admin");
    expect(ownerAlarm({ ...ok, adminStatus: "needs_reconnect" })).toBe("admin-status");
    expect(ownerAlarm({ ...ok, adminHasToken: false })).toBe("no-token");
    expect(ownerAlarm({ ...ok, decryptUsers: 1 })).toBeNull();
    expect(ownerAlarm({ ...ok, decryptUsers: 2 })).toBe("decrypt");
    expect(ownerAlarm({ ...ok, decryptUsers: 1, adminDecrypt: true })).toBe("decrypt");
  });
});

describe("T13: the stamp", () => {
  it("a burst inside the window does one tick's work, whichever caller sends it", async () => {
    const { deps, afters } = tickDeps({ now: () => NOW, stores });
    const replies = await Promise.all([ZEN, EXT, ZEN, EXT, ZEN, ZEN, EXT].map((h) => runTick(deps, h)));
    await Promise.all(afters);

    // One probe per user, once.
    expect(spotify.calls.filter((c) => c.path === "/v1/me/player").length).toBe(2);
    const worked = replies.filter((r) => Array.isArray(r.body.steps));
    expect(worked.length).toBeLessThanOrEqual(1);
    for (const r of replies) expect(r.status).toBe(200);
    // Inside the window, later calls do nothing either.
    const soon = tickDeps({ now: () => NOW + 44_000, stores });
    expect(await runTick(soon.deps, ZEN)).toEqual({ status: 200, body: { ok: true, skipped: "recent tick" } });
    expect(spotify.calls.filter((c) => c.path === "/v1/me/player").length).toBe(2);
  });

  it("pingers a minute apart both tick; the interim pinger's 90 s window lets every other one through", async () => {
    for (const [windowMs, expected] of [
      [45_000, 4],
      [90_000, 2],
    ] as const) {
      await q("DELETE FROM app_meta WHERE key = 'tick_at'");
      let ticked = 0;
      for (let i = 0; i < 4; i++) {
        const at = NOW + (windowMs === 45_000 ? 0 : 3_600_000) + i * 60_000;
        const { deps } = tickDeps({ now: () => at, stores, config: { stampWindowMs: windowMs } });
        await runTick(deps, i % 2 ? EXT : ZEN);
        if ((await getAppMeta("tick_at")) === String(at)) ticked++;
      }
      expect(ticked, `window ${windowMs}`).toBe(expected);
    }
  });

  it("cron-job.org's replies carry no per-user data in any outcome: worked, skipped, store down, alarm", async () => {
    const { deps } = tickDeps({ now: () => NOW, stores });
    expect(await runTick(deps, EXT)).toEqual(BARE);
    expect(await runTick(deps, EXT)).toEqual(BARE);
    await q("UPDATE users SET status = 'needs_reconnect' WHERE uid = :u", { u: ADMIN });
    expect(await runTick(tickDeps({ now: () => NOW + 120_000, stores }).deps, EXT)).toEqual(BARE);
    const down = tickDeps({ now: () => NOW + 240_000, stores });
    down.deps.queue = { ...down.deps.queue, stampTick: async () => Promise.reject(new Error("store down")) };
    expect(await runTick(down.deps, EXT)).toEqual(BARE);
    expect(await runTick(down.deps, ZEN)).toEqual({ status: 503, body: { ok: false, error: "admin-status" } });
  });

  it("the store down at the claim: the tick ends there, the Zenbook hears it, no Spotify call", async () => {
    const { deps } = tickDeps({ now: () => NOW, stores });
    deps.queue = { ...deps.queue, claimDueUsers: async () => Promise.reject(new Error("store down")) };
    expect(await runTick(deps, ZEN)).toEqual({ status: 200, body: { ok: true, skipped: "store" } });
    expect(spotify.calls).toEqual([]);
  });
});
