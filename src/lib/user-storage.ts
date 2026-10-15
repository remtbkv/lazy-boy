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
