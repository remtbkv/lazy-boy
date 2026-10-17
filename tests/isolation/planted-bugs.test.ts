// The planted-bug self-test (PLAN.md §6.4, completeness M2): a test that has never failed proves
// nothing, so each isolation check is run against a deliberately broken implementation of the
// thing it guards and must FAIL there, and against the real one and must pass. Kept in the
// suite for good, so a check that quietly loses its teeth fails `npm test`.
//
// Planted here: an unstable_cache keyed without the user (the uid captured in a closure, which
// Next's key cannot see); a token core whose in-flight refresh is one promise for everyone;
// the cache stub reverted to a pass-through (which can see no collision and no forged entry).
// The fourth, a URL template that ignores the uid: every db_name lands in one file.
//
// Phase 2 adds: a cipher that drops the associated data; a cipher that reuses its IV; a
// refresh write that is not conditional on the row it read; a TokenStore that answers another
// uid's row; an identity read that ignores SIGNUPS. Lane 03's review adds a key check that opens
// only the first key's sentinel.
//
// Phase 3 adds: a tick that hands a step another user's store; a lease released without its
// owner check. Lane 40 adds the suites' store reverted to a plain `file:` client, which runs a
// statement handed named args it does not use; Turso refuses it (lane 23's production failure).
//
// Phase 4a adds: a claim without its compare-and-set; a Log out that leaves capture on; a deletion
// with no admin refusal; a now-playing memo keyed by nobody. Its turn adds a /usage read that takes
// the viewer for the admin (friends' telemetry only by page template). Lane 1970's review adds a
// /join that counts the places held under SIGNUPS=owner.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { createClient as createPlainClient } from "@libsql/client/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkIdentity, type SessionClaims, type Uid } from "@/lib/identity";
import { appIdentityLookup, readIdentity } from "@/lib/identity-read";
import { createTokenCore, type TokenStore } from "@/lib/token-core";
import { claimInvite, endSessionsAndCapture, execDeletionStatements, getAppMeta, releaseLease, setAppMetaIfAbsent } from "@/lib/app-db";
import { runDeletion, type DeletionDeps } from "@/lib/deletion";
import { clearNowPlayingMemo, memoizedNowPlaying, rememberNowPlaying } from "@/lib/now-playing-memo";
import { decryptTokens, encryptTokens, open, parseTokenKeys, seal, tokenAad, type TokenKey } from "@/lib/token-crypto";
import { tokenKeysReady } from "@/lib/token-keys";
import { appTokenStore } from "@/lib/token-store-app";
import { rawClient, resetStore } from "../adversarial/helpers";
import * as faithful from "../stubs/next-cache-faithful";
import * as passthrough from "../stubs/next-cache";
import {
  A,
  B,
  EXPIRED,
  expectCiphertextBoundToUser,
  expectConcurrentRefreshIsolated,
  expectDeletionRefusesAdmin,
  expectInviteClaimedOnce,
  expectLogOutStopsCapture,
  expectMemoPerUser,
  expectFreshIvPerWrite,
  expectFriendTelemetryAggregated,
  expectRefreshLosesToSignIn,
  expectShutJoinReadsNothing,
  expectSignupsOwnerRefusesFriend,
  expectStoreAnswersOwnRow,
  expectWrongOlderKeyRefuses,
  freshAppDb,
  memoryTokenStore,
  scriptedSpotify,
  seedUser,
} from "./harness";
import { expectReleaseNeedsItsLease, expectStepsKeepToTheirStore } from "./tick-harness";
import { expectOwnDatabases, useUserFiles } from "./user-dbs";

// The /join page entry renders the real page, which reads cookies and imports the sign-in action.
vi.mock("next/headers", async () => (await import("./authz-context")).nextHeadersMock());
vi.mock("@/app/(app)/actions", () => ({ login: async () => {} }));

const data: Record<string, string> = { [A]: "A-only-history", [B]: "B-only-history" };

/** T2's equal-counter check over any per-user cached read. */
async function expectCacheSeparatesUsers(read: (uid: Uid, epoch: string, v: number) => Promise<string>) {
  expect(await read(A, "e", 7)).toBe("A-only-history");
  expect(await read(B, "e", 7)).toBe("B-only-history");
  expect(await read(A, "e", 7)).toBe("A-only-history");
}

/** T2's forged-entry check: an entry under B's key stamped with A must be refused and recorded. */
async function expectForgedEntryRefused(
  cache: typeof faithful.__cache | null,
  read: (uid: Uid, epoch: string) => Promise<string>,
) {
  await read(B, "e");
  const key = cache?.keys().find((k) => k.includes(B));
  if (key) cache!.forge(key, { o: A, v: "A-only-history" });
  expect(await read(B, "e")).toBe("B-only-history");
  const c = await rawClient();
  const r = await c.execute("SELECT meta FROM client_metrics WHERE event = 'isolation'");
  expect(r.rows.map((x) => String(x.meta))).toEqual([`cache-stamp|${B}`]);
}

/** userCache built over a given next/cache implementation (a fresh module graph each time). */
async function userCacheOver(impl: unknown) {
  vi.resetModules();
  vi.doMock("next/cache", () => impl);
  return (await import("@/lib/user-cache")).userCache;
}

beforeEach(async () => {
  faithful.__cache.clear();
  await resetStore();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.SPOTIFY_CLIENT_ID = "cid";
  process.env.SPOTIFY_CLIENT_SECRET = "cs";
});
afterEach(() => {
  vi.doUnmock("next/cache");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("planted: an unstable_cache keyed without the user", () => {
  it("the equal-counter check catches it", async () => {
    let current: Uid = A;
    const unkeyed = faithful.unstable_cache(async (_v: number) => data[current], ["history"]);
    const buggy = async (uid: Uid, _e: string, v: number) => ((current = uid), unkeyed(v));
    await expect(expectCacheSeparatesUsers(buggy)).rejects.toThrow();
  });

  it("and passes over the real userCache", async () => {
    const userCache = await userCacheOver(faithful);
    const read = userCache("planted-1", async (uid, _v: number) => data[uid], ["history"], { revalidate: 60 });
    await expectCacheSeparatesUsers(read);
  });
});

describe("planted: the cache stub reverted to a pass-through", () => {
  it("the forged-entry check fails, because a pass-through cannot hold an entry to forge", async () => {
    const userCache = await userCacheOver(passthrough);
    const read = userCache("planted-2", async (uid) => data[uid], ["history"], { revalidate: 60 });
    await expect(expectForgedEntryRefused(null, read)).rejects.toThrow();
  });

  it("and passes over the faithful stub", async () => {
    const userCache = await userCacheOver(faithful);
    const read = userCache("planted-3", async (uid) => data[uid], ["history"], { revalidate: 60 });
    await expectForgedEntryRefused(faithful.__cache, read);
  });
});

describe("planted: one in-flight refresh promise for every user (01e A2)", () => {
  const rows = () => ({
    [A]: { accessToken: "old-A", refreshToken: "rt-A", expiresAt: EXPIRED },
    [B]: { accessToken: "old-B", refreshToken: "rt-B", expiresAt: EXPIRED },
  });

  it("the concurrent-refresh check catches it", async () => {
    const spotify = scriptedSpotify({ delayMs: 20 });
    vi.stubGlobal("fetch", spotify.fetch);
    const core = createTokenCore(memoryTokenStore(rows()).store);
    // Today's auth.ts shape: whoever asks while a refresh is in flight gets that refresh.
    let shared: ReturnType<typeof core.getValidAccessToken> | null = null;
    const buggy = (uid: Uid) => (shared ??= core.getValidAccessToken(uid));
    await expect(expectConcurrentRefreshIsolated(buggy, spotify)).rejects.toThrow();
  });

  it("and passes over the real core", async () => {
    const spotify = scriptedSpotify({ delayMs: 20 });
    vi.stubGlobal("fetch", spotify.fetch);
    const core = createTokenCore(memoryTokenStore(rows()).store);
    await expectConcurrentRefreshIsolated((uid) => core.getValidAccessToken(uid), spotify);
  });
});

describe("planted: a URL template that ignores the uid", () => {
  it("the own-database check catches it: both names open one file, and B's open is refused there", async () => {
    const dir = useUserFiles();
    mkdirSync(path.join(dir, "pa"));
    mkdirSync(path.join(dir, "pb"));
    // `{db}` is in the template, so the open's own rule accepts it; the `..` throws it away.
    process.env.STORE_URL_TEMPLATE = `file:${dir}/{db}/../shared.db`;
    await expect(expectOwnDatabases("pa", "pb")).rejects.toThrow(/belongs to another user/);
  });

  it("and passes over the real template", async () => {
    useUserFiles();
    await expectOwnDatabases("qa", "qb");
  });
});

// ── Phase 2 (PLAN.md §5.2-5.3): the cipher ─────────────────────────────────────────────────
// Each planted cipher is the real one with one line changed.
function plantedCipher(bug: "no-aad" | "fixed-iv") {
  const encrypt = (keys: TokenKey[], uid: string, t: { accessToken: string; refreshToken: string }) => {
    const iv = bug === "fixed-iv" ? Buffer.alloc(12) : randomBytes(12);
    const c = createCipheriv("aes-256-gcm", keys[0].key, iv);
    if (bug !== "no-aad") c.setAAD(Buffer.from(tokenAad(uid)));
    const ct = Buffer.concat([c.update(JSON.stringify({ a: t.accessToken, r: t.refreshToken })), c.final()]);
    return `${keys[0].id}.${Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url")}`;
  };
  const decrypt = (keys: TokenKey[], uid: string, blob: string) => {
    const raw = Buffer.from(blob.slice(blob.indexOf(".") + 1), "base64url");
    const d = createDecipheriv("aes-256-gcm", keys[0].key, raw.subarray(0, 12));
    if (bug !== "no-aad") d.setAAD(Buffer.from(tokenAad(uid)));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const o = JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString());
    return { accessToken: o.a, refreshToken: o.r };
  };
  return { encrypt, decrypt };
}

describe("planted: a cipher that drops the associated data", () => {
  it("the bound-to-user check catches it", () => {
    expect(() => expectCiphertextBoundToUser(plantedCipher("no-aad"))).toThrow();
  });
  it("and passes over the real cipher", () => {
    expectCiphertextBoundToUser({ encrypt: encryptTokens, decrypt: decryptTokens });
  });
});

describe("planted: a cipher that reuses its IV", () => {
  it("the fresh-IV check catches it", () => {
    expect(() => expectFreshIvPerWrite(plantedCipher("fixed-iv").encrypt)).toThrow();
  });
  it("and passes over the real cipher", () => {
    expectFreshIvPerWrite(encryptTokens);
  });
});

// ── Phase 2: the token store over user_tokens ─────────────────────────────────────────────
async function appStore() {
  const db = freshAppDb();
  vi.stubEnv("TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")}`);
  const store = appTokenStore();
  await store.get(A);
  await seedUser(db.raw(), { uid: A, status: "active" });
  await seedUser(db.raw(), { uid: B, status: "active" });
  const spotify = scriptedSpotify({ delayMs: 60 });
  vi.stubGlobal("fetch", spotify.fetch);
  return { db, store, spotify };
}

describe("planted: a refresh write that is not conditional (security R4)", () => {
  it("the refresh-loses-to-sign-in check catches it", async () => {
    const { store, spotify } = await appStore();
    // The refresh lands with the sign-in's unconditional upsert instead of over the blob it read.
    const buggy: TokenStore = { ...store, update: async (uid, t) => (await store.set(uid, t), true) };
    await expect(expectRefreshLosesToSignIn(buggy, spotify)).rejects.toThrow();
  });
  it("and passes over the real store", async () => {
    const { store, spotify } = await appStore();
    await expectRefreshLosesToSignIn(store, spotify);
  });
});

describe("planted: a TokenStore that answers another uid's row", () => {
  it("the own-row check catches it", async () => {
    const { db, store } = await appStore();
    // The read forgot its WHERE: it answers with whichever row comes first, decrypted as its owner.
    const buggy: TokenStore = {
      ...store,
      async get() {
        const r = (await db.raw().execute("SELECT uid, blob, expires_at FROM user_tokens ORDER BY uid DESC LIMIT 1")).rows[0];
        if (!r) return null;
        const t = decryptTokens(parseTokenKeys(process.env.TOKEN_KEYS), String(r.uid), String(r.blob));
        return { ...t, expiresAt: Number(r.expires_at), rev: String(r.blob) };
      },
    };
    await expect(expectStoreAnswersOwnRow(buggy)).rejects.toThrow();
  });
  it("and passes over the real store", async () => {
    const { store } = await appStore();
    await expectStoreAnswersOwnRow(store);
  });
});

describe("planted: an identity read that ignores SIGNUPS (PLAN.md §12.1)", () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { admin: { uid: A, ep: 0, auth_time: now }, friend: { uid: B, ep: 0, auth_time: now } };
  async function rows() {
    const { db } = await appStore();
    await db.raw().execute({ sql: "UPDATE users SET is_admin = 1 WHERE uid = ?", args: [A] });
  }

  it("the freeze check catches it", async () => {
    await rows();
    // The lookup is right; the read forgets to pass the deployment's SIGNUPS.
    const buggy = (c: SessionClaims) => checkIdentity(c, appIdentityLookup, { now: Date.now(), signups: "invite" });
    await expect(expectSignupsOwnerRefusesFriend(buggy, claims)).rejects.toThrow();
  });
  it("and passes over the real read", async () => {
    await rows();
    await expectSignupsOwnerRefusesFriend((c) => readIdentity(c), claims);
  });
});

// ── Lane 03's review: the key check (PLAN.md §5.3) ────────────────────────────────────────
// token-keys.ts's check with one line changed: it opens the first key's sentinel and trusts the
// rest, so a wrong older key passes the cold-start check and every blob under it fails one user
// at a time instead of refusing the deploy.
function plantedFirstKeyOnlyCheck(): () => Promise<TokenKey[]> {
  const aad = (id: string) => `lazyboy:sentinel:v1:${id}`;
  const text = (id: string) => `lazyboy token key sentinel ${id}`;
  return async () => {
    const keys = parseTokenKeys(process.env.TOKEN_KEYS);
    for (const key of keys.slice(0, 1)) {
      const name = `sentinel:${key.id}`;
      if ((await getAppMeta(name)) === null) await setAppMetaIfAbsent(name, seal(key, aad(key.id), text(key.id)));
      const blob = await getAppMeta(name);
      let got: string | null = null;
      try {
        got = blob === null ? null : open([key], aad(key.id), blob);
      } catch {}
      if (got !== text(key.id)) throw new Error(`TOKEN_KEYS: key ${key.id} does not open its sentinel`);
    }
    return keys;
  };
}

describe("planted: a key check that opens only the first key's sentinel (PLAN.md §5.3)", () => {
  it("the wrong-older-key check catches it", async () => {
    await appStore();
    await expect(expectWrongOlderKeyRefuses(plantedFirstKeyOnlyCheck())).rejects.toThrow();
  });
  it("and passes over the real check", async () => {
    await appStore();
    await expectWrongOlderKeyRefuses(tokenKeysReady);
  });
});

// ── Phase 3: the tick (PLAN.md §6.2 layer 4, §7.2) ─────────────────────────────────────────
// A tick whose step lookup ignores the user it was given and hands every step the first user's
// store; and a release that drops its lease-owner check, so a step that outlived its lease
// overwrites the schedule of the tick that took the user after it.
describe("planted: a step handed another user's store", () => {
  async function twoUsers() {
    const db = freshAppDb();
    await getAppMeta("schema_version");
    await seedUser(db.raw(), { uid: A, status: "active" });
    await seedUser(db.raw(), { uid: B, status: "active", admin: true });
    for (const u of [A, B]) {
      await db.raw().execute({ sql: "INSERT INTO user_tokens (uid, blob, expires_at, granted_at) VALUES (?, 'v1.x', 0, 0)", args: [u] });
    }
  }
  it("the own-store check catches it", async () => {
    await twoUsers();
    await expect(expectStepsKeepToTheirStore(A, B, (stores) => () => stores[A].store)).rejects.toThrow();
  });
  it("and passes over the tick handing each step its own", async () => {
    await twoUsers();
    await expectStepsKeepToTheirStore(A, B, (stores) => (u) => stores[u.uid].store);
  });
});

describe("planted: a lease released without the owner check", () => {
  async function oneUser() {
    const db = freshAppDb();
    await getAppMeta("schema_version");
    await seedUser(db.raw(), { uid: A, status: "active" });
    return db;
  }
  it("the late-release check catches it", async () => {
    const db = await oneUser();
    const buggy = async (uid: Uid, _tick: string, now: number, w: { nextProbeAt: number }) =>
      (
        await db.raw().execute({
          sql: `UPDATE sync_state SET next_probe_at = ?, lease_owner = NULL, lease_until = NULL
                WHERE uid = ? AND lease_until >= ?`,
          args: [w.nextProbeAt, uid, now],
        })
      ).rowsAffected === 1;
    await expect(expectReleaseNeedsItsLease(A, buggy)).rejects.toThrow();
  });
  it("and passes over the real release", async () => {
    await oneUser();
    await expectReleaseNeedsItsLease(A, releaseLease);
  });
});

describe("planted: the suites' store reverted to a plain file: client", () => {
  // One args object shared by a batch whose statements each use some of it, as Phase 3's claim had.
  const shared = { tick: "t1", now: 1000 };
  const batch = [
    { sql: "SELECT :tick AS v", args: shared },
    { sql: "SELECT :now AS v", args: shared },
  ];
  it("the plain client runs the shared-args batch", async () => {
    const plain = createPlainClient({ url: "file::memory:" });
    await expect(plain.batch(batch, "read")).resolves.toHaveLength(2);
  });
  it("and the suites' client refuses it, as Turso does", async () => {
    const c = createClient({ url: "file::memory:" });
    await expect(c.batch(batch, "read")).rejects.toThrow("too many parameters, expected 1 found 2");
  });
});

// ── Phase 4a: sign-up, Log out, deletion, the now-playing memo ──────────────────────────────
// A claim with no compare-and-set (it rebinds a claimed invite and claims a pending request); a
// Log out that signs out but leaves capture on; a deletion with no admin refusal; a memo keyed by
// nobody.
describe("planted: a claim without its compare-and-set", () => {
  it("the claimed-once check catches it", async () => {
    const db = freshAppDb();
    await getAppMeta("schema_version");
    const buggy = async (rid: string, aid: string, sid: string) =>
      ((
        await db.raw().execute({
          sql: "UPDATE users SET account_id = ?, spotify_id = ?, status = 'active' WHERE uid = (SELECT uid FROM requests WHERE id = ?) RETURNING uid",
          args: [aid, sid, rid],
        })
      ).rows[0] as { uid: string } | undefined) ?? null;
    await expect(expectInviteClaimedOnce(db.raw(), buggy)).rejects.toThrow();
  });
  it("and passes over the real claim", async () => {
    const db = freshAppDb();
    await getAppMeta("schema_version");
    await expectInviteClaimedOnce(db.raw(), claimInvite);
  });
});

describe("planted: a Log out that leaves capture on", () => {
  async function twoUsers() {
    const db = freshAppDb();
    await getAppMeta("schema_version");
    for (const u of [A, B]) await seedUser(db.raw(), { uid: u, status: "active" });
    return db;
  }
  it("the stops-capture check catches it", async () => {
    const db = await twoUsers();
    const buggy = async (uid: Uid) => void (await db.raw().execute({ sql: "UPDATE users SET session_epoch = session_epoch + 1 WHERE uid = ?", args: [uid] }));
    await expect(expectLogOutStopsCapture(db.raw(), buggy)).rejects.toThrow();
  });
  it("and passes over the real Log out", async () => {
    const db = await twoUsers();
    await expectLogOutStopsCapture(db.raw(), endSessionsAndCapture);
  });
});

describe("planted: a deletion with no admin refusal", () => {
  async function admin() {
    const db = freshAppDb();
    await getAppMeta("schema_version");
    await seedUser(db.raw(), { uid: A, status: "active", admin: true });
    return db;
  }
  const deps = (): DeletionDeps => ({
    exec: execDeletionStatements,
    ownerOf: async () => null,
    destroy: async () => {},
    telemetry: { deleteUser: async () => {}, appendLifecycle: async () => {} },
    now: Date.now,
    by: "test",
  });
  it("the never-the-admin check catches it", async () => {
    const db = await admin();
    const buggy = async (uid: string) => {
      await db.raw().execute({ sql: "UPDATE users SET status = 'deleting', session_epoch = session_epoch + 1 WHERE uid = ?", args: [uid] });
      return { kind: "pending" };
    };
    await expect(expectDeletionRefusesAdmin(db.raw(), buggy)).rejects.toThrow();
  });
  it("and passes over the real job", async () => {
    const db = await admin();
    await expectDeletionRefusesAdmin(db.raw(), (uid) => runDeletion(uid, deps()));
  });
});

describe("planted: a /usage read that takes the viewer's uid for the admin's (Phase 4a's turn)", () => {
  it("the friends-aggregated check catches it: the friend's opens are listed, Rem's hidden", async () => {
    const { getClientLoadSpeed } = await import("@/lib/db");
    await expect(expectFriendTelemetryAggregated(A, B, () => getClientLoadSpeed(B))).rejects.toThrow();
  });
  it("and passes over the real read", async () => {
    const { getClientLoadSpeed } = await import("@/lib/db");
    await expectFriendTelemetryAggregated(A, B, getClientLoadSpeed);
  });
});

describe("planted: a now-playing memo keyed by nobody", () => {
  it("the per-user check catches it", () => {
    let last: { playing: unknown } | null = null;
    expect(() =>
      expectMemoPerUser(
        () => last,
        (_u, _n, p) => {
          last = { playing: p };
        },
      ),
    ).toThrow();
  });
  it("and passes over the real memo", () => {
    clearNowPlayingMemo();
    expectMemoPerUser(memoizedNowPlaying, rememberNowPlaying);
  });
});

describe("planted: a /join that counts the places whatever SIGNUPS says", () => {
  it("the shut-door check catches it: the count reaches the app database", async () => {
    const { seatsHeld } = await import("@/lib/app-db");
    await expect(expectShutJoinReadsNothing(() => seatsHeld().catch(() => null))).rejects.toThrow();
  });
  it("and passes over the real page", async () => {
    const page = (await import("@/app/(auth)/join/page")).default;
    await expectShutJoinReadsNothing(() => page({ searchParams: Promise.resolve({}) }));
  });
});
