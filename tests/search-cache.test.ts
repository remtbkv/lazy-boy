// Phase E (docs/STORE_MIGRATION.md §10): the browser's copy of the two search payloads. The cache
// module runs here against an in-memory map standing in for IndexedDB; the IndexedDB adapter is
// the only part these tests do not reach.
import { describe, expect, it, vi } from "vitest";
import {
  historyOk,
  libraryOk,
  readStored,
  slotFor,
  writeStored,
  type SearchKV,
  type Slot,
} from "@/lib/search-cache";
import { HISTORY_INDEX_SHAPE, LIBRARY_INDEX_SHAPE } from "@/lib/search-shape";

function memoryKV(): SearchKV & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    keys: async () => [...map.keys()],
    get: async (k) => map.get(k),
    put: async (k, v) => void map.set(k, v),
    del: async (ks) => ks.forEach((k) => map.delete(k)),
    clear: async () => map.clear(),
  };
}

const failingKV: SearchKV = {
  keys: () => Promise.reject(new Error("private mode")),
  get: () => Promise.reject(new Error("private mode")),
  put: () => Promise.reject(new Error("QuotaExceededError")),
  del: () => Promise.reject(new Error("private mode")),
  clear: () => Promise.reject(new Error("private mode")),
};

const LIB = { v: "41", images: ["i"], albums: ["a"], playlists: ["p"], tracks: [["n", "ar", 0, 0, [0]]] };
const HIST = {
  v: "907",
  images: [],
  albums: [],
  sources: ["s"],
  tracks: [["n", "ar", -1, -1, 200000]],
  plays: [[0, 29_000_000, 0]],
};
const lib = (u = "solo") => slotFor(u, "library");
const hist = (u = "solo") => slotFor(u, "history");

describe("readStored / writeStored", () => {
  it("round-trips each half", async () => {
    const kv = memoryKV();
    await writeStored(kv, lib(), "41", JSON.stringify(LIB));
    await writeStored(kv, hist(), "907", JSON.stringify(HIST));
    expect(await readStored(kv, lib(), libraryOk)).toEqual(LIB);
    expect(await readStored(kv, hist(), historyOk)).toEqual(HIST);
  });

  it("an empty store is a miss", async () => {
    expect(await readStored(memoryKV(), lib(), libraryOk)).toBeNull();
  });

  it("keys a record by (userKey, epoch, kind, segment, version, shape) and stamps the user on it", async () => {
    const kv = memoryKV();
    await writeStored(kv, hist(), "907", JSON.stringify(HIST));
    const [key] = kv.map.keys();
    expect(JSON.parse(key)).toEqual(["solo", "0", "history", "all", "907", HISTORY_INDEX_SHAPE]);
    expect((kv.map.get(key) as { u: string }).u).toBe("solo");
  });

  it("stores a body the server could not version (v: null)", async () => {
    const kv = memoryKV();
    const body = { ...LIB, v: null };
    await writeStored(kv, lib(), null, JSON.stringify(body));
    expect(await readStored(kv, lib(), libraryOk)).toEqual(body);
  });

  it("a numeric version still yields a key the next read can decode", async () => {
    const kv = memoryKV();
    await writeStored(kv, lib(), 670 as unknown as string, JSON.stringify(LIB));
    expect(await readStored(kv, lib(), libraryOk)).toEqual(LIB);
    expect(kv.map.size).toBe(1);
  });

  it("a write replaces that half's previous version and leaves the other half alone", async () => {
    const kv = memoryKV();
    await writeStored(kv, lib(), "41", JSON.stringify(LIB));
    await writeStored(kv, hist(), "906", JSON.stringify({ ...HIST, v: "906" }));
    await writeStored(kv, hist(), "907", JSON.stringify(HIST));
    expect(kv.map.size).toBe(2);
    expect(await readStored(kv, hist(), historyOk)).toEqual(HIST);
    expect(await readStored(kv, lib(), libraryOk)).toEqual(LIB);
  });

  it("a stored body that fails the network path's validators is a miss and is deleted", async () => {
    const kv = memoryKV();
    // A v1 history body: four slots per track, no durationMs.
    const v1 = { ...HIST, tracks: [["n", "ar", -1, -1]] };
    await writeStored(kv, hist(), "907", JSON.stringify(v1));
    expect(await readStored(kv, hist(), historyOk)).toBeNull();
    expect(kv.map.size).toBe(0);
  });

  it("unparseable text is a miss and is deleted", async () => {
    const kv = memoryKV();
    await writeStored(kv, lib(), "41", '{"tracks": [');
    expect(await readStored(kv, lib(), libraryOk)).toBeNull();
    expect(kv.map.size).toBe(0);
  });

  it("a record whose stamp is another user's is a miss and is deleted", async () => {
    const kv = memoryKV();
    await writeStored(kv, lib(), "41", JSON.stringify(LIB));
    const [key] = kv.map.keys();
    kv.map.set(key, { u: "someone-else", text: JSON.stringify(LIB) });
    expect(await readStored(kv, lib(), libraryOk)).toBeNull();
    expect(kv.map.size).toBe(0);
  });

  it("a different user key clears the whole store, both halves", async () => {
    const kv = memoryKV();
    await writeStored(kv, lib("solo"), "41", JSON.stringify(LIB));
    await writeStored(kv, hist("solo"), "907", JSON.stringify(HIST));
    expect(await readStored(kv, lib("u2"), libraryOk)).toBeNull();
    expect(kv.map.size).toBe(0);
  });

  it("a key nothing can decode clears the store", async () => {
    const kv = memoryKV();
    await writeStored(kv, lib(), "41", JSON.stringify(LIB));
    kv.map.set("not json", 1);
    expect(await readStored(kv, lib(), libraryOk)).toBeNull();
    expect(kv.map.size).toBe(0);
  });

  it("an older build's shape is a miss and is deleted; so is another store epoch", async () => {
    const kv = memoryKV();
    const oldShape: Slot = { ...hist(), shape: "v1" };
    await writeStored(kv, oldShape, "907", JSON.stringify(HIST));
    expect(await readStored(kv, hist(), historyOk)).toBeNull();
    expect(kv.map.size).toBe(0);

    const otherEpoch: Slot = { ...lib(), epoch: "7" };
    await writeStored(kv, otherEpoch, "41", JSON.stringify(LIB));
    expect(await readStored(kv, lib(), libraryOk)).toBeNull();
    expect(kv.map.size).toBe(0);
  });

  it("another segment is a different record: neither a hit nor deleted", async () => {
    const kv = memoryKV();
    const may: Slot = { ...hist(), segment: "2026-05" };
    await writeStored(kv, may, "3", JSON.stringify(HIST));
    expect(await readStored(kv, hist(), historyOk)).toBeNull();
    expect(kv.map.size).toBe(1);
    expect(await readStored(kv, may, historyOk)).toEqual(HIST);
  });

  it("a storage that throws (private mode, quota) reads as a miss and never throws", async () => {
    const m = await freshModule();
    expect(await m.readStored(failingKV, lib(), libraryOk)).toBeNull();
    await expect(m.writeStored(failingKV, lib(), "41", JSON.stringify(LIB))).resolves.toBeUndefined();
    await expect(m.clearStored(failingKV)).resolves.toBeUndefined();
  });
});

// clearStored is the sign-out form's: it ends storing for the page, so each of these gets its own
// module instance.
const freshModule = async () => {
  vi.resetModules();
  return import("@/lib/search-cache");
};

describe("clearStored (the sign-out form)", () => {
  it("empties the store", async () => {
    const m = await freshModule();
    const kv = memoryKV();
    await m.writeStored(kv, lib(), "41", JSON.stringify(LIB));
    expect(kv.map.size).toBe(1);
    await m.clearStored(kv);
    expect(kv.map.size).toBe(0);
  });

  it("a body that lands after the sign-out submit is not stored", async () => {
    // Home's history fetch is still in flight when the form submits; its body arrives after the
    // clear and must not put the signed-out user's copy back.
    const m = await freshModule();
    const kv = memoryKV();
    await m.clearStored(kv);
    await m.writeStored(kv, hist(), "907", JSON.stringify(HIST));
    expect(kv.map.size).toBe(0);
  });
});

describe("slotFor", () => {
  it("today: epoch 0, one segment, this build's shapes", () => {
    expect(slotFor("solo", "library")).toEqual({
      userKey: "solo",
      epoch: "0",
      kind: "library",
      segment: "all",
      shape: LIBRARY_INDEX_SHAPE,
    });
    expect(slotFor("solo", "history").shape).toBe(HISTORY_INDEX_SHAPE);
  });
});

describe("the validators (shared with the network path)", () => {
  it("library: five-slot tracks, or none", () => {
    expect(libraryOk(LIB)).toBe(true);
    expect(libraryOk({ ...LIB, tracks: [] })).toBe(true);
    expect(libraryOk({ ...LIB, tracks: [["n", "ar", 0, 0]] })).toBe(false);
    expect(libraryOk({ images: [] })).toBe(false);
    expect(libraryOk(null)).toBe(false);
  });
  it("history: five-slot tracks (v2) and a plays array", () => {
    expect(historyOk(HIST)).toBe(true);
    expect(historyOk({ ...HIST, tracks: [], plays: [] })).toBe(true);
    expect(historyOk({ ...HIST, tracks: [["n", "ar", -1, -1]] })).toBe(false);
    expect(historyOk({ ...HIST, plays: undefined })).toBe(false);
    expect(historyOk(null)).toBe(false);
  });
});
