// T4 and T13 through the real route (PLAN.md §6.4): GET /api/cron/sync with the harness's three
// database files (the app database, app.db, and two users' own, u1 and u2, each provisioned by
// the production open for the uid that opens it first), the encrypted tokens in user_tokens, the
// real token core, and a Spotify scripted per bearer that logs which bearer each call carried.
// tests/isolation/t4-tick.test.ts and t13-tick-callers run the tick's module with memory
// stores; this file runs what production runs.
//
// T4: one tick with A and B due, both tokens expired; then A failing three ways (403 "not
// registered", invalid_grant, a hang past the deadline); then library rescans for A and B on one
// instance — each database gets only its own plays, one refresh per user, A's trouble does not
// touch B's outcome, the reply within 20 s with both outcomes, each user's own playlist list.
// T13: cron-job.org's reply is bare and its tick runs after it; the Zenbook's body names the
// admin's step in full and a friend's by its code alone; a burst inside the window does one
// tick's work.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb"; // the admin
process.env.CRON_SECRET = "zen-secret";
process.env.CRON_SECRET_EXT = "ext-secret";
process.env.TOKEN_KEYS = `v1:${Buffer.alloc(32, 9).toString("base64")}`;
process.env.SIGNUPS = "invite"; // both users are served (Phase 4a's setting; Phase 3 runs the admin alone)
process.env.OWNER_UID = B;

const w = vi.hoisted(() => ({
  after: [] as Promise<unknown>[],
  scripts: {} as Record<string, { hang?: boolean; notRegistered?: boolean; deadGrant?: boolean }>,
  calls: [] as { path: string; who: string }[],
  refreshes: [] as string[],
}));

vi.mock("next/server", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  after: (task: (() => unknown) | Promise<unknown>) => {
    w.after.push(Promise.resolve().then(() => (typeof task === "function" ? task() : task)));
  },
}));
const flushAfter = async () => {
  while (w.after.length) await Promise.all(w.after.splice(0));
};

const raw = (uid: string, n: number) => ({
  id: `${uid}-t${n}`,
  name: `${uid}-only-song-${n}`,
  uri: `spotify:track:${uid}-t${n}`,
  duration_ms: 200_000,
  artists: [{ name: `${uid}-only-artist` }],
  album: { name: `${uid}-only-album`, images: [] },
  type: "track",
});

function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const s = init?.signal;
    s?.addEventListener("abort", () => reject(s.reason ?? new Error("aborted")));
  });
}

vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.href === "https://accounts.spotify.com/api/token") {
    const rt = new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "";
    const uid = rt.replace(/^rt-/, "");
    w.refreshes.push(uid);
    if (w.scripts[uid]?.deadGrant) return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({ access_token: `at-${uid}`, expires_in: 3600 });
  }
  if (url.origin !== "https://api.spotify.com") throw new Error(`unexpected fetch ${url}`);
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  const who = auth.replace(/^Bearer at-/, "");
  w.calls.push({ path: url.pathname, who });
  const s = w.scripts[who];
  if (!s) return new Response("no such token", { status: 401 });
  if (s.hang) return hang(init);
  if (s.notRegistered) {
    return new Response("Check settings on developer.spotify.com/dashboard, the user may not be registered.", { status: 403 });
  }
  switch (url.pathname) {
    case "/v1/me/player":
      return Response.json({ is_playing: true, progress_ms: 1_000, item: raw(who, 0) });
    case "/v1/me/player/recently-played":
      return Response.json({ items: [{ track: raw(who, 1), played_at: new Date(Date.now() - 300_000).toISOString(), context: null }] });
    case "/v1/me/playlists":
      return Response.json({
        items: [{ id: `${who}-pl`, name: `${who}-only-playlist`, owner: { id: `sp-${who}` }, images: [], items: { total: 1 }, snapshot_id: "s1" }],
        next: null,
        total: 1,
      });
    case `/v1/playlists/${who}-pl/items`:
      return Response.json({ items: [{ track: raw(who, 2), added_at: "2026-01-01T00:00:00Z" }], next: null, total: 1 });
    case "/v1/me/tracks":
      return Response.json({ items: [], next: null, total: 0 });
  }
  return new Response("not scripted", { status: 404 });
});

const { freshAppDb } = await import("./harness");
// Renamed: the hooks lint reads any use* call outside a component as a React hook.
const { dumpDb, useUserFiles: freshUserFiles } = await import("./user-dbs");
const { getAppMeta, setAppMeta } = await import("@/lib/app-db");
const { appTokenStore } = await import("@/lib/token-store-app");
const { forUserAt } = await import("@/lib/db");
const { mintUid } = await import("@/lib/identity");
const { GET } = await import("@/app/api/cron/sync/route");

// u1 and u2, new names per test: db.ts keeps one client per db_name for the process.
let run = 0;
const dbOf = (uid: string) => `${uid === A ? "u1" : "u2"}-${run}`;
const ZEN = "Bearer zen-secret";
const EXT = "Bearer ext-secret";
const call = (authorization: string) => GET(new Request("https://lazy-boy.example/api/cron/sync", { headers: { authorization } }));
const probes = (who?: string) => w.calls.filter((c) => c.path === "/v1/me/player" && (!who || c.who === who)).length;
const playsOf = async (uid: string) => (await forUserAt(mintUid(uid), dbOf(uid)).searchHistory("")).map((t) => t.name);

let app: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number | null> = {}) => (await app.raw().execute({ sql, args })).rows;

async function seed(o: { expired?: boolean } = {}): Promise<void> {
  run++;
  // The users' files first: from Phase 2's turn useUserFiles() also points APP_DATABASE_URL at
  // its own app.db; freshAppDb() after it makes this test's raw client and app-db.ts open the
  // same file.
  freshUserFiles();
  app = freshAppDb();
  await getAppMeta("schema_version"); // the first open creates app.db at the code's version
  for (const uid of [A, B]) {
    await q(
      `INSERT INTO users (uid, account_id, spotify_id, db_name, status, status_at, is_admin, session_epoch, invited_at)
       VALUES (:uid, :acct, :sid, :db, 'active', 0, :admin, 0, 0)`,
      { uid, acct: `acct-${uid}`, sid: `sp-${uid}`, db: dbOf(uid), admin: uid === B ? 1 : 0 },
    );
    const expiresAt = o.expired ? Math.floor(Date.now() / 1000) - 60 : Math.floor(Date.now() / 1000) + 3_600;
    await appTokenStore().set(mintUid(uid), { accessToken: `at-${uid}`, refreshToken: `rt-${uid}`, expiresAt });
  }
  await setAppMeta(`token_copy:${B}`, "copied"); // the admin's plaintext copy is Phase 2's, done
  await setAppMeta("daily_at", String(Date.now())); // the chores are the daily route's here
}

beforeEach(() => {
  w.after.length = 0;
  w.calls.length = 0;
  w.refreshes.length = 0;
  w.scripts = { [A]: {}, [B]: {} };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await flushAfter();
  app.close();
  vi.restoreAllMocks();
});

describe("T4 through the route", () => {
  it("both tokens expired: one refresh each, each database gets only its own plays, the reply within 20 s with both outcomes", async () => {
    await seed({ expired: true });
    const t0 = Date.now();
    const res = await call(ZEN);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { steps: unknown[] };
    expect(body.steps).toEqual(
      expect.arrayContaining([
        { uid: B, outcome: "ok", trigger: "backstop", added: 1 },
        { uid: A, outcome: "ok" },
      ]),
    );
    expect(w.refreshes.sort()).toEqual([A, B]);
    // Each user's calls carried their own bearer; nobody else's was used.
    expect(w.calls.every((c) => c.who === A || c.who === B)).toBe(true);
    expect(probes(A)).toBe(1);
    expect(probes(B)).toBe(1);
    expect(await playsOf(A)).toEqual([`${A}-only-song-1`]);
    expect(await playsOf(B)).toEqual([`${B}-only-song-1`]);
    expect(await dumpDb(dbOf(A))).not.toContain(`${B}-only`);
    expect(await dumpDb(dbOf(B))).not.toContain(`${A}-only`);
  });

  it("A refused as not registered: A's code, B's outcome ok and only B's plays stored", async () => {
    await seed();
    w.scripts[A] = { notRegistered: true };
    const body = (await (await call(ZEN)).json()) as { steps: unknown[] };
    expect(body.steps).toEqual(expect.arrayContaining([{ uid: A, outcome: "not-registered" }, { uid: B, outcome: "ok", trigger: "backstop", added: 1 }]));
    expect(await playsOf(B)).toEqual([`${B}-only-song-1`]);
    expect(await playsOf(A)).toEqual([]);
  });

  it("A's grant dead (invalid_grant): A stops, its token kept for the confirmation; B ok", async () => {
    await seed({ expired: true });
    w.scripts[A] = { deadGrant: true };
    const body = (await (await call(ZEN)).json()) as { steps: unknown[] };
    expect(body.steps).toEqual(expect.arrayContaining([{ uid: A, outcome: "invalid-grant" }, { uid: B, outcome: "ok", trigger: "backstop", added: 1 }]));
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: A }))[0].status).toBe("needs_reconnect");
    expect((await q("SELECT count(*) AS n FROM user_tokens WHERE uid = :u", { u: A }))[0].n).toBe(1);
    expect(await playsOf(B)).toEqual([`${B}-only-song-1`]);
  });

  it("A's Spotify hangs: A abandoned at its 15 s deadline, B ok, the reply inside 20 s", async () => {
    await seed();
    w.scripts[A] = { hang: true };
    const t0 = Date.now();
    const res = await call(ZEN);
    const took = Date.now() - t0;
    expect(took).toBeLessThan(20_000);
    const body = (await res.json()) as { steps: unknown[] };
    expect(body.steps).toEqual(expect.arrayContaining([{ uid: A, outcome: "timeout" }, { uid: B, outcome: "ok", trigger: "backstop", added: 1 }]));
    expect(await playsOf(B)).toEqual([`${B}-only-song-1`]);
  }, 40_000);

  it("rescans for A and B on one instance: each database holds its own playlist list", async () => {
    await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      await call(ZEN); // one rescan this tick
      vi.setSystemTime(t0 + 5 * 60_000); // both due again; the other one's rescan
      await call(ZEN);
    } finally {
      vi.useRealTimers();
    }
    for (const uid of [A, B]) {
      const lists = await forUserAt(mintUid(uid), dbOf(uid)).getStoredPlaylists();
      expect(lists.map((p) => p.name), uid).toEqual([`${uid}-only-playlist`]);
    }
    // No /me call: the claim carried each user's Spotify id (PLAN §7.7).
    expect(w.calls.filter((c) => c.path === "/v1/me")).toEqual([]);
  });
});

describe("T13 through the route", () => {
  it("cron-job.org hears a bare {\"ok\":true}; its tick runs after the reply and serves both users", async () => {
    await seed();
    const res = await call(EXT);
    expect({ status: res.status, body: await res.text() }).toEqual({ status: 200, body: '{"ok":true}' });
    await flushAfter();
    expect(await playsOf(A)).toEqual([`${A}-only-song-1`]);
    expect(await playsOf(B)).toEqual([`${B}-only-song-1`]);
  });

  it("the Zenbook's body has no track, name or token, and no friend's trigger or count", async () => {
    await seed();
    const text = await (await call(ZEN)).text();
    for (const leak of ["-t0", "-t1", "-only", "at-", "rt-"]) expect(text).not.toContain(leak);
    const body = JSON.parse(text) as { steps: { uid: string }[] };
    expect(body.steps.find((s) => s.uid === A)).toEqual({ uid: A, outcome: "ok" });
  });

  it("a burst inside the window, from both callers, does one tick's work", async () => {
    await seed();
    const replies = await Promise.all([ZEN, EXT, ZEN, EXT].map(call));
    await flushAfter();
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(probes(A)).toBe(1);
    expect(probes(B)).toBe(1);
  });
});
