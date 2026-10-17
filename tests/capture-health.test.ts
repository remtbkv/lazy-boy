// Capture health (burn review 2026-10-03, M1): every capture failure that night had been
// silent for weeks. From Phase 3 the rule reads the user's sync_state row and token row in the
// app database (multi-user PLAN §7.10): capture is healthy while a cron step succeeded for them
// within 30 minutes. Known answers for the rule, the message, and the read.
import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { appDatabaseUrl, getAppMeta } from "@/lib/app-db";
import { captureHealth, captureHealthMessage, CAPTURE_STALE_MS } from "@/lib/capture-health";
import { readCapture } from "@/lib/capture-read";
import { ownerUid } from "./owner-store";

const NOW = Date.parse("2026-10-14T18:00:00Z");
const MIN = 60_000;
const H = 3_600_000;
const live = { hasToken: true, status: "active" };

describe("captureHealth", () => {
  it("a step succeeded two minutes ago, signed in → ok", () => {
    expect(captureHealth(NOW, { ...live, lastOkAt: NOW - 2 * MIN })).toEqual({ ok: true, staleForMs: 2 * MIN, reason: null });
  });
  it("no successful step for an hour → stale", () => {
    expect(captureHealth(NOW, { ...live, lastOkAt: NOW - H })).toEqual({ ok: false, staleForMs: H, reason: "stale" });
  });
  it("the bar is 30 minutes: exactly 30 is still ok, a minute past is not", () => {
    expect(CAPTURE_STALE_MS).toBe(30 * MIN);
    expect(captureHealth(NOW, { ...live, lastOkAt: NOW - 30 * MIN }).ok).toBe(true);
    expect(captureHealth(NOW, { ...live, lastOkAt: NOW - 31 * MIN }).ok).toBe(false);
  });
  it("no token row → signed out, even with a fresh step", () => {
    expect(captureHealth(NOW, { ...live, hasToken: false, lastOkAt: NOW - 10 * MIN })).toEqual({
      ok: false,
      staleForMs: 10 * MIN,
      reason: "signed out",
    });
  });
  it("a dead grant (needs_reconnect) → signed out, though the blob stays for the confirmation", () => {
    expect(captureHealth(NOW, { hasToken: true, status: "needs_reconnect", lastOkAt: NOW - 5 * MIN }).reason).toBe("signed out");
  });
  it("no step has ever succeeded → stale with no age", () => {
    expect(captureHealth(NOW, { ...live, lastOkAt: null })).toEqual({ ok: false, staleForMs: null, reason: "stale" });
  });
});

describe("captureHealthMessage", () => {
  it("is empty when healthy", () => {
    expect(captureHealthMessage({ ok: true, staleForMs: H, reason: null })).toBe("");
  });
  it("names the age in minutes, then hours, then days", () => {
    expect(captureHealthMessage({ ok: false, staleForMs: 42 * MIN, reason: "stale" })).toMatch(/stopped 42 min ago/);
    expect(captureHealthMessage({ ok: false, staleForMs: 5 * H + 1, reason: "stale" })).toMatch(/stopped 5 h ago/);
    expect(captureHealthMessage({ ok: false, staleForMs: 50 * H, reason: "stale" })).toMatch(/stopped 2 days ago/);
  });
  it("tells a signed-out user to sign in again", () => {
    expect(captureHealthMessage({ ok: false, staleForMs: 3 * H, reason: "signed out" })).toMatch(/sign in again/i);
  });
});

describe("readCapture (the app database)", () => {
  it("reads the user's sync_state and token row, and the recently-played cooldown, in one statement", async () => {
    const uid = ownerUid();
    await getAppMeta("schema_version"); // the first open creates the app database
    const app = createClient({ url: appDatabaseUrl(), intMode: "number" });
    try {
      // No users row at all: nothing captures.
      expect((await readCapture(uid)).health.reason).toBe("signed out");
      await app.execute({
        sql: `INSERT INTO users (uid, account_id, spotify_id, db_name, status, status_at, is_admin, session_epoch, invited_at)
              VALUES (?, 'acct', 'sp', 'lazyboy', 'active', 0, 1, 0, 0)`,
        args: [uid],
      });
      await app.execute({ sql: "INSERT INTO user_tokens (uid, blob, expires_at, granted_at) VALUES (?, 'v1.x', 0, 0)", args: [uid] });
      // Signed in, no step yet.
      expect((await readCapture(uid)).health).toEqual({ ok: false, staleForMs: null, reason: "stale" });
      const now = Date.now();
      await app.execute({ sql: "INSERT INTO sync_state (uid, state, next_probe_at, last_ok_at) VALUES (?, 'idle', 0, ?)", args: [uid, now - 4 * MIN] });
      expect((await readCapture(uid)).health.ok).toBe(true);
      // Nothing about the plays store is read: last_sync means nothing from Phase 3.
      await app.execute({ sql: "UPDATE sync_state SET last_ok_at = ? WHERE uid = ?", args: [now - 2 * H, uid] });
      expect((await readCapture(uid)).health.reason).toBe("stale");
      await app.execute({ sql: "INSERT INTO app_meta (key, value) VALUES ('cooldown:recently-played', ?)", args: [String(now + 9 * MIN)] });
      expect((await readCapture(uid)).rpCooldownUntil).toBe(now + 9 * MIN);
      await app.execute({ sql: "DELETE FROM user_tokens WHERE uid = ?", args: [uid] });
      expect((await readCapture(uid)).health.reason).toBe("signed out");
    } finally {
      for (const t of ["user_tokens", "sync_state", "users"]) await app.execute(`DELETE FROM ${t}`);
      await app.execute("DELETE FROM app_meta WHERE key = 'cooldown:recently-played'");
      app.close();
    }
  });
});

// The cron's two no-token answers (signed out: 503 to the Zenbook; a transient refresh failure:
// 200) moved with Phase 3's tick to tests/cron-pinger.test.ts, which runs the real route.
