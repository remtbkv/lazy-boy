// T11 and T14 through the real entry points (PLAN.md §6.4, §12.3, §5.4; PHASE4A.md §4): the unit
// suites (t11-deletion, t14-invalid-grant) prove the job and the policy over their own deps; this
// runs them where production does. Turso's Platform API is stood in for (the friend's database is
// already gone: GET and DELETE answer 404), the telemetry store is the harness's file.
//   - T11 via GET /api/cron/daily: a friend left `deleting` by a Disconnect whose last step had to
//     wait finishes; a friend revoked on day 4 is deleted, one on day 2 is not; the admin is never
//     touched, even in a `deleting` row; the reply names no uid.
//   - T14 via the real jwt callback: Rem's refresh answered invalid_grant stops his capture and
//     keeps his row (needs_reconnect, the token row kept, one event), never `revoked`, and the
//     page explains it at /reconnect (decision 20).
import { createClient } from "@libsql/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./authz-context")).nextHeadersMock());
vi.mock("next/server", async (orig) => (await import("./authz-context")).nextServerMock(await orig()));
vi.mock("next/font/google", () => ({ Figtree: () => ({ variable: "" }), Geist_Mono: () => ({ variable: "" }) }));

import { appDatabaseUrl } from "@/lib/app-db";
import { recordClientMetrics } from "@/lib/db";
import { OWNER_UID, SECRETS, become, installSpotify, request, run, seedRem } from "./authz-harness";
import { seedUser } from "./harness";

const F = "ffffffffffff"; // a friend left mid-deletion
const G = "gggggggggggg"; // a friend revoked four days ago
const H = "hhhhhhhhhhhh"; // a friend revoked two days ago
const DAY = 86_400_000;
const app = () => createClient({ url: appDatabaseUrl(), intMode: "number" });
const platform: { method: string; url: string }[] = [];

function standInPlatform(): void {
  const harness = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.turso.tech/")) {
      platform.push({ method: (init?.method ?? "GET").toUpperCase(), url });
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return harness(input, init);
  });
}

beforeAll(() => installSpotify());
beforeEach(async () => {
  platform.length = 0;
  vi.stubEnv("TURSO_PLATFORM_TOKEN", "platform-test-token");
  vi.stubEnv("SIGNUPS", "invite");
  await seedRem();
});
afterEach(() => {
  vi.unstubAllEnvs();
  installSpotify();
});

describe("T11 through /api/cron/daily", () => {
  async function daily(): Promise<Response> {
    standInPlatform();
    await become("vercelCron");
    const { GET } = await import("@/app/api/cron/daily/route");
    // The chore's wait for the lease window (52 s) passes at once, and the clock moves past it.
    const realTimeout = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
      if ((ms ?? 0) >= 50_000) {
        vi.setSystemTime(Date.now() + (ms ?? 0));
        return realTimeout(fn, 0);
      }
      return realTimeout(fn, ms);
    }) as typeof setTimeout);
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    try {
      return await GET(request("/api/cron/daily", { headers: { authorization: `Bearer ${SECRETS.cron}` } }));
    } finally {
      vi.useRealTimers();
      vi.stubGlobal("setTimeout", realTimeout);
    }
  }

  it("finishes a friend's deletion, deletes on day 4 of revoked and not before, and never touches Rem", async () => {
    const now = Date.now();
    const c = app();
    await seedUser(c, { uid: F, status: "deleting", statusAt: now - 3_600_000 });
    await seedUser(c, { uid: G, status: "revoked", statusAt: now - 4 * DAY });
    await seedUser(c, { uid: H, status: "revoked", statusAt: now - 2 * DAY });
    for (const u of [F, G, H]) {
      await c.execute({ sql: "INSERT INTO user_tokens (uid, blob, expires_at, granted_at) VALUES (?, 'x', 0, 0)", args: [u] });
      await c.execute({ sql: "INSERT INTO sync_state (uid, state, next_probe_at) VALUES (?, 'active', 0)", args: [u] });
    }
    await recordClientMetrics([{ session: "s-f", page: "/home", event: "ttfb", value: 1, meta: null }], F);
    const remBefore = (await c.execute({ sql: "SELECT status, session_epoch FROM users WHERE uid = ?", args: [OWNER_UID as string] })).rows;

    const res = await daily();
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const u of [F, G, H, OWNER_UID as string]) expect(text, "the reply names a uid").not.toContain(u);
    expect((JSON.parse(text) as { chores: Record<string, string> }).chores.deletions).toMatch(/^retried done; day4 pending:window; invites none; after the window done$/);

    const status = async (u: string) => (await c.execute({ sql: "SELECT status FROM users WHERE uid = ?", args: [u] })).rows[0]?.status;
    expect(await status(F)).toBe("deleted");
    expect(await status(G)).toBe("deleted");
    expect(await status(H)).toBe("revoked");
    for (const u of [F, G]) {
      expect((await c.execute({ sql: "SELECT count(*) AS n FROM user_tokens WHERE uid = ?", args: [u] })).rows[0].n).toBe(0);
      expect((await c.execute({ sql: "SELECT count(*) AS n FROM sync_state WHERE uid = ?", args: [u] })).rows[0].n).toBe(0);
    }
    expect((await c.execute({ sql: "SELECT count(*) AS n FROM user_tokens WHERE uid = ?", args: [H] })).rows[0].n).toBe(1);
    // Turso was asked only about the two friends' own databases (gone already, so nothing to
    // destroy), never about Rem's or the friend still inside day 4.
    const asked = new Set(platform.map((p) => decodeURIComponent(p.url.split("/").pop()!)));
    expect([...asked].sort()).toEqual([`lb-u-${F}`, `lb-u-${G}`]);
    // Rem: untouched.
    expect((await c.execute({ sql: "SELECT status, session_epoch FROM users WHERE uid = ?", args: [OWNER_UID as string] })).rows).toEqual(remBefore);
    expect((await c.execute({ sql: "SELECT count(*) AS n FROM user_tokens WHERE uid = ?", args: [OWNER_UID as string] })).rows[0].n).toBe(1);
    c.close();
  });

  it("never hands the admin to the job, even in a deleting row: nothing of Rem's is destroyed or deleted", async () => {
    const c = app();
    await c.execute({ sql: "UPDATE users SET status = 'deleting', status_at = 0 WHERE uid = ?", args: [OWNER_UID as string] });
    const res = await daily();
    expect(res.status).toBe(200);
    // Not a candidate at all (dailyCandidates reads friends only); the job's own refusal is T11's.
    expect((JSON.parse(await res.text()) as { chores: Record<string, string> }).chores.deletions).toMatch(/^retried none/);
    expect(platform.filter((p) => p.method === "DELETE")).toEqual([]);
    expect((await c.execute({ sql: "SELECT count(*) AS n FROM user_tokens WHERE uid = ?", args: [OWNER_UID as string] })).rows[0].n).toBe(1);
    c.close();
  });
});

describe("T14 through the real jwt callback", () => {
  it("Rem's invalid_grant: capture stops, his row and token stay, one event, never revoked, and /home explains it", async () => {
    await seedRem({ tokenExpiresAt: 1_000 });
    await become("rem");
    const harness = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://accounts.spotify.com/api/token")) {
        return Response.json({ error: "invalid_grant", error_description: "Refresh token revoked" }, { status: 400 });
      }
      return harness(input, init);
    });
    const o = await run(async () => (await import("@/app/(app)/home/page")).default());
    expect(o.kind === "redirect" ? new URL(o.to, "http://127.0.0.1:3000").pathname : o).toBe("/reconnect");
    const c = app();
    const u = (await c.execute({ sql: "SELECT status FROM users WHERE uid = ?", args: [OWNER_UID as string] })).rows[0];
    expect(u.status).toBe("needs_reconnect");
    expect((await c.execute({ sql: "SELECT count(*) AS n FROM user_tokens WHERE uid = ?", args: [OWNER_UID as string] })).rows[0].n).toBe(1);
    expect((await c.execute({ sql: "SELECT code FROM events WHERE uid = ?", args: [OWNER_UID as string] })).rows.map((r) => r.code)).toEqual(["invalid-grant"]);
    c.close();
  });
});
