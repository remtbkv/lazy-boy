// T12 (PLAN.md §6.4): Phase 2's migration (§11.4) rehearsed on a local copy of a nightly backup,
// with a synthetic token row planted, since backups from lane 1904 on carry none.
//
//   T12_BACKUP=/path/to/backup.db.gz T12_REPORT=<scratch>/t12-report.txt \
//     npx vitest run tests/t12-phase2-rehearsal.test.ts
//
// takes Rem's real backup (`.db`, `.db.gz`, `.sql` or `.sql.gz`); without T12_BACKUP, `npm test`
// runs the same rehearsal on a small synthetic backup built by the store's own write path, so
// the harness itself stays tested. Nothing here reaches a network, Turso or Vercel: the Platform
// API is scripted, `lazyboy` is the working copy and `lazyboy-app` a fresh local file. The copy
// is made in a throwaway directory, which is deleted at the end; the backup file is only read.
// The report prints aggregates (counts, a max, key names), never a row.
//
// What it runs, in §11.4's order:
//   0. the copy: unpack, refuse a backup that still holds a token row, plant the synthetic one
//      (and Phase 1's four meta keys if the backup predates Phase 1's deploy, as lane 14 writes
//      them before Phase 2), then `--snapshot-out`;
//   1. scripts/phase2-app-db.mjs's step 1: lazyboy-app, APP_SCHEMA, the admin row;
//   3. the deployed runtime's first boot and tick: the sentinel, the copy of the planted row
//      into user_tokens with its log line, one refresh through the scripted Spotify;
//   5. `--verify` against the snapshot, verify-derived on the copy included; Rem still signed in
//      (his Phase 1 cookie through the identity read);
//   and the rollback: LB_TOKEN_ROLLBACK=1 writes the plaintext row back from the blob.
// Steps 2, 4 and 6 are credentials and a deletion a week later: nothing to rehearse locally.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newUid, type SessionClaims } from "@/lib/identity";
import { readIdentity } from "@/lib/identity-read";
import { createTokenCore } from "@/lib/token-core";
import { appTokenStore } from "@/lib/token-store-app";
import { withAdminTokenMove, type Plaintext } from "@/lib/token-move";
// @ts-expect-error -- a plain-Node script with no type declarations
import { main } from "../scripts/phase2-app-db.mjs";
import { play, rawClient } from "./adversarial/helpers";
import { ownerStore } from "./owner-store";
import { scriptedSpotify } from "./isolation/harness";

const REPO = path.resolve(__dirname, "..");
const REAL = process.env.T12_BACKUP;
const SYNTHETIC = { accessToken: "t12-synthetic-at", refreshToken: "t12-synthetic-rt", expiresAt: 1_000 };

const work = mkdtempSync(path.join(tmpdir(), "lazyboy-t12-"));
const COPY = path.join(work, "lazyboy.db");
const APP = path.join(work, "lazyboy-app.db");
const SNAP = path.join(work, "snapshot.json");
const report: string[] = [];
const logs: string[] = [];
let lb: Client;
let owner: string;

/** The backup to rehearse on: Rem's (T12_BACKUP) or a synthetic one written by db.ts itself. */
async function backupBytes(): Promise<Buffer> {
  if (REAL) return readFileSync(REAL);
  await ownerStore().recordPlays([
    play("t1", "2026-10-01T10:00:00.000Z", 200_000),
    play("t2", "2026-10-01T10:04:00.000Z", 180_000),
    play("t1", "2026-10-02T09:00:00.000Z", 200_000),
  ]);
  await ownerStore().recomputeAllTimeStats();
  const out = path.join(work, "synthetic-backup.db");
  await (await rawClient()).execute(`VACUUM INTO '${out}'`);
  return gzipSync(readFileSync(out));
}

/** Unpack into the working copy: gzip by its magic bytes, a SQLite file by its header, else a
 *  SQL dump loaded the way the backup job loads one. */
async function unpack(bytes: Buffer): Promise<void> {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  if (raw.subarray(0, 16).toString("latin1") === "SQLite format 3\0") {
    writeFileSync(COPY, raw);
  } else {
    const c = createClient({ url: `file:${COPY}` });
    await c.executeMultiple(raw.toString("utf8"));
    c.close();
  }
}

/** The admin's plaintext row in the copy's meta, under production's key, as db.ts stores it. */
const plaintext: Plaintext = {
  async read() {
    const r = await lb.execute("SELECT value FROM meta WHERE key = 'spotify_tokens'");
    return r.rows[0] ? JSON.parse(String(r.rows[0].value)) : null;
  },
  async write(t) {
    await lb.execute({
      sql: "INSERT INTO meta (key, value) VALUES ('spotify_tokens', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [JSON.stringify(t)],
    });
  },
  async clear() {
    await lb.execute("DELETE FROM meta WHERE key = 'spotify_tokens'");
  },
};

/** The script's world, local: the Platform API scripted, lazyboy = the copy, lazyboy-app = APP. */
const files: Record<string, string> = { "lazyboy-remtbkv.local": COPY, "lazyboy-app-remtbkv.local": APP };
const dbs: Record<string, { Hostname: string; group: string }> = {
  lazyboy: { Hostname: "lazyboy-remtbkv.local", group: "default" },
};
function scriptDeps() {
  return {
    platformToken: () => "t12-no-platform-token",
    fetch: async (url: string, init: RequestInit) => {
      const p = url.replace(/^.*\/organizations\/[^/]+/, "");
      const get = /^\/databases\/([^/?]+)$/.exec(p);
      if (init.method === "GET" && get) {
        const db = dbs[get[1]];
        return db ? Response.json({ database: { Name: get[1], ...db } }) : Response.json({}, { status: 404 });
      }
      if (init.method === "POST" && p === "/databases") {
        const { name, group } = JSON.parse(String(init.body));
        dbs[name] = { Hostname: `${name}-remtbkv.local`, group };
        return Response.json({ database: { Name: name, Hostname: dbs[name].Hostname } });
      }
      if (init.method === "POST" && /\/auth\/tokens\?/.test(p)) return Response.json({ jwt: "t12-local" });
      return Response.json({}, { status: 500 });
    },
    open: (url: string) => createClient({ url: `file:${files[url.replace("https://", "")]}`, intMode: "number" }),
    verifyDerived: (_url: string, _token: string, uid: string) => {
      try {
        execFileSync(process.execPath, [path.join(REPO, "scripts/verify-derived.mjs"), "--user", uid], {
          env: { ...process.env, TURSO_DATABASE_URL: `file:${COPY}`, TURSO_AUTH_TOKEN: "", OWNER_UID: uid },
          stdio: "pipe",
        });
        return true;
      } catch (e) {
        report.push(`verify-derived failed:\n${String((e as { stdout?: Buffer }).stdout ?? e)}`);
        return false;
      }
    },
    log: (s: string) => void report.push(s),
    now: () => Date.now(),
  };
}

const count = async (sql: string) => Number((await lb.execute(sql)).rows[0].n);

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void logs.push(a.join(" ")));
  await unpack(await backupBytes());
  copyFileSync(COPY, `${COPY}.pristine`);
  lb = createClient({ url: `file:${COPY}`, intMode: "number" });
});

afterAll(() => {
  lb?.close();
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const text = `T12 rehearsal on ${REAL ? REAL : "the synthetic backup"}, ${new Date().toISOString()}:\n${report.join("\n")}\n`;
  if (process.env.T12_REPORT) writeFileSync(process.env.T12_REPORT, text);
  console.info(text);
});

describe(`T12: §11.4 rehearsed on ${REAL ? "Rem's backup" : "a synthetic backup"}`, () => {
  it("0. the copy carries no token row; plant the synthetic one; snapshot", async () => {
    expect(await count("SELECT count(*) AS n FROM meta WHERE key LIKE 'spotify_tokens%'")).toBe(0);
    await plaintext.write(SYNTHETIC);
    const keys = new Set((await lb.execute("SELECT key FROM meta")).rows.map((r) => String(r.key)));
    if (keys.has("owner_uid")) {
      owner = String((await lb.execute("SELECT value FROM meta WHERE key = 'owner_uid'")).rows[0].value);
      report.push("Phase 1's meta keys: present in the backup");
    } else {
      owner = newUid();
      for (const [k, v] of [["owner_uid", owner], ["schema_version", "1"], ["min_reader", "1"], ["store_epoch", randomBytes(8).toString("hex")]]) {
        await lb.execute({ sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", args: [k, v] });
      }
      report.push("Phase 1's meta keys: absent (the backup predates Phase 1's deploy); planted, as lane 14 writes them");
    }
    expect(await main(["--snapshot-out", SNAP], scriptDeps(), { OWNER_UID: owner, SPOTIFY_OWNER_ID: "t12-owner" })).toBe(0);
  });

  it("1. step 1: lazyboy-app, APP_SCHEMA, the admin row with account_id NULL", async () => {
    expect(await main([], scriptDeps(), { OWNER_UID: owner, SPOTIFY_OWNER_ID: "t12-owner" })).toBe(0);
    const app = createClient({ url: `file:${APP}`, intMode: "number" });
    expect((await app.execute("SELECT uid, account_id, db_name, status, is_admin, session_epoch FROM users")).rows).toEqual([
      { uid: owner, account_id: null, db_name: "lazyboy", status: "active", is_admin: 1, session_epoch: 0 },
    ]);
    app.close();
  });

  it("3. the runtime's first boot and tick: sentinel, the copy and its log line, a refresh", async () => {
    vi.stubEnv("APP_DATABASE_URL", `file:${APP}`);
    vi.stubEnv("TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")}`);
    vi.stubEnv("SPOTIFY_CLIENT_ID", "cid");
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "cs");
    const spotify = scriptedSpotify();
    vi.stubGlobal("fetch", spotify.fetch);
    const core = createTokenCore(withAdminTokenMove(appTokenStore(), () => owner, plaintext));
    const t = await core.getValidAccessToken(owner as never);
    expect(t?.accessToken).toBe(`at:${SYNTHETIC.refreshToken}`);
    expect(logs).toContain(`[token-move] admin ${owner}: the blob written decrypts to the plaintext row`);
    expect(spotify.calls.map((c) => c.refreshToken)).toEqual([SYNTHETIC.refreshToken]);
    expect(await plaintext.read()).toEqual(SYNTHETIC);
    report.push("runtime: sentinel written, plaintext row copied and verified, one refresh stored encrypted");
  });

  it("5. step 5's checks against the snapshot, verify-derived on the copy included", async () => {
    report.push("--verify:");
    const code = await main(["--verify", "--snapshot", SNAP], scriptDeps(), { OWNER_UID: owner, SPOTIFY_OWNER_ID: "t12-owner" });
    const failed = report.filter((l) => l.startsWith("FAIL")).map((l) => l.replace(/  \(.*$/, "").slice(6));
    // A copy captures nothing, so its newest play cannot move; every other check must pass.
    expect(failed).toEqual(["max(played_at) moved past the snapshot"]);
    expect(code).toBe(1);
  });

  it("5. Rem stays signed in: his Phase 1 cookie through the identity read", async () => {
    const cookie: SessionClaims = { uid: owner, ep: 0, auth_time: Math.floor(Date.now() / 1000) - 60 };
    expect(await readIdentity(cookie)).toEqual({ kind: "allowed", uid: owner, admin: true });
  });

  it("the copy changed nothing in lazyboy but the planted rows", async () => {
    const before = createClient({ url: `file:${COPY}.pristine`, intMode: "number" });
    for (const t of ["tracks", "plays", "contexts", "playlists", "playlist_tracks", "saved_tracks"]) {
      const a = Number((await before.execute(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
      expect(await count(`SELECT count(*) AS n FROM ${t}`), t).toBe(a);
      report.push(`${t}: ${a}`);
    }
    before.close();
  });

  it("rollback: LB_TOKEN_ROLLBACK=1 writes the plaintext row back from the blob", async () => {
    await plaintext.write({ accessToken: "stale", refreshToken: "stale", expiresAt: 1 });
    vi.stubEnv("LB_TOKEN_ROLLBACK", "1");
    await withAdminTokenMove(appTokenStore(), () => owner, plaintext).get(owner as never);
    expect(await plaintext.read()).toMatchObject({ accessToken: `at:${SYNTHETIC.refreshToken}`, refreshToken: SYNTHETIC.refreshToken });
    report.push("rollback: the plaintext row written back from the blob");
  });
});
