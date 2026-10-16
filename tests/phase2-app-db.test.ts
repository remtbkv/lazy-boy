// scripts/phase2-app-db.mjs (PLAN.md §11.4 step 1, step 5's checks) against a scripted Turso
// Platform API and local database files: no Keychain, no network, no real store.
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { APP_SCHEMA_VERSION } from "@/lib/app-schema";
// @ts-expect-error -- a plain-Node script with no type declarations
import { main } from "../scripts/phase2-app-db.mjs";

const UID = "aaaaaaaaaaaa";
const ENV = { OWNER_UID: UID, SPOTIFY_OWNER_ID: "rem" };
const SECRET = "PLATFORM-SECRET-do-not-print";

type Call = { method: string; path: string; auth: string | null; body: unknown };
let dir: string;
let calls: Call[];
let logs: string[];
let dbs: Record<string, { Hostname: string; group: string }>;
let opened: { url: string; token: string }[];
let derivedRuns: number;
const clients = new Map<string, Client>();
const fileFor = (host: string) => `file:${path.join(dir, `${host}.db`)}`;
const local = (host: string) => {
  if (!clients.has(host)) clients.set(host, createClient({ url: fileFor(host), intMode: "number" }));
  return clients.get(host)!;
};

function deps() {
  return {
    platformToken: () => SECRET,
    fetch: async (url: string, init: RequestInit) => {
      const p = url.replace("https://api.turso.tech/v1/organizations/remtbkv", "");
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init.method ?? "GET", path: p, auth: new Headers(init.headers).get("authorization"), body });
      const get = /^\/databases\/([^/?]+)$/.exec(p);
      if (init.method === "GET" && get) {
        const db = dbs[get[1]];
        return db ? Response.json({ database: { Name: get[1], ...db } }) : Response.json({ error: "not found" }, { status: 404 });
      }
      if (init.method === "POST" && p === "/databases") {
        dbs[body.name] = { Hostname: `${body.name}-remtbkv.example`, group: body.group };
        return Response.json({ database: { Name: body.name, Hostname: dbs[body.name].Hostname, DbId: "x" } });
      }
      const tok = /^\/databases\/([^/]+)\/auth\/tokens\?expiration=1h&authorization=(full-access|read-only)$/.exec(p);
      if (init.method === "POST" && tok) return Response.json({ jwt: `jwt-${tok[1]}-${tok[2]}` });
      return Response.json({ error: "unscripted" }, { status: 500 });
    },
    open: (url: string, token: string) => {
      opened.push({ url, token });
      const host = url.replace("https://", "");
      // A fresh client per open, as the script closes what it opens.
      return createClient({ url: fileFor(host), intMode: "number" });
    },
    verifyDerived: () => (derivedRuns++, true),
    log: (s: string) => void logs.push(s),
    now: () => 1_700_000_000_000,
  };
}

async function seedLazyboy(opts: { plays: number; maxPlayedAt: string; keys: string[] }) {
  dbs.lazyboy = { Hostname: "lazyboy-remtbkv.example", group: "default" };
  const c = local("lazyboy-remtbkv.example");
  await c.executeMultiple(`
    DROP TABLE IF EXISTS tracks; DROP TABLE IF EXISTS plays; DROP TABLE IF EXISTS contexts; DROP TABLE IF EXISTS meta;
    DROP TABLE IF EXISTS playlists; DROP TABLE IF EXISTS playlist_tracks; DROP TABLE IF EXISTS saved_tracks;
    CREATE TABLE tracks (id TEXT); CREATE TABLE plays (id INTEGER, played_at TEXT); CREATE TABLE contexts (uri TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE playlists (id TEXT);
    CREATE TABLE playlist_tracks (playlist_id TEXT); CREATE TABLE saved_tracks (track_id TEXT);`);
  for (let i = 0; i < opts.plays; i++) {
    await c.execute({ sql: "INSERT INTO plays VALUES (?, ?)", args: [i, i === opts.plays - 1 ? opts.maxPlayedAt : "2026-01-01T00:00:00Z"] });
  }
  for (const k of opts.keys) {
    await c.execute({ sql: "INSERT INTO meta VALUES (?, ?)", args: [k, k === "spotify_tokens" ? "SECRET-TOKEN-VALUE" : "v"] });
  }
}

const ALL_KEYS = ["owner_uid", "schema_version", "min_reader", "store_epoch", "spotify_tokens", "last_sync", "plsnap:x"];

/** What the deployed runtime writes on its first boot and tick (the script never does). */
async function runtimeFirstTick() {
  const c = local("lazyboy-app-remtbkv.example");
  await c.execute({ sql: "INSERT INTO user_tokens VALUES (?, 'v1.ciphertext', 9, 9)", args: [UID] });
  await c.execute({ sql: "INSERT INTO app_meta VALUES (?, 'copied:1')", args: [`token_copy:${UID}`] });
  await c.execute("INSERT INTO app_meta VALUES ('sentinel:v1', 'v1.sentinel')");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lb-phase2-"));
  calls = [];
  logs = [];
  dbs = {};
  opened = [];
  derivedRuns = 0;
  clients.clear();
});

describe("refusals", () => {
  it("refuses to run with TOKEN_KEYS in its environment, before any call", async () => {
    expect(await main([], deps(), { ...ENV, TOKEN_KEYS: "v1:x" })).toBe(2);
    expect(calls).toEqual([]);
  });
  it("needs a uid-shaped OWNER_UID and a SPOTIFY_OWNER_ID", async () => {
    await expect(main([], deps(), { SPOTIFY_OWNER_ID: "rem", OWNER_UID: "AAAA" })).rejects.toThrow(/OWNER_UID/);
    await expect(main([], deps(), { OWNER_UID: UID })).rejects.toThrow(/SPOTIFY_OWNER_ID/);
  });
  it("refuses an existing lazyboy-app outside group default", async () => {
    dbs["lazyboy-app"] = { Hostname: "h", group: "other" };
    await expect(main([], deps(), ENV)).rejects.toThrow(/group other/);
  });
});

describe("step 1", () => {
  it("--dry-run writes nothing: no POST, no database opened", async () => {
    expect(await main(["--dry-run"], deps(), ENV)).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(opened).toEqual([]);
    expect(logs.join("\n")).toMatch(/would create lazyboy-app in group default/);
  });

  it("creates lazyboy-app in default, applies APP_SCHEMA, inserts the admin row with account_id NULL", async () => {
    expect(await main([], deps(), ENV)).toBe(0);
    expect(calls.find((c) => c.method === "POST" && c.path === "/databases")?.body).toEqual({ name: "lazyboy-app", group: "default" });
    expect(calls.every((c) => c.auth === `Bearer ${SECRET}`)).toBe(true);
    expect(opened).toEqual([{ url: "https://lazyboy-app-remtbkv.example", token: "jwt-lazyboy-app-full-access" }]);
    const c = local("lazyboy-app-remtbkv.example");
    expect((await c.execute("SELECT * FROM users")).rows).toEqual([
      {
        uid: UID,
        account_id: null,
        spotify_id: "rem",
        db_name: "lazyboy",
        status: "active",
        status_at: 1_700_000_000_000,
        is_admin: 1,
        session_epoch: 0,
        terms_version: null,
        terms_accepted_at: null,
        invited_at: 1_700_000_000_000,
        claimed_at: null,
        last_sign_in: null,
      },
    ]);
    expect((await c.execute("SELECT key, value FROM app_meta ORDER BY key")).rows).toEqual([
      { key: "min_reader", value: "1" },
      // Every APP_SCHEMA step; Phase 4a's requests table is additive, so min_reader stays 1.
      { key: "schema_version", value: String(APP_SCHEMA_VERSION) },
    ]);
    expect((await c.execute("SELECT count(*) AS n FROM user_tokens")).rows[0].n).toBe(0);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("re-runs as a no-op: no second create, the row as it was", async () => {
    await main([], deps(), ENV);
    calls = [];
    const d = { ...deps(), now: () => 1_800_000_000_000 };
    expect(await main([], d, ENV)).toBe(0);
    expect(calls.some((c) => c.method === "POST" && c.path === "/databases")).toBe(false);
    const rows = (await local("lazyboy-app-remtbkv.example").execute("SELECT status_at FROM users")).rows;
    expect(rows).toEqual([{ status_at: 1_700_000_000_000 }]);
  });
});

describe("--snapshot-out and --verify (step 5)", () => {
  it("passes once the runtime has run, against a snapshot, with read-only tokens", async () => {
    await seedLazyboy({ plays: 3, maxPlayedAt: "2026-10-17T10:00:00Z", keys: ALL_KEYS });
    const snap = path.join(dir, "snap.json");
    expect(await main(["--snapshot-out", snap], deps(), ENV)).toBe(0);
    const s = JSON.parse(readFileSync(snap, "utf8"));
    expect(s.counts.plays).toBe(3);
    expect(s.metaKeys).toEqual([...ALL_KEYS].sort());
    expect(readFileSync(snap, "utf8")).not.toContain("SECRET-TOKEN-VALUE");

    await main([], deps(), ENV);
    await runtimeFirstTick();
    await seedLazyboy({ plays: 5, maxPlayedAt: "2026-10-17T12:00:00Z", keys: ALL_KEYS.filter((k) => k !== "plsnap:x") });
    opened = [];
    logs = [];
    expect(await main(["--verify", "--snapshot", snap], deps(), ENV)).toBe(0);
    expect(logs.filter((l) => l.startsWith("FAIL"))).toEqual([]);
    expect(derivedRuns).toBe(1);
    expect(opened.every((o) => o.token.endsWith("read-only"))).toBe(true);
    expect(logs.join("\n")).not.toMatch(/SECRET-TOKEN-VALUE|PLATFORM-SECRET/);
  });

  it("fails on each thing step 5 must catch", async () => {
    await seedLazyboy({ plays: 3, maxPlayedAt: "2026-10-17T10:00:00Z", keys: ALL_KEYS });
    const snap = path.join(dir, "snap.json");
    await main(["--snapshot-out", snap], deps(), ENV);
    await main([], deps(), ENV); // step 1, but the runtime never ran: no token row, no copy, no sentinel
    await local("lazyboy-app-remtbkv.example").execute("INSERT INTO events (at, uid, code) VALUES (1, NULL, 'decrypt')");
    await seedLazyboy({ plays: 2, maxPlayedAt: "2026-10-17T10:00:00Z", keys: ALL_KEYS.filter((k) => k !== "last_sync") });
    logs = [];
    expect(await main(["--verify", "--snapshot", snap], deps(), ENV)).toBe(1);
    const failed = logs.filter((l) => l.startsWith("FAIL")).map((l) => l.replace(/  \(.*$/, "").slice(6));
    expect(failed).toEqual([
      "admin user_tokens row, encrypted (v<n>.)",
      "the runtime's copy ran and verified (token_copy marker)",
      "a sentinel per token key, written by the runtime",
      "no events",
      "plays count at or above the snapshot",
      "meta count at or above the snapshot",
      "max(played_at) moved past the snapshot",
      "no meta key removed",
    ]);
  });
});
