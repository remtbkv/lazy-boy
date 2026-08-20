// ADVERSARIAL — src/lib/history-days.ts
// Expectations from the file's own comments (lines 20-30, 32-35, 37-53, 61-63, 86-95,
// 118-119) and db.ts's TrackStats.source doc (db.ts:107, "where it was played from on the
// MOST RECENT play").

import { describe, expect, it } from "vitest";
import { buildDays, iso, type HistoryPayload } from "@/lib/history-days";

const MIN = (s: string) => Math.floor(Date.parse(s) / 60000);
const EST = -300; // minutes to ADD to UTC
const IST = 330; // +05:30, a half-hour zone
const CHATHAM = 765; // +12:45, a quarter-hour zone

const payload = (over: Partial<HistoryPayload> = {}): HistoryPayload => ({
  images: [],
  albums: [],
  sources: [],
  tracks: [],
  plays: [],
  ...over,
});

describe("buildDays — degenerate payloads", () => {
  it("empty payload yields empty maps and newest null", () => {
    const d = buildDays(payload(), EST);
    expect(d.rows.size).toBe(0);
    expect(d.playRows.size).toBe(0);
    expect(d.newest).toBeNull();
  });

  it("skips plays whose track index does not resolve", () => {
    const d = buildDays(
      payload({
        tracks: [["Song", "Artist", -1, -1, 0]],
        plays: [
          [0, MIN("2026-08-20T12:00:00Z"), -1],
          [9, MIN("2026-08-20T13:00:00Z"), -1], // dangling
          [-1, MIN("2026-08-20T14:00:00Z"), -1], // negative
        ],
      }),
      EST,
    );
    const day = "2026-08-20";
    expect(d.playRows.get(day)).toHaveLength(1);
    expect(d.rows.get(day)?.[0].plays).toBe(1);
  });

  it("newest never names a day the client holds no rows for", () => {
    // `newest` is the frontier: "Days strictly older than this are fully covered"
    // (history-days.ts:26-29) and den-home.tsx:284 routes `day >= newest` to the server.
    // A frontier pointing at a day with nothing in it is not a day the payload covers.
    const d = buildDays(
      payload({
        tracks: [["Song", "Artist", -1, -1, 0]],
        plays: [
          [7, MIN("2026-08-20T12:00:00Z"), -1], // dangling, newest
          [0, MIN("2026-08-18T12:00:00Z"), -1],
        ],
      }),
      EST,
    );
    expect(d.newest).not.toBeNull();
    expect(d.playRows.has(d.newest as string)).toBe(true);
  });

  it("a payload of ONLY unresolvable plays reports no frontier", () => {
    const d = buildDays(
      payload({ tracks: [], plays: [[0, MIN("2026-08-20T12:00:00Z"), -1]] }),
      EST,
    );
    expect(d.rows.size).toBe(0);
    expect(d.newest).toBeNull();
  });

  it("durationMs 0 becomes null, out-of-range album/image refs become null", () => {
    const d = buildDays(
      payload({
        images: ["i"],
        albums: ["a"],
        tracks: [["Song", "Artist", 5, 5, 0]],
        plays: [[0, MIN("2026-08-20T12:00:00Z"), 5]],
      }),
      EST,
    );
    const r = d.rows.get("2026-08-20")![0];
    expect(r.durationMs).toBeNull();
    expect(r.album).toBeNull();
    expect(r.albumImage).toBeNull();
    expect(r.source).toBeNull();
  });
});

describe("buildDays — conservation", () => {
  const build = () => {
    const tracks: HistoryPayload["tracks"] = [
      ["A", "X", -1, -1, 1000],
      ["B", "Y", -1, -1, 2000],
      ["C", "Z", -1, -1, 3000],
    ];
    const plays: HistoryPayload["plays"] = [];
    // 3 days x a deterministic scatter, newest-first.
    const stamps = [
      "2026-08-20T23:30:00Z",
      "2026-08-20T20:00:00Z",
      "2026-08-20T18:00:00Z",
      "2026-08-19T22:00:00Z",
      "2026-08-19T12:00:00Z",
      "2026-08-18T09:00:00Z",
      "2026-08-18T08:00:00Z",
      "2026-08-18T07:00:00Z",
      "2026-08-18T06:00:00Z",
    ];
    stamps.forEach((s, i) => plays.push([i % 3, MIN(s), -1]));
    return payload({ tracks, plays });
  };

  for (const off of [0, EST, IST, CHATHAM, -720, 840]) {
    it(`every play is bucketed exactly once at offset ${off}`, () => {
      const hist = build();
      const d = buildDays(hist, off);
      const totalPlayRows = [...d.playRows.values()].reduce((n, l) => n + l.length, 0);
      expect(totalPlayRows).toBe(hist.plays.length);
      const totalGrouped = [...d.rows.values()].reduce(
        (n, l) => n + l.reduce((m, r) => m + r.plays, 0),
        0,
      );
      expect(totalGrouped).toBe(hist.plays.length);
      // Per-day: grouped counts must equal that day's per-play rows.
      for (const [day, list] of d.rows) {
        expect(list.reduce((m, r) => m + r.plays, 0)).toBe(d.playRows.get(day)!.length);
      }
      // And every day key must be a valid ISO date.
      for (const day of d.rows.keys()) expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  }

  it("per-day play rows stay newest-first", () => {
    // "Plays arrive newest-first, so each day's per-play list is already newest-first."
    // (history-days.ts:118)
    const d = buildDays(build(), EST);
    for (const list of d.playRows.values()) {
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1].lastPlayed >= list[i].lastPlayed).toBe(true);
      }
    }
  });

  it("firstPlayed <= lastPlayed on every grouped row", () => {
    const d = buildDays(build(), EST);
    for (const list of d.rows.values()) {
      for (const r of list) expect(Date.parse(r.firstPlayed)).toBeLessThanOrEqual(Date.parse(r.lastPlayed));
    }
  });
});

describe("buildDays — local-day bucketing", () => {
  it("a minute at exact local midnight belongs to the NEW day", () => {
    // localDay(minute) shifts by offsetMin then slices the ISO date (history-days.ts:44).
    const midnightIST = MIN("2026-08-19T18:30:00Z"); // 2026-08-20T00:00 at +05:30
    const d = buildDays(
      payload({
        tracks: [["Song", "Artist", -1, -1, 0]],
        plays: [[0, midnightIST, -1]],
      }),
      IST,
    );
    expect([...d.playRows.keys()]).toEqual(["2026-08-20"]);
    expect(d.newest).toBe("2026-08-20");
  });

  it("one minute before local midnight belongs to the OLD day", () => {
    const d = buildDays(
      payload({
        tracks: [["Song", "Artist", -1, -1, 0]],
        plays: [[0, MIN("2026-08-19T18:29:00Z"), -1]],
      }),
      IST,
    );
    expect([...d.playRows.keys()]).toEqual(["2026-08-19"]);
  });

  it("splits one UTC day across two local days at a half-hour offset", () => {
    const d = buildDays(
      payload({
        tracks: [["Song", "Artist", -1, -1, 0]],
        plays: [
          [0, MIN("2026-08-19T19:00:00Z"), -1], // 2026-08-20 00:30 IST
          [0, MIN("2026-08-19T18:00:00Z"), -1], // 2026-08-19 23:30 IST
        ],
      }),
      IST,
    );
    expect(new Set(d.playRows.keys())).toEqual(new Set(["2026-08-20", "2026-08-19"]));
    expect(d.rows.get("2026-08-20")![0].plays).toBe(1);
    expect(d.rows.get("2026-08-19")![0].plays).toBe(1);
  });

  it("iso() round-trips an epoch minute", () => {
    const m = MIN("2026-08-20T12:34:00Z");
    expect(iso(m)).toBe("2026-08-20T12:34:00.000Z");
    expect(MIN(iso(m))).toBe(m);
  });
});

describe("buildDays — the same song under two track indices", () => {
  const dual = (): HistoryPayload =>
    payload({
      sources: ["playlist:A", "playlist:B"],
      tracks: [
        ["Song", "Artist", -1, -1, 200_000], // Spotify id #1
        ["Song", "Artist", -1, -1, 200_000], // Spotify id #2, same song
      ],
      plays: [],
    });

  it("groups both indices into ONE row for the day", () => {
    const hist = dual();
    hist.plays = [
      [1, MIN("2026-08-20T13:00:00Z"), 1],
      [0, MIN("2026-08-20T12:00:00Z"), 0],
    ];
    const d = buildDays(hist, 0);
    expect(d.rows.get("2026-08-20")).toHaveLength(1);
    expect(d.rows.get("2026-08-20")![0].plays).toBe(2);
  });

  it("per-play row ids stay unique when both indices play in the same minute", () => {
    // playRows ids are `identity@minute` (history-days.ts:67); the day list uses `id` as the
    // React key (history-days.ts:93-95). Two indices of one song sharing a minute — the very
    // dual-id payload history-patch.ts:57-59 says exists — collide.
    const hist = dual();
    const m = MIN("2026-08-20T12:00:00Z");
    hist.plays = [
      [0, m, 0],
      [1, m, 1],
    ];
    const d = buildDays(hist, 0);
    const ids = d.playRows.get("2026-08-20")!.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a day row's source is the song's most recent play OVERALL, across both indices", () => {
    // history-days.ts:46-53 states the rule in as many words ("the song's most recent play
    // OVERALL, not its last play that day"), and db.ts:107 defines TrackStats.source the same
    // way. `latestSource` is keyed by TRACK INDEX, so when the song's newest play sits under
    // the sibling id, an older day's row reports the wrong source — the identity-vs-index
    // defect that history-patch.ts fixed for the seen-set (audit T2.5) but this file did not.
    const hist = dual();
    hist.plays = [
      [1, MIN("2026-08-20T13:00:00Z"), 1], // newest overall: source "playlist:B"
      [0, MIN("2026-08-18T12:00:00Z"), 0], // older day, sibling index
    ];
    const d = buildDays(hist, 0);
    expect(d.rows.get("2026-08-20")![0].source).toBe("playlist:B");
    expect(d.rows.get("2026-08-18")![0].source).toBe("playlist:B");
  });

  it("with a SINGLE index the same scenario already reports the overall-newest source", () => {
    // Control: proves the rule above is the file's intent, not my invention.
    const hist = dual();
    hist.tracks = [["Song", "Artist", -1, -1, 200_000]];
    hist.plays = [
      [0, MIN("2026-08-20T13:00:00Z"), 1],
      [0, MIN("2026-08-18T12:00:00Z"), 0],
    ];
    const d = buildDays(hist, 0);
    expect(d.rows.get("2026-08-18")![0].source).toBe("playlist:B");
  });
});

describe("buildDays — grouped row ordering and stamps", () => {
  it("sorts a day by plays desc, then lastPlayed desc", () => {
    // history-days.ts:113-115
    const hist = payload({
      tracks: [
        ["A", "X", -1, -1, 0],
        ["B", "Y", -1, -1, 0],
        ["C", "Z", -1, -1, 0],
      ],
      plays: [
        [2, MIN("2026-08-20T15:00:00Z"), -1],
        [1, MIN("2026-08-20T14:00:00Z"), -1],
        [0, MIN("2026-08-20T13:00:00Z"), -1],
        [0, MIN("2026-08-20T12:00:00Z"), -1],
      ],
    });
    const d = buildDays(hist, 0);
    const list = d.rows.get("2026-08-20")!;
    expect(list.map((r) => r.name)).toEqual(["A", "C", "B"]);
    expect(list[0].plays).toBe(2);
  });

  it("a grouped row's lastPlayed is the day's newest play and firstPlayed its oldest", () => {
    // "the row was created from the day's LAST play — its time is already right, and every
    //  later play can only push firstPlayed back" (history-days.ts:86-90)
    const hist = payload({
      tracks: [["A", "X", -1, -1, 0]],
      plays: [
        [0, MIN("2026-08-20T15:00:00Z"), -1],
        [0, MIN("2026-08-20T13:00:00Z"), -1],
        [0, MIN("2026-08-20T11:00:00Z"), -1],
      ],
    });
    const r = buildDays(hist, 0).rows.get("2026-08-20")![0];
    expect(r.lastPlayed).toBe(iso(MIN("2026-08-20T15:00:00Z")));
    expect(r.firstPlayed).toBe(iso(MIN("2026-08-20T11:00:00Z")));
  });

  it("keeps each day's stamps inside that day", () => {
    const hist = payload({
      tracks: [["A", "X", -1, -1, 0]],
      plays: [
        [0, MIN("2026-08-20T15:00:00Z"), -1],
        [0, MIN("2026-08-19T15:00:00Z"), -1],
      ],
    });
    const d = buildDays(hist, 0);
    for (const [day, list] of d.rows) {
      for (const r of list) {
        expect(r.lastPlayed.slice(0, 10)).toBe(day);
        expect(r.firstPlayed.slice(0, 10)).toBe(day);
      }
    }
  });
});
