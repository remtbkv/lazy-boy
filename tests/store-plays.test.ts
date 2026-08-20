// Simulation: the plays pipeline end-to-end against a real (throwaway, local) SQLite
// store — inserts, skip verdicts, out-of-order re-adjudication, backfill exclusion,
// counters. Every case here pins a finding from the 2026-08-19 audit.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getAllTimeStats,
  getDailyStats,
  getPlaysByDay,
  recordPlays,
  getSpotifyCooldownUntil,
  setSpotifyCooldownUntil,
  acquireLock,
  releaseLock,
  recomputeAllTimeStats,
  type PlayRecord,
} from "@/lib/db";

// All timestamps on one fixed local day, UTC offset 0 for determinism.
const DAY = "2026-08-10";
const at = (hhmmss: string, ms = "000") => `${DAY}T${hhmmss}.${ms}Z`;

let n = 0;
function play(
  playedAt: string,
  over: Partial<PlayRecord> = {},
): PlayRecord {
  n += 1;
  return {
    trackId: over.trackId ?? `t${n}`,
    name: over.name ?? `Song ${over.trackId ?? n}`,
    artist: over.artist ?? "Artist",
    uri: `spotify:track:${over.trackId ?? `t${n}`}`,
    album: null,
    albumImage: null,
    durationMs: over.durationMs ?? 180_000, // 3:00 → skip bar at 63s
    playedAt,
    contextType: over.contextType ?? null,
    contextUri: over.contextUri ?? null,
    ...over,
  };
}

describe("plays pipeline (simulated store)", () => {
  beforeAll(async () => {
    // Warm the store (runs migrations once).
    await recordPlays([]);
  });

  it("in-order inserts: predecessor verdicts settle, newest stays pending", async () => {
    // 10:00 (3-min song) → next play 10:03 → gap 180s ≥ 35% → NOT skipped.
    // 10:03 (3-min song) → next play 10:03:30 → gap 30s < 63s → SKIPPED.
    // 10:03:30 → newest → pending (NULL) → still shown.
    const a = play(at("10:00:00"), { trackId: "a" });
    const b = play(at("10:03:00"), { trackId: "b" });
    const c = play(at("10:03:30"), { trackId: "c" });
    expect(await recordPlays([a])).toBe(1);
    expect(await recordPlays([a, b])).toBe(1); // dedupe: a already stored
    expect(await recordPlays([a, b, c])).toBe(1);

    const rows = await getPlaysByDay(DAY, 0);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toContain("a");
    expect(ids).toContain("c"); // pending → shown
    expect(ids).not.toContain("b"); // skipped → hidden
  });

  it("duplicate (trackId, playedAt) never double-counts", async () => {
    const d = play(at("11:00:00"), { trackId: "d" });
    expect(await recordPlays([d])).toBe(1);
    expect(await recordPlays([d])).toBe(0);
  });

  it("out-of-order gap-fill re-opens ONLY the true predecessor's verdict", async () => {
    // Existing: e1 12:00, e3 12:10 (e1 verdicted not-skipped: gap 600s).
    const e1 = play(at("12:00:00"), { trackId: "e1" });
    const e3 = play(at("12:10:00"), { trackId: "e3" });
    await recordPlays([e1, e3]);
    // Gap-fill: e2 at 12:00:20 → e1's true gap becomes 20s < 63s → e1 must flip to SKIPPED.
    const e2 = play(at("12:00:20"), { trackId: "e2" });
    await recordPlays([e1, e2, e3]);
    const rows = await getPlaysByDay(DAY, 0);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("e1"); // re-adjudicated to skipped
    expect(ids).toContain("e3");
    // e2's own verdict: gap to e3 ≈ 580s → not skipped.
    expect(ids).toContain("e2");
  });

  it("backfill rows are excluded from counters but keep real plays intact", async () => {
    const bf = play("2026-05-30T00:00:00.000Z", {
      trackId: "bf1",
      contextType: "backfill",
    });
    await recordPlays([bf]);
    const daily = await getDailyStats(0, 3650);
    const bfDay = daily.find((d) => d.day === "2026-05-30");
    expect(bfDay).toBeUndefined(); // never a day card
    await recomputeAllTimeStats();
    const all = await getAllTimeStats();
    // All-time counts only the real plays inserted above (a,c,d,e2,e3 — b,e1 skipped).
    expect(all.plays).toBe(5);
    expect(all.since >= at("10:00:00")).toBe(true); // never the backfill sentinel
  });

  it("daily stats agree with the day view on count and exclusions", async () => {
    const daily = await getDailyStats(0, 30);
    const day = daily.find((d) => d.day === DAY);
    const rows = await getPlaysByDay(DAY, 0);
    const rowPlays = rows.reduce((s, r) => s + r.plays, 0);
    expect(day?.plays).toBe(rowPlays);
  });

  it("cooldown persist is monotonic (a shorter later ban cannot shorten a longer one)", async () => {
    const far = Date.now() + 30 * 60 * 1000;
    const near = Date.now() + 60 * 1000;
    await setSpotifyCooldownUntil(far);
    await setSpotifyCooldownUntil(near);
    expect(await getSpotifyCooldownUntil()).toBe(Math.floor(far));
    // A LONGER later ban does extend.
    const farther = far + 60_000;
    await setSpotifyCooldownUntil(farther);
    expect(await getSpotifyCooldownUntil()).toBe(Math.floor(farther));
  });

  it("locks: nonce owners, expiry takeover, release only frees your own", async () => {
    const a = await acquireLock("simtest", 200);
    expect(a).not.toBeNull();
    expect(await acquireLock("simtest", 200)).toBeNull(); // held
    await new Promise((r) => setTimeout(r, 250));
    const b = await acquireLock("simtest", 60_000); // expired → takeover
    expect(b).not.toBeNull();
    expect(b).not.toBe(a);
    await releaseLock("simtest", a as string); // stale owner: must NOT free b's lock
    expect(await acquireLock("simtest", 60_000)).toBeNull();
    await releaseLock("simtest", b as string);
    expect(await acquireLock("simtest", 60_000)).not.toBeNull();
  });
});
