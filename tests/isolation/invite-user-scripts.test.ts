// scripts/invite.mjs and scripts/user.mjs (PLAN.md §12.1-12.3; RULINGS Oct 15 12:46 PM) against a
// scripted Turso Platform API and local database files: no Keychain, no network. The app database
// is the same file the runtime's app-db.ts opens, so a request made by the form, approved by the
// script and claimed by a sign-in runs end to end.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJoinRequest } from "@/lib/app-db";
import { resolveSignIn } from "@/lib/identity-read";
import { joinTokenHash } from "@/lib/request-cookie";
import { appTokenStore } from "@/lib/token-store-app";
// @ts-expect-error -- plain-Node scripts with no type declarations
import { main as invite } from "../../scripts/invite.mjs";
// @ts-expect-error -- plain-Node scripts with no type declarations
import { main as user } from "../../scripts/user.mjs";
import { freshAppDb, seedUser } from "./harness";

const SECRET = "PLATFORM-SECRET-do-not-print";
const ADMIN = "aaaaaaaaaaaa";
let db: ReturnType<typeof freshAppDb>;
let dir: string;
let dbs: Record<string, { Hostname: string; group: string }>;
let calls: { method: string; path: string; auth: string | null }[];
let logs: string[];
let clock: number;
let failCreate: number;
let tele: Client;
const q = async (sql: string, args: Record<string, string | number | null> = {}) => (await db.raw().execute({ sql, args })).rows;
const fileFor = (host: string) => (host.startsWith("lazyboy-app-") ? db.url : `file:${path.join(dir, `${host}.db`)}`);

function deps(env: Record<string, string> = {}) {
  let n = 0;
  return {
    env: { TELEMETRY_DATABASE_URL: `file:${path.join(dir, "telemetry.db")}`, ...env },
    platformToken: () => SECRET,
    fetch: async (url: string, init: RequestInit) => {
      const p = url.replace("https://api.turso.tech/v1/organizations/remtbkv", "");
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init.method ?? "GET", path: p, auth: new Headers(init.headers).get("authorization") });
      const one = /^\/databases\/([^/?]+)$/.exec(p);
      if (init.method === "GET" && one) {
        const d = dbs[one[1]];
        return d ? Response.json({ database: { Name: one[1], ...d } }) : Response.json({ error: "not found" }, { status: 404 });
      }
      if (init.method === "DELETE" && one) {
        if (!dbs[one[1]]) return Response.json({ error: "not found" }, { status: 404 });
        rmSync(fileFor(dbs[one[1]].Hostname).slice(5), { force: true });
        delete dbs[one[1]];
        return Response.json({ database: one[1] });
      }
      if (init.method === "POST" && p === "/databases") {
        if (failCreate-- > 0) return Response.json({ error: "boom" }, { status: 500 });
        dbs[body.name] = { Hostname: `${body.name}-remtbkv.example`, group: body.group };
        return Response.json({ database: { Name: body.name, Hostname: dbs[body.name].Hostname } });
      }
      const tok = /^\/databases\/([^/]+)\/auth\/tokens\?expiration=1h&authorization=(full-access|read-only)$/.exec(p);
      if (init.method === "POST" && tok) return Response.json({ jwt: `jwt-${tok[1]}` });
      return Response.json({ error: "unscripted" }, { status: 500 });
    },
    open: (url: string) => createClient({ url: url.startsWith("file:") ? url : fileFor(url.replace("https://", "")), intMode: "number" }),
    log: (s: string) => void logs.push(s),
    now: () => clock,
    randomBytes: (k: number) => {
      n++;
      return Buffer.alloc(k, n * 7 + 1);
    },
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

const linkToken = () => /\/api\/join\/link\?t=([A-Za-z0-9_-]+)/.exec(logs.join("\n"))?.[1] ?? null;

beforeEach(async () => {
  db = freshAppDb();
  dir = mkdtempSync(path.join(tmpdir(), "lazyboy-scripts-"));
  dbs = { "lazyboy-app": { Hostname: "lazyboy-app-remtbkv.example", group: "default" } };
  calls = [];
  logs = [];
  clock = Date.now();
  failCreate = 0;
  vi.stubEnv("TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")}`);
  vi.stubEnv("SIGNUPS", "invite");
  vi.spyOn(console, "error").mockImplementation(() => {});
  await appTokenStore().get(ADMIN as never);
  await seedUser(db.raw(), { uid: ADMIN, status: "active", admin: true });
  tele = createClient({ url: `file:${path.join(dir, "telemetry.db")}` });
});
afterEach(() => {
  db.close();
  tele.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function request(email: string) {
  const r = await createJoinRequest({ email, name: "Sam", agreed: true, now: clock });
  if (!r.ok) throw new Error(r.reason);
  return r.id;
}

describe("invite.mjs", () => {
  it("--list refuses inside a Claude Code session; prints the open requests for Rem", async () => {
    const rid = await request("sam@example.com");
    expect(await invite(["--list"], deps({ CLAUDECODE: "1" }))).toBe(2);
    expect(logs.join("\n")).not.toContain("sam@example.com");
    expect(await invite(["--list"], deps())).toBe(0);
    expect(logs.join("\n")).toContain(`${rid}  pending  sam@example.com  "Sam"`);
  });

  it("--list and --approve print a stored request's control and format characters escaped, never raw", async () => {
    // Lane 09's review: a row stored before the form refused them, or written by hand.
    await q(
      "INSERT INTO requests (id, email, name, status, created_at, status_at, terms_version) VALUES ('rrrrrrrrrrrr', :e, :n, 'pending', :t, :t, 'v')",
      { e: "x\u001b]0;pwn\u0007@example.com", n: "Sam\u009b2J\u202e", t: clock },
    );
    expect(await invite(["--list"], deps())).toBe(0);
    expect(await invite(["--approve", "rrrrrrrrrrrr"], deps())).toBe(0);
    const out = logs.join("\n");
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
    expect(out).toContain("x\\u{1b}]0;pwn\\u{7}@example.com");
  });

  it("--approve provisions lb-u-<uid> at today's schema with its four keys, then the claim works end to end", async () => {
    const rid = await request("sam@example.com");
    expect(await invite(["--approve", rid], deps())).toBe(0);
    const [u] = await q("SELECT uid, status, spotify_id, db_name, account_id FROM users WHERE is_admin = 0");
    expect(u).toMatchObject({ status: "invited", spotify_id: `invite:${rid}`, account_id: null, db_name: `lb-u-${u.uid}` });
    expect(dbs[`lb-u-${u.uid}`]).toEqual({ Hostname: `lb-u-${u.uid}-remtbkv.example`, group: "default" });
    const friend = createClient({ url: fileFor(`lb-u-${u.uid}-remtbkv.example`) });
    const meta = Object.fromEntries((await friend.execute("SELECT key, value FROM meta")).rows.map((r) => [r.key, r.value]));
    expect(Object.keys(meta).sort()).toEqual(["min_reader", "owner_uid", "schema_version", "store_epoch"]);
    expect(meta.owner_uid).toBe(u.uid);
    expect((await friend.execute("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('tracks','plays','contexts','meta','playlists','playlist_tracks','saved_tracks')")).rows[0].n).toBe(7);
    friend.close();
    const [r] = await q("SELECT status, uid, join_hash FROM requests WHERE id = :r", { r: rid });
    const token = linkToken();
    expect(r).toEqual({ status: "approved", uid: u.uid, join_hash: joinTokenHash(token!) });
    expect(logs.join("\n")).toContain("sam@example.com");
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(calls.every((c) => c.auth === `Bearer ${SECRET}`)).toBe(true);

    const o = await resolveSignIn({ id: "sam-sp", account_id: "acct-sam" }, clock, rid);
    expect(o.kind === "allowed" && o.user.uid).toBe(u.uid);
  });

  it("refuses once five people hold places, and a request that is not open", async () => {
    for (const x of ["bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd", "eeeeeeeeeeee"]) await seedUser(db.raw(), { uid: x, status: "active" });
    await q("INSERT INTO requests (id, email, name, status, created_at, status_at, terms_version) VALUES ('rrrrrrrrrrrr', 'f@x.io', 'n', 'pending', 0, 0, 'v')");
    await expect(invite(["--approve", "rrrrrrrrrrrr"], deps())).rejects.toThrow(/5 places/);
    expect(await q("SELECT count(*) AS n FROM users")).toEqual([{ n: 5 }]);
    expect(Object.keys(dbs)).toEqual(["lazyboy-app"]);
    await expect(invite(["--approve", "mmmmmmmmmmmm"], deps())).rejects.toThrow(/no request/);
  });

  it("an approval racing another on the same request reserves nothing", async () => {
    const rid = await request("sam@example.com");
    // Another run's link landed first (its row not yet visible here).
    await q("UPDATE requests SET uid = 'qqqqqqqqqqqq' WHERE id = :r", { r: rid });
    await expect(invite(["--approve", rid], deps())).rejects.toThrow(/changed while approving/);
    expect(await q("SELECT count(*) AS n FROM users WHERE is_admin = 0")).toEqual([{ n: 0 }]);
    expect((await q("SELECT uid FROM requests WHERE id = :r", { r: rid }))[0].uid).toBe("qqqqqqqqqqqq");
  });

  it("a crash after the row is reserved leaves it provisioning; --approve resumes it, --revoke removes it", async () => {
    const rid = await request("sam@example.com");
    failCreate = 1;
    await expect(invite(["--approve", rid], deps())).rejects.toThrow(/create/);
    const [p] = await q("SELECT uid, status FROM users WHERE is_admin = 0");
    expect(p.status).toBe("provisioning");
    expect((await resolveSignIn({ id: "s", account_id: "acct-s" }, clock, rid)).kind).toBe("refused");
    expect(await invite(["--approve", rid], deps())).toBe(0);
    expect(await q("SELECT uid, status FROM users WHERE is_admin = 0")).toEqual([{ uid: p.uid, status: "invited" }]);

    expect(await invite(["--revoke", String(p.uid)], deps())).toBe(0);
    expect(await q("SELECT uid FROM users WHERE is_admin = 0")).toEqual([]);
    expect(await q("SELECT id FROM requests")).toEqual([]);
    expect(dbs[`lb-u-${p.uid}`]).toBeUndefined();
    expect(existsSync(fileFor(`lb-u-${p.uid}-remtbkv.example`).slice(5))).toBe(false);
  });

  it("--revoke refuses a claimed user and the admin; --decline deletes only a pending request", async () => {
    await seedUser(db.raw(), { uid: "bbbbbbbbbbbb", status: "active" });
    expect(await invite(["--revoke", "bbbbbbbbbbbb"], deps())).toBe(1);
    expect(await invite(["--revoke", ADMIN], deps())).toBe(1);
    const rid = await request("x@example.com");
    expect(await invite(["--decline", rid], deps())).toBe(0);
    expect(await q("SELECT id FROM requests")).toEqual([]);
  });
});

describe("user.mjs", () => {
  const lifecycle = async () => (await tele.execute("SELECT uid, action, by FROM lifecycle_log ORDER BY id")).rows.map((r) => `${r.action}:${r.uid}:${r.by}`);

  it("--disable ends sessions (epoch + 1), --enable restores, each one lifecycle line; never the admin", async () => {
    await seedUser(db.raw(), { uid: "bbbbbbbbbbbb", status: "active", epoch: 3 });
    expect(await user(["--disable", "bbbbbbbbbbbb"], deps())).toBe(0);
    expect((await q("SELECT status, session_epoch FROM users WHERE uid = 'bbbbbbbbbbbb'"))[0]).toEqual({ status: "disabled", session_epoch: 4 });
    expect(await user(["--enable", "bbbbbbbbbbbb"], deps())).toBe(0);
    expect((await q("SELECT status FROM users WHERE uid = 'bbbbbbbbbbbb'"))[0].status).toBe("active");
    await expect(user(["--disable", ADMIN], deps())).rejects.toThrow(/never the admin/);
    expect(await lifecycle()).toEqual(["disabled:bbbbbbbbbbbb:user.mjs", "enabled:bbbbbbbbbbbb:user.mjs"]);
  });

  it("refuses without the telemetry store, changing nothing", async () => {
    await seedUser(db.raw(), { uid: "bbbbbbbbbbbb", status: "active" });
    expect(await user(["--disable", "bbbbbbbbbbbb"], deps({ TELEMETRY_DATABASE_URL: "" }))).toBe(2);
    expect((await q("SELECT status FROM users WHERE uid = 'bbbbbbbbbbbb'"))[0].status).toBe("active");
  });

  it("--remove runs the deletion job from the Mac: database destroyed, rows gone, deleted after the window", async () => {
    const rid = await request("sam@example.com");
    await invite(["--approve", rid], deps());
    const o = await resolveSignIn({ id: "sam-sp", account_id: "acct-sam" }, clock, rid);
    const uid = o.kind === "allowed" ? o.user.uid : "";
    await appTokenStore().set(uid as never, { accessToken: "a", refreshToken: "r", expiresAt: 4_000_000_000 });
    expect(await user(["--remove", uid], deps())).toBe(0);
    expect((await q("SELECT status, db_name FROM users WHERE uid = :u", { u: uid }))[0]).toEqual({ status: "deleted", db_name: `deleted:${uid}` });
    expect(await q("SELECT count(*) AS n FROM user_tokens WHERE uid = :u", { u: uid })).toEqual([{ n: 0 }]);
    expect(await q("SELECT count(*) AS n FROM requests")).toEqual([{ n: 0 }]);
    expect(dbs[`lb-u-${uid}`]).toBeUndefined();
    expect(await lifecycle()).toEqual([`deleted:${uid}:user.mjs`]);
    expect(await user(["--remove", ADMIN], deps())).toBe(1);
  });
});
