// The optimistic-play reconcile rules and the history-payload patcher — every case pins
// an audit finding (grace-window false confirms, day scoping, identity dedupe, the
// same-minute boundary).
import { describe, expect, it } from "vitest";
import { addPlay, reconcilePlays, type PlayRow, type Provisional } from "@/lib/optimistic-play";
import { patchHistoryPayload } from "@/lib/history-patch";
import { fuzzyFilter } from "@/lib/filter";
import { formatDuration, timeAgo } from "@/lib/format";

const row = (name: string, lastPlayed: string, over: Partial<PlayRow> = {}): PlayRow => ({
  id: name,
  name,
  artist: "Artist",
  uri: `spotify:track:${name}`,
  album: null,
  albumImage: null,
  durationMs: 180000,
  plays: 1,
  lastPlayed,
  firstPlayed: lastPlayed,
  source: null,
  ...over,
});

const prov = (name: string, at: number, day = "2026-08-10"): Provisional => ({
  row: row(name, new Date(at).toISOString()),
  at,
  day,
});

describe("reconcilePlays", () => {
  const T = Date.parse("2026-08-10T20:00:00Z");

  it("an EARLIER play of the same song no longer falsely confirms a fresh provisional", () => {
    // Server row's lastPlayed is 40s before the mint — outside the 30s grace, so the
    // repeat play must survive as a provisional (old 90s grace swallowed it).
    const server = [row("Repeat", new Date(T - 40_000).toISOString())];
    const { rows, remaining } = reconcilePlays(server, [prov("Repeat", T)], T + 1000);
    expect(remaining.length).toBe(1);
    expect(rows.find((r) => r.name === "Repeat")?.plays).toBe(2);
  });

  it("a server row at/after the mint confirms and retires the provisional", () => {
    const server = [row("Fresh", new Date(T + 5_000).toISOString())];
    const { rows, remaining } = reconcilePlays(server, [prov("Fresh", T)], T + 10_000);
    expect(remaining.length).toBe(0);
    expect(rows.find((r) => r.name === "Fresh")?.plays).toBe(1);
  });

  it("expired provisionals drop silently", () => {
    const { remaining } = reconcilePlays([], [prov("Old", T)], T + 6 * 60_000);
    expect(remaining.length).toBe(0);
  });

  it("addPlay never moves a row's timestamp backwards", () => {
    const server = row("S", "2026-08-10T21:00:00.000Z");
    const merged = addPlay([server], row("S", "2026-08-10T20:00:00.000Z"));
    expect(merged[0].plays).toBe(2);
    expect(merged[0].lastPlayed).toBe("2026-08-10T21:00:00.000Z");
  });
});

describe("patchHistoryPayload", () => {
  const base = {
    images: [],
    albums: [],
    sources: [],
    tracks: [["Song", "Artist", -1, -1, 180000]] as [string, string, number, number, number][],
    plays: [[0, 29_700_000, -1]] as [number, number, number][],
  };

  it("re-delivered boundary-minute plays dedupe by IDENTITY, not track index", () => {
    // Same song already present at the same minute under index 0; the delta re-delivers it.
    const patched = patchHistoryPayload(base, [
      row("Song", new Date(29_700_000 * 60000).toISOString()),
    ]);
    expect(patched.plays).toBe(base.plays); // same reference = nothing new
  });

  it("a different song in the same minute IS delivered", () => {
    const patched = patchHistoryPayload(base, [
      row("Other", new Date(29_700_000 * 60000).toISOString()),
    ]);
    expect(patched.plays.length).toBe(2);
  });
});

describe("format/filter edges", () => {
  it("formatDuration guards zero/negative/NaN", () => {
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(-1000)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(61_000)).toBe("1:01");
  });
  it("timeAgo guards unparseable input", () => {
    expect(timeAgo("garbage")).toBe("—");
  });
  it("fuzzyFilter matches all tokens in any order", () => {
    const items = ["Old Chinese Song", "New Wave"];
    expect(fuzzyFilter(items, "chinese old", (s) => s)).toEqual(["Old Chinese Song"]);
  });
});
