// Runs before each test file's imports. Point the store at a throwaway local SQLite file —
// NEVER the funnel/Zenbook — unique per process so parallel files can't collide.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "lazyboy-sim-"));
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "sim.db")}`;
delete process.env.TURSO_AUTH_TOKEN;
// The telemetry store (docs/STORE_MIGRATION.md §5) shares that file unless a test file sets
// its own; an inherited TELEMETRY_* would point the log rows at the real Zenbook.
delete process.env.TELEMETRY_DATABASE_URL;
delete process.env.TELEMETRY_AUTH_TOKEN;
// The owner (multi-user Phase 1): forUser() maps this uid to Rem's database, which is the file
// above. A test about an unset or different owner sets its own; the per-user template is
// unset unless a test provisions its own files (tests/isolation/).
process.env.OWNER_UID = "ownerownerow";
delete process.env.STORE_URL_TEMPLATE;
delete process.env.VERCEL_ENV;
