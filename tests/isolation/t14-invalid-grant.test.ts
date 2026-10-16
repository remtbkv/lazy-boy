// T14 (PLAN.md §5.4, §6.4; decision 21 as ruled): invalid_grant is a question, not a verdict. One
// friend's, confirmed 10 minutes later, is a revocation with day 4 scheduled (status_at, the first
// failure, is the clock); two users within the window, or the admin, is Spotify's event and deletes
// nothing; an old grant has expired and waits; the admin is never revoked. On the request path the
// user stops with the row kept, exactly as the tick does, and a dead grant is not re-sent to Spotify
// at every request; a refresh racing a sign-in leaves the sign-in's grant.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppMeta, markGrantDead } from "@/lib/app-db";
import { runPhase4aChores } from "@/lib/daily-4a";
import { confirmedDeadGrant, EXPIRY_AGE_S } from "@/lib/grant-policy";
import { mintUid, type Uid } from "@/lib/identity";
import { runTick } from "@/lib/sync/tick";
import { createTokenCore, RefreshError } from "@/lib/token-core";
import { appTokenStore } from "@/lib/token-store-app";
import { expectRefreshLosesToSignIn, freshAppDb, scriptedSpotify, seedUser } from "./harness";
import { ZEN, memoryStepStore, stubCronSecrets, tickDeps, tickSpotify, tokenSource, type Script } from "./tick-harness";

const R: Uid = mintUid("rrrrrrrrrrrr"); // the admin
const X: Uid = mintUid("xxxxxxxxxxxx");
const Y: Uid = mintUid("yyyyyyyyyyyy");
const NOW = Date.UTC(2026, 9, 16, 18, 0);
const NOW_S = Math.floor(NOW / 1000);
const MIN = 60_000;
const DAY = 86_400_000;

let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number | null> = {}) => (await db.raw().execute({ sql, args })).rows;
const status = async (uid: string) => (await q("SELECT status, status_at FROM users WHERE uid = :u", { u: uid }))[0];
const codes = async () => (await q("SELECT uid, code FROM events ORDER BY id")).map((r) => `${r.code}:${r.uid ?? "-"}`);
const healthy = (uid: string): Script => ({ player: { trackId: `${uid}-now`, isPlaying: true, progressMs: 5_000 }, recent: [] });
const dead = () => {
  throw new RefreshError(true, "invalid_grant");
};

describe("T14 through the tick", () => {
  let stores: Record<string, ReturnType<typeof memoryStepStore>>;
  beforeEach(async () => {
    db = freshAppDb();
    await getAppMeta("schema_version");
    await seedUser(db.raw(), { uid: R, status: "active", admin: true });
    await seedUser(db.raw(), { uid: X, status: "active" });
    await seedUser(db.raw(), { uid: Y, status: "active" });
    // Young grants (ten days old) unless a test ages one.
    for (const u of [R, X, Y]) await q("INSERT INTO user_tokens (uid, blob, expires_at, granted_at) VALUES (:u, 'v1.x', 0, :g)", { u, g: NOW_S - 10 * 86_400 });
    stores = { [R]: memoryStepStore(R), [X]: memoryStepStore(X), [Y]: memoryStepStore(Y) };
    vi.stubGlobal("fetch", tickSpotify({ [`at-${R}`]: healthy(R), [`at-${X}`]: healthy(X), [`at-${Y}`]: healthy(Y) }).fetch);
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

  async function ticks(deadUsers: Uid[], at: number[]) {
    let t = at[0];
    const { deps } = tickDeps({ now: () => t, stores, tokenFor: tokenSource(Object.fromEntries(deadUsers.map((u) => [u, dead]))) });
    for (const x of at) {
      t = x;
      await runTick(deps, ZEN);
    }
  }

  it("one friend's, confirmed 10 minutes later: revoked, its clock the first failure, Rem alarmed, nothing deleted yet", async () => {
    await ticks([X], [NOW, NOW + 11 * MIN]);
    expect(await status(X)).toEqual({ status: "revoked", status_at: NOW });
    expect(await codes()).toEqual([`invalid-grant:${X}`, `revoked:${X}`]);
    expect((await q("SELECT count(*) AS n FROM user_tokens WHERE uid = :u", { u: X }))[0].n).toBe(1);
    expect((await status(Y)).status).toBe("active");
  });

  it("two users inside the window: an app-wide event, both kept needs_reconnect, nobody revoked", async () => {
    await ticks([X, Y], [NOW, NOW + 11 * MIN, NOW + 13 * MIN, NOW + 15 * MIN]);
    expect((await status(X)).status).toBe("needs_reconnect");
    expect((await status(Y)).status).toBe("needs_reconnect");
    const c = await codes();
    expect(c).toContain("grant-wide:-");
    expect(c.filter((x) => x.startsWith("revoked"))).toEqual([]);
  });

  it("the admin's confirmed dead grant: needs_reconnect and an app-wide event, never revoked", async () => {
    await ticks([R], [NOW, NOW + 11 * MIN, NOW + 13 * MIN]);
    expect((await status(R)).status).toBe("needs_reconnect");
    expect((await codes()).filter((x) => x.startsWith("revoked"))).toEqual([]);
  });

  // Lane 09's review: a friend already revoked when a second user's grant dies inside 24 hours is
  // part of the same app-wide event (§5.4 step 3: everyone stays needs_reconnect, nothing is
  // scheduled), whether the second failure comes through the request path, which records no
  // `grant-wide` event, or through the tick, whose event holds deletions only four days.
  const dayFour = (now: number) => {
    const deleted: string[] = [];
    const deps = {
      now: () => now,
      deleteAccount: async (uid: string) => (deleted.push(uid), { kind: "done" as const }),
      withdrawInvite: async () => ({ kind: "done" as const }),
      reenableJobs: async () => "skipped",
    };
    return { deleted, run: () => runPhase4aChores(deps) };
  };

  it("a revoked friend is not deleted when a second user's grant dies on the request path inside 24 hours", async () => {
    await ticks([X], [NOW, NOW + 11 * MIN]);
    expect((await status(X)).status).toBe("revoked");
    await markGrantDead(Y, NOW + 300 * MIN);
    const d = dayFour(NOW + 3 * DAY + 60 * MIN);
    const out = await d.run();
    expect(d.deleted).toEqual([]);
    expect(out.deletions).toContain("held:app-wide");
    expect((await status(X)).status).toBe("needs_reconnect");
  });

  it("a revoked friend is not deleted once the tick's grant-wide hold has lapsed", async () => {
    await ticks([X], [NOW, NOW + 11 * MIN]);
    await ticks([X, Y], [NOW + 300 * MIN, NOW + 311 * MIN]);
    expect((await codes())).toContain("grant-wide:-");
    expect((await status(Y)).status).toBe("needs_reconnect");
    const d = dayFour(NOW + 4 * DAY + 360 * MIN);
    await d.run();
    expect(d.deleted).toEqual([]);
    expect((await status(X)).status).toBe("needs_reconnect");
  });

  it("a revocation with no other failure within 24 hours either side is still deleted on day 4", async () => {
    await ticks([X], [NOW, NOW + 11 * MIN]);
    await markGrantDead(Y, NOW + 25 * 60 * MIN);
    const d = dayFour(NOW + 3 * DAY + 60 * MIN);
    await d.run();
    expect(d.deleted).toEqual([X]);
  });

  it("an old grant (about 170 days) has expired: needs_reconnect, the data kept, nothing scheduled", async () => {
    await q("UPDATE user_tokens SET granted_at = :g WHERE uid = :u", { g: NOW_S - EXPIRY_AGE_S - 60, u: X });
    await ticks([X], [NOW, NOW + 11 * MIN]);
    expect((await status(X)).status).toBe("needs_reconnect");
    expect((await codes()).filter((x) => x.startsWith("revoked"))).toEqual([]);
  });
});

describe("T14: the verdict", () => {
  const base = { isAdmin: false, grantedAt: NOW_S - 86_400, users24h: 1, admin24h: false, grantWide: 0, nowMs: NOW };
  it("each branch", () => {
    expect(confirmedDeadGrant(base)).toBe("revoked");
    expect(confirmedDeadGrant({ ...base, isAdmin: true })).toBe("admin");
    expect(confirmedDeadGrant({ ...base, users24h: 2 })).toBe("app-wide");
    expect(confirmedDeadGrant({ ...base, admin24h: true })).toBe("app-wide");
    expect(confirmedDeadGrant({ ...base, grantWide: 1 })).toBe("app-wide");
    expect(confirmedDeadGrant({ ...base, grantedAt: NOW_S - EXPIRY_AGE_S })).toBe("expired");
    expect(confirmedDeadGrant({ ...base, grantedAt: null })).toBe("expired");
  });
});

describe("T14 on the request path", () => {
  beforeEach(async () => {
    db = freshAppDb();
    vi.stubEnv("TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")}`);
    await appTokenStore().get(R as never);
    await seedUser(db.raw(), { uid: R, status: "active", admin: true });
    await seedUser(db.raw(), { uid: X, status: "active" });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("a dead grant stops and keeps (needs_reconnect, the row, the confirmation's error, an event), and is not re-sent", async () => {
    const store = appTokenStore();
    await store.set(X, { accessToken: "old", refreshToken: "rt-X", expiresAt: 1_000 });
    const spotify = scriptedSpotify({ dead: ["rt-X"] });
    vi.stubGlobal("fetch", spotify.fetch);
    const core = createTokenCore(store, { onDeadGrant: (uid) => markGrantDead(uid, NOW) });
    expect(await core.getValidAccessToken(X)).toBeNull();
    expect((await q("SELECT status, status_at FROM users WHERE uid = :u", { u: X }))[0]).toEqual({ status: "needs_reconnect", status_at: NOW });
    expect((await q("SELECT count(*) AS n FROM user_tokens WHERE uid = :u", { u: X }))[0].n).toBe(1);
    expect((await q("SELECT last_error FROM sync_state WHERE uid = :u", { u: X }))[0].last_error).toBe("invalid_grant");
    expect((await q("SELECT code FROM events WHERE uid = :u", { u: X })).map((r) => r.code)).toEqual(["invalid-grant"]);
    const sent = spotify.calls.filter((c) => c.url.includes("/api/token")).length;
    expect(sent).toBeGreaterThan(0);

    // An open tab's next requests: no token-endpoint call for the grant already known dead.
    expect(await core.getValidAccessToken(X)).toBeNull();
    await expect(core.refreshForRequest(X, "rt-X")).rejects.toThrow(/invalid_grant/);
    expect(spotify.calls.filter((c) => c.url.includes("/api/token")).length).toBe(sent);
    // The tick's confirmation still asks Spotify.
    await expect(core.tokenForTick(X)).rejects.toThrow(/invalid_grant/);
    expect(spotify.calls.filter((c) => c.url.includes("/api/token")).length).toBeGreaterThan(sent);
    // Only one event: the second failure found the user already stopped. Another instance's
    // failure later (no memo there) writes nothing either, and leaves the clock alone.
    await markGrantDead(X, NOW + 5 * MIN);
    expect((await q("SELECT count(*) AS n FROM events WHERE uid = :u", { u: X }))[0].n).toBe(1);
    expect((await q("SELECT status_at FROM users WHERE uid = :u", { u: X }))[0].status_at).toBe(NOW);
  });

  it("a refresh racing a sign-in leaves the sign-in's tokens and granted_at", async () => {
    await seedUser(db.raw(), { uid: "aaaaaaaaaaaa", status: "active" });
    const spotify = scriptedSpotify({ delayMs: 50 });
    vi.stubGlobal("fetch", spotify.fetch);
    await expectRefreshLosesToSignIn(appTokenStore(), spotify);
    const [row] = await q("SELECT granted_at FROM user_tokens WHERE uid = 'aaaaaaaaaaaa'");
    expect(Number(row.granted_at)).toBeGreaterThan(Math.floor(Date.now() / 1000) - 60);
  });
});
