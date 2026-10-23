// The authz suite's rig (docs/multi-user/AUTHZ.md): principals as real Auth.js cookies and
// real headers, a scripted Spotify that answers per bearer and logs which bearer each call
// carried, Rem's store seeded with a marker in every text column, an ordered dump of every
// table, and one oracle that turns what an entry point did into allow / deny / allow-own.
//
// The real Auth.js runs here (vitest.config.ts inlines next-auth so its next/server import
// resolves): the cookie is a JWE minted with next-auth/jwt's encode under AUTH_SECRET, decoded
// by Auth.js, then passed through src/lib/auth.ts's own jwt and session callbacks against the
// throwaway store. So a forged or stale cookie fails exactly where production's would.
//
// Nothing here touches a real store, Spotify or Vercel (tests/setup.ts points the store at a
// temp file; fetch is stubbed per test file).
import { createClient, type Client } from "@libsql/client";
import { encode } from "next-auth/jwt";
import { vi } from "vitest";
import { ctx, flushAfter, resetContext, requestHeaders } from "./authz-context";

// ── Environment: set before any app module loads (test files import this first) ──────────
export const SECRETS = {
  auth: "authz-current-AUTH_SECRET-0123456789abcdef",
  // AUTH_SECRET before the Oct 15 12:46 PM rotation: every cookie it signed is void.
  authOld: "authz-pre-rotation-AUTH_SECRET-fedcba9876543210",
  // What an attacker without the secret signs with.
  authForged: "authz-attacker-guess-0000000000000000",
  cron: "authz-cron-secret-zenbook",
  cronExt: "authz-cron-secret-cronjob-org",
} as const;

process.env.AUTH_SECRET = SECRETS.auth;
process.env.CRON_SECRET = SECRETS.cron;
process.env.CRON_SECRET_EXT = SECRETS.cronExt;
process.env.SPOTIFY_CLIENT_ID = "authz-client-id";
process.env.SPOTIFY_CLIENT_SECRET = "authz-client-secret";
process.env.SPOTIFY_OWNER_ID = "rem-spotify";
// Phase 1's owner constant (PLAN §11.4). Unused by today's code; mu/phase1's identity check
// reads it, so Rem's cookie below carries it as its uid.
process.env.OWNER_UID = "remremremrem";
process.env.NEXT_PUBLIC_BUILD_ID = "authz-build";
delete process.env.AUTH_URL;
delete process.env.TURSO_PLATFORM_TOKEN;
delete process.env.CRONJOB_API_KEY;

export const OWNER_UID = process.env.OWNER_UID;

// Phase 2: the identity read and the token row live in the app database (dev and tests: app.db
// beside the store's file, app-db.ts), the token encrypted under TOKEN_KEYS (a fixed test key).
process.env.TOKEN_KEYS = `v1:${Buffer.alloc(32, 7).toString("base64")}`;
delete process.env.APP_DATABASE_URL;

// ── Principals ───────────────────────────────────────────────────────────────────────────
export const PRINCIPALS = [
  "anon",
  "rem",
  "friendA",
  "friendB",
  "revoked",
  "vercelCron",
  "zenbookPinger",
  "zenbookRecorder",
  "cronjobOrg",
  "staleSecret",
  "staleLogout",
  "forged",
] as const;
export type Principal = (typeof PRINCIPALS)[number];

export const PRINCIPAL_LABEL: Record<Principal, string> = {
  anon: "no session",
  rem: "Rem (owner)",
  friendA: "friend A",
  friendB: "friend B",
  revoked: "friend whose access was revoked",
  vercelCron: "Vercel cron (CRON_SECRET, no x-vercel-cron header)",
  zenbookPinger: "Zenbook pinger (CRON_SECRET)",
  zenbookRecorder: "Zenbook recorder (its own Spotify token, no app secret)",
  cronjobOrg: "cron-job.org (CRON_SECRET_EXT)",
  staleSecret: "cookie signed before the AUTH_SECRET rotation",
  staleLogout: "Rem's cookie replayed after Log out",
  forged: "cookie forged without AUTH_SECRET",
};

/** The session claims each person's cookie carries. `uid`, `ep` and `auth_time` are Phase 1's
 *  claims (PLAN §5.1); today's callbacks ignore them, which is the point of the friend rows. */
const CLAIMS: Record<"rem" | "friendA" | "friendB" | "revoked", Record<string, unknown>> = {
  rem: { name: "Rem", email: "rem@example.test", sub: "sub-rem", uid: "remremremrem" },
  friendA: { name: "Friend A", email: "a@example.test", sub: "sub-a", uid: "aaaaaaaaaaaa" },
  friendB: { name: "Friend B", email: "b@example.test", sub: "sub-b", uid: "bbbbbbbbbbbb" },
  revoked: { name: "Revoked R", email: "r@example.test", sub: "sub-r", uid: "rrrrrrrrrrrr" },
};

const COOKIE = "authjs.session-token"; // http in tests; production's is __Secure-authjs.session-token

export async function sessionCookie(
  who: keyof typeof CLAIMS,
  secret: string = SECRETS.auth,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return encode({
    token: { ...CLAIMS[who], ep: 0, auth_time: now, ...extra },
    secret,
    salt: COOKIE,
  });
}

/** Put the request context into `p`'s shoes. Store-side state a principal implies (Rem's token
 *  row gone after Log out) is applied here too, after the seed. */
export async function become(p: Principal): Promise<void> {
  resetContext();
  switch (p) {
    case "anon":
      return;
    case "rem":
    case "friendA":
    case "friendB":
    case "revoked":
      ctx.cookies.set(COOKIE, await sessionCookie(p));
      return;
    case "staleSecret":
      ctx.cookies.set(COOKIE, await sessionCookie("rem", SECRETS.authOld));
      return;
    case "forged":
      ctx.cookies.set(COOKIE, await sessionCookie("rem", SECRETS.authForged));
      return;
    case "staleLogout": {
      // A copy of Rem's cookie taken before he pressed Log out. Log out clears his token row
      // (Phase 2: his `user_tokens` row, PHASE2.md §4 item 1; the plaintext `meta` row with it)
      // and deletes the browser's cookie, but the JWE itself stays valid for its 30 days.
      ctx.cookies.set(COOKIE, await sessionCookie("rem"));
      const c = await raw();
      await c.execute({ sql: "DELETE FROM meta WHERE key = ?", args: [TOKENS_KEY] });
      await (await appRaw()).execute({ sql: "DELETE FROM user_tokens WHERE uid = ?", args: [OWNER_UID as string] });
      return;
    }
    case "vercelCron":
      ctx.headers = { authorization: `Bearer ${SECRETS.cron}`, "user-agent": "vercel-cron/1.0" };
      return;
    case "zenbookPinger":
      ctx.headers = { authorization: `Bearer ${SECRETS.cron}`, "user-agent": "curl/8.5.0" };
      return;
    case "zenbookRecorder":
      // The recorder holds a Spotify grant for Rem's account (~/lazyboy-recorder/tokens.json)
      // and no app secret; this is that grant presented to the app.
      ctx.headers = { authorization: "Bearer at-RECORDER", "user-agent": "python-requests/2.31" };
      return;
    case "cronjobOrg":
      ctx.headers = { authorization: `Bearer ${SECRETS.cronExt}`, "user-agent": "cron-job.org" };
      return;
  }
}

// ── Scripted Spotify ─────────────────────────────────────────────────────────────────────
export type SpotifyCall = { method: string; url: string; bearer: string | null; refreshToken: string | null; gen: number };
export const spotifyCalls: SpotifyCall[] = [];
// Each observation is one generation; a straggler from an earlier test's background work is
// logged under its old generation and not counted against the current one.
let generation = 0;

const OWNER_OF: Record<string, string> = {
  REM: "rem-spotify",
  A: "friend-a-spotify",
  B: "friend-b-spotify",
  R: "friend-r-spotify",
  RECORDER: "rem-spotify",
};

function who(bearer: string | null): string {
  const m = bearer?.match(/^at-([A-Z]+)/);
  return m ? m[1] : "NOBODY";
}

function trackJson(owner: string, n: number) {
  return {
    id: `${owner.toLowerCase()}-t${n}`,
    name: `${owner}-only-song-${n}`,
    uri: `spotify:track:${owner.toLowerCase()}-t${n}`,
    duration_ms: 200_000,
    artists: [{ name: `${owner}-only-artist` }],
    album: { name: `${owner}-only-album`, images: [] },
    type: "track",
  };
}

async function spotifyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const authz = headers.get("authorization");
  const bearer = authz?.startsWith("Bearer ") ? authz.slice(7) : null;
  let refreshToken: string | null = null;
  let code: string | null = null;
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    refreshToken = body.get("refresh_token");
    code = body.get("code");
  } else if (typeof body === "string" && body.includes("=")) {
    const p = new URLSearchParams(body);
    refreshToken = p.get("refresh_token");
    code = p.get("code");
  }

  if (url.startsWith("https://accounts.spotify.com/api/token")) {
    spotifyCalls.push({ method, url, bearer, refreshToken, gen: generation });
    // A code from the OAuth stand-in names its person: code-REM, code-A, code-NOTREG.
    const person = code ? code.replace(/^code-/, "") : (refreshToken ?? "").replace(/^rt-/, "");
    return Response.json({
      access_token: `at-${person}${code ? "" : "-refreshed"}`,
      refresh_token: `rt-${person}`,
      expires_in: 3600,
      token_type: "Bearer",
      scope: "user-read-private",
    });
  }
  if (!url.startsWith("https://api.spotify.com/")) {
    throw new Error(`authz harness: unexpected fetch ${method} ${url}`);
  }
  spotifyCalls.push({ method, url, bearer, refreshToken, gen: generation });
  const owner = who(bearer);
  if (owner === "NOBODY") return new Response("no token", { status: 401 });
  if (owner === "NOTREG") {
    return new Response("Check settings on developer.spotify.com/dashboard, the user may not be registered.", {
      status: 403,
    });
  }
  const path = new URL(url).pathname.replace(/^\/v1/, "");
  if (method !== "GET") {
    if (/\/playlists$/.test(path)) return Response.json({ id: `${owner.toLowerCase()}-new-pl`, name: "new" }, { status: 201 });
    // `next` refuses: saveQueue's skip-through walk stops at its first skip instead of stalling
    // 15 s on a queue that never moves (the player below is playing). Not the queue itself:
    // addToQueueAction is one of the player commands the suites expect to succeed.
    if (path === "/me/player/next") return Response.json({ error: { status: 404, message: "No active device found" } }, { status: 404 });
    return Response.json({ snapshot_id: "snap-after" }, { status: 200 });
  }
  if (path === "/me") {
    return Response.json({ id: OWNER_OF[owner] ?? owner, display_name: owner, email: null, images: [], product: "premium" });
  }
  // The player state, per owner, playing from the owner's playlist: /api/now-playing reads it
  // (NOW_PLAYING_2S L2) and goes on to the owner's context-name cache (code review 0156 M4).
  if (path === "/me/player") {
    return Response.json({
      is_playing: true,
      progress_ms: 1000,
      item: trackJson(owner, 1),
      context: { type: "playlist", uri: `spotify:playlist:${owner.toLowerCase()}-pl-1` },
      currently_playing_type: "track",
    });
  }
  if (path === "/me/player/recently-played") {
    return Response.json({
      items: [{ track: trackJson(owner, 9), played_at: new Date(Date.now() - 60_000).toISOString(), context: null }],
      next: null,
    });
  }
  if (path === "/me/player/queue") return Response.json({ currently_playing: trackJson(owner, 1), queue: [trackJson(owner, 2)] });
  if (path === "/me/playlists") {
    return Response.json({
      items: [
        {
          id: `${owner.toLowerCase()}-pl-1`,
          name: `${owner}-only-playlist`,
          owner: { id: OWNER_OF[owner] ?? owner },
          images: [],
          tracks: { total: 1 },
          items: { total: 1 },
          snapshot_id: "snap-1",
        },
      ],
      next: null,
      total: 1,
    });
  }
  if (path === "/me/tracks") return Response.json({ items: [], next: null, total: 0 });
  const pl = path.match(/^\/playlists\/([^/]+)(\/items|\/tracks)?$/);
  if (pl) {
    if (pl[2]) return Response.json({ items: [{ track: trackJson(owner, 1), added_at: "2026-01-01T00:00:00Z" }], next: null, total: 1 });
    return Response.json({
      id: pl[1],
      name: `${owner}-only-playlist`,
      snapshot_id: "snap-live",
      owner: { id: OWNER_OF[owner] ?? owner },
      images: [],
      tracks: { total: 1 },
      items: { total: 1 },
    });
  }
  return Response.json({}, { status: 404 });
}

export function installSpotify(): void {
  vi.stubGlobal("fetch", vi.fn(spotifyFetch));
}

export const remBearerUsed = () =>
  spotifyCalls.some(
    (c) => c.gen === generation && ((c.bearer ?? "").startsWith("at-REM") || (c.refreshToken ?? "").startsWith("rt-REM")),
  );

// ── Rem's store ──────────────────────────────────────────────────────────────────────────
// NODE_ENV is "test", so db.ts keeps the token row under its dev key.
export const TOKENS_KEY = process.env.NODE_ENV === "production" ? "spotify_tokens" : "spotify_tokens_dev";
export const MARKER = /REM-only|at-REM|rt-REM/;
export const FAR = 4_000_000_000;
export const REM_PLAYLIST = "rem-pl-1";
export const REM_DAY = new Date(Date.now() - 3_600_000).toISOString().slice(0, 10);

/** Rem's store: OWNER_UID at `lazyboy`, the database his `users` row names, which is the
 *  throwaway file (the seed writes it before any identity read has named it). */
async function remStore() {
  const db = await import("@/lib/db");
  const { mintUid } = await import("@/lib/identity");
  return db.forUserAt(mintUid(OWNER_UID as string), "lazyboy");
}

let rawClient: Client | null = null;
async function raw(): Promise<Client> {
  const db = await import("@/lib/db");
  await (await remStore()).getLastSync(); // the first open provisions the file for Rem
  await db.readLedger(1); // the telemetry init creates the log tables beside it
  rawClient ??= createClient({ url: process.env.TURSO_DATABASE_URL as string, intMode: "number" });
  return rawClient;
}

// The four keys the open checks say whose database the file is; a reseed keeps them.
const OPEN_KEYS = "'owner_uid', 'schema_version', 'min_reader', 'store_epoch'";

// The app database (Phase 2), opened once through app-db.ts so its schema is the code's.
let appClient: Client | null = null;
async function appRaw(): Promise<Client> {
  const app = await import("@/lib/app-db");
  await app.readTokenRow(OWNER_UID as string); // the first open creates the schema
  appClient ??= createClient({ url: app.appDatabaseUrl(), intMode: "number" });
  return appClient;
}

/** The app database as Phase 2 leaves it for Rem (PLAN §11.4): the admin row step 1 writes,
 *  bound to his account_id by his first sign-in, and his token encrypted in `user_tokens` with
 *  the runtime's copy marked done. The key's sentinel and the schema keys survive a reseed. */
async function seedApp(tokens: { accessToken: string; refreshToken: string; expiresAt: number }): Promise<void> {
  const a = await appRaw();
  for (const t of ["user_tokens", "sync_state", "events", "users"]) await a.execute(`DELETE FROM ${t}`);
  await a.execute("DELETE FROM app_meta WHERE key NOT IN ('schema_version', 'min_reader') AND key NOT LIKE 'sentinel:%'");
  await a.execute({
    sql: `INSERT INTO users (uid, account_id, spotify_id, db_name, status, status_at, is_admin, session_epoch, invited_at)
          VALUES (?, 'rem-account', 'rem-spotify', 'lazyboy', 'active', 0, 1, 0, 0)`,
    args: [OWNER_UID as string],
  });
  const { appTokenStore } = await import("@/lib/token-store-app");
  const { mintUid } = await import("@/lib/identity");
  await appTokenStore().set(mintUid(OWNER_UID as string), tokens);
  await a.execute({ sql: "INSERT INTO app_meta (key, value) VALUES (?, ?)", args: [`token_copy:${OWNER_UID}`, `copied:${Date.now()}`] });
  // The friends as Phase 4a's invites leave them: their own rows, databases and token rows,
  // none of it Rem's. The revoked friend connected once, then Rem disabled them (user.mjs
  // --disable), which also moved their session epoch: their cookie stays validly signed and is
  // refused by the row (status, then epoch), not for being unknown.
  for (const [uid, tag] of [["aaaaaaaaaaaa", "A"], ["bbbbbbbbbbbb", "B"], ["rrrrrrrrrrrr", "R"]] as const) {
    await a.execute({
      sql: `INSERT INTO users (uid, account_id, spotify_id, db_name, status, status_at, is_admin, session_epoch, invited_at)
            VALUES (?, ?, ?, ?, 'active', 0, 0, 0, 0)`,
      args: [uid, `${tag}-account`, `${tag}-spotify`, `lb-u-${uid}`],
    });
    await appTokenStore().set(mintUid(uid), { accessToken: `at-${tag}-friend`, refreshToken: `rt-${tag}-friend`, expiresAt: FAR });
  }
  await a.execute("UPDATE users SET status = 'disabled', session_epoch = 1 WHERE uid = 'rrrrrrrrrrrr'");
}

async function tables(): Promise<string[]> {
  const c = await raw();
  const r = await c.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return r.rows.map((x) => String(x.name));
}

export async function seedRem(opts: { tokenExpiresAt?: number } = {}): Promise<void> {
  const c = await raw();
  for (const t of await tables()) {
    await c.execute(t === "meta" ? `DELETE FROM meta WHERE key NOT IN (${OPEN_KEYS})` : `DELETE FROM ${t}`);
  }
  const db = await import("@/lib/db");
  const rem = await remStore();
  const tokens = { accessToken: "at-REM", refreshToken: "rt-REM", expiresAt: opts.tokenExpiresAt ?? FAR };
  await rem.setSpotifyTokens(tokens); // the plaintext row Phase 2 keeps for a week (§11.4 step 6)
  await seedApp(tokens);
  await c.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('me_id', ?)", args: ["rem-spotify"] });
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  const playOf = (n: number, minAgo: number) => ({
    trackId: `rem-t${n}`,
    name: `REM-only-song-${n}`,
    artist: "REM-only-artist",
    uri: `spotify:track:rem-t${n}`,
    album: "REM-only-album",
    albumImage: null,
    durationMs: 200_000,
    playedAt: at(minAgo),
    contextType: "playlist",
    contextUri: `spotify:playlist:${REM_PLAYLIST}`,
  });
  await rem.recordPlays([playOf(1, 60), playOf(2, 50), playOf(1, 40)]);
  await rem.recordContexts([{ uri: `spotify:playlist:${REM_PLAYLIST}`, name: "REM-only-playlist", type: "playlist" }]);
  await rem.storePlaylists(
    [{ id: REM_PLAYLIST, name: "REM-only-playlist", ownerId: "rem-spotify", image: null, trackCount: 2 }],
    "rem-spotify",
  );
  const trackOf = (n: number) => ({
    id: `rem-t${n}`,
    title: `REM-only-song-${n}`,
    artist: "REM-only-artist",
    uri: `spotify:track:rem-t${n}`,
    album: "REM-only-album",
    albumImage: null,
    durationMs: 200_000,
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  await rem.storePlaylistTracks(REM_PLAYLIST, [trackOf(1), trackOf(2)], "snap-1");
  await rem.rebuildHomePayload();
  await db.recordClientMetrics([{ session: "s-rem", page: "/REM-only-page", event: "ttfb", value: 120, meta: "pv:v1" }]);
  // The library stays stale on purpose: a scan request then reaches Spotify, which is the
  // observable proof that a gate let it through.
  await c.execute("DELETE FROM meta WHERE key IN ('library_synced_at', 'library_scan_attempt_at', 'last_sync')");
}

/** Every row of every table, ordered: a logical dump (a file hash would be fooled by WAL). */
export async function dump(): Promise<string> {
  const c = await raw();
  const out: Record<string, unknown[]> = {};
  for (const t of await tables()) {
    const r = await c.execute(`SELECT * FROM ${t}`);
    out[t] = r.rows.map((row) => JSON.stringify(row)).sort();
  }
  return JSON.stringify(out);
}

/** Rem's token rows, the encrypted one (Phase 2's token of record) and the plaintext one. */
export async function tokenRow(): Promise<string | null> {
  const c = await raw();
  const r = await c.execute({ sql: "SELECT value FROM meta WHERE key = ?", args: [TOKENS_KEY] });
  const a = await (await appRaw()).execute({ sql: "SELECT * FROM user_tokens WHERE uid = ?", args: [OWNER_UID as string] });
  if (!r.rows[0] && !a.rows[0]) return null;
  return JSON.stringify({ meta: r.rows[0] ? String(r.rows[0].value) : null, app: a.rows[0] ?? null });
}

// ── Invoking an entry point and reading what it did ──────────────────────────────────────
export type Outcome =
  | { kind: "response"; status: number; text: string; headers: Headers }
  | { kind: "redirect"; to: string }
  | { kind: "notFound" }
  | { kind: "value"; value: unknown; text: string }
  | { kind: "throw"; message: string };

function controlFlow(e: unknown): Outcome | null {
  const digest = (e as { digest?: unknown })?.digest;
  if (typeof digest !== "string") return null;
  if (digest.startsWith("NEXT_REDIRECT")) return { kind: "redirect", to: digest.split(";")[2] ?? "" };
  if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return { kind: "notFound" };
  return null;
}

/** Serialize what a page or action handed back, invoking nested async server components the
 *  way the RSC renderer would, so their reads land in the text too. */
async function serialize(node: unknown, depth = 0): Promise<string> {
  if (depth > 40 || node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return (await Promise.all(node.map((n) => serialize(n, depth + 1)))).join(" ");
  if (node instanceof Promise) return serialize(await node, depth + 1);
  if (typeof node !== "object") return "";
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (el.$$typeof && el.props) {
    const t = el.type as ((p: unknown) => unknown) | undefined;
    if (typeof t === "function" && t.constructor?.name === "AsyncFunction") {
      return serialize(await t(el.props), depth + 1);
    }
    const parts: string[] = [];
    for (const [k, v] of Object.entries(el.props)) {
      if (typeof v === "function") continue;
      parts.push(k === "children" ? await serialize(v, depth + 1) : await serialize(v, depth + 1));
      if (typeof v === "object" && v && !(v as { $$typeof?: unknown }).$$typeof && !Array.isArray(v)) {
        parts.push(safeJson(v));
      }
    }
    return parts.join(" ");
  }
  return safeJson(node);
}

function safeJson(v: unknown): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(v, (_k, x) => {
      if (typeof x === "function" || typeof x === "symbol") return undefined;
      if (x && typeof x === "object") {
        if (seen.has(x)) return undefined;
        seen.add(x);
      }
      return x;
    });
  } catch {
    return "";
  }
}

export async function run(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    const v = await fn();
    if (v instanceof Response) {
      return { kind: "response", status: v.status, text: await v.text(), headers: v.headers };
    }
    return { kind: "value", value: v, text: await serialize(v) };
  } catch (e) {
    const cf = controlFlow(e);
    if (cf) return cf;
    return { kind: "throw", message: e instanceof Error ? e.message : String(e) };
  } finally {
    await flushAfter();
  }
}

export type Observed = "allow" | "deny" | "allow-own";
export type Observation = {
  observed: Observed;
  outcome: Outcome;
  marker: boolean;
  remBearer: boolean;
  storeChanged: boolean;
  calls: SpotifyCall[];
};

/** Did the outcome refuse the caller? A redirect to /login, a 404 page, a 401/403/404 status,
 *  an action's `{ ok: false }`, or a read action's empty answer. */
export function refusedByDefault(o: Outcome): boolean {
  switch (o.kind) {
    case "redirect":
      return new URL(o.to, "http://127.0.0.1:3000").pathname === "/login";
    case "notFound":
      return true;
    case "response":
      return o.status === 401 || o.status === 403 || o.status === 404;
    case "throw":
      return /auth|sign|session|unauthor/i.test(o.message);
    case "value": {
      const v = o.value as Record<string, unknown> | unknown[] | null | undefined;
      if (v == null) return true;
      if (Array.isArray(v)) return v.length === 0;
      if (typeof v === "object" && "ok" in v) return v.ok === false;
      return Object.values(v).every((x) => x == null || x === false || (Array.isArray(x) && x.length === 0));
    }
  }
}

/** Run `fn` as `p` against a freshly seeded store and classify it.
 *  allow = it reached Rem's data, Rem's Spotify grant or Rem's rows; deny = it refused and
 *  touched none of them; allow-own = it neither refused nor touched anything of Rem's. */
export async function observe(
  p: Principal,
  fn: () => Promise<unknown>,
  opts: { refused?: (o: Outcome) => boolean; seed?: { tokenExpiresAt?: number }; before?: () => Promise<void> } = {},
): Promise<Observation> {
  await seedRem(opts.seed);
  await become(p);
  await opts.before?.();
  spotifyCalls.length = 0;
  generation++;
  const before = await dump();
  const outcome = await run(fn);
  const after = await dump();
  const text =
    outcome.kind === "response"
      ? `${outcome.text} ${outcome.headers.get("etag") ?? ""}`
      : outcome.kind === "value"
        ? outcome.text
        : outcome.kind === "redirect"
          ? outcome.to
          : outcome.kind === "throw"
            ? outcome.message
            : "";
  const marker = MARKER.test(text);
  const remBearer = remBearerUsed();
  const storeChanged = before !== after;
  const refused = (opts.refused ?? refusedByDefault)(outcome);
  const observed: Observed = marker || remBearer || storeChanged ? "allow" : refused ? "deny" : "allow-own";
  return { observed, outcome, marker, remBearer, storeChanged, calls: spotifyCalls.filter((c) => c.gen === generation) };
}

export function describeObservation(o: Observation): string {
  const out =
    o.outcome.kind === "response"
      ? `${o.outcome.status} ${o.outcome.headers.get("location") ?? ""} ${o.outcome.text.slice(0, 160)}`
      : o.outcome.kind === "value"
        ? o.outcome.text.slice(0, 160)
        : o.outcome.kind === "redirect"
          ? `redirect ${o.outcome.to}`
          : o.outcome.kind === "throw"
            ? `throw ${o.outcome.message.slice(0, 160)}`
            : "notFound";
  return `${o.observed} (marker=${o.marker} remBearer=${o.remBearer} storeChanged=${o.storeChanged}) :: ${out}`;
}

/** A Request as the route sees it, carrying the current principal's headers and cookie. */
export function request(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const h = requestHeaders();
  for (const [k, v] of Object.entries(init.headers ?? {})) h.set(k, v);
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: init.method ?? "GET",
    headers: h,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
