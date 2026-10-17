// Capture health (burn review 2026-10-03, M1): every capture failure that night had been
// silent for weeks. Known answers for the rule, the store read, and the cron's no-token reply.
import { describe, expect, it, vi } from "vitest";
import { captureHealth, captureHealthMessage, CAPTURE_STALE_MS } from "@/lib/capture-health";

const NOW = Date.parse("2026-10-14T18:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;

describe("captureHealth", () => {
  it("synced an hour ago, signed in → ok", () => {
    expect(captureHealth(NOW, ago(1 * H), true)).toEqual({ ok: true, staleForMs: H, reason: null });
  });
  it("synced three hours ago → stale", () => {
    expect(captureHealth(NOW, ago(3 * H), true)).toEqual({
      ok: false,
      staleForMs: 3 * H,
      reason: "stale",
    });
  });
  it("the bar is 2 h: exactly 2 h is still ok, a minute past is not", () => {
    expect(CAPTURE_STALE_MS).toBe(2 * H);
    expect(captureHealth(NOW, ago(2 * H), true).ok).toBe(true);
    expect(captureHealth(NOW, ago(2 * H + 60_000), true).ok).toBe(false);
  });
  it("tokens absent → signed out, even with a fresh sync stamp", () => {
    expect(captureHealth(NOW, ago(10 * 60_000), false)).toEqual({
      ok: false,
      staleForMs: 10 * 60_000,
      reason: "signed out",
    });
  });
  it("never synced → stale with no age", () => {
    expect(captureHealth(NOW, null, true)).toEqual({ ok: false, staleForMs: null, reason: "stale" });
  });
  it("an unparseable stamp reads as never synced", () => {
    expect(captureHealth(NOW, "garbage", true)).toEqual({
      ok: false,
      staleForMs: null,
      reason: "stale",
    });
  });
});

describe("captureHealthMessage", () => {
  it("is empty when healthy", () => {
    expect(captureHealthMessage({ ok: true, staleForMs: H, reason: null })).toBe("");
  });
  it("names the age in hours, then days", () => {
    expect(captureHealthMessage({ ok: false, staleForMs: 5 * H + 1, reason: "stale" })).toMatch(
      /stopped 5 h ago/,
    );
    expect(captureHealthMessage({ ok: false, staleForMs: 50 * H, reason: "stale" })).toMatch(
      /stopped 2 days ago/,
    );
  });
  it("tells a signed-out user to sign in again", () => {
    expect(captureHealthMessage({ ok: false, staleForMs: 3 * H, reason: "signed out" })).toMatch(
      /sign in again/i,
    );
  });
});

describe("getCaptureHealth (real store)", () => {
  it("reads last_sync and token presence", async () => {
    const db = (await import("./owner-store")).ownerStore();
    expect((await db.getCaptureHealth()).reason).toBe("signed out");
    await db.setSpotifyTokens({ accessToken: "a", refreshToken: "r", expiresAt: 0 });
    // No last_sync yet: signed in but never synced.
    expect(await db.getCaptureHealth()).toEqual({ ok: false, staleForMs: null, reason: "stale" });
    // A harvest stamps last_sync atomically with its plays.
    await db.recordPlays([
      {
        trackId: "t1",
        name: "Song",
        artist: "Artist",
        uri: "spotify:track:t1",
        album: null,
        albumImage: null,
        durationMs: 180000,
        playedAt: new Date().toISOString(),
        contextType: null,
        contextUri: null,
      },
    ]);
    expect((await db.getCaptureHealth()).ok).toBe(true);
    await db.clearSpotifyTokens();
  });
});

// next-auth can't load under vitest (next/server); the route only needs the token getter, which
// for a store with no tokens returns null — the case under test. Tokens present + null is the
// transient refresh failure, which must stay a 200.
vi.mock("@/lib/auth", () => ({ getValidAccessTokenFor: async () => null }));

describe("cron with no token", () => {
  const call = async () => {
    process.env.CRON_SECRET = "s3cret";
    // The admin's users row names his database (multi-user Phase 2).
    await (await import("./owner-store")).seedOwnerApp();
    const { GET } = await import("@/app/api/cron/sync/route");
    return GET(new Request("http://x/api/cron/sync", { headers: { authorization: "Bearer s3cret" } }));
  };
  it("signed out (no stored tokens) → 503 so the pinger's unit fails visibly", async () => {
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "no token" });
  });
  it("tokens stored but no access token (transient refresh failure) → still 200", async () => {
    const db = (await import("./owner-store")).ownerStore();
    await db.setSpotifyTokens({ accessToken: "a", refreshToken: "r", expiresAt: 0 });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "no token" });
    await db.clearSpotifyTokens();
  });
  it("no admin row: no owner, 503", async () => {
    const { appDatabaseUrl } = await import("@/lib/app-db");
    const { createClient } = await import("@libsql/client");
    const { GET } = await import("@/app/api/cron/sync/route");
    await call();
    const c = createClient({ url: appDatabaseUrl() });
    await c.execute("DELETE FROM users");
    c.close();
    const res = await GET(new Request("http://x/api/cron/sync", { headers: { authorization: "Bearer s3cret" } }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "no owner" });
  });
});
