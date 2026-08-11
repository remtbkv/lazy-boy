// Known-answer tests for the read-cost ledger and the reconciliation math.
//
//   node scripts/test-ledger.mjs
//
// Two halves, and they are verified differently on purpose:
//
//   • The RECONCILIATION math is imported straight from src/lib/read-costs.ts (Node strips
//     the types), so what is tested here is exactly what ships. That file is dependency-free
//     for this reason — keep it that way.
//   • The LEDGER STORAGE cannot be imported: src/lib/db.ts pulls in `server-only`,
//     `next/cache` and React, none of which run in a bare Node script. So the SQL below is a
//     COPY, in the same way scripts/verify-derived.mjs copies ORPHAN_PREDICATE, and it
//     carries the same obligation: MUST MATCH the statements in db.ts's ledger section. A
//     divergence here is not caught by anything, which is why the copies are kept literal.
//
// Runs against a THROWAWAY file DB in the OS temp dir, created and deleted per run. It never
// opens data/listens.db or data/replica.db (the retired replica copy) — both are real data, and
// the prod store is live, so no test may touch either.
import { createClient } from "@libsql/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESIDUAL_FLOOR_ROWS,
  RESIDUAL_MIN_PLATFORM_ROWS,
  residualVerdict,
} from "../src/lib/read-costs.ts";

// ── MUST MATCH src/lib/db.ts ───────────────────────────────────────────────────────────
const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS usage_ledger (
    day TEXT NOT NULL,
    reader TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    modeled_rows INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, reader)
  );`;

// db.ts ledgerAdd()
const LEDGER_ADD_SQL = `
  INSERT INTO usage_ledger (day, reader, calls, modeled_rows)
  VALUES (:day, :reader, 1, :rows)
  ON CONFLICT(day, reader) DO UPDATE SET
    calls = calls + 1,
    modeled_rows = modeled_rows + excluded.modeled_rows`;

// db.ts ledgerSet()
const LEDGER_SET_SQL = `
  INSERT INTO usage_ledger (day, reader, calls, modeled_rows)
  VALUES (:day, :reader, 1, :rows)
  ON CONFLICT(day, reader) DO UPDATE SET
    calls = calls + 1,
    modeled_rows = excluded.modeled_rows`;

// db.ts readLedger()
const READ_LEDGER_SQL = `
  SELECT day, reader, calls, modeled_rows AS modeledRows FROM usage_ledger
  WHERE day >= :cutoff ORDER BY day DESC, reader ASC`;

// db.ts ledgerDayModeledTotal()
const DAY_TOTAL_SQL = `
  SELECT COALESCE(SUM(modeled_rows), 0) AS total FROM usage_ledger
  WHERE day = :day AND substr(reader, 1, 1) <> '_'`;

// db.ts utcDay()
const utcDay = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

// ── harness ───────────────────────────────────────────────────────────────────────────
let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lazyboy-ledger-"));
const dbPath = path.join(tmpDir, "ledger-test.db");
// Guard the guard: a bug in the path above must not be able to open the real store.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (dbPath.startsWith(repo)) throw new Error(`refusing to test against a repo path: ${dbPath}`);

const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
const add = (day, reader, rows) =>
  client.execute({ sql: LEDGER_ADD_SQL, args: { day, reader, rows: Math.round(rows) || 0 } });
const set = (day, reader, rows) =>
  client.execute({ sql: LEDGER_SET_SQL, args: { day, reader, rows: Math.round(rows) || 0 } });
const rows = (res) => res.rows.map((r) => ({ ...r }));

try {
  await client.executeMultiple(CREATE_LEDGER);
  const today = utcDay();
  const yesterday = utcDay(Date.now() - 86_400_000);
  const old = utcDay(Date.now() - 30 * 86_400_000);

  // ── storage ──────────────────────────────────────────────────────────────────────────
  console.log("ledgerAdd");
  await add(today, "sync_tick_steady", 159);
  await add(today, "sync_tick_steady", 159);
  const steady = rows(
    await client.execute({
      sql: "SELECT calls, modeled_rows AS modeledRows FROM usage_ledger WHERE day = ? AND reader = ?",
      args: [today, "sync_tick_steady"],
    }),
  );
  check("two calls, same reader + day, collapse to one row", steady.length, 1);
  check("calls increment", steady[0].calls, 2);
  check("modeled rows sum", steady[0].modeledRows, 318);

  await add(today, "day_strip", 2880);
  const readers = rows(
    await client.execute({
      sql: "SELECT reader FROM usage_ledger WHERE day = ? ORDER BY reader",
      args: [today],
    }),
  ).map((r) => r.reader);
  check("a different reader gets its own row", readers, ["day_strip", "sync_tick_steady"]);

  await add(today, "_residual", -4_000);
  const neg = rows(
    await client.execute({
      sql: "SELECT modeled_rows AS modeledRows FROM usage_ledger WHERE day = ? AND reader = '_residual'",
      args: [today],
    }),
  );
  check("a negative modeled cost is stored as-is (residuals go both ways)", neg[0].modeledRows, -4_000);

  console.log("ledgerSet");
  await set(yesterday, "_platform_total", 5_000_000);
  await set(yesterday, "_platform_total", 6_000_000);
  const platform = rows(
    await client.execute({
      sql: "SELECT calls, modeled_rows AS modeledRows FROM usage_ledger WHERE day = ? AND reader = '_platform_total'",
      args: [yesterday],
    }),
  );
  check("a re-run REPLACES the measured total, never adds to it", platform[0].modeledRows, 6_000_000);
  check("but the re-run is still visible in calls", platform[0].calls, 2);

  console.log("ledgerDayModeledTotal");
  await add(yesterday, "sync_tick_steady", 1_000);
  await add(yesterday, "alltime_list", 25_000);
  const total = rows(await client.execute({ sql: DAY_TOTAL_SQL, args: { day: yesterday } }))[0].total;
  check("sums the read paths and excludes the reserved _ rows", total, 26_000);
  const emptyDay = rows(await client.execute({ sql: DAY_TOTAL_SQL, args: { day: "1999-01-01" } }))[0];
  check("a day with no rows totals 0, not null", emptyDay.total, 0);

  console.log("readLedger bounds");
  await add(old, "sync_tick_steady", 42);
  const window2 = rows(await client.execute({ sql: READ_LEDGER_SQL, args: { cutoff: utcDay(Date.now() - 86_400_000) } }));
  check("a 2-day window excludes the 30-day-old row", window2.some((r) => r.day === old), false);
  check("a 2-day window keeps today and yesterday", [...new Set(window2.map((r) => r.day))], [today, yesterday]);
  check("newest day first", window2[0].day, today);
  const window40 = rows(await client.execute({ sql: READ_LEDGER_SQL, args: { cutoff: utcDay(Date.now() - 39 * 86_400_000) } }));
  check("a 40-day window reaches the old row", window40.some((r) => r.day === old), true);

  // ── reconciliation (the real function, imported from src/lib/read-costs.ts) ───────────
  console.log("residualVerdict");
  check("residual is platform minus model", residualVerdict(5_000_000, 4_000_000).residual, 1_000_000);
  check(
    "the bar is the larger of the floor and half the day",
    residualVerdict(10_000_000, 0).threshold,
    5_000_000,
  );
  check(
    "on a small day the floor is the bar",
    residualVerdict(400_000, 0).threshold,
    RESIDUAL_FLOOR_ROWS,
  );

  // Either side of the relative bar on a 10M day: threshold 5M.
  check(
    "10M day, 4M explained -> 6M residual is over the bar",
    residualVerdict(10_000_000, 4_000_000).alarm,
    true,
  );
  check(
    "10M day, 6M explained -> 4M residual is under it",
    residualVerdict(10_000_000, 6_000_000).alarm,
    false,
  );
  check(
    "exactly on the bar does not alarm (strictly greater)",
    residualVerdict(10_000_000, 5_000_000).alarm,
    false,
  );

  // Either side of the absolute floor on a 2M day: threshold 1M.
  check(
    "2M day, 1.1M unexplained -> alarms",
    residualVerdict(2_000_000, 900_000).alarm,
    true,
  );
  check(
    "2M day, 0.9M unexplained -> quiet",
    residualVerdict(2_000_000, 1_100_000).alarm,
    false,
  );

  // A model that OVER-charges is a defect too, and the bar is two-sided.
  check(
    "a large negative residual alarms as well",
    residualVerdict(4_000_000, 12_000_000).alarm,
    true,
  );

  // The quiet-day gate.
  check(
    "below the traffic floor nothing alarms, however large the gap",
    residualVerdict(RESIDUAL_MIN_PLATFORM_ROWS, 0).alarm,
    false,
  );
  check(
    "just above the traffic floor, a gap over the bar does alarm",
    residualVerdict(RESIDUAL_MIN_PLATFORM_ROWS + 1, -2_000_000).alarm,
    true,
  );
  check("a fully explained day is quiet", residualVerdict(8_000_000, 8_000_000).alarm, false);
} finally {
  client.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("FAIL: the ledger or the reconciliation math does not match its known answers.");
  process.exit(1);
}
process.exit(0);
