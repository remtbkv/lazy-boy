// @libsql/client as the rehearsal's server sees it (docs/multi-user/REHEARSAL.md): the preload's
// resolve hook hands this module to every import of the package, the server's hashed external
// included. A store URL `https://<db>.rehearsal.invalid` (what STORE_URL_TEMPLATE, the app
// database's URL and the Platform API stand-in's Hostname produce) opens the throwaway file
// `<REHEARSAL_STORES>/<db>.db`; any other remote URL is refused, so nothing reaches a real Turso. A
// database the stand-in destroyed answers every statement with Turso's not-found error instead of
// being re-created by SQLite. Every statement is counted for check 1 (globalThis.__rehearsal).
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createClient as realCreateClient } from "@libsql/client";

export * from "@libsql/client";

const SUFFIX = ".rehearsal.invalid";
const R = (globalThis.__rehearsal ??= { inflight: 0, activity: 0, stmts: [], stmtSeq: 0 });

function target(url) {
  if (url.startsWith("file:")) return { file: url.slice(5).split("?")[0], db: path.basename(url.slice(5)).replace(/\.db$/, "") };
  const u = new URL(url);
  if (!u.hostname.endsWith(SUFFIX)) throw new Error(`rehearsal: refusing store URL ${u.protocol}//${u.hostname}`);
  const db = u.hostname.slice(0, -SUFFIX.length);
  const stores = process.env.REHEARSAL_STORES;
  if (!stores) throw new Error("rehearsal: REHEARSAL_STORES is unset");
  return { file: path.join(stores, `${db}.db`), db, remote: true };
}

const sqlOf = (s) => (typeof s === "string" ? s : s?.sql ?? "");

export function createClient(config) {
  const t = target(String(config.url));
  if (!t.remote) mkdirSync(path.dirname(t.file), { recursive: true });
  // Opened at the first statement, so a database the Platform API creates later is found.
  let inner = null;
  let ready = null;
  const prepare = () =>
    (ready ??= (async () => {
      inner = realCreateClient({ url: `file:${t.file}`, intMode: config.intMode });
      await inner.execute("PRAGMA busy_timeout = 15000");
      await inner.execute("PRAGMA journal_mode = WAL").catch(() => {});
    })());
  const run = async (kind, arg, f) => {
    // Turso refuses a database that does not exist (never made, or destroyed); SQLite would create it.
    if (t.remote && !existsSync(t.file)) {
      throw Object.assign(new Error(`SERVER_ERROR: Server returned HTTP status 404 (database ${t.db} not found)`), { code: "SERVER_ERROR" });
    }
    const list = kind === "batch" ? arg.map(sqlOf) : [sqlOf(arg)];
    for (const sql of list) {
      R.stmts.push({ seq: ++R.stmtSeq, db: t.db, sql: sql.slice(0, 160), at: Date.now() });
      if (R.stmts.length > 20_000) R.stmts.splice(0, 5_000);
    }
    R.inflight++;
    R.activity++;
    try {
      await prepare();
      return await f();
    } finally {
      R.inflight--;
      R.activity++;
    }
  };
  let closed = false;
  return {
    execute: (s, args) => run("execute", s, () => inner.execute(s, args)),
    batch: (s, mode) => run("batch", s, () => inner.batch(s, mode)),
    executeMultiple: (sql) => run("execute", sql, () => inner.executeMultiple(sql)),
    migrate: (s) => run("batch", s, () => inner.migrate(s)),
    transaction: async (mode) => {
      await prepare();
      return inner.transaction(mode);
    },
    sync: async () => {},
    close: () => {
      closed = true;
      inner?.close();
    },
    get closed() {
      return closed;
    },
    protocol: "http",
  };
}
