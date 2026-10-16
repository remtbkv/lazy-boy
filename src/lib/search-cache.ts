// The browser's copy of Home's two search payloads (docs/STORE_MIGRATION.md §10, phase E).
//
// Search matches in the browser once both payloads are in memory; what a visit waited on was the
// download, which the history half repeats after every new play. So the last good body of each
// half is kept in IndexedDB, Home builds its searchable set from it before the network answers,
// and the fresh pair replaces it when it lands (den-home.tsx, loadIndex).
//
// A record's KEY is the tuple (userKey, epoch, kind, segment, version, shape), JSON-encoded:
//   userKey  the opaque key the (app) layout renders on #den-root (a constant until multi-user
//            Phase 1's uid replaces it). It is stamped on the record too. A key with any other
//            user in it clears the whole store; a record stamped with another user is dropped.
//   epoch    the store epoch (multi-user PLAN §4.5). "0" until that exists.
//   segment  "all": one body per kind today. P3's monthly history segments are the reason the
//            dimension is here, so that change needs no second migration of browser data.
//   version  the body's own `v` (the server's content version), "" when it had none.
//   shape    the payload format THIS build reads (search-shape.ts). An older build's record is a
//            miss and is deleted, the same rule the Data Cache key and the ETag follow (GOTCHAS:
//            "The Data Cache OUTLIVES THE DEPLOY").
// One record per (userKey, epoch, kind, segment): a write deletes that slot's other versions.
//
// The body is stored as the response TEXT, not the parsed object: putting a string is one copy,
// where putting the parsed payload structured-clones some 20,000 nested arrays on the main thread.
// A read parses it and runs the same validators as the network path (fetchPayload); a body that
// fails them is deleted. Every storage failure (private mode, quota, no IndexedDB) reads as a
// miss and is otherwise silent: the page then behaves exactly as it did before this existed.
import { HISTORY_INDEX_SHAPE, LIBRARY_INDEX_SHAPE } from "@/lib/search-shape";

export type Kind = "library" | "history";
export type Slot = { userKey: string; epoch: string; kind: Kind; segment: string; shape: string };

/** The storage the module needs; IndexedDB in the browser (idbKV), a Map in the tests. */
export interface SearchKV {
  keys(): Promise<string[]>;
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  del(keys: string[]): Promise<void>;
  clear(): Promise<void>;
}

type Stored = { u: string; text: string };

const STORE_EPOCH = "0";
const SEGMENT = "all";

export function slotFor(userKey: string, kind: Kind): Slot {
  return {
    userKey,
    epoch: STORE_EPOCH,
    kind,
    segment: SEGMENT,
    shape: kind === "library" ? LIBRARY_INDEX_SHAPE : HISTORY_INDEX_SHAPE,
  };
}

type Tuple = [userKey: string, epoch: string, kind: string, segment: string, version: string, shape: string];

const encode = (s: Slot, version: string | null) =>
  JSON.stringify([s.userKey, s.epoch, s.kind, s.segment, version ?? "", s.shape] satisfies Tuple);

function decode(key: string): Tuple | null {
  try {
    const t: unknown = JSON.parse(key);
    return Array.isArray(t) && t.length === 6 && t.every((x) => typeof x === "string") ? (t as Tuple) : null;
  } catch {
    return null;
  }
}

/** The network path's checks (den-home.tsx fetchPayload), shared so a stored body passes exactly
 *  what a fresh one must. A 200 is not "a payload this build can read" (GOTCHAS). */
type Shaped = { tracks?: unknown; plays?: unknown } | null | undefined;
const fiveSlot = (tracks: unknown[]) => !tracks.length || (tracks[0] as unknown[])?.length >= 5;
export const libraryOk = (d: unknown): boolean => {
  const p = d as Shaped;
  return Array.isArray(p?.tracks) && fiveSlot(p.tracks);
};
// 5, not 4: a v1 history body (no durationMs) would derive days with an empty Length column.
export const historyOk = (d: unknown): boolean => {
  const p = d as Shaped;
  return Array.isArray(p?.tracks) && Array.isArray(p?.plays) && fiveSlot(p.tracks);
};

/** The slot's last good body, or null. Clears the store when it holds another user's key. */
export async function readStored<T>(kv: SearchKV, slot: Slot, ok: (d: unknown) => boolean): Promise<T | null> {
  try {
    const keys = await kv.keys();
    const decoded = keys.map((k) => [k, decode(k)] as const);
    if (decoded.some(([, t]) => !t || t[0] !== slot.userKey)) {
      await kv.clear();
      return null;
    }
    // Same user, kind and segment: the one record this slot may hold, or one an older build
    // (shape) or another store epoch wrote, which nothing will read again.
    const mine = decoded.filter(([, t]) => t![2] === slot.kind && t![3] === slot.segment);
    const stale = mine.filter(([, t]) => t![1] !== slot.epoch || t![5] !== slot.shape).map(([k]) => k);
    if (stale.length) await kv.del(stale);
    const hit = mine.find(([k]) => !stale.includes(k));
    if (!hit) return null;
    const rec = (await kv.get(hit[0])) as Stored | undefined;
    let body: unknown = null;
    if (rec?.u === slot.userKey && typeof rec.text === "string") {
      try {
        body = JSON.parse(rec.text);
      } catch {
        body = null;
      }
    }
    if (!ok(body)) {
      await kv.del([hit[0]]);
      return null;
    }
    return body as T;
  } catch {
    return null;
  }
}

/** Store a validated body as the slot's last good copy, replacing any other version of it. */
export async function writeStored(kv: SearchKV, slot: Slot, version: string | null, text: string): Promise<void> {
  try {
    const key = encode(slot, version);
    await kv.put(key, { u: slot.userKey, text } satisfies Stored);
    const others = (await kv.keys()).filter((k) => {
      const t = decode(k);
      return k !== key && t?.[0] === slot.userKey && t[1] === slot.epoch && t[2] === slot.kind && t[3] === slot.segment;
    });
    if (others.length) await kv.del(others);
  } catch {
    /* quota / private mode: the next visit downloads, as before phase E */
  }
}

export async function clearStored(kv: SearchKV): Promise<void> {
  try {
    await kv.clear();
  } catch {
    /* nothing stored, or nothing reachable */
  }
}

// ---- IndexedDB -----------------------------------------------------------------------------
// One database, one object store, out-of-line string keys. A connection is opened per operation
// and closed when its transaction completes, so nothing holds the database open (a held
// connection would block a version change from another tab).
const DB_NAME = "lb-search";
const OBJECTS = "payloads";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(OBJECTS);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("indexedDB open blocked"));
  });
}

function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T;
        try {
          const tx = db.transaction(OBJECTS, mode);
          const req = op(tx.objectStore(OBJECTS));
          if (req) req.onsuccess = () => (result = req.result);
          tx.oncomplete = () => {
            db.close();
            resolve(result);
          };
          tx.onerror = tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        } catch (e) {
          db.close();
          reject(e);
        }
      }),
  );
}

export function idbKV(): SearchKV {
  return {
    keys: () => run("readonly", (s) => s.getAllKeys()).then((ks) => ks.map(String)),
    get: (key) => run("readonly", (s) => s.get(key)),
    put: (key, value) => run("readwrite", (s) => void s.put(value, key)),
    del: (keys) => run("readwrite", (s) => keys.forEach((k) => s.delete(k))),
    clear: () => run("readwrite", (s) => void s.clear()),
  };
}
