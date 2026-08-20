// buildDays — the client-side day derivation, now pure and executable.
import { describe, expect, it } from "vitest";
import { buildDays, type HistoryPayload } from "@/lib/history-days";

// Minutes for 2026-08-10 at hh:mm UTC.
const m = (h: number, min: number) => Math.floor(Date.UTC(2026, 7, 10, h, min) / 60000);

function payload(plays: [number, number, number][], tracks?: HistoryPayload["tracks"]): HistoryPayload {
  return {
    images: ["img0"],
    albums: ["alb0"],
    sources: ["Playlist A", "Playlist B"],
    tracks: tracks ?? [
      ["Song One", "Artist", 0, 0, 180000],
      ["Song Two", "Artist", 0, 0, 200000],
    ],
    plays, // newest-first, [trackIdx, minute, sourceIdx]
  };
}

describe("buildDays (pure)", () => {
  it("groups by identity with counts, and per-play rows keep their own times", () => {
    const p = payload([
      [0, m(22, 30), 1], // newest play of Song One, from Playlist B
      [1, m(21, 0), 0],
      [0, m(20, 0), 0], // older play of Song One
    ]);
    const d = buildDays(p, 0);
    const day = d.rows.get("2026-08-10");
    expect(day).toBeDefined();
    const one = day!.find((r) => r.name === "Song One");
    expect(one?.plays).toBe(2);
    // Row time = the day's LAST play; firstPlayed pushed back by the older play.
    expect(one?.lastPlayed).toBe(new Date(m(22, 30) * 60000).toISOString());
    expect(one?.firstPlayed).toBe(new Date(m(20, 0) * 60000).toISOString());
    // Source = the song's newest play's source overall (documented rule).
    expect(one?.source).toBe("Playlist B");
    expect(d.playRows.get("2026-08-10")!.length).toBe(3);
    expect(d.newest).toBe("2026-08-10");
  });

  it("buckets by the injected offset, not UTC", () => {
    // 23:30 UTC with +120 offset lands on the NEXT local day.
    const d = buildDays(payload([[0, m(23, 30), 0]]), 120);
    expect(d.rows.has("2026-08-11")).toBe(true);
    expect(d.rows.has("2026-08-10")).toBe(false);
  });

  it("a play referencing a missing track index is skipped, not crashed on", () => {
    const d = buildDays(payload([[99, m(12, 0), 0]]), 0);
    expect(d.rows.size).toBe(0);
    // newest still derives from the play list (documented: newest = plays[0]'s day).
    expect(d.newest).toBe("2026-08-10");
  });

  it("-1 interner slots render as null, never as an array read at -1", () => {
    const d = buildDays(payload([[0, m(12, 0), -1]], [["S", "A", -1, -1, 0]]), 0);
    const row = d.rows.get("2026-08-10")![0];
    expect(row.album).toBeNull();
    expect(row.albumImage).toBeNull();
    expect(row.source).toBeNull();
    expect(row.durationMs).toBeNull(); // 0 = unknown → null
  });
});
