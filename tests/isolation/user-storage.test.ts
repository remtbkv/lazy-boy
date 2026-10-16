// Browser storage per user (PLAN.md §6.2 layer 6, T7's client half). The search routes' ETags
// and bodies (T7's server half) are in files queued lanes edit and are pending.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bodyIsFor,
  clearIfSignedOut,
  clearThisBrowser,
  clearUserStorage,
  isSignedOutResponse,
  leaveForAnotherUser,
  namesAnotherUser,
  userStorageName,
  USER_DATA_NAMES,
} from "@/lib/user-storage";
import { A, B } from "./harness";

function fakeStorage(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()].sort(),
  };
}

describe("user storage", () => {
  it("every per-user name differs between A and B", () => {
    for (const n of USER_DATA_NAMES) expect(userStorageName(A, n)).not.toBe(userStorageName(B, n));
  });

  it("sign-out clears every user's data, prefixed or legacy, and keeps device-level keys", () => {
    const local = fakeStorage({
      "lb-nowplaying": "legacy",
      [userStorageName(A, "lb-nowplaying")]: "A",
      [userStorageName(B, "clean:active")]: "B",
      "clean:active": "legacy",
      "lb-build-reload-at": "1",
      "lb-perf": "1",
      "lb-nowplaying-extra": "not ours",
    });
    const session = fakeStorage({
      "lb-days": "legacy",
      [userStorageName(A, "lb-days")]: "A",
      "lb-ring:https://i.scdn.co/x": "rgb",
      "lb:metrics-session": "s",
      "app-error-reload-at": "1",
    });
    clearUserStorage([local, session]);
    expect(local.keys()).toEqual(["lb-build-reload-at", "lb-nowplaying-extra", "lb-perf"]);
    expect(session.keys()).toEqual(["app-error-reload-at", "lb:metrics-session"]);
  });

  it("only the app's own signed-out 401 clears; a 503, a 500 or a plain 401 does not", () => {
    const res = (status: number, h: Record<string, string> = {}) => ({ status, headers: new Headers(h) });
    expect(isSignedOutResponse(res(401, { "x-lb-signed-out": "1" }))).toBe(true);
    expect(isSignedOutResponse(res(401))).toBe(false);
    expect(isSignedOutResponse(res(503, { "x-lb-signed-out": "1" }))).toBe(false);
    expect(isSignedOutResponse(res(500))).toBe(false);
  });

  it("a body that names another user is not used", () => {
    expect(bodyIsFor({ u: A, rows: [] }, A)).toBe(true);
    expect(bodyIsFor({ u: B, rows: [] }, A)).toBe(false);
    expect(bodyIsFor({ rows: [] }, A)).toBe(false);
    expect(bodyIsFor(null, A)).toBe(false);
  });

  // A tab rendered for A whose cookie now names B (B signed in in another tab): only a body that
  // names someone, and someone else, says so; a signed-out body names no one.
  it("namesAnotherUser: true only for a body naming a different user", () => {
    expect(namesAnotherUser({ u: B, playing: null }, A)).toBe(true);
    expect(namesAnotherUser({ u: A, playing: null }, A)).toBe(false);
    expect(namesAnotherUser({ playing: null }, A)).toBe(false);
    expect(namesAnotherUser(null, A)).toBe(false);
  });
});

describe("a tab that finds the browser signed in as someone else", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("clears every user's storage, its own included, and reloads", () => {
    const local = fakeStorage({ [userStorageName(A, "lb-nowplaying")]: "B's player", "lb-perf": "1" });
    const session = fakeStorage({ [userStorageName(A, "lb-days")]: "B's days" });
    const reload = vi.fn();
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    const idb = fakeIndexedDB([userStorageName(A, "lb-search")], false);
    vi.stubGlobal("indexedDB", idb);
    vi.stubGlobal("location", { reload });
    leaveForAnotherUser(A);
    expect(local.keys()).toEqual(["lb-perf"]);
    expect(session.keys()).toEqual([]);
    expect([...idb.live]).toEqual([]);
    expect(reload).toHaveBeenCalledOnce();
  });
});

// The browser's IndexedDB databases, as the sign-out form and the signed-out 401 see them.
function fakeIndexedDB(names: string[], listable = true) {
  const live = new Set(names);
  return {
    live,
    deleteDatabase: (n: string) => {
      live.delete(n);
      return {} as IDBOpenDBRequest;
    },
    ...(listable ? { databases: async () => [...live].map((name) => ({ name, version: 1 })) } : {}),
  };
}

describe("the search payloads' IndexedDB copy (lane 1905's, per user since the stitch)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("sign-out deletes every user's copy, per-user or the bare pre-Phase-1 one, and no other database", async () => {
    const idb = fakeIndexedDB([userStorageName(A, "lb-search"), userStorageName(B, "lb-search"), "lb-search", "unrelated"]);
    vi.stubGlobal("indexedDB", idb);
    vi.stubGlobal("localStorage", fakeStorage({}));
    vi.stubGlobal("sessionStorage", fakeStorage({}));
    clearThisBrowser(A);
    await settle();
    expect([...idb.live]).toEqual(["unrelated"]);
  });

  it("the signed-out 401 deletes them too; a 503 deletes nothing", async () => {
    const idb = fakeIndexedDB([userStorageName(A, "lb-search")]);
    vi.stubGlobal("indexedDB", idb);
    vi.stubGlobal("localStorage", fakeStorage({}));
    vi.stubGlobal("sessionStorage", fakeStorage({}));
    clearIfSignedOut({ status: 503, headers: new Headers({ "x-lb-signed-out": "1" }) }, A);
    await settle();
    expect([...idb.live]).toEqual([userStorageName(A, "lb-search")]);
    clearIfSignedOut({ status: 401, headers: new Headers({ "x-lb-signed-out": "1" }) }, A);
    await settle();
    expect([...idb.live]).toEqual([]);
  });

  // Firefox before 126 has no indexedDB.databases(). The bare name and the page user's own name
  // are known without a list, so both go; another user's copy cannot be found there (lane 13:
  // the signed-out 401 used to leave the page user's own copy on such a browser).
  it("a browser that cannot list its databases still loses the bare one and the page user's", async () => {
    const idb = fakeIndexedDB(
      ["lb-search", userStorageName(A, "lb-search"), userStorageName(B, "lb-search")],
      false,
    );
    vi.stubGlobal("indexedDB", idb);
    vi.stubGlobal("localStorage", fakeStorage({}));
    vi.stubGlobal("sessionStorage", fakeStorage({}));
    clearIfSignedOut({ status: 401, headers: new Headers({ "x-lb-signed-out": "1" }) }, A);
    await settle();
    expect([...idb.live]).toEqual([userStorageName(B, "lb-search")]);
  });
});
