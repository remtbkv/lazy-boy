// The open app's sync (docs/multi-user/PLAN.md §7.6): POST /api/sync runs the cron's own step
// under the cron's own lease. A load or a return to the tab (`x-sync: load`) harvests once when
// the probe has seen a track change since the last harvest, at least 60 s apart; the tab's
// 2-minute timer runs a step only when no tick has stamped `tick_at` in 5 minutes. The browser's
// zone is written only when it changes, and the Home payload buckets days in the user's own zone
// (`user_tz`, design C §3.3). The real route, the real app database, the owner's store (the
// throwaway file), the real Spotify client against a scripted fetch.
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.TOKEN_KEYS = `v1:${Buffer.alloc(32, 5).toString("base64")}`;

const w = vi.hoisted(() => ({
  paths: [] as string[],
  player: null as null | { id: string; progress: number; playing: boolean },
  cookies: new Map<string, string>(),
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (w.cookies.has(n) ? { name: n, value: w.cookies.get(n) } : undefined) }),
  headers: async () => w.headers,
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  after: (task: (() => unknown) | Promise<unknown>) => void Promise.resolve().then(() => (typeof task === "function" ? task() : task)),
}));
// The gate is the authz suite's subject; here the request is the owner's.
vi.mock("@/lib/require-user", async () => {
  const { mintUid } = await import("@/lib/identity");
  return { requireRouteUser: async () => ({ uid: mintUid(process.env.OWNER_UID as string), admin: true }) };
});

const track = (id: string) => ({
  id,
  name: `song ${id}`,
  uri: `spotify:track:${id}`,
  duration_ms: 200_000,
  artists: [{ name: "artist" }],
  album: { name: "album", images: [] },
  type: "track",
});

vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "https://api.spotify.com") throw new Error(`unexpected fetch ${url}`);
  w.paths.push(url.pathname);
  if (url.pathname === "/v1/me/player") {
    if (!w.player) return new Response(null, { status: 204 });
    return Response.json({ is_playing: w.player.playing, progress_ms: w.player.progress, item: track(w.player.id) });
  }
  if (url.pathname === "/v1/me/player/recently-played") {
    return Response.json({ items: [{ track: track("t0"), played_at: new Date(Date.now() - 300_000).toISOString(), context: null }] });
  }
  throw new Error(`unexpected Spotify call ${url.pathname}`);
});

const appDb = await import("@/lib/app-db");
const { createClient } = await import("@libsql/client");
const { appTokenStore } = await import("@/lib/token-store-app");
const { forUser } = await import("@/lib/db");
const { mintUid } = await import("@/lib/identity");
const { POST } = await import("@/app/api/sync/route");

const OWNER = mintUid(process.env.OWNER_UID as string);
const owner = forUser(OWNER);
const MIN = 60_000;
let raw: import("@libsql/client").Client;
let userRaw: import("@libsql/client").Client;

const sync = async (load: boolean) => {
  w.headers = new Headers({ "x-sync": load ? "load" : "timer" });
  const res = await POST();
  return (await res.json()) as { ok: boolean; ran: boolean; trigger?: string | null; reason?: string };
};
const harvests = () => w.paths.filter((p) => p === "/v1/me/player/recently-played").length;
const probes = () => w.paths.filter((p) => p === "/v1/me/player").length;

let base = Date.parse("2026-10-16T16:00:00Z");
const at = (ms: number) => vi.setSystemTime(base + ms);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  base += 3_600_000;
  at(0);
  w.paths.length = 0;
  w.player = null;
  w.cookies.clear();
  await appDb.getAppMeta("schema_version");
  raw ??= createClient({ url: appDb.appDatabaseUrl(), intMode: "number" });
  for (const t of ["user_tokens", "sync_state", "events", "users"]) await raw.execute(`DELETE FROM ${t}`);
  await raw.execute("DELETE FROM app_meta WHERE key NOT IN ('schema_version', 'min_reader') AND key NOT LIKE 'sentinel:%'");
  await raw.execute({
    sql: `INSERT INTO users (uid, account_id, spotify_id, db_name, status, status_at, is_admin, session_epoch, invited_at)
          VALUES (?, 'acct-rem', 'rem-spotify', 'lazyboy', 'active', 0, 1, 0, 0)`,
    args: [OWNER],
  });
  await appTokenStore().set(OWNER, { accessToken: "at-rem", refreshToken: "rt-rem", expiresAt: Math.floor(base / 1000) + 7_200 });
  await appDb.setAppMeta(`token_copy:${OWNER}`, "copied");
  // Harvested a minute before the test began; the library is not due.
  await raw.execute({
    sql: "INSERT INTO sync_state (uid, state, next_probe_at, next_rescan_at, last_harvest_at) VALUES (?, 'idle', ?, ?, ?)",
    args: [OWNER, base + 10 * MIN, base + 86_400_000, base - MIN],
  });
  // The owner's own database: no probe state, no zone yet.
  await owner.getLastSync(); // the first open provisions the file
  userRaw ??= createClient({ url: process.env.TURSO_DATABASE_URL as string, intMode: "number" });
  await userRaw.execute("DELETE FROM meta WHERE key IN ('probe', 'user_tz', 'user_tz_offset')");
});

describe("POST /api/sync, the open app (PLAN §7.6)", () => {
  it("a load probes and harvests nothing when the probe has seen no track change", async () => {
    w.player = { id: "a", progress: 10_000, playing: true };
    const r = await sync(true);
    expect(r).toMatchObject({ ok: true, ran: true, trigger: null });
    expect(probes()).toBe(1);
    expect(harvests()).toBe(0);
  });

  it("a load harvests a track change its probe saw, once: a return with no new change harvests nothing", async () => {
    w.player = { id: "a", progress: 10_000, playing: true };
    await sync(true); // the first probe: the state it starts from
    at(30_000);
    w.player = { id: "b", progress: 5_000, playing: true }; // a change, seen by this load's probe
    // With the brake off a seen change is the cron's own `change` trigger; the open app's
    // `open-app` catch-up (once a minute) is for a change the brake held back (harvest-policy.ts,
    // known answers in tests/harvest-policy.test.ts and T4).
    const first = await sync(true);
    expect(first).toMatchObject({ ran: true, trigger: "change" });
    expect(harvests()).toBe(1);
    at(60_000);
    w.player = { id: "b", progress: 35_000, playing: true }; // the same song, played on
    expect(await sync(true)).toMatchObject({ ran: true, trigger: null });
    expect(harvests()).toBe(1);
  });

  it("the tab's 2-minute timer does nothing while ticks run, and stands in after 5 minutes without one", async () => {
    w.player = { id: "a", progress: 10_000, playing: true };
    await appDb.setAppMeta("tick_at", String(base - 4 * MIN));
    expect(await sync(false)).toMatchObject({ ok: true, ran: false, reason: "cron" });
    expect(w.paths).toEqual([]);
    // No tick for over 5 minutes: the user is due (their next probe was 10 minutes out; the
    // timer waits for it), so move the clock past it.
    at(11 * MIN);
    const r = await sync(false);
    expect(r).toMatchObject({ ok: true, ran: true });
    expect(probes()).toBe(1);
  });

  it("the browser's zone is written only when it changes", async () => {
    expect(await owner.setUserTzOffset(-240)).toBe(true);
    expect(await owner.setUserTzOffset(-240)).toBe(false);
    expect(await owner.setUserTzOffset(-300)).toBe(true);
    expect(await owner.setUserTz("America/Chicago")).toBe(true);
    expect(await owner.setUserTz("America/Chicago")).toBe(false);
    expect(await owner.getUserTz()).toBe("America/Chicago");
    // A zone the runtime does not know is never stored.
    expect(await owner.setUserTz("Mars/Olympus_Mons")).toBe(false);
    expect(await owner.getUserTz()).toBe("America/Chicago");
  });

  it("the route publishes both cookies: the offset and the IANA zone", async () => {
    w.cookies.set("tzoffset", "-300");
    w.cookies.set("tzname", "America/Chicago");
    await sync(false);
    expect(await owner.getUserTzOffset()).toBe(-300);
    expect(await owner.getUserTz()).toBe("America/Chicago");
  });

  it("the Home payload buckets days in the user's own zone, with the DST check against that zone (design C §3.3)", async () => {
    // Chicago in October is UTC−5, New York UTC−4: a stored −300 is exactly 60 from New York's
    // offset, which the New York-only rule read as a DST change no browser had reported.
    await owner.setUserTzOffset(-300);
    await owner.setUserTz("America/Chicago");
    expect((await owner.rebuildHomePayload()).tzOffsetMinutes).toBe(-300);
    // The check still works in the user's zone: a stale offset an hour off follows the zone.
    await owner.setUserTzOffset(-240);
    expect((await owner.rebuildHomePayload()).tzOffsetMinutes).toBe(-300);
  });
});
