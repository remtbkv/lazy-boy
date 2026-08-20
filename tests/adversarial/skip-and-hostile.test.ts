// Adversarial: the skip rule's exact boundary, the backfill exclusion contract, and what
// survives hostile text.
//
// Documented contract, quoted:
//   db.ts:778-784 — "A play with less than this fraction of the song actually listened is a
//     SKIP … Listened time is estimated exactly as the hours are: the gap to the NEXT play,
//     capped at song length." SKIP_FRACTION = 0.35.
//   db.ts:786-790 — "Unknown duration or a clock-weird negative gap counts as not-skipped
//     (be permissive). The newest play stays pending."
//   db.ts:768-774 — backfill rows "are EXCLUDED from every listening counter — all-time
//     totals, the day strip, day rows — and INCLUDED wherever a song's history/existence is
//     the point (the search payloads, per-play history, source labels, the all-time list)."
//   docs/LOGIC_AUDIT_2026-08-19.md:49-53 (T1.5) — `since` must not read as the sentinel.
import { beforeEach, describe, expect, it } from "vitest";
import {
  getAllTimePlays,
  getDailyStats,
  getHistoryIndex,
  getPlaysByDay,
  hasPlaysBeforeDay,
  recomputeAllTimeStats,
  recordPlays,
  searchHistory,
  findTrackWithPlaylists,
} from "@/lib/db";
import { DAY_MS, iso, play, resetStore, verdicts } from "./helpers";

const BASE = Math.floor((Date.now() - 3 * DAY_MS) / DAY_MS) * DAY_MS + 10 * 3_600_000;
const DUR = 100_000; // 35% = 35_000 exactly

/** Record `a` then `b` then a far-future terminator, and return a's stored verdict. */
async function verdictOf(gapMs: number, durationMs: number | null): Promise<number | null> {
  await recordPlays([
    play("a", iso(BASE), durationMs),
    play("b", iso(BASE + gapMs), 200_000),
    play("z", iso(BASE + gapMs + 10_000_000), 200_000),
  ]);
  return (await verdicts())[`a@${iso(BASE)}`];
}

describe("the 35% skip boundary", () => {
  beforeEach(resetStore);

  it("listened exactly 35% of the song is NOT a skip (the rule is strictly <)", async () => {
    expect(await verdictOf(35_000, DUR)).toBe(0);
  });

  it("one millisecond under 35% IS a skip", async () => {
    expect(await verdictOf(34_999, DUR)).toBe(1);
  });

  it("one millisecond over 35% is not a skip", async () => {
    expect(await verdictOf(35_001, DUR)).toBe(0);
  });

  it("a gap longer than the song is capped at song length → not a skip", async () => {
    expect(await verdictOf(9 * 3_600_000, DUR)).toBe(0);
  });

  it("unknown (NULL) duration is permissive even at a 1ms gap", async () => {
    expect(await verdictOf(1, null)).toBe(0);
  });

  it("zero duration is permissive", async () => {
    expect(await verdictOf(1, 0)).toBe(0);
  });

  it("the newest play stays pending, and a pending play still counts as a play", async () => {
    await recordPlays([play("only", iso(BASE), DUR)]);
    expect(await verdicts()).toEqual({ [`only@${iso(BASE)}`]: null });
    expect((await recomputeAllTimeStats()).plays).toBe(1);
    expect(await searchHistory("")).toHaveLength(1);
  });

  it("a skipped play is excluded from every counter but keeps its row", async () => {
    await recordPlays([
      play("skipme", iso(BASE), DUR),
      play("kept", iso(BASE + 1_000), 200_000),
      play("last", iso(BASE + 600_000), 200_000),
    ]);
    expect((await verdicts())[`skipme@${iso(BASE)}`]).toBe(1);
    const stats = await recomputeAllTimeStats();
    expect(stats.plays).toBe(2);
    expect(await searchHistory("Song skipme")).toEqual([]);
    const day = await getPlaysByDay(iso(BASE).slice(0, 10), 0);
    expect(day.map((t) => t.id).sort()).toEqual(["kept", "last"]);
  });

  // Reading chosen for the two tests below: with two plays at the same instant the rule's
  // "next play" is ambiguous, so the store may rule either one the zero-length listen. What
  // it may NOT do is let the answer depend on which one was handed to recordPlays first —
  // db.ts:556-563 exists precisely so a verdict is a fact about the timeline rather than an
  // arrival artifact, and db.ts:786-790 states the rule in terms of the timeline only.
  const tiedPair = async (first: "A" | "B") => {
    const at = iso(BASE);
    const A = play("A", at, DUR);
    const B = play("B", at, DUR);
    const tail = play("tail", iso(BASE + 1_800_000), DUR);
    await recordPlays(first === "A" ? [A, B, tail] : [B, A, tail]);
    return verdicts();
  };

  it("two plays sharing a played_at: the per-track verdict is arrival-independent", async () => {
    const forwards = await tiedPair("A");
    await resetStore();
    const backwards = await tiedPair("B");
    expect(backwards).toEqual(forwards);
  });

  it("two plays sharing a played_at: the NUMBER of skips is arrival-independent", async () => {
    const forwards = await tiedPair("A");
    await resetStore();
    const backwards = await tiedPair("B");
    const skips = (v: Record<string, number | null>) =>
      Object.values(v).filter((x) => x === 1).length;
    expect(skips(backwards)).toBe(skips(forwards));
    expect(skips(forwards)).toBe(1);
  });

  it("a tied play arriving LATE converges on the same verdicts as one arriving together", async () => {
    // The predecessor re-open (db.ts:567-572) selects `p.played_at < :at` — strictly less —
    // so a play landing at a timestamp already in the store cannot re-open its tie-mate,
    // whose verdict was measured against a successor that is no longer adjacent. That is the
    // exact staleness db.ts:556-563 says this machinery exists to prevent.
    const at = iso(BASE);
    const X = play("X", at, DUR);
    const Z = play("Z", at, DUR);
    const Y = play("Y", iso(BASE + 1_800_000), DUR);

    await recordPlays([X, Z, Y]);
    const together = await verdicts();
    await resetStore();
    await recordPlays([X, Y]);
    await recordPlays([Z]);
    const late = await verdicts();

    expect(late).toEqual(together);
  });

  it("a tied play arriving LATE gives the same all-time play count", async () => {
    // The reader-level consequence of the case above: whether the store counts 2 or 3 plays
    // for the same three rows must not depend on which sync tick delivered them.
    const at = iso(BASE);
    const X = play("X", at, DUR);
    const Z = play("Z", at, DUR);
    const Y = play("Y", iso(BASE + 1_800_000), DUR);

    await recordPlays([X, Z, Y]);
    const together = (await recomputeAllTimeStats()).plays;
    await resetStore();
    await recordPlays([X, Y]);
    await recordPlays([Z]);
    const late = (await recomputeAllTimeStats()).plays;

    expect(late).toBe(together);
  });

  it("mixed timestamp precision at the same second records both plays", async () => {
    await recordPlays([
      play("noms", `${iso(BASE).slice(0, 19)}Z`, DUR),
      play("withms", iso(BASE + 789), DUR),
      play("later", iso(BASE + 1_800_000), DUR),
    ]);
    expect((await recomputeAllTimeStats()).plays).toBeGreaterThanOrEqual(2);
    expect(await searchHistory("")).toHaveLength(3);
  });
});

describe("backfill rows (context_type = 'backfill')", () => {
  const SENTINEL = "2026-05-30T00:00:00.000Z";
  const backfill = (id: string) =>
    play(id, SENTINEL, 200_000, { contextType: "backfill", contextUri: null });

  beforeEach(resetStore);

  it("is excluded from every listening counter", async () => {
    await recordPlays([backfill("cat1"), backfill("cat2")]);
    await recordPlays([play("real1", iso(BASE), 200_000), play("real2", iso(BASE + 600_000), 200_000)]);
    const stats = await recomputeAllTimeStats();
    expect(stats.plays).toBe(2);
    expect(stats.uniqueTracks).toBe(2);

    const daily = await getDailyStats(0, 400);
    expect(daily.reduce((n, d) => n + d.plays, 0)).toBe(2);
    expect(daily.map((d) => d.day)).not.toContain(SENTINEL.slice(0, 10));

    expect(await getPlaysByDay(SENTINEL.slice(0, 10), 0)).toEqual([]);
    // The sentinel is the only thing before today, and it must not make the strip expandable.
    expect(await hasPlaysBeforeDay(iso(BASE).slice(0, 10), 0)).toBe(false);
  });

  it("the 2026-05-30 sentinel never becomes `since` (T1.5)", async () => {
    await recordPlays([backfill("cat1")]);
    await recordPlays([play("real1", iso(BASE), 200_000), play("real2", iso(BASE + 600_000), 200_000)]);
    const stats = await recomputeAllTimeStats();
    expect(stats.since).toBe(iso(BASE));
    expect(stats.since?.slice(0, 10)).not.toBe("2026-05-30");
  });

  it("is INCLUDED in search, the all-time list and the history payload", async () => {
    await recordPlays([backfill("cat1")]);
    await recordPlays([play("real1", iso(BASE), 200_000), play("real2", iso(BASE + 600_000), 200_000)]);

    expect((await searchHistory("")).map((t) => t.id)).toContain("cat1");
    expect((await searchHistory("Song cat1")).map((t) => t.id)).toEqual(["cat1"]);
    expect((await getAllTimePlays(500)).map((t) => t.id)).toContain("cat1");
    const idx = await getHistoryIndex("v");
    expect(idx.tracks.map((t) => t[0])).toContain("Song cat1");
  });

  it("a store holding ONLY backfill rows reports an empty listening history", async () => {
    await recordPlays([backfill("cat1"), backfill("cat2")]);
    expect(await recomputeAllTimeStats()).toEqual({
      plays: 0,
      uniqueTracks: 0,
      durationMs: 0,
      since: null,
    });
    expect(await getDailyStats(0, 400)).toEqual([]);
  });
});

describe("hostile text", () => {
  const NASTY: [string, string][] = [
    ["quotes", `O'Brien "the ''best''" \\ back\\slash`],
    ["sql-ish", `Robert'); DROP TABLE plays;--`],
    ["like-wildcards", `100% _underscore_ [bracket]`],
    ["unicode", `Björk — 等一個人 — Ω≈ç√ 🎧`],
    ["newlines", `line one\nline two\r\nline three\tTAB`],
    ["long", "x".repeat(10_000)],
    ["empty-ish", " "],
  ];

  beforeEach(resetStore);

  it("round-trips names and artists byte-identically through every reader", async () => {
    const plays = NASTY.map(([, text], i) => ({
      ...play(`h${i}`, iso(BASE + i * 600_000), 200_000),
      name: text,
      artist: `${text} (artist)`,
    }));
    await recordPlays(plays);

    const rows = await searchHistory("", 500);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    for (let i = 0; i < NASTY.length; i++) {
      const [label, text] = NASTY[i];
      expect({ label, name: byId[`h${i}`]?.name, artist: byId[`h${i}`]?.artist }).toEqual({
        label,
        name: text,
        artist: `${text} (artist)`,
      });
    }
    // The table the injection string names is still there with every row in it.
    expect(rows).toHaveLength(NASTY.length);
    expect((await getAllTimePlays(500)).map((t) => t.name).sort()).toEqual(
      NASTY.map(([, t]) => t).sort(),
    );
    const idx = await getHistoryIndex("v");
    expect(idx.tracks.map((t) => t[0]).sort()).toEqual(NASTY.map(([, t]) => t).sort());
  });

  it("finds a hostile name by substring search", async () => {
    const plays = NASTY.map(([, text], i) => ({
      ...play(`h${i}`, iso(BASE + i * 600_000), 200_000),
      name: text,
      artist: `${text} (artist)`,
    }));
    await recordPlays(plays);
    // A fragment of each string that contains no LIKE metacharacter.
    const probes: [number, string][] = [
      [0, "O'Brien"],
      [1, "DROP TABLE"],
      [3, "等一個人"],
      [4, "line two"],
    ];
    for (const [i, q] of probes) {
      const hit = await searchHistory(q, 500);
      expect({ q, ids: hit.map((r) => r.id) }).toEqual({ q, ids: [`h${i}`] });
    }
    // 10k characters survive the round trip at full length.
    const long = (await searchHistory("", 500)).find((r) => r.id === "h5");
    expect(long?.name).toHaveLength(10_000);
  });

  it("identity lookup matches a unicode name exactly", async () => {
    await recordPlays([
      { ...play("bj", iso(BASE), 200_000), name: "Jóga", artist: "Björk" },
    ]);
    const found = await findTrackWithPlaylists("Jóga", "Björk");
    expect(found.track?.id).toBe("bj");
  });
});
