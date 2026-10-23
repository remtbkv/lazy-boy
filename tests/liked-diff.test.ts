// Known answers for Phase 3's Liked change (docs/multi-user/PLAN.md §7.7): position leaves the diff,
// so one like writes one row; the list is read from the newest page until a stored
// (track, added_at) appears; a full refetch only when the count still disagrees.
import { describe, expect, it } from "vitest";
import { likedDiff, likedHead, type LikedRow } from "@/lib/liked-diff";

const row = (trackId: string, day: number): LikedRow => ({ trackId, addedAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z` });
// Stored newest first, as Spotify lists it: t1000 (day 1) … t1 (oldest).
const stored: LikedRow[] = Array.from({ length: 1000 }, (_, i) => ({
  trackId: `t${1000 - i}`,
  addedAt: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString(),
}));

describe("likedDiff: keyed by track, position ignored", () => {
  it("one new like at the top writes one row, not N", () => {
    const incoming = [row("new", 20), ...stored];
    expect(likedDiff(incoming, stored)).toEqual({ upserts: [row("new", 20)], deletes: [] });
  });

  it("an unlike deletes one row; a re-like moves only that row's added_at", () => {
    const less = stored.filter((r) => r.trackId !== "t500");
    expect(likedDiff(less, stored)).toEqual({ upserts: [], deletes: ["t500"] });
    const relike = [row("t500", 20), ...less];
    expect(likedDiff(relike, stored)).toEqual({ upserts: [row("t500", 20)], deletes: [] });
  });

  it("an unchanged list writes nothing", () => {
    expect(likedDiff(stored, stored)).toEqual({ upserts: [], deletes: [] });
  });
});

describe("likedHead: read from the newest page until a stored row appears", () => {
  it("nothing changed: the first page meets the stored list at its first row, no writes", () => {
    expect(likedHead(stored.slice(0, 50), 1000, stored, false)).toEqual({ kind: "diff", upserts: [], deletes: [] });
  });

  it("three new likes: written from the first page alone", () => {
    const fresh = [row("n1", 22), row("n2", 21), row("n3", 20)];
    const page = [...fresh, ...stored].slice(0, 50);
    expect(likedHead(page, 1003, stored, false)).toEqual({ kind: "diff", upserts: fresh, deletes: [] });
  });

  it("more new likes than a page: ask for the next page, then write them all", () => {
    const fresh = Array.from({ length: 60 }, (_, i) => row(`n${i}`, 28 - (i % 20)));
    const all = [...fresh, ...stored];
    expect(likedHead(all.slice(0, 50), 1060, stored, false)).toEqual({ kind: "more" });
    expect(likedHead(all.slice(0, 100), 1060, stored, false)).toEqual({ kind: "diff", upserts: fresh, deletes: [] });
  });

  it("an unlike the head cannot see: the count disagrees, so refetch", () => {
    const less = stored.filter((r) => r.trackId !== "t10");
    expect(likedHead(less.slice(0, 50), 999, stored, false)).toEqual({ kind: "refetch" });
  });

  it("an unlike and a like in one window: the count matches the old one, still a refetch", () => {
    const list = [row("n1", 22), ...stored.filter((r) => r.trackId !== "t10")];
    expect(likedHead(list.slice(0, 50), 1000, stored, false)).toEqual({ kind: "refetch" });
  });

  it("a re-like of an older song: one row moves, the count agrees", () => {
    const list = [row("t3", 22), ...stored.filter((r) => r.trackId !== "t3")];
    expect(likedHead(list.slice(0, 50), 1000, stored, false)).toEqual({ kind: "diff", upserts: [row("t3", 22)], deletes: [] });
  });

  it("an empty store reads to the end and writes the whole list", () => {
    const list = stored.slice(0, 120);
    expect(likedHead(list.slice(0, 50), 120, [], false)).toEqual({ kind: "more" });
    expect(likedHead(list, 120, [], true)).toEqual({ kind: "diff", upserts: list, deletes: [] });
  });

  it("read to the end without meeting the store: the whole list is in hand, so diff it in full", () => {
    const list = [row("n1", 22), row("n2", 21)];
    expect(likedHead(list, 2, stored, true)).toEqual({ kind: "diff", upserts: list, deletes: stored.map((r) => r.trackId) });
  });

  it("an emptied Liked list", () => {
    expect(likedHead([], 0, stored, true)).toEqual({ kind: "diff", upserts: [], deletes: stored.map((r) => r.trackId) });
  });
});
