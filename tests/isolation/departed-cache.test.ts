// The deletion's Data Cache step (lane 21's review): purgeDeparted, which the daily chores run for
// every friend whose `deleted` row is kept, expires that friend's userCache entries by their tag
// and leaves everyone else's. Run over the faithful cache stub, which keeps each entry's tags.
import { describe, expect, it, vi } from "vitest";
import { A, B } from "./harness";

vi.mock("next/cache", async () => await import("../stubs/next-cache-faithful"));
const { __cache } = await import("../stubs/next-cache-faithful");
const { userCache } = await import("@/lib/user-cache");
const { purgeDeparted } = await import("@/lib/deletion-runtime");

describe("a departed friend's Data Cache entries", () => {
  it("are expired by purgeDeparted, and another user's stay", async () => {
    const read = userCache("departed", async (uid) => `${uid}-only-history`, ["s"], { revalidate: 86_400 });
    await read(A, "e");
    await read(B, "e");
    expect(__cache.keys().filter((k) => k.includes(B))).toHaveLength(1);
    await purgeDeparted(B);
    expect(__cache.keys().filter((k) => k.includes(B))).toEqual([]);
    expect(__cache.keys().filter((k) => k.includes(A))).toHaveLength(1);
  });
});
