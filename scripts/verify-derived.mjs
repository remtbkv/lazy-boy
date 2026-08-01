// Recompute-from-source verifier for the store's DERIVED values.
//
// src/lib/db.ts caches three values that are cheap to read and expensive to compute, and
// keeps them fresh by hand-maintained invalidation (recomputeAllTimeStats /
// recomputeUniqueSongCount / recomputeOrphanFlags, each called from the writes that can
// change them). Nothing checked that the stored answers still equal what the source data
// says. This script is that check: it recomputes each value from source and exits non-zero,
// naming the diff, when a stored value disagrees.
//
// Runs against the PRIMARY (TURSO_DATABASE_URL) — the source of truth, and the client
// db.ts itself uses for every `meta` read. Read-only unless --demo is passed.
//
//   node --env-file=.env.local scripts/verify-derived.mjs          # verify (read-only)
//   node --env-file=.env.local scripts/verify-derived.mjs --demo    # prove it catches corruption
//
// --demo deliberately corrupts each stored value ON THE LIVE PRIMARY for a few seconds and
// checks that the verifier fails on it, then restores the saved original (in a finally, so a
// crash can't leave the corruption behind). A green run on untouched data proves nothing on
// its own: the bar is BOTH sides — fail on every injected corruption AND pass on clean data.
// A verifier that always passes, or always fails, meets neither half.
import { createClient } from "@libsql/client";

const URL_PRIMARY = process.env.TURSO_DATABASE_URL;
const AUTH = process.env.TURSO_AUTH_TOKEN;
if (!URL_PRIMARY) throw new Error("TURSO_DATABASE_URL missing (run with --env-file=.env.local)");

const DEMO = process.argv.includes("--demo");
// How long a mid-flight sync gets to finish before a mismatch is called a real failure.
const RACE_RECHECK_MS = 2000;

// ── logic copied from src/lib/db.ts ────────────────────────────────────────────────────
// These must match the store, or the comparison is meaningless. Each block names its source.

// db.ts LISTEN_FALLBACK_MS / LISTEN_MIN_MS
const LISTEN_FALLBACK_MS = 600000;
const LISTEN_MIN_MS = 5000;

// db.ts playsWithListened() — the ordered plays⋈tracks fetch the gap math runs over.
const PLAYS_ORDERED_SQL = `
  SELECT p.played_at AS playedAt, p.track_id AS trackId, t.duration_ms AS durationMs
  FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
  ORDER BY p.played_at ASC`;

// db.ts recomputeUniqueSongCount() — the DISTINCT (artist, title) scan.
const UNIQUE_SONG_SQL = `
  SELECT COUNT(*) AS n FROM (
    SELECT DISTINCT lower(t.artist) AS a, lower(t.name) AS m
    FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
  )`;

// MUST MATCH src/lib/db.ts ORPHAN_PREDICATE — a mismatch here is exactly what this script
// exists to catch.
const ORPHAN_PREDICATE = `
  CASE WHEN p.context_type = 'playlist' AND p.context_uri IS NOT NULL
            AND EXISTS (SELECT 1 FROM playlist_tracks pl
                        WHERE pl.playlist_id = replace(p.context_uri, 'spotify:playlist:', ''))
            AND NOT EXISTS (
              SELECT 1 FROM playlist_tracks plm JOIN tracks tm ON tm.id = plm.track_id
              WHERE plm.playlist_id = replace(p.context_uri, 'spotify:playlist:', '')
                AND lower(tm.artist) = (SELECT lower(artist) FROM tracks WHERE id = p.track_id)
                AND lower(tm.name) = (SELECT lower(name) FROM tracks WHERE id = p.track_id))
       THEN 1 ELSE 0 END`;

// db.ts playsWithListened(): listened time per play = the gap to the next play, capped at the
// track's duration (10-min fallback when unknown); under LISTEN_MIN_MS it's a skip and counts 0.
function listenedMs(row, next) {
  const dur = row.durationMs ?? LISTEN_FALLBACK_MS;
  const gap = next ? Date.parse(next.playedAt) - Date.parse(row.playedAt) : null;
  const ran = gap != null && gap >= 0 ? Math.min(dur, gap) : dur;
  return ran < LISTEN_MIN_MS ? 0 : ran;
}

// db.ts recomputeAllTimeStats(), over the same ordered fetch.
function computeAllTimeStats(rows) {
  if (rows.length === 0) return { plays: 0, uniqueTracks: 0, durationMs: 0, since: null };
  const tracks = new Set();
  let durationMs = 0;
  for (let i = 0; i < rows.length; i++) {
    tracks.add(rows[i].trackId);
    durationMs += listenedMs(rows[i], rows[i + 1]);
  }
  // rows come back ascending, so the first is the earliest recorded play.
  return { plays: rows.length, uniqueTracks: tracks.size, durationMs, since: rows[0].playedAt };
}

// ── plumbing ──────────────────────────────────────────────────────────────────────────
const client = createClient({ url: URL_PRIMARY, authToken: AUTH, intMode: "number" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (res) => res.rows.map((r) => ({ ...r }));

async function getMeta(key) {
  const res = await client.execute({ sql: "SELECT value FROM meta WHERE key = ?", args: [key] });
  return res.rows[0] ? String(res.rows[0].value) : null;
}

async function setMeta(key, value) {
  await client.execute({
    sql: `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

// A check returns { name, status: "OK" | "FAIL" | "NOT-CACHED", detail, ids? }.
// `ids` (ctx_orphan only) narrows the race re-check to the rows that disagreed.

async function checkAllTimeStats() {
  const stored = await getMeta("alltime_stats");
  const live = computeAllTimeStats(rows(await client.execute(PLAYS_ORDERED_SQL)));
  const shown = `plays=${live.plays} uniqueTracks=${live.uniqueTracks} durationMs=${live.durationMs} since=${live.since}`;
  if (stored === null) {
    // getAllTimeStats() computes on demand when the key is absent, so this is a legitimate
    // cold state, not a wrong answer.
    return { name: "alltime_stats", status: "NOT-CACHED", detail: `no meta row; recomputed ${shown}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { name: "alltime_stats", status: "FAIL", detail: `stored value is not JSON: ${stored}` };
  }
  const diffs = ["plays", "uniqueTracks", "durationMs", "since"]
    .filter((k) => live[k] !== (parsed[k] ?? null))
    .map((k) => `${k}: recomputed=${live[k]} stored=${parsed[k] ?? null}`);
  return diffs.length
    ? { name: "alltime_stats", status: "FAIL", detail: diffs.join(" | ") }
    : { name: "alltime_stats", status: "OK", detail: shown };
}

async function checkUniqueSongCount() {
  const stored = await getMeta("unique_song_count");
  const res = await client.execute(UNIQUE_SONG_SQL);
  const live = res.rows[0] ? Number(res.rows[0].n) : 0;
  if (stored === null) {
    // getUniqueSongCount() returns 0 and Home falls back to the raw sum until it's cached.
    return { name: "unique_song_count", status: "NOT-CACHED", detail: `no meta row; recomputed ${live}` };
  }
  const storedN = Number(stored) || 0;
  return storedN === live
    ? { name: "unique_song_count", status: "OK", detail: `${live}` }
    : {
        name: "unique_song_count",
        status: "FAIL",
        detail: `recomputed=${live} stored=${storedN} (raw ${JSON.stringify(stored)})`,
      };
}

async function checkCtxOrphan(onlyIds = null) {
  const where = onlyIds ? `WHERE p.id IN (${onlyIds.map(() => "?").join(",")})` : "";
  const res = await client.execute({
    sql: `SELECT p.id AS id, p.ctx_orphan AS stored, (${ORPHAN_PREDICATE}) AS live
          FROM plays p ${where} ORDER BY p.id`,
    args: onlyIds ?? [],
  });
  let nulls = 0;
  const bad = [];
  for (const r of rows(res)) {
    // A stored NULL means "not computed yet" (pre-backfill / pre-column plays). db.ts reads it
    // as non-orphan by design, so it is informational here, never a failure.
    if (r.stored === null) {
      nulls++;
      continue;
    }
    if (Number(r.stored) !== Number(r.live)) {
      bad.push({ id: Number(r.id), stored: Number(r.stored), live: Number(r.live) });
    }
  }
  const scope = onlyIds ? `${res.rows.length} re-checked plays` : `${res.rows.length} plays`;
  const nullNote = `(NULLs: ${nulls}${nulls ? " — not computed yet, informational" : ""})`;
  return bad.length
    ? {
        name: "ctx_orphan",
        status: "FAIL",
        detail: `${bad.length} of ${scope} disagree with the live predicate ${nullNote}; examples: ${bad
          .slice(0, 5)
          .map((b) => `id=${b.id} stored=${b.stored} live=${b.live}`)
          .join(", ")}`,
        ids: bad.map((b) => b.id),
      }
    : { name: "ctx_orphan", status: "OK", detail: `${scope} agree ${nullNote}` };
}

const CHECKS = {
  alltime_stats: () => checkAllTimeStats(),
  unique_song_count: () => checkUniqueSongCount(),
  ctx_orphan: () => checkCtxOrphan(),
};

/** Run the named checks (all of them by default) and print one line each.
 *  `recheck`: on a mismatch, wait and re-check that one value once before calling it a
 *  failure — a sync may have been mid-flight between the stored read and the recompute.
 *  Returns { ok, results }. */
async function verify({ only = null, recheck = true, indent = "" } = {}) {
  const names = only ?? Object.keys(CHECKS);
  const results = [];
  for (const name of names) {
    let r = await CHECKS[name]();
    if (r.status === "FAIL" && recheck) {
      console.log(`${indent}${name.padEnd(17)} MISMATCH — re-checking in ${RACE_RECHECK_MS}ms (write may have been in flight)`);
      await sleep(RACE_RECHECK_MS);
      r = name === "ctx_orphan" && r.ids ? await checkCtxOrphan(r.ids) : await CHECKS[name]();
    }
    console.log(`${indent}${r.name.padEnd(17)} ${r.status.padEnd(10)} ${r.detail}`);
    results.push(r);
  }
  return { ok: results.every((r) => r.status !== "FAIL"), results };
}

// ── demo: prove the verifier fails on injected corruption ─────────────────────────────
class DemoStop extends Error {}

// Restores registered by each corruption, replayed from main()'s finally as a crash backstop.
const restoreQueue = [];

/** Corrupt one stored value, confirm the verifier catches it, restore the saved original,
 *  and confirm the restore by re-reading. The restore also runs from the caller's finally,
 *  so a crash mid-check cannot leave the corruption in place. */
async function corruptionCase({ step, name, describe, original, corrupt, restore, reread, expect }) {
  let restored = false;
  const doRestore = async () => {
    if (restored) return;
    await restore();
    restored = true;
  };
  restoreQueue.push(doRestore);
  console.log(`\n[demo ${step}] corrupt ${describe}`);
  const t0 = Date.now();
  await corrupt();
  try {
    // Race re-check off here: the cause is known, and the corrupted window must stay short
    // (the deployed site reads these values).
    const { results } = await verify({ only: [name], recheck: false, indent: "  " });
    const r = results[0];
    if (r.status !== "FAIL") throw new DemoStop(`[demo ${step}] verifier did NOT catch the corruption — it is not doing its job`);
    if (expect && !expect(r)) throw new DemoStop(`[demo ${step}] verifier failed but not with the expected diff: ${r.detail}`);
    console.log(`  caught: FAIL named ${name}`);
  } finally {
    await doRestore();
    const now = await reread();
    const ms = Date.now() - t0;
    const match = now === original;
    console.log(`  restored: re-read ${JSON.stringify(now)} vs original ${JSON.stringify(original)} -> ${match ? "MATCH" : "MISMATCH"} (corrupted window ${ms}ms)`);
    if (!match) throw new Error(`[demo ${step}] RESTORE FAILED for ${name} — stored value is not the original`);
  }
}

async function demo() {
  console.log("[demo a] clean verification (must pass before any corruption)");
  const clean = await verify({ indent: "  " });
  if (!clean.ok) {
    throw new DemoStop(
      "[demo a] clean verification FAILED — that is a real mismatch in the live data, not a demo artifact. Stopping before corrupting anything; the FAIL line above is the finding.",
    );
  }
  console.log("[demo a] PASS");

  // (b) meta.alltime_stats — plays + 1. Shortest possible window: the deployed site reads it.
  const atOriginal = await getMeta("alltime_stats");
  if (atOriginal === null) throw new DemoStop("[demo b] meta.alltime_stats is absent — nothing to corrupt");
  const atBumped = JSON.stringify({ ...JSON.parse(atOriginal), plays: JSON.parse(atOriginal).plays + 1 });
  await corruptionCase({
    step: "b",
    name: "alltime_stats",
    describe: `meta.alltime_stats plays ${JSON.parse(atOriginal).plays} -> ${JSON.parse(atBumped).plays}`,
    original: atOriginal,
    corrupt: () => setMeta("alltime_stats", atBumped),
    restore: () => setMeta("alltime_stats", atOriginal), // the EXACT original string
    reread: () => getMeta("alltime_stats"),
    expect: (r) => /\bplays:/.test(r.detail),
  });

  // (c) one plays.ctx_orphan — flip the newest non-NULL flag. Only the derived column is
  // written; track_id / played_at / context_* are never touched.
  const pick = rows(
    await client.execute(
      "SELECT id, ctx_orphan AS flag FROM plays WHERE ctx_orphan IS NOT NULL ORDER BY played_at DESC LIMIT 1",
    ),
  )[0];
  if (!pick) throw new DemoStop("[demo c] no play has a non-NULL ctx_orphan — nothing to corrupt");
  const readFlag = async () => {
    const r = await client.execute({ sql: "SELECT ctx_orphan AS flag FROM plays WHERE id = ?", args: [pick.id] });
    return r.rows[0] ? Number(r.rows[0].flag) : null;
  };
  await corruptionCase({
    step: "c",
    name: "ctx_orphan",
    describe: `plays.ctx_orphan for id=${pick.id} (newest non-NULL): ${Number(pick.flag)} -> ${1 - Number(pick.flag)}`,
    original: Number(pick.flag),
    corrupt: () =>
      client.execute({ sql: "UPDATE plays SET ctx_orphan = 1 - ctx_orphan WHERE id = ?", args: [pick.id] }),
    restore: () =>
      client.execute({ sql: "UPDATE plays SET ctx_orphan = ? WHERE id = ?", args: [Number(pick.flag), pick.id] }),
    reread: readFlag,
    expect: (r) => (r.ids ?? []).includes(pick.id) && r.detail.includes(`id=${pick.id}`),
  });

  // (d) meta.unique_song_count — + 1.
  const usOriginal = await getMeta("unique_song_count");
  if (usOriginal === null) throw new DemoStop("[demo d] meta.unique_song_count is absent — nothing to corrupt");
  await corruptionCase({
    step: "d",
    name: "unique_song_count",
    describe: `meta.unique_song_count ${usOriginal} -> ${Number(usOriginal) + 1}`,
    original: usOriginal,
    corrupt: () => setMeta("unique_song_count", String(Number(usOriginal) + 1)),
    restore: () => setMeta("unique_song_count", usOriginal), // the EXACT original string
    reread: () => getMeta("unique_song_count"),
    expect: (r) => /recomputed=\d+ stored=\d+/.test(r.detail),
  });

  console.log("\n[demo e] final clean verification (must pass — everything restored)");
  const final = await verify({ indent: "  " });
  if (!final.ok) throw new Error("[demo e] final verification FAILED — the data is not back to its original state");
  console.log("[demo e] PASS");
  console.log("\ndemo: verifier failed on all 3 injected corruptions and passes on clean data");
}

// ── main ──────────────────────────────────────────────────────────────────────────────
let exitCode = 0;
try {
  if (DEMO) {
    await demo();
  } else {
    const { ok } = await verify();
    if (!ok) {
      console.log("\nFAIL: a stored derived value disagrees with the source data (see above).");
      exitCode = 1;
    }
  }
} catch (err) {
  console.error(`\n${err instanceof DemoStop ? "STOPPED" : "ERROR"}: ${err.message}`);
  exitCode = 1;
} finally {
  // Belt and braces: every corruption is already restored inline, but a throw between the
  // write and that restore must not leave the live DB corrupted.
  for (const r of restoreQueue.reverse()) {
    try {
      await r();
    } catch (e) {
      console.error(`RESTORE ERROR (manual fix needed): ${e.message}`);
      exitCode = 1;
    }
  }
  client.close();
}
process.exit(exitCode);
