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
import { mintUid, type Uid } from "@/lib/identity";
import { reportIsolation } from "@/lib/isolation";

type Stamped<R> = { o: string; v: R };

const names = new Set<string>();

// The callback unstable_cache stores: one factory, so every wrapper's callback has the same source
// text (the name in the key parts tells them apart) and the planted probe's forged entry lands
// under exactly the key the real read uses. `owner` is the stamp; only the probe passes anything
// but the uid itself.
function stamped<A extends unknown[], R>(fn: (uid: Uid, ...args: A) => Promise<R>, owner: (u: Uid) => string) {
  return async (u: Uid, ...a: A): Promise<Stamped<R>> => ({ o: owner(u), v: await fn(u, ...a) });
}
const self = (u: Uid) => u;

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
    const cached = unstable_cache(stamped(fn, self), ["u", name, uid, storeEpoch, ...keyParts], opts);
    const got = await cached(uid, ...args);
    if (got?.o === uid) return got.v;
    await reportIsolation("cache-stamp", uid);
    return fn(uid, ...args);
  };
}

// ── The planted probe (PLAN.md §13.1, Phase 4a's row; RULINGS Oct 15 9:27 PM) ──────────────────
// /api/cron/probe, opened by the Zenbook's CRON_SECRET alone: forge one entry under `uid`'s key
// stamped with another uid (which need not belong to anyone), then read it back through
// userCache, so its owner check records exactly one `cache-stamp` event for `uid` and the health
// check turns red. The wrapper is the probe's own, its value a constant, and the nonce a fresh key
// part per run: no read path that serves data ever meets the forged entry.
const PROBE = "planted-probe";
const PROBE_OPTS = { revalidate: 300 };
const probeValue = async (): Promise<{ probe: true }> => ({ probe: true });
const probeRead = userCache(PROBE, probeValue, ["v1"], PROBE_OPTS);

export async function plantedProbe(uid: string, stamp: string, nonce: string): Promise<void> {
  const u = mintUid(uid);
  if (stamp === uid) throw new Error("planted probe: the stamp must be another uid");
  await unstable_cache(stamped(probeValue, () => mintUid(stamp)), ["u", PROBE, u, nonce, "v1"], PROBE_OPTS)(u);
  await probeRead(u, nonce);
}
