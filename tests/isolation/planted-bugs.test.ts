// The planted-bug self-test (PLAN.md §6.4, completeness M2): a test that has never failed proves
// nothing, so each isolation check is run against a deliberately broken implementation of the
// thing it guards and must FAIL there, and against the real one and must pass. Kept in the
// suite for good, so a check that quietly loses its teeth fails `npm test`.
//
// Planted here: an unstable_cache keyed without the user (the uid captured in a closure, which
// Next's key cannot see); a token core whose in-flight refresh is one promise for everyone;
// the cache stub reverted to a pass-through (which can see no collision and no forged entry).
// The fourth, a URL template that ignores the uid: every db_name lands in one file.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Uid } from "@/lib/identity";
import { createTokenCore } from "@/lib/token-core";
import { decryptTokens, encryptTokens, tokenAad, type TokenKey } from "@/lib/token-crypto";
import { rawClient, resetStore } from "../adversarial/helpers";
import * as faithful from "../stubs/next-cache-faithful";
import * as passthrough from "../stubs/next-cache";
import {
  A,
  B,
  EXPIRED,
  expectCiphertextBoundToUser,
  expectConcurrentRefreshIsolated,
  expectFreshIvPerWrite,
  memoryTokenStore,
  scriptedSpotify,
} from "./harness";
import { expectOwnDatabases, useUserFiles } from "./user-dbs";

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
