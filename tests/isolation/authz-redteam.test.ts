// Red team of the authz map (docs/multi-user/AUTHZ.md §3): what the cell matrix does not reach.
// Every friend cell in the matrix already passes Rem's own identifiers (his playlist id, his
// task id, his history day), so "another user's ids" is covered there; this file takes cache
// keys and ETags across users, cookie and token reuse, the cron and pinger secrets, the search
// payloads and Home's pre-gate reads.
//
// A test marked `pinned <phase>` asserts what today's code does and fails the day that phase
// lands; that lane rewrites it to the target its message states.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const keyLog = vi.hoisted(() => ({ calls: [] as { keys: string[]; args: unknown[] }[] }));
const stmtLog = vi.hoisted(() => ({ count: 0 }));

vi.mock("next/headers", async () => (await import("./authz-context")).nextHeadersMock());
vi.mock("next/server", async (orig) => (await import("./authz-context")).nextServerMock(await orig()));
// The seven cached reads record their key parts and arguments (what Next 16.2.6 keys on).
vi.mock("next/cache", () => ({
  unstable_cache:
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>, keys: string[] = []) =>
    (...args: A) => {
      keyLog.calls.push({ keys, args });
      return fn(...args);
    },
  revalidatePath: () => {},
  revalidateTag: () => {},
}));
// Count every statement db.ts sends (Home's pre-gate reads).
vi.mock("@libsql/client", async (orig) => {
  const real = (await orig()) as typeof import("@libsql/client");
  return {
    ...real,
    createClient: (cfg: Parameters<typeof real.createClient>[0]) => {
      const c = real.createClient(cfg);
      const count = <F extends (...a: never[]) => unknown>(f: F): F =>
        ((...a: Parameters<F>) => {
          stmtLog.count++;
          return f.apply(c, a);
        }) as F;
      c.execute = count(c.execute);
      c.batch = count(c.batch);
      return c;
    },
  };
});

import {
  OWNER_UID,
  REM_PLAYLIST,
  SECRETS,
  become,
  dump,
  installSpotify,
  observe,
  request,
  seedRem,
  sessionCookie,
  spotifyCalls,
  tokenRow,
} from "./authz-harness";
import { ctx, flushAfter } from "./authz-context";
import { expectPinned } from "./authz-cells";

const COOKIE = "authjs.session-token";

beforeAll(() => installSpotify());
beforeEach(() => {
  keyLog.calls.length = 0;
});

async function library(): Promise<Response> {
  const { GET } = await import("@/app/api/search/library/route");
  return GET(request("/api/search/library"));
}
async function history(): Promise<Response> {
  const { GET } = await import("@/app/api/search/history/route");
  return GET(request("/api/search/history"));
}
const CRON_ROUTES: Record<string, () => Promise<{ GET: (req: Request) => Promise<Response> }>> = {
  "/api/cron/sync": () => import("@/app/api/cron/sync/route"),
  "/api/cron/daily": () => import("@/app/api/cron/daily/route"),
  "/api/cron/store-bench": () => import("@/app/api/cron/store-bench/route"),
  "/api/cron/usage-check": () => import("@/app/api/cron/usage-check/route"),
};
async function cron(headers: Record<string, string> = {}, path = "/api/cron/sync"): Promise<Response> {
  return (await CRON_ROUTES[path]()).GET(request(path, { headers }));
}

describe("cache keys and ETags across users", () => {
  it("a friend sending Rem's library ETag gets no 304 onto Rem's body (P1: the uid in the ETag, the friend refused)", async () => {
    await seedRem();
    await become("rem");
    const remTag = (await library()).headers.get("etag");
    await become("friendB");
    const res = await (await import("@/app/api/search/library/route")).GET(
      request("/api/search/library", { headers: { "if-none-match": remTag ?? "" } }),
    );
    // PLAN T7: B's ETag carries B's uid, so B never 304s onto A's body (in Phase 1 B is refused
    // outright; tests/isolation/search-payloads.test.ts runs two users through the routes).
    expect(res.status, "a friend sending Rem's library ETag").not.toBe(304);
  });

  it("both search ETags carry the uid (P1)", async () => {
    await seedRem();
    await become("rem");
    const tags = [(await library()).headers.get("etag"), (await history()).headers.get("etag")];
    expect(tags.every((x) => !!x && x.includes(OWNER_UID)), `the uid in both search ETags: ${JSON.stringify(tags)}`).toBe(true);
  });

  it("search bodies are `private, no-store` and stamped with the uid as `u` (P1)", async () => {
    await seedRem();
    await become("rem");
    for (const res of [await library(), await history()]) {
      const body = (await res.json()) as { u?: unknown };
      const seen = { cacheControl: res.headers.get("cache-control"), u: body.u ?? null };
      expect(
        /private/.test(seen.cacheControl ?? "") && /no-store/.test(seen.cacheControl ?? "") && seen.u === OWNER_UID,
        `search bodies \`private, no-store\` and stamped with u: ${JSON.stringify(seen)}`,
      ).toBe(true);
    }
  });

  it("every cached read behind the search payloads and Home keys on the user (P1: userCache)", async () => {
    await seedRem();
    await become("rem");
    await library();
    await history();
    const { dailyStatsAction, allTimePlaysAction, dayTracksAction } = await import("@/app/(app)/history-actions");
    await dailyStatsAction(14);
    await allTimePlaysAction();
    await dayTracksAction(new Date(Date.now() - 3_600_000).toISOString().slice(0, 10));
    expect(keyLog.calls.length).toBeGreaterThan(0);
    const keyed = keyLog.calls.map((c) => JSON.stringify([c.keys, c.args]).includes(OWNER_UID));
    expect(keyed.every((x) => x), "the uid in every cached read's key").toBe(true);
  });

  it("a friend's cookie with Rem's token expired refreshes nothing of Rem's (P1: the identity check first)", async () => {
    const obs = await observe("friendA", async () => {
      const { GET } = await import("@/app/api/auth/[...nextauth]/route");
      const { NextRequest } = await import("next/server");
      return GET(new NextRequest(request("/api/auth/session")));
    }, { seed: { tokenExpiresAt: 1_000 } });
    // The identity check refuses the cookie before any token is read.
    expect(obs.observed, "a friend's session read refreshing Rem's grant").not.toBe("allow");
  });
});

describe("cookie and token reuse", () => {
  it("pinned P4a: Rem's cookie copied before Log out works fully again once Rem signs in elsewhere (F3)", async () => {
    // seedRem() restores the token row: Rem signed in again on another device.
    // The copy is byte-identical to a live cookie today: Log out changed nothing it carries.
    // Target: Log out bumps session_epoch; the copy's `ep` (0) no longer matches and it is refused.
    const obs = await observe("rem", async () => (await import("@/app/api/sync/route")).POST());
    expectPinned("P4a", obs.observed, (o) => o === "allow", (o) => o === "deny", "a cookie copied before Log out, after Rem signs in elsewhere");
  });

  it("a 31-day-old sign-in (auth_time) is refused (P1, F9)", async () => {
    await seedRem();
    await become("anon");
    ctx.cookies.set(COOKIE, await sessionCookie("rem", SECRETS.auth, { auth_time: Math.floor(Date.now() / 1000) - 31 * 86_400 }));
    const res = await library();
    expect(res.status, "a 31-day-old sign-in reading the library").toBe(401);
  });

  it("GET /api/auth/session re-issues a replayed cookie with a fresh expiry (F3)", async () => {
    await seedRem();
    await become("staleLogout");
    const { GET } = await import("@/app/api/auth/[...nextauth]/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest(request("/api/auth/session")));
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`))).toBe(true);
  });

  it("an expired cookie, a truncated one, garbage and an unsigned JWT are no session", async () => {
    await seedRem();
    const now = Math.floor(Date.now() / 1000);
    const { encode } = await import("next-auth/jwt");
    const expired = await encode({ token: { name: "Rem", sub: "s", uid: OWNER_UID }, secret: SECRETS.auth, salt: COOKIE, maxAge: -60 });
    const good = await sessionCookie("rem");
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ name: "Rem", sub: "s", exp: now + 3600 })}.`;
    for (const value of [expired, good.slice(0, -8), "garbage", unsigned, SECRETS.cron]) {
      await become("anon");
      ctx.cookies.set(COOKIE, value);
      const res = await library();
      expect(res.status, `cookie ${value.slice(0, 24)}…`).toBe(401);
    }
  });

  it("a session cookie, or Rem's Spotify token, presented as the cron bearer is refused", async () => {
    await seedRem();
    await become("anon");
    spotifyCalls.length = 0;
    const jwe = await sessionCookie("rem");
    for (const bearer of [jwe, "at-REM", "rt-REM"]) {
      expect((await cron({ authorization: `Bearer ${bearer}` })).status).toBe(401);
    }
    expect(spotifyCalls.filter((c) => c.bearer === "at-REM")).toEqual([]);
  });

  it("a sign-in's callbackUrl to another origin lands on this origin", async () => {
    await seedRem();
    await become("anon");
    const { GET, POST } = await import("@/app/api/auth/[...nextauth]/route");
    const { NextRequest } = await import("next/server");
    const csrfRes = await GET(new NextRequest(request("/api/auth/csrf")));
    for (const c of csrfRes.headers.getSetCookie()) {
      const [kv] = c.split(";");
      ctx.cookies.set(kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1));
    }
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const signin = await POST(
      new NextRequest(
        request("/api/auth/signin/spotify", {
          method: "POST",
          body: new URLSearchParams({ csrfToken, callbackUrl: "https://evil.example/steal" }).toString(),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
      ),
    );
    for (const c of signin.headers.getSetCookie()) {
      const [kv] = c.split(";");
      ctx.cookies.set(kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1));
    }
    const state = new URL(signin.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const done = await GET(new NextRequest(request(`/api/auth/callback/spotify?code=code-REM&state=${encodeURIComponent(state)}`)));
    expect(new URL(done.headers.get("location") ?? "").origin).toBe("http://127.0.0.1:3000");
  });

  it("Log out deletes Rem's token of record (user_tokens) and its plaintext copy: a copy of his cookie is refused, and the cron stops (RULINGS Oct 15 1:33 PM)", async () => {
    await seedRem();
    await become("rem");
    const copy = ctx.cookies.get(COOKIE)!;
    expect(JSON.parse((await tokenRow())!).app).not.toBeNull();
    const { run } = await import("./authz-harness");
    const out = await run(async () => (await import("@/app/(app)/actions")).logout());
    expect(out).toMatchObject({ kind: "redirect" });
    expect(await tokenRow(), "a token row left after Log out").toBeNull();
    await become("anon");
    ctx.cookies.set(COOKIE, copy);
    expect((await library()).status, "the copied cookie after Log out").toBe(401);
    ctx.cookies.clear();
    expect((await cron({ authorization: `Bearer ${SECRETS.cron}` })).status, "the cron after Log out").toBe(503);
  });

  it("the revoked friend is refused by their own row (status, then epoch), never as an unknown uid; friends A and B by SIGNUPS=owner, each with only their own token row", async () => {
    await seedRem();
    const { readIdentity } = await import("@/lib/identity-read");
    const claims = (uid: string, ep = 0) => ({ uid, ep, auth_time: Math.floor(Date.now() / 1000) });
    expect(await readIdentity(claims("rrrrrrrrrrrr"))).toEqual({ kind: "refused", reason: "status" });
    expect(await readIdentity(claims("rrrrrrrrrrrr", 1))).toEqual({ kind: "refused", reason: "status" });
    for (const uid of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) {
      expect(await readIdentity(claims(uid))).toEqual({ kind: "refused", reason: "signups" });
    }
    const { appTokenStore } = await import("@/lib/token-store-app");
    const { mintUid } = await import("@/lib/identity");
    expect((await appTokenStore().get(mintUid("aaaaaaaaaaaa")))?.accessToken).toBe("at-A-friend");
    expect((await appTokenStore().get(mintUid("bbbbbbbbbbbb")))?.accessToken).toBe("at-B-friend");
  });

  it("the app database down (identity read unavailable) reaches each require*User form as the retryable answer, never a sign-out", async () => {
    await seedRem();
    await become("rem");
    spotifyCalls.length = 0;
    const before = await dump();
    const saved = process.env.APP_DATABASE_URL;
    process.env.APP_DATABASE_URL = "libsql://app-db-down.invalid";
    try {
      const res = await library();
      expect([res.status, res.headers.get("x-lb-signed-out")]).toEqual([503, null]);
      const { addToQueueAction } = await import("@/app/(app)/actions");
      expect(await addToQueueAction("spotify:track:rem-t1")).toMatchObject({ ok: false, retry: true });
      const { default: Playlists } = await import("@/app/(app)/playlists/page");
      await expect(Playlists()).rejects.toMatchObject({ name: "RetryableAuthError" });
    } finally {
      if (saved === undefined) delete process.env.APP_DATABASE_URL;
      else process.env.APP_DATABASE_URL = saved;
    }
    expect(await dump()).toBe(before);
    expect(spotifyCalls.filter((c) => c.bearer === "at-REM")).toEqual([]);
  });

  it("a friend's completed sign-in leaves Rem's token row byte for byte", async () => {
    await seedRem();
    const before = await tokenRow();
    await become("anon");
    const { oauthCallback } = await import("./authz-registry");
    const res = await oauthCallback("A");
    expect(res.headers.get("location")).toContain("error=AccessDenied");
    expect(await tokenRow()).toBe(before);
  });
});

describe("the cron and pinger secrets", () => {
  // (A trailing space is no variant: fetch's Headers strips surrounding whitespace, so it is
  // the secret itself.)
  it("every malformed or misplaced secret is refused", async () => {
    await seedRem();
    await become("anon");
    spotifyCalls.length = 0;
    const s = SECRETS.cron;
    const variants: Record<string, string>[] = [
      { authorization: `bearer ${s}` },
      { authorization: s },
      { authorization: `Bearer  ${s}` },
      { authorization: `Bearer ${s}x` },
      { authorization: `Bearer ${s.slice(0, -1)}` },
      { authorization: `Basic ${Buffer.from(`x:${s}`).toString("base64")}` },
      { "x-cron-secret": s },
      { cookie: `CRON_SECRET=${s}` },
    ];
    for (const headers of variants) {
      for (const path of Object.keys(CRON_ROUTES)) {
        expect((await cron(headers, path)).status, `${path} ${JSON.stringify(headers)}`).toBe(401);
      }
    }
    const { GET } = await import("@/app/api/cron/sync/route");
    expect((await GET(request(`/api/cron/sync?secret=${s}`))).status).toBe(401);
    expect(spotifyCalls.filter((c) => c.bearer === "at-REM")).toEqual([]);
  });

  it("an unset or empty CRON_SECRET matches nobody, not even an empty bearer", async () => {
    await seedRem();
    await become("anon");
    const was = process.env.CRON_SECRET;
    try {
      for (const v of [undefined, ""]) {
        if (v === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = v;
        for (const authorization of [`Bearer ${was}`, "Bearer ", "Bearer undefined", ""]) {
          for (const path of Object.keys(CRON_ROUTES)) expect((await cron({ authorization }, path)).status, path).toBe(401);
        }
      }
    } finally {
      process.env.CRON_SECRET = was;
    }
  });

  async function seedOldMetric(): Promise<void> {
    const { recordClientMetrics } = await import("@/lib/db");
    // Clamped to the 7-day window on insert, so write it, then age it past the 30-day prune.
    await recordClientMetrics([{ session: "old", page: "/old", event: "ttfb", value: 1 }]);
    const { createClient } = await import("@libsql/client");
    const c = createClient({ url: process.env.TURSO_DATABASE_URL as string });
    await c.execute("UPDATE client_metrics SET ts = '2020-01-01T00:00:00.000Z' WHERE session = 'old'");
    c.close();
  }
  async function oldMetricSurvived(): Promise<boolean> {
    const { createClient } = await import("@libsql/client");
    const c = createClient({ url: process.env.TURSO_DATABASE_URL as string });
    const r = await c.execute("SELECT count(*) AS n FROM client_metrics WHERE session = 'old'");
    c.close();
    return Number(r.rows[0].n) === 1;
  }

  it("x-vercel-cron opens nothing on /api/cron/sync: the chores run only on /api/cron/daily (F7, fixed by 75aea82)", async () => {
    await seedRem();
    await seedOldMetric();
    await become("zenbookPinger");
    await cron({ "x-vercel-cron": "1" });
    expect(await oldMetricSurvived()).toBe(true);
    await cron({}, "/api/cron/daily");
    expect(await oldMetricSurvived()).toBe(false);
  });

  it("CRON_SECRET_EXT opens none of the daily, bench and usage routes, nor the chores by header (tripwire for lane 07, F7)", async () => {
    await seedRem();
    await seedOldMetric();
    await become("cronjobOrg");
    await cron({ "x-vercel-cron": "1" });
    await flushAfter(); // cron-job.org's tick runs after its reply
    for (const path of ["/api/cron/daily", "/api/cron/store-bench", "/api/cron/usage-check"]) {
      expect((await cron({}, path)).status, path).toBe(401);
    }
    expect(await oldMetricSurvived()).toBe(true);
  });

  it("cron-job.org's secret opens /api/cron/sync, and its reply is a bare {\"ok\":true} (F10, lane 07)", async () => {
    await seedRem();
    await become("cronjobOrg");
    const res = await cron();
    expect({ status: res.status, body: await res.text() }).toEqual({ status: 200, body: '{"ok":true}' });
    await flushAfter(); // the tick runs after the reply, with Rem's grant
    expect(spotifyCalls.some((c) => (c.bearer ?? "").startsWith("at-REM"))).toBe(true);
  });


  it("the Zenbook pinger still gets the 503 owner alarm when no token is stored", async () => {
    await seedRem();
    await become("staleLogout"); // drops the token row
    ctx.cookies.clear();
    ctx.headers = { authorization: `Bearer ${SECRETS.cron}` };
    expect((await cron()).status).toBe(503);
  });
});

describe("the search payloads and their bounds", () => {
  it("searchPlaysAction takes LIKE wildcards and quotes as text, and refuses an anonymous caller", async () => {
    await seedRem();
    await become("rem");
    const { searchPlaysAction } = await import("@/app/(app)/history-actions");
    expect(await searchPlaysAction("%' OR 1=1 --")).toEqual([]);
    expect((await searchPlaysAction("REM-only")).length).toBeGreaterThan(0);
    await become("anon");
    expect(await searchPlaysAction("%")).toEqual([]);
  });

  it("pinned P4a: dailyStatsAction accepts any width up to 100,000 days (PLAN §6.6)", async () => {
    await seedRem();
    await become("rem");
    const { dailyStatsAction } = await import("@/app/(app)/history-actions");
    const rows = await dailyStatsAction(99_999);
    expectPinned("P4a", rows.length, (n) => n > 0, (n) => n === 0, "a 99,999-day dailyStatsAction");
  });
});

describe("reads before the gate", () => {
  it("an anonymous /home sends no store statement before its redirect (P1, F8)", async () => {
    await seedRem();
    await become("anon");
    stmtLog.count = 0;
    const page = (await import("@/app/(app)/home/page")).default;
    let redirected = false;
    try {
      await page();
    } catch (e) {
      redirected = String((e as { digest?: string }).digest ?? "").includes("/login");
    }
    expect(redirected).toBe(true);
    expect(stmtLog.count, "store statements before /home's redirect").toBe(0);
  });

  it("every other gated page and route sends no statement for an anonymous caller", async () => {
    await seedRem();
    await become("anon");
    const calls: (() => Promise<unknown>)[] = [
      async () => (await import("@/app/(app)/playlists/page")).default(),
      async () => (await import("@/app/(app)/playlists/[id]/page")).default({ params: Promise.resolve({ id: REM_PLAYLIST }) }),
      async () => (await import("@/app/(app)/usage/page")).default(),
      library,
      history,
      async () => (await import("@/app/api/now-playing/route")).GET(),
      async () => (await import("@/app/api/sync/route")).POST(),
    ];
    for (const call of calls) {
      stmtLog.count = 0;
      await call().catch(() => {});
      expect(stmtLog.count, call.toString().slice(0, 80)).toBe(0);
    }
  });
});
