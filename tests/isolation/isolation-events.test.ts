// Isolation events from Phase 2 (PLAN.md §6.5): an awaited row in the app database's `events`,
// beside the telemetry row and the log line Phase 1 already wrote.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportIsolation } from "@/lib/isolation";
import { rawClient, resetStore } from "../adversarial/helpers";
import { freshAppDb } from "./harness";

let db: ReturnType<typeof freshAppDb>;
let logged: string[];
beforeEach(async () => {
  await resetStore();
  db = freshAppDb();
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a.join(" ")));
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("reportIsolation", () => {
  it("writes the events row, the telemetry row and the log line, with the uid and code only", async () => {
    await reportIsolation("cache-stamp", "bbbbbbbbbbbb");
    expect((await db.raw().execute("SELECT uid, code, alarmed FROM events")).rows).toEqual([
      { uid: "bbbbbbbbbbbb", code: "cache-stamp", alarmed: 0 },
    ]);
    const t = await (await rawClient()).execute("SELECT meta FROM client_metrics WHERE event = 'isolation'");
    expect(t.rows.map((r) => r.meta)).toEqual(["cache-stamp|bbbbbbbbbbbb"]);
    expect(logged[0]).toBe("[isolation] cache-stamp uid=bbbbbbbbbbbb");
  });

  it("with the app database unreachable, still logs and still writes telemetry", async () => {
    vi.stubEnv("APP_DATABASE_URL", "libsql://not-allowed.example.invalid");
    await reportIsolation("decrypt", "aaaaaaaaaaaa");
    const t = await (await rawClient()).execute("SELECT meta FROM client_metrics WHERE event = 'isolation'");
    expect(t.rows.map((r) => r.meta)).toEqual(["decrypt|aaaaaaaaaaaa"]);
    expect(logged[0]).toBe("[isolation] decrypt uid=aaaaaaaaaaaa");
    expect(logged.some((l) => /events row not written/.test(l))).toBe(true);
  });
});
