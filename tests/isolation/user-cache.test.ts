// userCache (PLAN.md §6.2 layer 4, T2's helper half): the one wrapper around unstable_cache.
// Run against a stub that keys the way Next does, so a key that forgets the user collides
// here the way it would in production. db.ts's seven cached reads move onto this helper in
// Phase 1's turn (they are in a file queued lanes edit); T2 over them is pending.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rawClient, resetStore } from "../adversarial/helpers";
import { A, B } from "./harness";

vi.mock("next/cache", async () => await import("../stubs/next-cache-faithful"));
const { __cache } = await import("../stubs/next-cache-faithful");
const { userCache } = await import("@/lib/user-cache");

const EPOCH = "e1";
/** The isolation events the server recorded (Phase 1: telemetry rows, PLAN.md §6.5). */
async function reported(): Promise<{ code: string; uid: string }[]> {
  const c = await rawClient();
  const r = await c.execute("SELECT meta FROM client_metrics WHERE event = 'isolation' ORDER BY id");
  return r.rows.map((row) => {
    const [code, uid] = String(row.meta).split("|");
    return { code, uid };
  });
}
beforeEach(async () => {
  __cache.clear();
  await resetStore();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// A "store" whose answers name the user, with equal version counters for both users: the
// collision the per-user databases make likely (01a §5: small integers collide).
const data: Record<string, string> = { [A]: "A-only-history", [B]: "B-only-history" };
const version = 7;

describe("userCache", () => {
  it("equal counters: A then B each get their own value, and each is cached", async () => {
    let reads = 0;
    const read = userCache(
      "history",
      async (uid, v: number) => (reads++, `${data[uid]}@${v}`),
      ["shape-1"],
      { revalidate: 60 },
    );
    expect(await read(A, EPOCH, version)).toBe("A-only-history@7");
    expect(await read(B, EPOCH, version)).toBe("B-only-history@7");
    expect(await read(A, EPOCH, version)).toBe("A-only-history@7");
    expect(await read(B, EPOCH, version)).toBe("B-only-history@7");
    expect(reads).toBe(2);
    expect(await reported()).toEqual([]);
  });

  it("the uid and the store epoch are in every key", async () => {
    const read = userCache("k", async (uid) => data[uid], ["s"], { revalidate: 60 });
    await read(A, EPOCH);
    await read(A, "e2");
    const keys = __cache.keys();
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toContain(A);
    expect(keys.some((k) => k.includes("e2"))).toBe(true);
  });

  it("a forged entry under B's key stamped with A is refused, B served uncached, an event recorded", async () => {
    const read = userCache("history-forged", async (uid) => data[uid], ["shape-1"], { revalidate: 60 });
    await read(B, EPOCH); // creates B's real key
    const [bKey] = __cache.keys();
    __cache.forge(bKey, { o: A, v: "A-only-history" });
    expect(await read(B, EPOCH)).toBe("B-only-history");
    expect(await reported()).toEqual([{ code: "cache-stamp", uid: B }]);
  });

  it("two wrappers with the same key parts cannot share a name", () => {
    userCache("dup", async () => 1, ["x"], { revalidate: 60 });
    expect(() => userCache("dup", async () => 2, ["x"], { revalidate: 60 })).toThrow(/name/);
  });

  it("a wrapper's callback captured in a closure is still told apart by its name", async () => {
    const one = userCache("one", async (uid) => `one:${data[uid]}`, [], { revalidate: 60 });
    const two = userCache("two", async (uid) => `two:${data[uid]}`, [], { revalidate: 60 });
    expect(await one(A, EPOCH)).toBe("one:A-only-history");
    expect(await two(A, EPOCH)).toBe("two:A-only-history");
  });
});
