// P2 — write-posting-latency probe (pre-registered in PREREG.md).
// Short-lived client: one 200-row batch, then close. Long-lived: one client, 10 rows/min
// for 20 min. Poll org usage every 15s throughout; log everything as JSONL.
import { createClient } from "@libsql/client";
import fs from "node:fs";

const OUT = new URL("./p2-write-probe.jsonl", import.meta.url).pathname;
const TOKEN = process.env.TURSO_PLATFORM_TOKEN;
const log = (o) => fs.appendFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");

async function usage() {
  try {
    const r = await fetch("https://api.turso.tech/v1/organizations/remtbkv/usage", {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { err: `http ${r.status}` };
    const d = await r.json();
    const u = d.organization.usage;
    return { rows_read: u.rows_read, rows_written: u.rows_written };
  } catch (e) {
    return { err: String(e).slice(0, 80) };
  }
}

const poll = setInterval(async () => log({ kind: "usage", ...(await usage()) }), 15000);

const mk = () =>
  createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
    intMode: "number",
  });

log({ kind: "start", baseline: await usage() });

// Phase A: short-lived client, one 200-row batch, close immediately.
{
  // DDL is BLOCKED while reads are blocked (IF NOT EXISTS needs a schema read — measured
  // Aug 8 2:29 AM). Probe rows go into the existing api_log table instead: TTL-pruned by
  // the app (self-cleaning), and each insert bills ~2 rows_written (row + ts index).
  // batch("write") is ALSO blocked while reads are blocked (the transaction wrapper trips
  // the read block — measured Aug 8 2:38 AM); single executes pass. 200 sequential inserts.
  const c = mk();
  const t0 = Date.now();
  for (let i = 0; i < 200; i++)
    await c.execute({ sql: "INSERT INTO api_log (ts, method, path, status, retry_after) VALUES (?, 'PROBE', '/forensic-a', 0, NULL)", args: [Date.now()] });
  log({ kind: "phaseA-executed", n: 200, ms: Date.now() - t0 });
  c.close();
  log({ kind: "phaseA-closed" });
}

// Watch 6 min for the +200 to appear.
await new Promise((r) => setTimeout(r, 6 * 60 * 1000));

// Phase B: ONE long-lived client, 10 single-row inserts per minute for 20 min, close at end.
{
  const c = mk();
  log({ kind: "phaseB-open" });
  for (let m = 0; m < 20; m++) {
    for (let i = 0; i < 10; i++) {
      await c.execute({ sql: "INSERT INTO api_log (ts, method, path, status, retry_after) VALUES (?, 'PROBE', '/forensic-b', 0, NULL)", args: [Date.now()] });
      await new Promise((r) => setTimeout(r, 5600));
    }
    log({ kind: "phaseB-minute", minute: m + 1, inserted: (m + 1) * 10 });
  }
  log({ kind: "phaseB-done-pre-close" });
  await new Promise((r) => setTimeout(r, 3 * 60 * 1000)); // watch while connection still open
  c.close();
  log({ kind: "phaseB-closed" });
}

// Tail-watch 8 min after close.
await new Promise((r) => setTimeout(r, 8 * 60 * 1000));
clearInterval(poll);
log({ kind: "end", final: await usage() });
console.log("P2 done — see p2-write-probe.jsonl");
