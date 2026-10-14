// One-time migration for C1 (burn lazyboy-review, 2026-10-03): re-rule EVERY real play's skip
// verdict from its PREVIOUS play, because Spotify's played_at is the END of a play and the
// verdicts stored before this fix were measured against the next play (shifted one play
// back: a skip flagged its predecessor). Also recomputes the all-time totals and drops the
// materialized Home payload, both of which embed the old verdicts.
//
//   node --env-file=.env.local scripts/migrate-skip-rule.mjs           # dry run: counts only
//   node --env-file=.env.local scripts/migrate-skip-rule.mjs --apply   # write
//
// Run --apply AFTER the code with the new rule is live: until then the old code keeps ruling
// new plays the old way. Re-running is safe — it only writes rows whose verdict differs, and
// a second run finds none. It refuses to apply if the history no longer looks like end stamps.
//
// The rule is imported from src/lib/skip-rule.ts (Node strips the types) — the module db.ts
// itself rules with — so this cannot drift from the store.
import { createClient } from "@libsql/client";
import { allTimeStats, isSkip, playedAtConvention } from "../src/lib/skip-rule.ts";

const URL = process.env.TURSO_DATABASE_URL;
if (!URL) throw new Error("TURSO_DATABASE_URL missing (run with --env-file=.env.local)");
const APPLY = process.argv.includes("--apply");
const client = createClient({ url: URL, authToken: process.env.TURSO_AUTH_TOKEN, intMode: "number" });

// Same fetch as db.ts orderedRealPlays(), plus the row id to write back to.
const PLAYS_ORDERED_SQL = `
  SELECT p.id AS id, p.played_at AS playedAt, p.track_id AS trackId,
         t.duration_ms AS durationMs, p.skipped AS skipped
  FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
  WHERE (p.context_type IS NULL OR p.context_type <> 'backfill')
  ORDER BY p.played_at ASC, p.track_id ASC`;

async function readPlays() {
  return (await client.execute(PLAYS_ORDERED_SQL)).rows.map((r) => ({ ...r }));
}

function rule(rows) {
  return rows.map((r, i) => isSkip(i > 0 ? rows[i - 1].playedAt : null, r.playedAt, r.durationMs));
}

async function getMeta(key) {
  const res = await client.execute({ sql: "SELECT value FROM meta WHERE key = ?", args: [key] });
  return res.rows[0] ? String(res.rows[0].value) : null;
}

try {
  const rows = await readPlays();
  const next = rule(rows);
  const changed = [];
  let oneToZero = 0;
  let toOne = 0;
  let nullToZero = 0;
  for (let i = 0; i < rows.length; i++) {
    const was = rows[i].skipped === null ? null : Number(rows[i].skipped);
    if (was === next[i]) continue;
    changed.push({ id: rows[i].id, v: next[i] });
    if (was === 1) oneToZero++;
    else if (next[i] === 1) toOne++;
    else nullToZero++;
  }
  const after = allTimeStats(rows.map((r, i) => ({ ...r, skipped: next[i] })));
  const convention = playedAtConvention(rows);
  const hours = (ms) => (ms / 3_600_000).toFixed(1);
  const before = await getMeta("alltime_stats");

  console.log(`plays (non-backfill)      ${rows.length}`);
  console.log(`skipped after             ${next.filter((v) => v === 1).length}`);
  console.log(`verdicts to write         ${changed.length} (1→0: ${oneToZero}, 0/NULL→1: ${toOne}, NULL→0: ${nullToZero})`);
  console.log(`alltime_stats stored      ${before ?? "(none)"}`);
  console.log(`alltime_stats after       ${JSON.stringify(after)} (${hours(after.durationMs)} h)`);
  console.log(
    `played_at convention      ${convention.pairs} close pairs: gap matches the LATER play ${convention.later}, the EARLIER ${convention.earlier}`,
  );

  if (convention.inverted) {
    console.error("REFUSING: the history no longer looks like END stamps — the new rule would be wrong.");
    process.exitCode = 1;
  } else if (!APPLY) {
    console.log("\ndry run — nothing written (pass --apply to write)");
  } else {
    for (let i = 0; i < changed.length; i += 500) {
      await client.batch(
        changed.slice(i, i + 500).map((c) => ({ sql: "UPDATE plays SET skipped = ? WHERE id = ?", args: [c.v, c.id] })),
        "write",
      );
    }
    const now = String(Date.now());
    await client.batch(
      [
        {
          sql: `INSERT INTO meta (key, value) VALUES ('alltime_stats', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          args: [JSON.stringify(after)],
        },
        {
          sql: `INSERT INTO meta (key, value) VALUES ('alltime_at', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          args: [now],
        },
        // Home rebuilds a missing payload on its next load (db.ts rebuildHomePayload).
        { sql: "DELETE FROM meta WHERE key = 'home_payload'", args: [] },
        // plays.skipped feeds every cached read and the browsers' history payload; this bump
        // is what invalidates them (db.ts "WHICH WRITES BUMP IT").
        {
          sql: `INSERT INTO meta (key, value) VALUES ('write_seq', '1')
                ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1`,
          args: [],
        },
      ],
      "write",
    );
    // Check the write: a fresh read must agree with the rule everywhere.
    const reread = await readPlays();
    const ruled = rule(reread);
    const off = reread.filter((r, i) => r.skipped === null || Number(r.skipped) !== ruled[i]).length;
    console.log(`\napplied: ${changed.length} verdicts written; re-read disagreements: ${off}`);
    if (off > 0) process.exitCode = 1;
  }
} finally {
  client.close();
}
