#!/usr/bin/env node
// The two-user rehearsal (docs/multi-user/REHEARSAL.md; RULINGS Oct 15 9:27 PM, FASTPATH §2.4): the
// code that will deploy, as a production build, with an admin standing in for Rem and two friends,
// A and B, all synthetic, through the scripted stand-ins. Touches no Spotify, Turso, Vercel, Zenbook
// or anyone's data: every store is a throwaway file under the run directory, and the preload refuses
// every non-loopback connection.
//
//   node tests/rehearsal/run.mjs [--dir <run dir>] [--skip-build] [--only 1,3,...] [--port 3128]
//
// Exit 0 when every check selected passes. Evidence: <run dir>/evidence.json and results.md.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeBrowser, launchBrowser, newProfile, sessionCookie, signIn } from "./browser.mjs";
import { CHECKS } from "./checks.mjs";
import { cleanupSecrets, ctl, Jar, look, makeSecrets, quiet, REPO, req, runScript, startServer, stopServer, waitForRam, write } from "./lib.mjs";
import { PEOPLE } from "./personas.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const dir = path.resolve(opt("--dir", path.join(os.tmpdir(), `lazyboy-rehearsal-${Date.now()}`)));
const only = opt("--only", null)?.split(",").map((s) => s.trim());
const port = Number(opt("--port", 3128));
mkdirSync(dir, { recursive: true });

const H = {
  dir,
  port,
  servers: new Set(),
  browser: null,
  evidence: {},
  log: (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a),
};

// The simulated clock starts at the next 06:30 UTC, so a run's days look the same whenever it runs.
function startOffset() {
  const now = Date.now();
  const day = Math.floor(now / 86_400_000) + 1;
  return day * 86_400_000 + (6 * 60 + 30) * 60_000 - now;
}

H.start = async (name, o = {}) => {
  const srv = await startServer({ dir, name, port: o.port ?? port, offset: o.offset ?? H.offset ?? 0, plants: o.plants, env: { ...H.serverEnv, ...o.env }, project: o.project, stores: o.stores });
  H.servers.add(srv);
  H.log(`server ${name} up: pid ${srv.pid}, port ${srv.port}`);
  return srv;
};
H.stop = async (srv) => {
  await stopServer(srv);
  H.servers.delete(srv);
  H.log(`server ${srv.name} stopped: pid ${srv.pid}`);
};
/** Move the server's clock forward to `offset` (ms from the machine's). */
H.setClock = async (srv, offset) => {
  await ctl(srv, "/clock", { offsetMs: offset });
  H.offset = offset;
};
H.advance = async (srv, ms) => H.setClock(srv, (H.offset ?? 0) + ms);
H.simNow = () => Date.now() + (H.offset ?? 0);

/** One cron tick as the Zenbook sends it (CRON_SECRET); waits until the server is quiet again. */
H.tick = async (srv, o = {}) => {
  const secret = o.ext ? H.secrets.CRON_SECRET_EXT : H.secrets.CRON_SECRET;
  const r = await req(srv, "/api/cron/sync", { headers: { authorization: `Bearer ${secret}`, "user-agent": o.ext ? "cron-job.org" : "curl/8.5.0" } });
  await quiet(srv, o.quietMs ?? 150);
  return { status: r.status, body: JSON.parse(r.text || "{}") };
};
H.daily = async (srv) => {
  const r = await req(srv, "/api/cron/daily", { headers: { authorization: `Bearer ${H.secrets.CRON_SECRET}`, "user-agent": "vercel-cron/1.0" } });
  await quiet(srv, 300, 180_000);
  return { status: r.status, body: JSON.parse(r.text || "{}") };
};

H.files = (srv = H.P) => ({
  app: path.join(srv.stores, "lazyboy-app.db"),
  admin: path.join(srv.stores, "lazyboy.db"),
  tele: path.join(srv.stores, "telemetry.db"),
  user: (uid) => path.join(srv.stores, `lb-u-${uid}.db`),
});
H.uidOf = (tag) => H.people[tag]?.uid;
H.dbOf = (tag, srv = H.P) => (tag === "ADMIN" ? H.files(srv).admin : H.files(srv).user(H.uidOf(tag)));

/** A friend asks at /join, the admin approves with invite.mjs, the friend opens the join link
 *  and connects: the path a friend takes. Returns the profile, signed in. */
H.join = async (tag, { connect = true } = {}) => {
  const p = PEOPLE[tag];
  const profile = await newProfile(H.browser, H.P, H.blocked);
  const page = await profile.ctx.newPage();
  await page.goto("/join");
  await page.fill('input[name="email"]', p.email);
  await page.fill('input[name="name"]', p.displayName);
  await page.check('input[name="agree"]');
  await page.getByRole("button", { name: "Ask to join" }).click();
  await page.waitForSelector("text=Your request is in");
  const [r] = look(H.files().app, "SELECT id FROM requests WHERE email = ?", p.email);
  const out = runScript(dir, H.P.stores, "scripts/invite.mjs", ["--approve", String(r.id)], {
    LAZYBOY_ORIGIN: H.P.origin,
    TURSO_ORG: "rehearsal",
    REHEARSAL_CLOCK_OFFSET_MS: String(H.offset),
  });
  if (out.status !== 0) throw new Error(`invite.mjs --approve ${tag}: ${out.out}`);
  const link = out.out.match(/https?:\/\/\S+\/api\/join\/link\?t=[A-Za-z0-9_-]+/)?.[0];
  if (!link) throw new Error(`invite.mjs printed no link: ${out.out}`);
  const [u] = look(H.files().app, "SELECT uid FROM requests WHERE id = ?", r.id);
  H.people[tag] = { ...p, uid: String(u.uid), rid: String(r.id), link };
  await page.close();
  if (!connect) return profile;
  const second = await profile.ctx.newPage();
  await second.goto(link);
  await second.waitForSelector("text=Rem approved your request");
  await second.close();
  const home = await signIn(profile, tag, { fromJoin: true });
  await home.close();
  return profile;
};

/** A jar holding `profile`'s session cookie, for scripted requests as that person. */
H.jarOf = async (profile) => {
  const j = new Jar();
  j.set("authjs.session-token", await sessionCookie(profile));
  return j;
};

/** A store set as production holds it before any friend: the admin's database as Phase 1's
 *  deploy leaves Rem's (the user schema and the four keys), the telemetry store (empty; the app
 *  makes its tables), and the app database as Phase 2's step 1 leaves it, by the script itself,
 *  under the preload. */
H.provision = async (stores) => {
  mkdirSync(stores, { recursive: true });
  const { USER_SCHEMA_STATEMENTS, userMetaStatement } = await import("../../src/lib/user-schema.ts");
  const meta = userMetaStatement(H.secrets.OWNER_UID, randomBytes(16).toString("hex"));
  write(path.join(stores, "lazyboy.db"), [...USER_SCHEMA_STATEMENTS, { sql: meta.sql, args: meta.args }]);
  write(path.join(stores, "telemetry.db"), []);
  const p2 = runScript(dir, stores, "scripts/phase2-app-db.mjs", ["--org", "rehearsal"], {
    OWNER_UID: H.secrets.OWNER_UID,
    SPOTIFY_OWNER_ID: H.secrets.SPOTIFY_OWNER_ID,
    REHEARSAL_CLOCK_OFFSET_MS: String(H.offset),
  });
  if (p2.status !== 0) throw new Error(`phase2-app-db.mjs: ${p2.out}`);
  H.log(p2.out.trim().split("\n").join(" | "));
};

async function build() {
  if (argv.includes("--skip-build")) return;
  waitForRam(4);
  H.log("npm run build");
  const r = spawnSync("npm", ["run", "build"], { cwd: REPO, stdio: "inherit" });
  if (r.status !== 0) throw new Error("npm run build failed");
}

async function setup() {
  H.secrets = makeSecrets(dir);
  H.offset = startOffset();
  H.blocked = [];
  H.people = { ADMIN: { ...PEOPLE.ADMIN, uid: H.secrets.OWNER_UID } };
  H.serverEnv = {
    AUTH_SECRET: H.secrets.AUTH_SECRET,
    CRON_SECRET: H.secrets.CRON_SECRET,
    CRON_SECRET_EXT: H.secrets.CRON_SECRET_EXT,
    TOKEN_KEYS: H.secrets.TOKEN_KEYS,
    SPOTIFY_CLIENT_ID: H.secrets.SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET: H.secrets.SPOTIFY_CLIENT_SECRET,
    SPOTIFY_OWNER_ID: H.secrets.SPOTIFY_OWNER_ID,
    OWNER_UID: H.secrets.OWNER_UID,
    VERCEL_ENV: "production",
    SIGNUPS: "invite",
  };
  await H.provision(path.join(dir, "P", "stores"));
  H.P = await H.start("P");

  // The guard first, before anything else is trusted: a planted call to a real host from inside
  // the server, at fetch, socket, DNS and store level, each refused and recorded.
  const g = await ctl(H.P, "/plant-egress");
  H.evidence.guard = g;
  const ok = g.fetch === "REHEARSAL_EGRESS" && g.socket === "REHEARSAL_EGRESS" && g.dns === "REHEARSAL_EGRESS" && g.store === "REHEARSAL_STORE_REFUSED";
  H.log(`guard self-test: ${JSON.stringify(g)}`);
  if (!ok) throw new Error(`the egress guard let a planted call through: ${JSON.stringify(g)}`);

  H.browser = await launchBrowser();
  H.log(`browser up: pid ${H.browser.pid}`);
  H.profiles = {};
  H.profiles.ADMIN = await newProfile(H.browser, H.P, H.blocked);
  (await signIn(H.profiles.ADMIN, "ADMIN")).close();
  for (const tag of ["FRIENDA", "FRIENDB"]) H.profiles[tag] = await H.join(tag);
  const users = look(H.files().app, "SELECT uid, account_id, status, is_admin FROM users ORDER BY is_admin DESC, uid");
  H.evidence.users = users.map((u) => ({ ...u, tag: Object.keys(H.people).find((t) => H.people[t].uid === u.uid) }));
  H.log(`users: ${JSON.stringify(H.evidence.users)}`);
  // Warm up: ticks two minutes apart until every person's library is scanned and plays are in.
  for (let i = 0; i < 12; i++) {
    await H.advance(H.P, 120_000);
    await H.tick(H.P);
  }
  for (const t of ["ADMIN", "FRIENDA", "FRIENDB"]) {
    const n = look(H.dbOf(t), "SELECT (SELECT count(*) FROM plays) AS plays, (SELECT count(*) FROM playlists) AS playlists, (SELECT count(*) FROM saved_tracks) AS liked")[0];
    H.log(`${t}: ${JSON.stringify(n)}`);
  }
}

const results = [];
async function main() {
  await build();
  await setup();
  for (const c of CHECKS) {
    if (only && !only.includes(String(c.id))) continue;
    H.log(`── check ${c.id}: ${c.title}`);
    const t0 = Date.now();
    try {
      const ev = (H.evidence[`check${c.id}`] = {});
      await c.run(H, ev);
      results.push({ id: c.id, title: c.title, ok: true, ms: Date.now() - t0, evidence: ev });
      H.log(`check ${c.id} PASS`);
    } catch (e) {
      results.push({ id: c.id, title: c.title, ok: false, ms: Date.now() - t0, error: String(e?.stack ?? e), evidence: H.evidence[`check${c.id}`] });
      H.log(`check ${c.id} FAIL: ${e?.stack ?? e}`);
      if (argv.includes("--stop-on-fail")) break;
    }
  }
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  H.log(`setup failed: ${e?.stack ?? e}`);
  results.push({ id: "setup", ok: false, error: String(e?.stack ?? e) });
} finally {
  writeFileSync(path.join(dir, "evidence.json"), JSON.stringify({ evidence: H.evidence, results }, null, 2));
  for (const r of results) H.log(`${r.ok ? "PASS" : "FAIL"} ${r.id} ${r.title ?? ""}`);
  exitCode = results.length && results.every((r) => r.ok) ? 0 : 1;
  await closeBrowser(H.browser);
  for (const s of [...H.servers]) await H.stop(s);
  if (H.secrets) cleanupSecrets(H.secrets);
}
process.exit(exitCode);
