// With TELEMETRY_DATABASE_URL unset the log tables sit in Rem's database (db.ts "Clients"), and
// the telemetry client's init is a schema step on it: CREATE TABLE for the log tables and Phase
// 1's ALTER TABLE … ADD COLUMN user_id. The versioned open lets only production code (or a local
// file) apply a step to a user database (multi-user PLAN §4.5), so a dev server or a test
// pointed at Rem's remote database must not run this one either (lane 13's review, brief (f)).
// No remote store is touched: @libsql/client is replaced by a recorder.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => {
  process.env.TURSO_DATABASE_URL = "libsql://lazyboy-remote.invalid";
  delete process.env.TELEMETRY_DATABASE_URL;
  return [] as string[];
});

vi.mock("@libsql/client", () => ({
  createClient: () => {
    const rs = { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: undefined };
    const text = (s: unknown) => (typeof s === "string" ? s : (s as { sql: string }).sql);
    return {
      execute: async (s: unknown) => (sent.push(text(s)), rs),
      batch: async (ss: unknown[]) => (ss.forEach((s) => sent.push(text(s))), ss.map(() => rs)),
      executeMultiple: async (s: string) => void sent.push(s),
    };
  },
}));

const isSchemaStep = (sql: string) => /\b(CREATE|ALTER|PRAGMA)\b/i.test(sql);

async function writeOneLogRow(): Promise<void> {
  const g = globalThis as { __lbTelemetry?: unknown };
  delete g.__lbTelemetry;
  vi.resetModules();
  const { recordClientMetrics } = await import("@/lib/db");
  await recordClientMetrics([{ session: "s", page: "/home", event: "fcp", value: 1 }], null);
}

beforeEach(() => {
  sent.length = 0;
});
afterEach(() => {
  delete process.env.VERCEL_ENV;
});

describe("the telemetry init on Rem's database", () => {
  it("a non-production process sends the row and no schema step", async () => {
    await writeOneLogRow();
    expect(sent.some((s) => /INSERT INTO client_metrics/.test(s))).toBe(true);
    expect(sent.filter(isSchemaStep)).toEqual([]);
  });

  it("production code still brings the log tables up to date (the positive control)", async () => {
    process.env.VERCEL_ENV = "production";
    await writeOneLogRow();
    expect(sent.some((s) => /CREATE TABLE IF NOT EXISTS client_metrics/.test(s))).toBe(true);
    expect(sent.some((s) => /INSERT INTO client_metrics/.test(s))).toBe(true);
  });
});
