// The simulated environment never reaches a real store (CLAUDE.md, `npm test`). tests/setup.ts
// points the core store at a throwaway file; since the store split the telemetry store has its
// own env (docs/STORE_MIGRATION.md §5), and a shell holding .env.local's TELEMETRY_* values would
// otherwise send every test's log rows to the Zenbook. Setup must clear those too.
import { describe, expect, it } from "vitest";

describe("tests/setup.ts", () => {
  it("clears the telemetry store's env, as it does the core token", async () => {
    process.env.TELEMETRY_DATABASE_URL = "https://real-telemetry-store.example";
    process.env.TELEMETRY_AUTH_TOKEN = "a-real-jwt";
    await import("./setup?rerun");
    expect(process.env.TELEMETRY_DATABASE_URL).toBeUndefined();
    expect(process.env.TELEMETRY_AUTH_TOKEN).toBeUndefined();
    expect(process.env.TURSO_DATABASE_URL).toMatch(/^file:/);
  });
});
