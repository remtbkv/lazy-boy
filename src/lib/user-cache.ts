// userCache: the only caller of unstable_cache (docs/multi-user/PLAN.md §6.2 layer 4; static
// check S1 in tests/isolation/static.test.ts holds every other file to that).
//
// Next keys an unstable_cache entry on the callback's SOURCE TEXT, the key parts and the
// arguments (next 16.2.6, unstable-cache.js:55, :82). A user id captured in a closure is in
// none of those, so two users could share an entry. Here:
//   - the uid and the store epoch go into the key parts AND the uid is the callback's first
//     argument, so the user separates entries twice over;
//   - every wrapper has a unique name in its key parts: the inner callback below has the same
//     source text for every wrapper, so without the name two wrappers with equal key parts
//     would read each other's entries;
//   - the value is stored as { o: uid, v } and the owner is checked on every return. A
//     mismatch records an isolation event and serves the right user's data uncached, so a key
//     mistake costs a slow request instead of a leak.
// The store epoch (PLAN.md §4.5) is the caller's: a restored database writes a new one, so
// versions it re-issues cannot meet entries cached before the restore.
import "server-only";
import { unstable_cache } from "next/cache";
import type { Uid } from "@/lib/identity";
import { reportIsolation } from "@/lib/isolation";

type Stamped<R> = { o: string; v: R };

const names = new Set<string>();

export function userCache<A extends unknown[], R>(
  name: string,
  fn: (uid: Uid, ...args: A) => Promise<R>,
  keyParts: string[],
  opts: { revalidate: number },
): (uid: Uid, storeEpoch: string, ...args: A) => Promise<R> {
  // Not under `next dev`: an edit re-evaluates db.ts, whose wrappers register again, while this
  // module (and its set of names) stays loaded.
  if (names.has(name) && process.env.NODE_ENV !== "development") {
    throw new Error(`userCache name "${name}" is already taken`);
  }
  names.add(name);
  return async (uid, storeEpoch, ...args) => {
    const cached = unstable_cache(
      async (u: Uid, ...a: A): Promise<Stamped<R>> => ({ o: u, v: await fn(u, ...a) }),
      ["u", name, uid, storeEpoch, ...keyParts],
      opts,
    );
    const got = await cached(uid, ...args);
    if (got?.o === uid) return got.v;
    await reportIsolation("cache-stamp", uid);
    return fn(uid, ...args);
  };
}
