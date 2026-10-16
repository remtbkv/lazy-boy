// Simulation: the two offline play importers (scripts/backfill-from-backstop.mjs and
// scripts/import-extended-history.mjs) run as real child processes against the throwaway
// store, the way Rem runs them with `--db file:`. Pins D3 (one verdict reset for the whole
// dump instead of one per inserted run) and the D2 importer's contract (lazyboy-review,
// 2026-10-03).
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { beforeAll, describe, expect, it } from "vitest";
import { type PlayRecord } from "@/lib/db";
import { ownerStore } from "./owner-store";
import { insertedRuns } from "../scripts/import-tail.mjs";

const owner = ownerStore();

const DB = process.env.TURSO_DATABASE_URL!;
const scratch = mkdtempSync(path.join(tmpdir(), "lazyboy-import-"));
const root = path.resolve(__dirname, "..");

function run(script: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args, "--db", DB], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`${script} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

const store = () => createClient({ url: DB, intMode: "number" });

async function skippedAt(playedAt: string): Promise<number | null | undefined> {
  const c = store();
  const res = await c.execute({ sql: "SELECT skipped FROM plays WHERE played_at = ?", args: [playedAt] });
  c.close();
  return res.rows[0] ? (res.rows[0].skipped as number | null) : undefined;
}

async function meta(key: string): Promise<string | null> {
  const c = store();
  const res = await c.execute({ sql: "SELECT value FROM meta WHERE key = ?", args: [key] });
  c.close();
  return res.rows[0] ? String(res.rows[0].value) : null;
}

function play(trackId: string, playedAt: string): PlayRecord {
  return {
    trackId,
    name: `Song ${trackId}`,
    artist: "Artist",
    uri: `spotify:track:${trackId}`,
    album: null,
    albumImage: null,
    durationMs: 180_000,
    playedAt,
    contextType: null,
    contextUri: null,
  };
}

// A recently-played item as the recorder stores it (Spotify's API shape).
function captured(trackId: string, playedAt: string) {
  return JSON.stringify({
    played_at: playedAt,
    track: {
      id: trackId,
      name: `Song ${trackId}`,
      uri: `spotify:track:${trackId}`,
      type: "track",
      duration_ms: 180_000,
      artists: [{ name: "Artist" }],
      album: { name: "Album", images: [] },
    },
    context: null,
  });
}

describe("insertedRuns", () => {
  it("groups inserts that no existing row separates", () => {
    const existing = ["01", "05", "09"];
    expect(insertedRuns(existing, ["02", "03", "06", "10", "11"])).toEqual([
      { first: "02", last: "03" },
      { first: "06", last: "06" },
      { first: "10", last: "11" },
    ]);
  });

  it("an existing row at the same instant splits a run (its tie-mates need re-opening)", () => {
    expect(insertedRuns(["05"], ["04", "05", "06"])).toEqual([
      { first: "04", last: "04" },
      { first: "05", last: "05" },
      { first: "06", last: "06" },
    ]);
  });

  it("is order-independent and empty for no inserts", () => {
    expect(insertedRuns(["05"], ["06", "02"])).toEqual([
      { first: "02", last: "02" },
      { first: "06", last: "06" },
    ]);
    expect(insertedRuns(["05"], [])).toEqual([]);
  });
});

describe("backfill-from-backstop (D3)", () => {
  const D = "2026-07-01";
  const t = (hhmm: string) => `${D}T${hhmm}:00.000Z`;

  beforeAll(async () => {
    // A verdicted timeline with two holes the recorder can fill: 10:00-10:30 and 12:00-12:30.
    for (const [id, hhmm] of [
      ["far", "09:00"],
      ["a", "10:00"],
      ["b", "10:30"],
      ["c", "11:00"],
      ["d", "12:00"],
      ["e", "12:30"],
      ["f", "13:00"],
    ]) {
      await owner.recordPlays([play(id, t(hhmm))]);
    }
    await owner.rebuildHomePayload();
  });

  it("re-opens the neighbours on BOTH sides of EVERY inserted run, and nothing else", async () => {
    for (const hhmm of ["09:00", "10:00", "10:30", "11:00", "12:00", "12:30"]) {
      expect(await skippedAt(t(hhmm))).toBe(0);
    }
    const seqBefore = Number(await meta("write_seq"));
    const dump = path.join(scratch, "backstop.jsonl");
    // The dump is the recorder's whole history: already-stored plays plus two separated
    // windows of new ones. Its oldest item (09:00) borders neither window.
    writeFileSync(
      dump,
      [
        captured("far", t("09:00")),
        captured("x1", t("10:10")),
        captured("x2", t("10:20")),
        captured("a", t("10:00")),
        captured("y1", t("12:10")),
      ].join("\n"),
    );
    expect(run("backfill-from-backstop.mjs", dump)).toContain("3 inserted");

    // Window 1 (x1, x2) sits between a and b; window 2 (y1) between d and e.
    expect(await skippedAt(t("10:00"))).toBeNull();
    expect(await skippedAt(t("10:30"))).toBeNull();
    expect(await skippedAt(t("12:00"))).toBeNull();
    expect(await skippedAt(t("12:30"))).toBeNull();
    // The dump's oldest item and rows away from both windows keep their verdicts.
    expect(await skippedAt(t("09:00"))).toBe(0);
    expect(await skippedAt(t("11:00"))).toBe(0);
    expect(Number(await meta("write_seq"))).toBeGreaterThan(seqBefore);
    // Home's materialized payload no longer holds the gap: dropped so the next load rebuilds.
    expect(await meta("home_payload")).toBeNull();

    expect(run("backfill-from-backstop.mjs", dump)).toContain("0 inserted");
  });
});

describe("import-extended-history (D2)", () => {
  const D = "2026-07-05";
  const t = (hhmmss: string) => `${D}T${hhmmss}.000Z`;
  // Extended Streaming History rows: `ts` is the stream's END, second resolution.
  const row = (uri: string | null, hhmmss: string, ms = 120_000, name = "Song") => ({
    ts: `${D}T${hhmmss}Z`,
    ms_played: ms,
    master_metadata_track_name: uri ? name : null,
    master_metadata_album_artist_name: uri ? "Export Artist" : null,
    master_metadata_album_album_name: uri ? "Export Album" : null,
    spotify_track_uri: uri,
    spotify_episode_uri: uri ? null : "spotify:episode:ep1",
  });
  const window = `${D}T10:00:00Z/${D}T12:00:00Z`;

  beforeAll(async () => {
    await owner.recordPlays([play("before", t("09:00:00"))]);
    await owner.recordPlays([play("inside", t("10:30:00"))]);
    await owner.recordPlays([play("after", t("12:30:00"))]);
    await owner.rebuildHomePayload();
  });

  it("inserts only qualifying rows inside the gap windows, then is a no-op on re-run", async () => {
    expect(await skippedAt(t("09:00:00"))).toBe(0);
    const dir = path.join(scratch, "export");
    spawnSync("mkdir", ["-p", dir]);
    writeFileSync(
      path.join(dir, "Streaming_History_Audio_2026_0.json"),
      JSON.stringify([
        row("spotify:track:new1", "10:10:00", 120_000, "New One"), // inserted
        row("spotify:track:new2", "11:00:00"), // inserted
        row("spotify:track:inside", "10:30:04"), // within 5 s of a stored play → skip
        row("spotify:track:short", "10:40:00", 29_999), // under 30 s → skip
        row(null, "10:50:00"), // podcast episode → skip
        row("spotify:track:outside", "09:30:00"), // outside every window → skip
      ]),
    );
    // A second export file repeating a row: the export itself must not double-insert.
    writeFileSync(
      path.join(dir, "Streaming_History_Audio_2026_1.json"),
      JSON.stringify([row("spotify:track:new2", "11:00:00")]),
    );
    // Non-audio files in the export folder are ignored.
    writeFileSync(path.join(dir, "Streaming_History_Video_2026.json"), "[]");

    expect(run("import-extended-history.mjs", dir, "--window", window)).toContain("2 inserted");

    const c = store();
    const plays = (
      await c.execute({
        sql: "SELECT track_id, played_at, context_type FROM plays WHERE played_at LIKE ? ORDER BY played_at",
        args: [`${D}%`],
      })
    ).rows.map((r) => `${r.track_id}@${String(r.played_at).slice(11)}:${r.context_type}`);
    expect(plays).toEqual([
      "before@09:00:00.000Z:null",
      "new1@10:10:00.000Z:null",
      "inside@10:30:00.000Z:null",
      "new2@11:00:00.000Z:null",
      "after@12:30:00.000Z:null",
    ]);
    const track = (await c.execute("SELECT * FROM tracks WHERE id = 'new1'")).rows[0];
    expect(track).toMatchObject({
      name: "New One",
      artist: "Export Artist",
      album: "Export Album",
      uri: "spotify:track:new1",
      album_image: null,
      duration_ms: null,
    });
    c.close();
    // Neighbours of both runs re-opened; Home's payload dropped for a rebuild.
    expect(await skippedAt(t("09:00:00"))).toBeNull();
    expect(await skippedAt(t("10:30:00"))).toBeNull();
    expect(await meta("home_payload")).toBeNull();

    expect(run("import-extended-history.mjs", dir, "--window", window)).toContain("0 inserted");
  });

  it("never overwrites a track row the app already has", async () => {
    const file = path.join(scratch, "one.json");
    writeFileSync(file, JSON.stringify([row("spotify:track:inside", "11:30:00", 60_000, "Renamed")]));
    expect(run("import-extended-history.mjs", file, "--window", window)).toContain("1 inserted");
    const c = store();
    const track = (await c.execute("SELECT name, duration_ms FROM tracks WHERE id = 'inside'")).rows[0];
    c.close();
    expect(track).toMatchObject({ name: "Song inside", duration_ms: 180_000 });
  });
});
