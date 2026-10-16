// Browser storage per user (docs/multi-user/PLAN.md §6.2 layer 6, M7). Client-safe: no server
// imports.
//
// Every name that holds a user's data (localStorage, sessionStorage, IndexedDB, BroadcastChannel,
// Web Lock) is built by `userStorageName`, which puts the uid in it, so two users' tabs in one
// browser neither read nor relay each other's state (static check S6 in
// tests/isolation/static.test.ts lists the names still built by hand). Sign-out, and a 401 that
// carries the signed-out marker, clear every user's entries on this device; a 5xx, a 503
// "unavailable" or a network error clears nothing, so a store blip does not cost the next visit
// its cache.

/** Names that hold a user's data. Device-level names (the build-skew reload stamp, the perf
 *  flag, the metrics session id, the error-reload stamp) are not user data and stay. */
export const USER_DATA_NAMES = [
  "lb-nowplaying", // now-playing cache (localStorage) and its BroadcastChannel
  "lb-nowplaying-leader", // the polling leader's Web Lock
  "lb-days", // Home's day list (sessionStorage)
  "clean:active", // a clean in progress (localStorage)
  "lb-ring:", // the now-playing ring colour per album image (sessionStorage)
  "lb-search", // Home's search payloads (an IndexedDB database, search-cache.ts)
] as const;

export type UserDataName = (typeof USER_DATA_NAMES)[number];

/** The per-user form of a storage, channel or lock name. */
export function userStorageName(uid: string, name: UserDataName): string {
  return `${name}@${uid}`;
}

type KeyedStorage = Pick<Storage, "length" | "key" | "removeItem">;

function isUserDataKey(key: string): boolean {
  return USER_DATA_NAMES.some((n) => key === n || key.startsWith(n.endsWith(":") ? n : `${n}@`));
}

/** Remove every user's data from the given stores (both the per-user names and the bare
 *  single-user names written before Phase 1). Returns the keys removed. */
export function clearUserStorage(stores: KeyedStorage[]): string[] {
  const removed: string[] = [];
  for (const s of stores) {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k !== null && isUserDataKey(k)) keys.push(k);
    }
    for (const k of keys) {
      s.removeItem(k);
      removed.push(k);
    }
  }
  return removed;
}

export const SIGNED_OUT_HEADER = "x-lb-signed-out";

/** True only for the app's own 401 that says the session is gone. */
export function isSignedOutResponse(res: { status: number; headers: { get(name: string): string | null } }): boolean {
  return res.status === 401 && res.headers.get(SIGNED_OUT_HEADER) === "1";
}

/** A payload from the network or from storage is used only if it names the page's user. */
export function bodyIsFor(body: unknown, uid: string): boolean {
  return typeof body === "object" && body !== null && (body as { u?: unknown }).u === uid;
}

type Databases = Pick<IDBFactory, "deleteDatabase"> & { databases?: () => Promise<{ name?: string }[]> };

/** Delete every user's IndexedDB database on this device: each name that is user data, per-user
 *  or the bare name written before Phase 1. The bare one is deleted by name; the per-user ones are
 *  found with indexedDB.databases(), which a browser without it (Firefox before 126) cannot list,
 *  so there only the sign-out form's own clear (search-cache.ts clearStored) empties the page
 *  user's copy. A delete waits for open connections to close; nothing here waits for it. */
export async function clearUserDatabases(idb: Databases): Promise<string[]> {
  const listed = idb.databases ? (await idb.databases()).map((d) => d.name ?? "") : [];
  const names = [...new Set(["lb-search", ...listed.filter(isUserDataKey)])];
  for (const n of names) idb.deleteDatabase(n);
  return names;
}

/** This browser's stores: clearUserStorage over localStorage and sessionStorage, and every
 *  user's IndexedDB database (clearUserDatabases, off the caller's path). Called by the sign-out
 *  form before it submits, and by the fetchers on the signed-out 401. Storage that is
 *  unavailable (private mode, a server render) clears nothing. */
export function clearThisBrowser(): string[] {
  try {
    if (typeof indexedDB !== "undefined") void clearUserDatabases(indexedDB).catch(() => {});
  } catch {
    /* IndexedDB unreachable: nothing stored there to clear */
  }
  try {
    return clearUserStorage([localStorage, sessionStorage]);
  } catch {
    return [];
  }
}

/** For the app's own fetchers: clear this browser's user data if the response says the
 *  session is gone. Anything else (a 5xx, a 503, a plain 401) clears nothing. */
export function clearIfSignedOut(res: { status: number; headers: { get(name: string): string | null } }): void {
  if (isSignedOutResponse(res)) clearThisBrowser();
}
