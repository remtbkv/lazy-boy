// T4 (PLAN.md §6.4, §7.2, §7.8): the cron tick with two users. Real app database (the claim, the
// lease, the release), each user's store in memory, a Spotify scripted per bearer. Each user's
// calls carry only their own bearer and their plays land only in their own store; A failing in
// each way the plan names leaves B's outcome `ok`; and the reply arrives within 20 s even when one
// user's Spotify hangs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countRpCall as appQueueCount, getAppMeta } from "@/lib/app-db";
import { mintUid, type Uid } from "@/lib/identity";
import { runOpenApp, runTick } from "@/lib/sync/tick";
import { RefreshError } from "@/lib/token-core";
import { DecryptError } from "@/lib/token-crypto";
import { freshAppDb, seedUser } from "./harness";
import { ZEN, memoryStepStore, stubCronSecrets, tickDeps, tickSpotify, tokenSource, type Script } from "./tick-harness";

const A: Uid = mintUid("aaaaaaaaaaaa");
const B: Uid = mintUid("bbbbbbbbbbbb");
const NOW = Date.UTC(2026, 9, 16, 18, 0);
const MIN = 60_000;

let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number | null> = {}) => (await db.raw().execute({ sql, args })).rows;
let stores: { [k: string]: ReturnType<typeof memoryStepStore> };

const playing = (trackId: string): Script["player"] => ({ trackId, isPlaying: true, progressMs: 5_000 });
const recent = (uid: string) => [
  { trackId: `${uid}-t2`, playedAt: "2026-10-16T17:58:00.000Z" },
  { trackId: `${uid}-t1`, playedAt: "2026-10-16T17:55:00.000Z" },
];
const healthy = (uid: string): Script => ({ player: playing(`${uid}-now`), recent: recent(uid) });

function install(scripts: Record<string, Script>) {
  const spotify = tickSpotify(scripts);
  vi.stubGlobal("fetch", spotify.fetch);
  return spotify;
}

async function row(uid: string) {
  return (await q("SELECT * FROM sync_state WHERE uid = :u", { u: uid }))[0];
}

beforeEach(async () => {
  db = freshAppDb();
  await getAppMeta("schema_version");
  await seedUser(db.raw(), { uid: A, status: "active" });
  await seedUser(db.raw(), { uid: B, status: "active", admin: true });
  // Token rows exist (the owner alarm reads the admin's); their tokens come from tokenSource.
  for (const u of [A, B]) await q("INSERT INTO user_tokens (uid, blob, expires_at, granted_at) VALUES (:u, 'v1.x', 0, 0)", { u });
  stores = { [A]: memoryStepStore(A), [B]: memoryStepStore(B) };
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

describe("T4: two users, one tick", () => {
  it("each user's calls carry their own bearer, and each user's plays land in their own store", async () => {
    const spotify = install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    const { deps } = tickDeps({ now: () => NOW, stores });
    const r = await runTick(deps, ZEN);
    expect(r.status).toBe(200);
    expect(r.body.steps).toEqual(
      expect.arrayContaining([
        { uid: A, outcome: "ok", trigger: "backstop", added: 2 },
        { uid: B, outcome: "ok", trigger: "backstop", added: 2 },
      ]),
    );
    // Calls: one probe and one harvest per user, each with that user's bearer only.
    expect(spotify.calls.filter((c) => c.bearer === `at-${A}`).map((c) => c.path).sort()).toEqual(["/v1/me/player", "/v1/me/player/recently-played"]);
    expect(spotify.calls.filter((c) => c.bearer === `at-${B}`).map((c) => c.path).sort()).toEqual(["/v1/me/player", "/v1/me/player/recently-played"]);
    expect(spotify.calls.every((c) => c.bearer === `at-${A}` || c.bearer === `at-${B}`)).toBe(true);
    expect(stores[A].handed.every((id) => id.startsWith(`${A}-`))).toBe(true);
    expect(stores[B].handed.every((id) => id.startsWith(`${B}-`))).toBe(true);
    expect(stores[A].plays.size).toBe(2);
    expect(stores[B].plays.size).toBe(2);
    expect(stores[A].probe).toMatchObject({ track: `${A}-now`, stoppedAt: null });
    // Released: two minutes on (or onto the uid's phase), the harvest and the success stamped.
    for (const uid of [A, B]) {
      const s = await row(uid);
      expect(s).toMatchObject({ lease_owner: null, last_harvest_at: NOW, last_ok_at: NOW, failures: 0, state: "active" });
      expect(Number(s.next_probe_at) - NOW).toBeGreaterThan(90_000);
      expect(Number(s.next_probe_at) - NOW).toBeLessThanOrEqual(210_000);
    }
    // The brake counted each harvest, before it was made.
    expect((await q("SELECT uid, rp_calls, quota_day FROM sync_state ORDER BY uid")).map((x) => [x.rp_calls, x.quota_day])).toEqual([
      [1, "2026-10-16"],
      [1, "2026-10-16"],
    ]);
  });

  it("A's grant is dead: A stops with its blob kept and an event; B's outcome stays ok", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    const dead = () => {
      throw new RefreshError(true, "invalid_grant");
    };
    const { deps } = tickDeps({ now: () => NOW, stores, tokenFor: tokenSource({ [A]: dead }) });
    const r = await runTick(deps, ZEN);
    const steps = r.body.steps as { uid: string; outcome: string }[];
    expect(steps.find((s) => s.uid === A)?.outcome).toBe("invalid-grant");
    expect(steps.find((s) => s.uid === B)?.outcome).toBe("ok");
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: A }))[0].status).toBe("needs_reconnect");
    expect(await row(A)).toMatchObject({ last_error: "invalid_grant", lease_owner: null });
    expect(await q("SELECT uid, code FROM events")).toEqual([{ uid: A, code: "invalid-grant" }]);
    expect(stores[A].plays.size).toBe(0);
    expect(stores[B].plays.size).toBe(2);
  });

  it("…and 10 minutes on, one confirming refresh brings A back when the grant works again", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    let grant: "dead" | "alive" = "dead";
    const tokenFor = tokenSource({
      [A]: () => {
        if (grant === "dead") throw new RefreshError(true, "invalid_grant");
        return { uid: A, accessToken: `at-${A}`, refreshToken: "rt", expiresAt: 4_000_000_000 };
      },
    });
    let t = NOW;
    const { deps } = tickDeps({ now: () => t, stores, tokenFor });
    await runTick(deps, ZEN);
    t = NOW + 5 * MIN;
    await runTick(deps, ZEN);
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: A }))[0].status).toBe("needs_reconnect");
    grant = "alive";
    t = NOW + 11 * MIN;
    await runTick(deps, ZEN);
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: A }))[0].status).toBe("active");
    expect(await row(A)).toMatchObject({ last_error: null, next_probe_at: NOW + 11 * MIN });
  });

  it("…a confirmation that fails again is recorded once and not repeated", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    let refreshes = 0;
    const tokenFor = tokenSource({
      [A]: () => {
        refreshes++;
        throw new RefreshError(true, "invalid_grant");
      },
    });
    let t = NOW;
    const { deps } = tickDeps({ now: () => t, stores, tokenFor });
    await runTick(deps, ZEN);
    for (const m of [11, 13, 15]) {
      t = NOW + m * MIN;
      await runTick(deps, ZEN);
    }
    expect(refreshes).toBe(2);
    expect(await row(A)).toMatchObject({ last_error: "invalid_grant:confirmed" });
  });

  it("A and the admin both hit within 24 hours: an app-wide event, data kept", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    const dead = () => {
      throw new RefreshError(true, "invalid_grant");
    };
    const { deps } = tickDeps({ now: () => NOW, stores, tokenFor: tokenSource({ [A]: dead, [B]: dead }) });
    await runTick(deps, ZEN);
    expect((await q("SELECT code FROM events WHERE code = 'grant-wide'")).length).toBe(1);
    expect((await q("SELECT status FROM users ORDER BY uid")).map((x) => x.status)).toEqual(["needs_reconnect", "needs_reconnect"]);
  });

  it("A has no token row: no Spotify call with anyone's bearer for A, A stays on the 2-minute cadence; B ok", async () => {
    const spotify = install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    const { deps } = tickDeps({ now: () => NOW, stores, tokenFor: tokenSource({ [A]: () => null }) });
    const r = await runTick(deps, ZEN);
    const steps = r.body.steps as { uid: string; outcome: string }[];
    expect(steps.find((s) => s.uid === A)?.outcome).toBe("no-token");
    expect(steps.find((s) => s.uid === B)?.outcome).toBe("ok");
    expect(spotify.calls.every((c) => c.bearer === `at-${B}`)).toBe(true);
    expect(await row(A)).toMatchObject({ state: "idle", failures: 0, last_error: "no-token", next_probe_at: NOW + 2 * MIN });
  });

  it("Spotify fails A with a 5xx: A backs off alone; B's outcome stays ok", async () => {
    install({ [`at-${A}`]: { player: playing(`${A}-now`), recent: 502 }, [`at-${B}`]: healthy(B) });
    const { deps } = tickDeps({ now: () => NOW, stores });
    const r = await runTick(deps, ZEN);
    const steps = r.body.steps as { uid: string; outcome: string }[];
    expect(steps.find((s) => s.uid === A)?.outcome).toBe("spotify-error");
    expect(steps.find((s) => s.uid === B)?.outcome).toBe("ok");
    expect(await row(A)).toMatchObject({ state: "backoff", failures: 1, last_error: "spotify-error", next_probe_at: NOW + 2 * MIN });
    expect(await row(B)).toMatchObject({ state: "active", failures: 0 });
  });

  it("A's token does not decrypt: nothing about A is written, the lease lapses; B ok", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    const bad = () => {
      throw new DecryptError("bad tag");
    };
    const { deps } = tickDeps({ now: () => NOW, stores, tokenFor: tokenSource({ [A]: bad }) });
    const before = await row(A);
    const r = await runTick(deps, ZEN);
    const steps = r.body.steps as { uid: string; outcome: string }[];
    expect(steps.find((s) => s.uid === A)?.outcome).toBe("decrypt");
    expect(steps.find((s) => s.uid === B)?.outcome).toBe("ok");
    const after = await row(A);
    expect(after).toMatchObject({ lease_owner: expect.any(String), failures: 0, last_error: null, state: "idle" });
    expect(before).toBeUndefined();
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: A }))[0].status).toBe("active");
  });

  it("a 403 that does not say \"not registered\" is an ordinary failure: A backs off, nobody is removed", async () => {
    install({ [`at-${A}`]: { player: 403 }, [`at-${B}`]: healthy(B) });
    const { deps } = tickDeps({ now: () => NOW, stores });
    const r = await runTick(deps, ZEN);
    const steps = r.body.steps as { uid: string; outcome: string }[];
    expect(steps.find((s) => s.uid === A)?.outcome).toBe("spotify-error");
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: A }))[0].status).toBe("active");
  });

  /** Spotify refusing the given users with its "not registered" 403; everyone else healthy. */
  function refuse(...uids: string[]) {
    const spotify = tickSpotify({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    const inner = spotify.fetch.getMockImplementation()!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const bearer = new Headers(init?.headers).get("authorization");
        if (uids.some((u) => bearer === `Bearer at-${u}`)) {
          return new Response("Check settings on developer.spotify.com/dashboard, the user may not be registered.", { status: 403 });
        }
        return inner(input, init);
      }),
    );
  }
  const statuses = async () => (await q("SELECT uid, status FROM users ORDER BY uid")).map((x) => [x.uid, x.status]);

  it("…with Spotify's own words, A is removed at its second refusal while B, the admin, keeps working", async () => {
    refuse(A);
    const r = await runTick(tickDeps({ now: () => NOW, stores }).deps, ZEN);
    const steps = r.body.steps as { uid: string; outcome: string }[];
    expect(steps.find((s) => s.uid === A)?.outcome).toBe("not-registered");
    expect(steps.find((s) => s.uid === B)?.outcome).toBe("ok");
    // One refusal proves nothing about A alone: B's success came in the same moment.
    expect(await statuses()).toEqual([
      [A, "active"],
      [B, "active"],
    ]);
    expect(await row(A)).toMatchObject({ state: "backoff", last_error: "not-registered" });
    // Refused again after its backoff, with B served since: A alone is not registered.
    await runTick(tickDeps({ now: () => NOW + 4 * MIN, stores }).deps, ZEN);
    expect(await statuses()).toEqual([
      [A, "removed"],
      [B, "active"],
    ]);
  });

  it("every user refused that way at once (the owner's Premium lapsing): nobody is removed, everyone backs off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("the user may not be registered", { status: 403 })));
    const { deps } = tickDeps({ now: () => NOW, stores });
    const r = await runTick(deps, ZEN);
    expect((r.body.steps as { outcome: string }[]).map((s) => s.outcome)).toEqual(["not-registered", "not-registered"]);
    expect((await q("SELECT status FROM users ORDER BY uid")).map((x) => x.status)).toEqual(["active", "active"]);
    expect((await q("SELECT state FROM sync_state ORDER BY uid")).map((x) => x.state)).toEqual(["backoff", "backoff"]);
  });

  it("…and when both had been working until that tick: their earlier successes do not count, nobody is removed", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    await runTick(tickDeps({ now: () => NOW, stores }).deps, ZEN);
    refuse(A, B);
    for (const m of [4, 8, 16]) await runTick(tickDeps({ now: () => NOW + m * MIN, stores }).deps, ZEN);
    expect(await statuses()).toEqual([
      [A, "active"],
      [B, "active"],
    ]);
    expect((await q("SELECT state, last_error FROM sync_state ORDER BY uid")).map((x) => [x.state, x.last_error])).toEqual([
      ["backoff", "not-registered"],
      ["backoff", "not-registered"],
    ]);
  });

  it("…and when the refusals begin on different minutes (users on different ticks): B's success before the onset does not remove A", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    await runTick(tickDeps({ now: () => NOW, stores }).deps, ZEN);
    refuse(A, B);
    // A's minute: B is not due, its last success (at NOW) came before anything was refused.
    await q("UPDATE sync_state SET next_probe_at = :t WHERE uid = :u", { t: NOW + 3 * MIN, u: B });
    await q("UPDATE sync_state SET next_probe_at = :t WHERE uid = :u", { t: NOW + 2 * MIN, u: A });
    await runTick(tickDeps({ now: () => NOW + 2 * MIN, stores }).deps, ZEN);
    // B's minute, then A's second refusal, then both again.
    for (const m of [3, 4, 8, 12]) await runTick(tickDeps({ now: () => NOW + m * MIN, stores }).deps, ZEN);
    expect(await statuses()).toEqual([
      [A, "active"],
      [B, "active"],
    ]);
  });

  it("the admin refused that way while a friend keeps working is never removed: he backs off", async () => {
    refuse(B);
    for (const m of [0, 4, 8]) await runTick(tickDeps({ now: () => NOW + m * MIN, stores }).deps, ZEN);
    expect(await statuses()).toEqual([
      [A, "active"],
      [B, "active"],
    ]);
    expect(await row(B)).toMatchObject({ state: "backoff", last_error: "not-registered" });
  });

  it(
    "A's Spotify hangs: A is abandoned at its 15 s deadline and backs off, B is ok, the reply is inside 20 s",
    async () => {
      install({ [`at-${A}`]: { player: "hang" }, [`at-${B}`]: healthy(B) });
      const { deps } = tickDeps({ now: () => NOW, stores });
      const t0 = Date.now();
      const r = await runTick(deps, ZEN);
      const took = Date.now() - t0;
      expect(took).toBeLessThan(20_000);
      expect(took).toBeGreaterThanOrEqual(15_000);
      const steps = r.body.steps as { uid: string; outcome: string }[];
      expect(steps.find((s) => s.uid === A)?.outcome).toBe("timeout");
      expect(steps.find((s) => s.uid === B)?.outcome).toBe("ok");
      expect(await row(A)).toMatchObject({ state: "backoff", last_error: "timeout", lease_owner: null });
      expect(stores[B].plays.size).toBe(2);
    },
    40_000,
  );

  it("whatever is unfinished at the reply goes to after(), and the reply says which steps are pending", async () => {
    install({ [`at-${A}`]: { player: "hang" }, [`at-${B}`]: healthy(B) });
    const { deps, afters } = tickDeps({ now: () => NOW, stores, config: { stepMs: 400, replyMs: 150 } });
    const t0 = Date.now();
    const r = await runTick(deps, ZEN);
    expect(Date.now() - t0).toBeLessThan(400);
    expect(r.body.after).toBe(true);
    expect((r.body.steps as { uid: string; outcome: string }[]).find((s) => s.uid === A)?.outcome).toBe("pending");
    expect(afters.length).toBeGreaterThanOrEqual(1);
    await Promise.all(afters);
    expect(await row(A)).toMatchObject({ last_error: "timeout", lease_owner: null });
  });
});

describe("T4: the lease and the brake's counter, through the tick", () => {
  it("a step that outlived its lease writes nothing to the queue, and the user is claimable once the lease runs out", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    // B is not due; A's store takes longer than the 50-s lease to record its harvest, so A's step
    // finishes ok but its release comes after the lease ran out.
    await q("INSERT INTO sync_state (uid, state, next_probe_at) VALUES (:u, 'idle', :t)", { u: B, t: NOW + 3_600_000 });
    const record = stores[A].store.recordHarvest;
    let slow = true;
    stores[A].store.recordHarvest = async (plays, sp) => {
      if (slow) {
        slow = false;
        const real = Date.now.bind(Date);
        vi.spyOn(Date, "now").mockImplementation(() => real() + 60_000);
      }
      return record(plays, sp);
    };
    const r = await runTick(tickDeps({ now: () => NOW, stores }).deps, ZEN);
    vi.mocked(Date.now).mockRestore();
    expect((r.body.steps as { uid: string; outcome: string }[]).find((s) => s.uid === A)?.outcome).toBe("ok");
    expect(await row(A)).toMatchObject({ lease_owner: expect.any(String), next_probe_at: NOW, last_ok_at: null, last_harvest_at: null });
    // After lease_until (NOW + 50 s) the user is due again and the next tick's release lands.
    await runTick(tickDeps({ now: () => NOW + 51_000, stores }).deps, ZEN);
    expect(await row(A)).toMatchObject({ lease_owner: null, last_ok_at: NOW + 51_000 });
  });

  it("a dead grant met by a slow store still gets its confirmation 10 minutes on (§5.4 step 2)", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    let grant: "dead" | "alive" = "dead";
    const tokenFor = tokenSource({
      [A]: () => {
        if (grant === "dead") throw new RefreshError(true, "invalid_grant");
        return { uid: A, accessToken: `at-${A}`, refreshToken: "rt", expiresAt: 4_000_000_000 };
      },
    });
    // The status write takes longer than what is left of the 50-s lease.
    const first = tickDeps({ now: () => NOW, stores, tokenFor });
    const moveStatus = first.deps.queue.moveStatus;
    first.deps.queue = {
      ...first.deps.queue,
      moveStatus: async (...args) => {
        const real = Date.now.bind(Date);
        vi.spyOn(Date, "now").mockImplementation(() => real() + 60_000);
        return moveStatus(...args);
      },
    };
    await runTick(first.deps, ZEN);
    vi.mocked(Date.now).mockRestore();
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: A }))[0].status).toBe("needs_reconnect");
    grant = "alive";
    await runTick(tickDeps({ now: () => NOW + 11 * MIN, stores, tokenFor }).deps, ZEN);
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: A }))[0].status).toBe("active");
  });

  it("the brake counts a harvest before it is made, and counts one Spotify refuses (§7.5 item 1)", async () => {
    const spotify = install({ [`at-${A}`]: { player: playing(`${A}-now`), recent: 502 }, [`at-${B}`]: healthy(B) });
    const harvestsBefore: number[] = [];
    const { deps } = tickDeps({ now: () => NOW, stores });
    deps.queue = {
      ...deps.queue,
      countRpCall: async (uid, day) => {
        harvestsBefore.push(spotify.calls.filter((c) => c.bearer === `at-${uid}` && c.path.endsWith("/recently-played")).length);
        return appQueueCount(uid, day);
      },
    };
    await runTick(deps, ZEN);
    expect(harvestsBefore).toEqual([0, 0]);
    expect((await q("SELECT uid, rp_calls FROM sync_state ORDER BY uid")).map((x) => [x.uid, x.rp_calls])).toEqual([
      [A, 1],
      [B, 1],
    ]);
  });
});

describe("T4: the rest of the tick", () => {
  it("at most one library rescan a tick, after the harvests, for a user whose step succeeded", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    const { deps } = tickDeps({ now: () => NOW, stores });
    const r = await runTick(deps, ZEN);
    expect(stores[A].rescans + stores[B].rescans).toBe(1);
    const who = r.body.rescan as string;
    expect([A, B]).toContain(who);
    expect(Number((await row(who)).next_rescan_at)).toBe(NOW + 30 * MIN);
  });

  it("no rescan when less than 10 s of the 20 remain", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    const { deps } = tickDeps({ now: () => NOW, stores, config: { replyMs: 5_000 } });
    await runTick(deps, ZEN);
    expect(stores[A].rescans + stores[B].rescans).toBe(0);
  });

  it("the daily chores run in after() when daily_at is over 26 hours old, under lock:daily, once", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    let t = NOW;
    const { deps, afters, daily } = tickDeps({ now: () => t, stores });
    const r = await runTick(deps, ZEN);
    expect(r.body.daily).toBe("started");
    await Promise.all(afters);
    expect(daily).toHaveBeenCalledTimes(1);
    expect(await getAppMeta("daily_at")).toBe(String(NOW));
    expect(await getAppMeta("lock:daily")).toBeNull();
    t = NOW + 25 * 3_600_000;
    await runTick(deps, ZEN);
    t = NOW + 26 * 3_600_000 + MIN;
    await runTick(deps, ZEN);
    await Promise.all(afters);
    expect(daily).toHaveBeenCalledTimes(2);
  });

  it("chores held by another tick's lock are not run twice", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    await q("INSERT INTO app_meta (key, value) VALUES ('lock:daily', :v)", { v: `${Date.now() + 600_000}:other` });
    const { deps, afters, daily } = tickDeps({ now: () => NOW, stores });
    await runTick(deps, ZEN);
    await Promise.all(afters);
    expect(daily).not.toHaveBeenCalled();
  });

  it("the open app catches up a change the brake held back, under the same lease", async () => {
    install({ [`at-${A}`]: { player: playing(`${A}-now`), recent: recent(A) }, [`at-${B}`]: healthy(B) });
    const { deps } = tickDeps({ now: () => NOW, stores, config: { brakeOn: true } });
    await runTick(deps, ZEN);
    // Brake on, A far past the app's budget: changes now wait 30 minutes, except on opening the app.
    await q("UPDATE sync_state SET rp_calls = 500, quota_day = '2026-10-16' WHERE uid = :u", { u: A });
    stores[A].probe = { ...stores[A].probe!, changes: 2 };
    const later = tickDeps({ now: () => NOW + 3 * MIN, stores, config: { brakeOn: true } });
    install({ [`at-${A}`]: { player: { trackId: `${A}-now`, isPlaying: true, progressMs: 185_000 }, recent: recent(A) } });
    expect(await runOpenApp(later.deps, { uid: A, load: true })).toEqual({ ran: true, outcome: "ok", trigger: "open-app" });
    expect(await row(A)).toMatchObject({ last_harvest_at: NOW + 3 * MIN, lease_owner: null });
  });

  it("the tab's own timer stands in only when no tick has stamped for 5 minutes", async () => {
    install({ [`at-${A}`]: healthy(A), [`at-${B}`]: healthy(B) });
    const { deps } = tickDeps({ now: () => NOW, stores });
    await runTick(deps, ZEN);
    const soon = tickDeps({ now: () => NOW + 4 * MIN, stores });
    expect(await runOpenApp(soon.deps, { uid: A, load: false })).toEqual({ ran: false, reason: "cron" });
    const late = tickDeps({ now: () => NOW + 6 * MIN, stores });
    expect(await runOpenApp(late.deps, { uid: A, load: false })).toMatchObject({ ran: true, outcome: "ok" });
  });
});
