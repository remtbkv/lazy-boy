// The rehearsal's checks (docs/multi-user/REHEARSAL.md; FASTPATH §2.4's list as RULINGS Oct 15
// 9:27 PM names it, and Rem's Oct 16 1:19 AM daily cycle). Each returns its evidence or throws.
// Where the code allows a plant, the check is first run against one (an environment plant, so no
// rebuild: a stand-in that leaks, a restored store, a sign-out that keeps storage) and must fail
// there before its pass on the real path counts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hydrated } from "./browser.mjs";
import { actionIds, callAction, censusFor } from "./census.mjs";
import { callsTail, ctl, Jar, look, quiet, readCalls, REPO, req, shadow, sleep, write } from "./lib.mjs";
import { foreignPattern, PEOPLE } from "./personas.mjs";

const FRIENDS = ["FRIENDA", "FRIENDB"];
const other = (t) => (t === "FRIENDA" ? "FRIENDB" : "FRIENDA");

/** Every foreign string in `text` for `tag`: the other people's tagged ids and names, and their uids. */
export function foreign(H, tag, text) {
  const uids = Object.entries(H.people).filter(([t]) => t !== tag).map(([, p]) => p.uid);
  const re = new RegExp(foreignPattern(tag, uids).source, "gi");
  return [...new Set(String(text).match(re) ?? [])];
}
const own = (tag, text) => new RegExp(`${tag}(x|-only)`).test(text);

function shuffle(list, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const IDENTITY_READ = /SELECT u\.status, u\.session_epoch, u\.is_admin, u\.db_name/;
const TOKEN_READ = /SELECT blob, expires_at, granted_at FROM user_tokens WHERE uid/;

/** Statements the server ran while `fn` ran (it alone: the caller keeps the server otherwise idle). */
async function statementsOf(srv, fn) {
  await quiet(srv, 150);
  const { seq } = await ctl(srv, "/stmts?since=999999999999");
  const r = await fn();
  await quiet(srv, 150);
  const { stmts } = await ctl(srv, `/stmts?since=${seq}`);
  return { r, stmts };
}

const isRoute = (e) => /^(GET|POST) \/api\//.test(e.id);

// ── 1. cache() in route handlers ─────────────────────────────────────────────────────────────
async function check1(H, ev) {
  const P = H.P;
  const ids = actionIds(REPO);
  const jars = { FRIENDA: await H.jarOf(H.profiles.FRIENDA), FRIENDB: await H.jarOf(H.profiles.FRIENDB) };
  const state = { offset: () => H.offset };
  Object.assign(ev, { perRequest: {}, crossRequest: {}, concurrent: {}, plant: null });

  // (a) Identity and token reads per request, three requests in a row, for every route handler
  // (React cache() boxes in auth.ts: identityFor, the token box) and for /home as the RSC control.
  const entries = censusFor(P, ids, "FRIENDA", state).filter((e) => isRoute(e) || e.id === "GET /home");
  for (const e of entries) {
    ev.perRequest[e.id] = [];
    for (let i = 0; i < 3; i++) {
      const { r, stmts } = await statementsOf(P, () => e.run(jars.FRIENDA));
      ev.perRequest[e.id].push({ status: r.status, identity: stmts.filter((s) => IDENTITY_READ.test(s.sql)).length, token: stmts.filter((s) => TOKEN_READ.test(s.sql)).length });
    }
  }
  const routeCounts = Object.entries(ev.perRequest).filter(([k]) => k !== "GET /home");
  // No request reuses an earlier request's identity read: every request reads it at least once.
  for (const [k, v] of Object.entries(ev.perRequest)) for (const x of v) assert.ok(x.identity >= 1, `${k}: a request with no identity read (a cross-request memo): ${JSON.stringify(v)}`);
  ev.answer = {
    routeHandlers: routeCounts.every(([, v]) => v.every((x) => x.identity >= 2))
      ? "pass-through: each auth() call in a route handler reads the identity row twice (jwt and session callbacks), so cache() keeps no box there, in a request or across requests"
      : routeCounts.every(([, v]) => v.every((x) => x.identity === 1))
        ? "per request: one identity read per request in route handlers"
        : `mixed: ${JSON.stringify(routeCounts)}`,
    // /home runs auth() four times (the (app) layout's gate and its second call, the page's gate
    // and its second call: eight identityFor calls) plus readCapture's direct row read. Two reads
    // a request there means the box dedupes inside a page render.
    page: ev.perRequest["GET /home"].every((x) => x.identity === 2 && x.token === 1)
      ? "per request: /home's eight identityFor calls cost one read (plus readCapture's direct one), and its four token reads one"
      : `unexpected: ${JSON.stringify(ev.perRequest["GET /home"])}`,
  };

  // (b) The known answer that rules out a cross-request memo: A disabled between two requests with
  // the same cookie (same uid, epoch and auth_time, the box's arguments) is refused at once.
  const app = H.files().app;
  const uidA = H.uidOf("FRIENDA");
  // (now-playing answers a refused caller 200 {playing:null} by design, so it cannot tell here.)
  for (const e of entries.filter((x) => ["GET /api/search/library", "GET /api/search/history", "GET /home"].includes(x.id))) {
    const before = await e.run(jars.FRIENDA);
    write(app, [{ sql: "UPDATE users SET status = 'disabled' WHERE uid = ?", args: [uidA] }]);
    // A copy of the jar: the refusal's response clears the cookie, as it would in a browser.
  // (The page's refusal is a redirect to /login; the routes' a 401.)
    const during = await e.run(cloneJar(jars.FRIENDA));
    write(app, [{ sql: "UPDATE users SET status = 'active' WHERE uid = ?", args: [uidA] }]);
    const after = await e.run(jars.FRIENDA);
    ev.crossRequest[e.id] = [before.status, during.status === 200 && !/login/.test(during.location ?? "") ? `${during.status} SERVED` : `${during.status} ${during.location ?? ""}`.trim(), after.status];
    assert.equal(before.status, 200, `${e.id} before: ${before.status}`);
    assert.ok(!(during.status === 200), `${e.id}: served A while disabled (a memo across requests)`);
    assert.equal(after.status, 200, `${e.id} after re-enable: ${after.status}`);
  }

  // (c) A and B at once on every route handler that reads through the boxes, 20 rounds each.
  const routesA = censusFor(P, ids, "FRIENDA", state).filter(isRoute);
  const routesB = censusFor(P, ids, "FRIENDB", state).filter(isRoute);
  for (let i = 0; i < routesA.length; i++) {
    const hits = [];
    let ownSeen = { FRIENDA: false, FRIENDB: false };
    for (let k = 0; k < 20; k++) {
      const [ra, rb] = await Promise.all([routesA[i].run(jars.FRIENDA), routesB[i].run(jars.FRIENDB)]);
      for (const [tag, r] of [["FRIENDA", ra], ["FRIENDB", rb]]) {
        const f = foreign(H, tag, r.text + " " + (r.headers.get("etag") ?? ""));
        if (f.length) hits.push({ tag, status: r.status, foreign: f });
        if (own(tag, r.text)) ownSeen[tag] = true;
      }
    }
    ev.concurrent[routesA[i].id] = { rounds: 20, foreign: hits.length, ownSeen };
    assert.equal(hits.length, 0, `${routesA[i].id}: foreign data ${JSON.stringify(hits.slice(0, 3))}`);
  }
  for (const id of ["GET /api/search/library", "GET /api/search/history"]) {
    assert.ok(ev.concurrent[id].ownSeen.FRIENDA && ev.concurrent[id].ownSeen.FRIENDB, `${id}: no positive control`);
  }

  // (d) The detector fails first: a shadow server whose stand-in answers B's bearer with A's
  // library (01b A6's shape), its own cache and store copies; B's library sync, then B's payload.
  ev.plant = await leakPlant(H, jars);
  assert.ok(ev.plant.foreign.length > 0, "the leak plant was not detected");
}

function cloneJar(j) {
  const c = new Jar();
  for (const [k, v] of j.c) c.set(k, v);
  return c;
}

async function leakPlant(H, jars) {
  await quiet(H.P, 300);
  const sh = shadow(H.dir, "S-leak", H.P.stores);
  // Its clock 2 h on, past the library scan's freshness gate, so B's scan reaches the stand-in.
  const S = await H.start("S-leak", { port: H.port + 11, project: sh.project, stores: sh.stores, plants: ["leak-library"], offset: H.offset + 2 * 3_600_000 + 60_000 });
  try {
    const sync = await req(S, "/api/playlists/sync", { method: "POST", jar: cloneJar(jars.FRIENDB) });
    await quiet(S, 500, 120_000);
    const r = await req(S, "/api/search/library", { jar: cloneJar(jars.FRIENDB) });
    return { sync: sync.status, status: r.status, foreign: foreign(H, "FRIENDB", r.text).slice(0, 5) };
  } finally {
    await H.stop(S);
  }
}

// ── 3. One instance serving two users ────────────────────────────────────────────────────────
async function check3(H, ev) {
  const P = H.P;
  const ids = actionIds(REPO);
  const jars = { FRIENDA: await H.jarOf(H.profiles.FRIENDA), FRIENDB: await H.jarOf(H.profiles.FRIENDB) };
  const state = { offset: () => H.offset, task: {} };
  const reps = 6;
  const list = [];
  for (const tag of FRIENDS) {
    const c = censusFor(P, ids, tag, state);
    for (let r = 0; r < reps; r++) for (const e of c) list.push({ tag, e });
  }
  const shuffled = shuffle(list, 20261016);
  const perUser = { FRIENDA: 0, FRIENDB: 0 };
  const hits = [];
  const statuses = {};
  const ownSeen = {};
  const etags = { FRIENDA: new Set(), FRIENDB: new Set() };
  const samples = {};
  await pool(shuffled, 8, async ({ tag, e }) => {
    const r = await e.run(jars[tag]);
    perUser[tag]++;
    const key = `${e.id} ${tag}`;
    (statuses[key] ??= {})[r.status] = (statuses[key][r.status] ?? 0) + 1;
    if (e.id.startsWith("action") && !samples[key]) samples[key] = r.text.replace(/^0:.*\n/, "").slice(0, 240);
    const f = foreign(H, tag, `${r.text} ${r.headers.get("etag") ?? ""} ${r.location ?? ""}`);
    if (f.length) hits.push({ tag, id: e.id, status: r.status, foreign: f });
    if (own(tag, r.text)) ownSeen[e.id] = { ...(ownSeen[e.id] ?? {}), [tag]: true };
    const et = r.headers.get("etag");
    if (et) etags[tag].add(et);
    const task = r.text.match(/"taskId":"([0-9a-f-]{36})"/);
    if (task) state.task[tag] = task[1];
  });
  // ETags: each user's carry their own uid and never the other's; B sent A's gets B's body.
  const uid = { FRIENDA: H.uidOf("FRIENDA"), FRIENDB: H.uidOf("FRIENDB") };
  for (const tag of FRIENDS) {
    assert.ok(etags[tag].size > 0, `no ETag seen for ${tag}`);
    for (const et of etags[tag]) assert.ok(et.includes(uid[tag]) && !et.includes(uid[other(tag)]), `${tag}'s ETag ${et}`);
  }
  const aEtag = [...etags.FRIENDA].find((x) => x.includes('"lib-'));
  const cross = await req(P, "/api/search/library", { jar: jars.FRIENDB, headers: { "if-none-match": aEtag } });
  assert.equal(cross.status, 200, "B with A's ETag must get 200");
  assert.equal(foreign(H, "FRIENDB", cross.text).length, 0);
  // Storage names: the page names its user, and every per-user name is built from that uid.
  const homes = {};
  for (const tag of FRIENDS) {
    const r = await req(P, "/home", { jar: jars[tag] });
    homes[tag] = r.text.includes(uid[tag]) && !r.text.includes(uid[other(tag)]);
    assert.ok(homes[tag], `${tag}'s /home does not name ${tag}'s uid alone`);
  }
  // B with A's identifiers in the input (T3): A's task, A's playlist page and tracks route.
  const crossIds = {};
  const aTask = state.task.FRIENDA;
  const aPl = PEOPLE.FRIENDA.playlists[0].id;
  for (const [k, r] of [
    ["GET /api/tasks/<A's task>", aTask ? await req(P, `/api/tasks/${aTask}`, { jar: jars.FRIENDB }) : null],
    ["GET /playlists/<A's playlist>", await req(P, `/playlists/${aPl}`, { jar: jars.FRIENDB })],
    ["POST /api/playlists/<A's playlist>/tracks", await req(P, `/api/playlists/${aPl}/tracks`, { method: "POST", jar: jars.FRIENDB, body: "{}", headers: { "content-type": "application/json" } })],
  ]) {
    if (!r) continue;
    const f = foreign(H, "FRIENDB", r.text).filter((x) => x !== aPl);
    crossIds[k] = { status: r.status, foreign: f };
    assert.equal(f.length, 0, `${k}: A's data in B's answer ${JSON.stringify(f)}`);
  }
  assert.ok(aTask, "A started no task, so the task cross-check did not run");
  assert.equal(crossIds["GET /api/tasks/<A's task>"].status, 404, "B polling A's task must get 404");
  Object.assign(ev, {
    requests: perUser,
    foreignHits: hits.length,
    ownSeen: Object.keys(ownSeen).length,
    etags: Object.fromEntries(FRIENDS.map((t) => [t, [...etags[t]]])),
    crossEtag: cross.status,
    crossIds,
    storageNames: FRIENDS.map((t) => `lb-search@${uid[t]}, lb-days@${uid[t]}`),
    statuses,
    samples,
  });
  assert.ok(perUser.FRIENDA >= 200 && perUser.FRIENDB >= 200, `too few requests ${JSON.stringify(perUser)}`);
  assert.equal(hits.length, 0, `foreign data: ${JSON.stringify(hits.slice(0, 5))}`);
  for (const id of ["GET /api/search/library", "GET /api/search/history", "GET /home", "action dockDataAction", "action allTimePlaysAction"]) {
    assert.ok(ownSeen[id]?.FRIENDA && ownSeen[id]?.FRIENDB, `${id}: no positive control (own data never seen)`);
  }
}

// ── 2. The Data Cache across environments ────────────────────────────────────────────────────
const CACHE_DIR = (project = REPO) => path.join(project, ".next/cache/fetch-cache");
const cacheFiles = (project) => new Set(existsSync(CACHE_DIR(project)) ? readdirSync(CACHE_DIR(project)) : []);

/** A copy of `from` whose every track and playlist name says it is the other environment's
 *  (` PVQ`), with a new store_epoch per user database unless `sameEpoch` (a restore that kept the
 *  old one: the plant). */
function markedCopy(H, from, to, { sameEpoch = false } = {}) {
  mkdirSync(path.dirname(to), { recursive: true });
  const r = spawnSyncSafe("cp", ["-cR", from, to]);
  if (r) throw new Error(r);
  for (const f of readdirSync(to).filter((n) => n === "lazyboy.db" || /^lb-u-[a-z2-7]{12}\.db$/.test(n))) {
    write(path.join(to, f), [
      "UPDATE tracks SET name = name || ' PVQ'",
      "UPDATE playlists SET name = name || ' PVQ'",
      ...(sameEpoch ? [] : [{ sql: "UPDATE meta SET value = ? WHERE key = 'store_epoch'", args: [createHash("sha256").update(`${f}${Math.random()}`).digest("hex").slice(0, 32)] }]),
    ]);
  }
}

function fileEnv(stores) {
  return {
    VERCEL_ENV: undefined,
    APP_DATABASE_URL: `file:${path.join(stores, "lazyboy-app.db")}`,
    TURSO_DATABASE_URL: `file:${path.join(stores, "lazyboy.db")}`,
    STORE_URL_TEMPLATE: `file:${path.join(stores, "{db}.db")}`,
    TELEMETRY_DATABASE_URL: `file:${path.join(stores, "telemetry.db")}`,
  };
}

/** A, B and the admin against both servers at once, the search payloads, 10 rounds: the
 *  production server never serves a marked name, the other never an unmarked one. */
async function crossEnv(H, prod, other, jars) {
  const bad = [];
  let otherMarked = 0;
  for (let k = 0; k < 10; k++) {
    await Promise.all(
      Object.entries(jars).flatMap(([tag, jar]) =>
        ["/api/search/library", "/api/search/history"].flatMap((u) => [
          req(prod, u, { jar: cloneJar(jar) }).then((r) => {
            if (/ PVQ/.test(r.text)) bad.push({ server: prod.name, tag, u, why: "the other environment's entry" });
            if (foreign(H, tag, r.text).length) bad.push({ server: prod.name, tag, u, why: "foreign" });
          }),
          req(other, u, { jar: cloneJar(jar) }).then((r) => {
            if (r.status !== 200) bad.push({ server: other.name, tag, u, why: `status ${r.status}` });
            if (/-only-song-\d+"/.test(r.text)) bad.push({ server: other.name, tag, u, why: "production's entry" });
            if (/ PVQ/.test(r.text)) otherMarked++;
            if (foreign(H, tag, r.text).length) bad.push({ server: other.name, tag, u, why: "foreign" });
          }),
        ]),
      ),
    );
  }
  return { bad, otherMarked };
}

async function check2(H, ev) {
  const P = H.P;
  const jars = { ADMIN: await H.jarOf(H.profiles.ADMIN), FRIENDA: await H.jarOf(H.profiles.FRIENDA), FRIENDB: await H.jarOf(H.profiles.FRIENDB) };
  const ids = actionIds(REPO);
  // Warm P's entries for all three, so a collision would have something to serve.
  for (const jar of Object.values(jars)) for (const u of ["/api/search/library", "/api/search/history"]) await req(P, u, { jar });
  await quiet(P, 300);

  // (a) Preview as deployed: VERCEL_ENV=preview, its own AUTH_SECRET, its own stores, the same
  // build and cache directory. It refuses to open any store (appDatabaseUrl), so it can write no
  // user entry; the shared cache directory gains nothing while it serves every census entry,
  // the cron routes and the probe, and P serves the same answers after it.
  const qStores = path.join(H.dir, "Q", "stores");
  await H.provision(qStores);
  const Q = await H.start("Q", { port: H.port + 1, stores: qStores, env: { VERCEL_ENV: "preview", AUTH_SECRET: H.secrets.AUTH_SECRET_PREVIEW } });
  const before = cacheFiles();
  const qStatus = {};
  const qBad = [];
  try {
    for (const tag of ["ADMIN", "FRIENDA", "FRIENDB"]) {
      for (const e of censusFor(Q, ids, tag === "ADMIN" ? "FRIENDA" : tag, { offset: () => H.offset })) {
        const r = await e.run(cloneJar(jars[tag]));
        (qStatus[e.id] ??= new Set()).add(r.status);
        // The request's own playlist id comes back in a redirect's callbackUrl and as the route
        // param in the RSC tree; anything else tagged is data.
        const seen = decodeSafe(`${r.text} ${r.location ?? ""}`).replace(/FRIEND[AB]xpl\d/g, "");
        const m = seen.match(/.{0,40}(ADMIN|FRIEND[AB])(x|-only).{0,40}/);
        if (m) qBad.push({ tag, id: e.id, status: r.status, at: m[0] });
      }
    }
    for (const [u, m] of [["/api/cron/sync", "GET"], ["/api/cron/daily", "GET"], ["/api/cron/health", "GET"]]) {
      const r = await req(Q, u, { method: m, headers: { authorization: `Bearer ${H.secrets.CRON_SECRET}` } });
      qStatus[`${m} ${u} (CRON_SECRET)`] = new Set([r.status]);
      if (/(ADMIN|FRIEND[AB])(x|-only)/.test(r.text)) qBad.push({ id: u, status: r.status });
    }
    const probe = await req(Q, "/api/cron/probe", { method: "POST", headers: { authorization: `Bearer ${H.secrets.CRON_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ uid: H.uidOf("FRIENDB"), stamp: H.uidOf("FRIENDA") }) });
    qStatus["POST /api/cron/probe (forge)"] = new Set([probe.status]);
    await quiet(Q, 300);
  } finally {
    await H.stop(Q);
  }
  // What Preview wrote into the shared directory: only the probe's forged entry may appear (no
  // store read, a constant value, under a fresh nonce no read path ever asks for).
  const added = [...cacheFiles()].filter((f) => !before.has(f)).map((f) => JSON.parse(JSON.parse(readFileSync(path.join(CACHE_DIR(), f), "utf8")).data.body));
  ev.preview = { statuses: Object.fromEntries(Object.entries(qStatus).map(([k, v]) => [k, [...v]])), userData: qBad, cacheEntriesWritten: added };
  assert.equal(qBad.length, 0, `Preview served user data: ${JSON.stringify(qBad.slice(0, 3))}`);
  assert.ok(added.every((x) => JSON.stringify(x.v) === '{"probe":true}'), `Preview wrote a data entry: ${JSON.stringify(added).slice(0, 300)}`);
  for (const [tag, jar] of Object.entries(jars)) {
    const r = await req(P, "/api/search/library", { jar });
    assert.ok(r.status === 200 && own(tag, r.text) && !foreign(H, tag, r.text).length, `P after Preview, ${tag}`);
  }

  // (b) The detector fails first: a pair on a copy of the build and the stores, the other
  // environment's stores a restore that kept the store_epoch (same uids, same epochs, marked
  // names): the keys collide and one serves the other's entries.
  await quiet(P, 300);
  const sh = shadow(H.dir, "S-env", P.stores);
  const plantStores = path.join(H.dir, "S-env2", "stores");
  markedCopy(H, sh.stores, plantStores, { sameEpoch: true });
  const P2 = await H.start("S-env", { port: H.port + 12, project: sh.project, stores: sh.stores });
  const O2 = await H.start("S-env2", { port: H.port + 13, project: sh.project, stores: plantStores, env: fileEnv(plantStores) });
  try {
    ev.plant = await crossEnv(H, P2, O2, jars);
  } finally {
    await H.stop(O2);
    await H.stop(P2);
  }
  assert.ok(ev.plant.bad.length > 0, "the same-epoch plant was not detected");

  // (c) The real case: another environment's server given stores of its own (the misconfiguration
  // appDatabaseUrl refuses: VERCEL_ENV unset, file stores), same uids as P but its own store_epoch,
  // sharing P's build and cache directory, A, B and the admin on both at once.
  const q2Stores = path.join(H.dir, "Q2", "stores");
  markedCopy(H, P.stores, q2Stores);
  const Q2 = await H.start("Q2", { port: H.port + 2, stores: q2Stores, env: fileEnv(q2Stores) });
  try {
    ev.keyedApart = await crossEnv(H, P, Q2, jars);
  } finally {
    await H.stop(Q2);
  }
  assert.equal(ev.keyedApart.bad.length, 0, `entries crossed environments: ${JSON.stringify(ev.keyedApart.bad.slice(0, 4))}`);
  assert.ok(ev.keyedApart.otherMarked > 0, "the other environment never served its own (marked) data: no positive control");
}

// ── 4. Two token refreshes in one tick ─────────────────────────────────────────────────────
let crypto = null;
async function tokenOf(H, stores, uid) {
  crypto ??= await import("../../src/lib/token-crypto.ts");
  const row = look(path.join(stores, "lazyboy-app.db"), "SELECT blob, expires_at FROM user_tokens WHERE uid = ?", uid)[0];
  if (!row) return null;
  const keys = crypto.parseTokenKeys(H.secrets.TOKEN_KEYS);
  const t = crypto.decryptTokens(keys, uid, row.blob);
  let opensAsOther = false;
  for (const o of Object.values(H.people)) {
    if (!o.uid || o.uid === uid) continue;
    try {
      crypto.decryptTokens(keys, o.uid, row.blob);
      opensAsOther = true;
    } catch {
      /* bound to its own uid, as it must be */
    }
  }
  return { ...t, expiresAt: row.expires_at, opensAsOther };
}

/** One tick after every stored token has expired: the stand-in's record of it, api_log's rows. */
async function expiredTick(H, srv, server) {
  await H.advance(srv, 61 * 60_000);
  await ctl(srv, "/standin", { op: "expire", tags: ["ADMIN", "FRIENDA", "FRIENDB"] });
  await quiet(srv, 300);
  const c0 = readCalls(H.dir, server).length;
  const l0 = look(path.join(srv.stores, "telemetry.db"), "SELECT coalesce(max(id), 0) AS m FROM api_log")[0].m;
  const t = await H.tick(srv);
  await quiet(srv, 500);
  const calls = readCalls(H.dir, server).slice(c0);
  const log = look(path.join(srv.stores, "telemetry.db"), "SELECT path, status, user_id FROM api_log WHERE id > ? ORDER BY id", l0);
  return { tick: t, calls, log };
}

/** Per user: the Spotify data calls the stand-in saw by token owner, against api_log's rows by uid. */
function attribution(H, calls, log) {
  const byOwner = {};
  for (const c of calls.filter((c) => c.host === "api.spotify.com")) (byOwner[c.owner] ??= []).push(c.path);
  const byUid = {};
  for (const r of log) (byUid[r.user_id] ??= []).push(r.path);
  const out = {};
  for (const tag of ["ADMIN", "FRIENDA", "FRIENDB"]) {
    const a = (byOwner[tag] ?? []).sort();
    const b = (byUid[H.uidOf(tag)] ?? []).sort();
    out[tag] = { standin: a.length, apiLog: b.length, same: JSON.stringify(a) === JSON.stringify(b) };
  }
  return out;
}

async function check4(H, ev) {
  const P = H.P;
  const uid = Object.fromEntries(FRIENDS.map((t) => [t, H.uidOf(t)]));

  // (a) The detector fails first: a shadow server whose stand-in answers B's refresh with a token
  // minted for A. B's row then holds A's token; the check below reads it as such.
  await quiet(P, 300);
  const sh = shadow(H.dir, "S-swap", P.stores);
  const S = await H.start("S-swap", { port: H.port + 15, project: sh.project, stores: sh.stores, plants: ["swap-refresh"] });
  try {
    const savedOffset = H.offset;
    await expiredTick(H, S, "S-swap");
    H.offset = savedOffset;
    const b = await tokenOf(H, sh.stores, uid.FRIENDB);
    ev.plant = { bRowHolds: b?.accessToken.match(/^at-([A-Z]+)/)?.[1] };
  } finally {
    await H.stop(S);
  }
  assert.equal(ev.plant.bRowHolds, "FRIENDA", "the swapped refresh was not detected");

  // (b) Both friends' tokens expired (the app's rows and the stand-in), one tick with CRON_SECRET.
  const one = await expiredTick(H, P, "P");
  const refreshes = one.calls.filter((c) => c.grant === "refresh_token");
  ev.tick1 = { status: one.tick.status, steps: one.tick.body.steps?.map((s) => s.outcome), refreshes: refreshes.map((r) => ({ owner: r.owner, status: r.status ?? 200, issuedFor: r.issued?.match(/^at-([A-Z]+)/)?.[1] })) };
  for (const tag of FRIENDS) {
    const mine = refreshes.filter((r) => r.owner === tag);
    assert.equal(mine.length, 1, `${tag}: ${mine.length} refreshes in the tick`);
    assert.ok(mine[0].refreshToken.startsWith(`rt-${tag}-`), `${tag}'s refresh carried ${mine[0].refreshToken.slice(0, 12)}`);
    const t = await tokenOf(H, P.stores, uid[tag]);
    ev.tick1[tag] = { storedIsIssued: t.accessToken === mine[0].issued, opensAsOther: t.opensAsOther };
    assert.equal(t.accessToken, mine[0].issued, `${tag}'s stored token is not the one issued for ${tag}`);
    assert.equal(t.opensAsOther, false, `${tag}'s blob opens under another uid`);
    // Every data call after the refresh carries the token issued for that person.
    const after = one.calls.filter((c) => c.host === "api.spotify.com" && c.seq > mine[0].seq && c.owner === tag);
    assert.ok(after.length > 0, `${tag}: no data call after the refresh`);
    assert.ok(after.every((c) => c.bearer === mine[0].issued), `${tag}: a call after the refresh carried another token`);
  }
  assert.equal(one.calls.filter((c) => c.status === 401).length, 0, "a call carried an expired or unknown token");
  ev.tick1.attribution = attribution(H, one.calls, one.log);
  for (const tag of FRIENDS) assert.ok(ev.tick1.attribution[tag].same && ev.tick1.attribution[tag].apiLog > 0, `api_log for ${tag}: ${JSON.stringify(ev.tick1.attribution[tag])}`);

  // (c) B's refresh answers invalid_grant, A's succeeds: B stops (needs_reconnect, an event), A is
  // untouched (status, epoch, sync state; its own new token).
  const aRow = () => look(H.files().app, "SELECT status, session_epoch, account_id, db_name FROM users WHERE uid = ?", uid.FRIENDA)[0];
  const aBefore = aRow();
  await ctl(P, "/standin", { op: "deadRefresh", tag: "FRIENDB", dead: true });
  const e0 = events(H).length;
  const two = await expiredTick(H, P, "P");
  const r2 = two.calls.filter((c) => c.grant === "refresh_token");
  const aNow = await tokenOf(H, P.stores, uid.FRIENDA);
  const aIssued = r2.find((r) => r.owner === "FRIENDA")?.issued;
  const bStatus = look(H.files().app, "SELECT status FROM users WHERE uid = ?", uid.FRIENDB)[0].status;
  const aSync = look(H.files().app, "SELECT state, last_error, failures FROM sync_state WHERE uid = ?", uid.FRIENDA)[0];
  const newEvents = events(H).slice(e0).map((e) => [e.code, e.uid === uid.FRIENDB ? "B" : e.uid === uid.FRIENDA ? "A" : e.uid]);
  ev.tick2 = {
    refreshes: r2.map((r) => ({ owner: r.owner, status: r.status ?? 200 })),
    steps: two.tick.body.steps?.map((s) => s.outcome),
    aStoredIsIssued: aNow.accessToken === aIssued,
    aUsersRowUnchanged: JSON.stringify(aRow()) === JSON.stringify(aBefore),
    aSync,
    bStatus,
    events: newEvents,
    attribution: attribution(H, two.calls, two.log),
  };
  assert.deepEqual(r2.filter((r) => r.owner !== "ADMIN").map((r) => [r.owner, r.status ?? 200]).sort(), [["FRIENDA", 200], ["FRIENDB", 400]]);
  assert.ok(ev.tick2.aStoredIsIssued && ev.tick2.aUsersRowUnchanged, "A was touched");
  assert.equal(aSync.last_error, null);
  assert.equal(bStatus, "needs_reconnect");
  assert.ok(newEvents.some(([c, u]) => c === "invalid-grant" && u === "B") && !newEvents.some(([, u]) => u === "A"), `events ${JSON.stringify(newEvents)}`);
  assert.ok(ev.tick2.attribution.FRIENDA.same, "api_log for A");
  // B comes back the way a friend would: the app says the grant died (/reconnect, decision 20),
  // and B signs in again; Spotify's grant is new, so its refresh token lives.
  const visit = await H.profiles.FRIENDB.ctx.newPage();
  await visit.goto("/home");
  ev.bLandsOn = new URL(visit.url()).pathname;
  await visit.close();
  assert.equal(ev.bLandsOn, "/reconnect", "a dead grant must land on /reconnect");
  (await signInAgain(H, "FRIENDB")).close();
  ev.bAfterSignIn = look(H.files().app, "SELECT status FROM users WHERE uid = ?", uid.FRIENDB)[0].status;
  assert.equal(ev.bAfterSignIn, "active");
}

async function signInAgain(H, tag) {
  const { signIn } = await import("./browser.mjs");
  return signIn(H.profiles[tag], tag);
}

// ── 5. The shared device ───────────────────────────────────────────────────────────────────
/** Home as a person uses it: the page, the two search payloads stored in this browser
 *  (IndexedDB `lb-search@<uid>`), and a day opened from the strip. */
async function openHome(profile, tag, uid) {
  const page = await profile.ctx.newPage();
  await page.goto("/home");
  await storedPayloads(page, tag, uid);
  await page.locator("button[aria-pressed]").first().click();
  await page.getByText(new RegExp(`${tag}-only-song-\\d+`)).first().waitFor({ timeout: 30_000 });
  // The day's refresh can rewrite the stored payloads: wait until they are whole again.
  await storedPayloads(page, tag, uid);
  return page;
}

/** Both payloads stored: the person's own song names in the database's records, not just its keys.
 *  Polled from here: page.waitForFunction takes an async predicate's promise as truthy. */
async function storedPayloads(page, tag, uid) {
  const t0 = Date.now();
  for (;;) {
    const n = await page.evaluate(countStored, [`lb-search@${uid}`, `${tag}-only-song-\\d+`]);
    if (n >= 20) return n;
    if (Date.now() - t0 > 60_000) throw new Error(`${tag}'s Home stored ${n} song names in 60 s`);
    await sleep(300);
  }
}

/** In the page: how many of `mark`'s matches the records of IndexedDB database `name` hold. */
async function countStored([name, mark]) {
  const dbs = await indexedDB.databases();
  if (!dbs.some((d) => d.name === name)) return 0;
  return new Promise((res) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => {
      const db = r.result;
      const stores = [...db.objectStoreNames];
      if (!stores.length) return (db.close(), res(0));
      const tx = db.transaction(stores, "readonly");
      const all = [];
      for (const s of stores) tx.objectStore(s).getAll().onsuccess = (e) => all.push(...e.target.result);
      tx.oncomplete = () => {
        db.close();
        res((JSON.stringify(all).match(new RegExp(mark, "g")) ?? []).length);
      };
    };
    r.onerror = () => res(0);
  });
}

async function logOutIn(page) {
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.waitForURL((u) => u.pathname === "/signed-out", { timeout: 30_000 });
  return page.locator("main").innerText();
}

async function check5(H, ev) {
  const { newProfile, signIn, dumpProfile } = await import("./browser.mjs");
  const uid = { FRIENDA: H.uidOf("FRIENDA"), FRIENDB: H.uidOf("FRIENDB") };
  const scanFor = (tag, s) => foreign(H, tag, s).filter((x) => x !== uid[tag]);

  // (a) The detector fails first: A uses Home, and a copy of A's stored payloads sits under a name
  // the uid helper never built (the bug static check S6 exists for, which no clear knows to
  // remove); the profile is handed over (the cookie dropped) and B signs in and uses Home.
  const s0 = await newProfile(H.browser, H.P, H.blocked);
  try {
    (await signIn(s0, "FRIENDA")).close();
    const a = await openHome(s0, "FRIENDA", uid.FRIENDA);
    await a.evaluate(async ([name]) => {
      const db = await new Promise((res) => (indexedDB.open(name).onsuccess = (e) => res(e.target.result)));
      const all = await new Promise((res) => (db.transaction("payloads").objectStore("payloads").getAll().onsuccess = (e) => res(e.target.result)));
      db.close();
      localStorage.setItem("lb-recent", JSON.stringify(all).slice(0, 4000));
    }, [`lb-search@${uid.FRIENDA}`]);
    await a.close();
    await s0.ctx.clearCookies();
    (await signIn(s0, "FRIENDB")).close();
    const page = await openHome(s0, "FRIENDB", uid.FRIENDB);
    const dump = JSON.stringify(await dumpProfile(s0, page));
    ev.plant = { foreignInB: scanFor("FRIENDB", dump).slice(0, 5) };
    await page.close();
  } finally {
    await s0.ctx.close();
  }
  assert.ok(ev.plant.foreignInB.length > 0, "the plant (A's payload under an unkeyed name) left nothing the dump found");

  // (b) The real path: one profile; A uses Home, presses Log out, B signs in, then A again.
  const s = await newProfile(H.browser, H.P, H.blocked);
  try {
    (await signIn(s, "FRIENDA")).close();
    let page = await openHome(s, "FRIENDA", uid.FRIENDA);
    const before = JSON.stringify(await dumpProfile(s, page));
    ev.aBeforeLogOut = { aIdsStored: (before.match(/FRIENDA-only-song-\d+/g) ?? []).length, idb: before.includes(`lb-search@${uid.FRIENDA}`) };
    assert.ok(ev.aBeforeLogOut.aIdsStored > 0 && ev.aBeforeLogOut.idb, "A's Home stored nothing in the browser (no positive control)");
    ev.signedOutPage = await logOutIn(page);
    assert.match(ev.signedOutPage, /stopped recording/i, "the page after Log out must say capture stopped");
    assert.match(ev.signedOutPage, /sign in/i, "the page after Log out must say how to resume");
    ev.aTokenAfterLogOut = look(H.files().app, "SELECT count(*) AS n FROM user_tokens WHERE uid = ?", uid.FRIENDA)[0].n;
    assert.equal(ev.aTokenAfterLogOut, 0, "Log out left A's token row (capture not stopped)");
    await page.close();

    (await signIn(s, "FRIENDB")).close();
    page = await openHome(s, "FRIENDB", uid.FRIENDB);
    // The profile as B's Home left it (the positive control: B's own payloads stored), then again
    // after B's other pages.
    const dumpHome = JSON.stringify(await dumpProfile(s, page));
    const pagesB = [];
    for (const u of ["/home", "/playlists", `/playlists/${PEOPLE.FRIENDB.playlists[0].id}`]) {
      await page.goto(u);
      pagesB.push(await page.content());
    }
    const dumpB = JSON.stringify(await dumpProfile(s, page));
    const keysOf = (d) => Object.keys(JSON.parse(d).local).concat(Object.keys(JSON.parse(d).session), Object.keys(JSON.parse(d).idb));
    ev.bSees = {
      foreign: scanFor("FRIENDB", dumpHome + dumpB + pagesB.join(" ")),
      ownStored: (dumpHome.match(/FRIENDB-only-song-\d+/g) ?? []).length,
      keys: keysOf(dumpHome),
      keysAfterPages: keysOf(dumpB),
    };
    assert.deepEqual(ev.bSees.foreign, [], `B's profile holds A's data: ${ev.bSees.foreign.slice(0, 5)}`);
    assert.ok(ev.bSees.ownStored > 0, "B's Home stored nothing (no positive control)");
    await logOutIn(page);
    await page.close();

    (await signIn(s, "FRIENDA")).close();
    page = await openHome(s, "FRIENDA", uid.FRIENDA);
    const dumpA = JSON.stringify(await dumpProfile(s, page));
    ev.aSees = { foreign: scanFor("FRIENDA", dumpA + (await page.content())), keys: Object.keys(JSON.parse(dumpA).idb) };
    assert.deepEqual(ev.aSees.foreign, [], `A's profile holds B's data: ${ev.aSees.foreign.slice(0, 5)}`);
    await page.close();
  } finally {
    await s.ctx.close();
    // Log out ended every session of A and B, so their own profiles sign in again for what follows.
    for (const tag of FRIENDS) (await signIn(H.profiles[tag], tag)).close();
  }
}

// ── 6. The probe's e-mail ──────────────────────────────────────────────────────────────────
const cronHeaders = (secret, ua = "curl/8.5.0") => ({ authorization: `Bearer ${secret}`, "user-agent": ua, "content-type": "application/json" });
const events = (H) => look(H.files().app, "SELECT id, uid, code, alarmed FROM events ORDER BY id");

/** The library-index entries (24-hour lifetime) of `uid` in a cache directory, newest first. */
function libraryEntries(project, uid) {
  const dir = CACHE_DIR(project);
  return readdirSync(dir)
    .map((f) => {
      const raw = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      const body = JSON.parse(raw.data.body);
      return { f, raw, body, mtime: statSync(path.join(dir, f)).mtimeMs };
    })
    .filter((x) => x.body.o === uid && x.body.v && !Array.isArray(x.body.v) && "tracks" in x.body.v)
    .sort((a, b) => b.mtime - a.mtime);
}

/** Rewrite every library entry of `victim` to hold `donor`'s value, stamped `stamp`. */
function tamper(project, victim, donor, stamp) {
  const donorV = libraryEntries(project, donor)[0]?.body.v;
  assert.ok(donorV, "no library entry of the donor to copy");
  const saved = [];
  for (const e of libraryEntries(project, victim)) {
    saved.push({ f: e.f, text: readFileSync(path.join(CACHE_DIR(project), e.f), "utf8") });
    const raw = { ...e.raw, data: { ...e.raw.data, body: JSON.stringify({ o: stamp, v: donorV }) } };
    writeFileSync(path.join(CACHE_DIR(project), e.f), JSON.stringify(raw));
  }
  return saved;
}

async function check6(H, ev) {
  const uidA = H.uidOf("FRIENDA");
  const uidB = H.uidOf("FRIENDB");
  const jarB = await H.jarOf(H.profiles.FRIENDB);
  const probe = (secret, body) => req(H.P, "/api/cron/probe", { method: "POST", headers: secret ? cronHeaders(secret) : { "content-type": "application/json" }, body: JSON.stringify(body) });

  // (a) Who may open it: CRON_SECRET only.
  ev.refusals = {
    none: (await probe(null, { uid: uidB, stamp: uidA })).status,
    ext: (await probe(H.secrets.CRON_SECRET_EXT, { uid: uidB, stamp: uidA })).status,
  };
  assert.deepEqual(ev.refusals, { none: 401, ext: 401 });
  // (b) Forge under B's key stamped with A, then read it back: exactly one cache-stamp event for B.
  await quiet(H.P, 300);
  const before = events(H);
  const forged = await probe(H.secrets.CRON_SECRET, { uid: uidB, stamp: uidA });
  assert.equal(forged.status, 202, `forge: ${forged.status} ${forged.text}`);
  const { nonce } = JSON.parse(forged.text);
  await quiet(H.P, 300);
  const read = await probe(H.secrets.CRON_SECRET, { uid: uidB, nonce });
  await quiet(H.P, 300);
  const after = events(H);
  const added = after.filter((e) => !before.some((b) => b.id === e.id));
  ev.probe = { forge: forged.status, read: { status: read.status, body: JSON.parse(read.text) }, eventsAdded: added.map((e) => ({ code: e.code, uid: e.uid === uidB ? "B" : e.uid })) };
  assert.equal(read.status, 200);
  assert.deepEqual(JSON.parse(read.text), { ok: true, events: 1 });
  assert.deepEqual(added.map((e) => [e.code, e.uid]), [["cache-stamp", uidB]]);
  // (c) The hourly health check, as cron-job.org calls it (CRON_SECRET_EXT): non-200 naming
  // isolation, the red verdict recorded for lane 29 to read; the next hour reports it no more.
  const h1 = await req(H.P, "/api/cron/health", { headers: cronHeaders(H.secrets.CRON_SECRET_EXT, "cron-job.org") });
  const reds = look(H.files().app, "SELECT key, value FROM app_meta WHERE key LIKE 'health_red:%' ORDER BY key DESC LIMIT 1");
  const h2 = await req(H.P, "/api/cron/health", { headers: cronHeaders(H.secrets.CRON_SECRET_EXT, "cron-job.org") });
  ev.health = { first: { status: h1.status, body: JSON.parse(h1.text) }, recorded: reds[0], second: { status: h2.status, body: JSON.parse(h2.text) } };
  assert.notEqual(h1.status, 200);
  assert.ok(JSON.parse(h1.text).reasons.includes("isolation"), `health reasons ${h1.text}`);
  assert.ok(reds[0] && String(reds[0].value).includes("isolation"), `no health_red record with isolation: ${JSON.stringify(reds)}`);
  assert.ok(!(JSON.parse(h2.text).reasons ?? []).includes("isolation"), "the event was reported twice");
  assert.equal(look(H.files().app, "SELECT alarmed FROM events WHERE id = ?", added[0].id)[0].alarmed, 1);

  // (d) The same on a real read path: B's library-index entries rewritten to A's value. First the
  // plant, on a copy: stamped B (the stamp agrees with the key), B is served A's library, which
  // the detector sees. Then the real case on P: stamped A, B is served B's own library, uncached,
  // and one more cache-stamp event is recorded.
  await quiet(H.P, 300);
  await req(H.P, "/api/search/library", { jar: await H.jarOf(H.profiles.FRIENDA) });
  await req(H.P, "/api/search/library", { jar: jarB });
  await quiet(H.P, 300);
  const sh = shadow(H.dir, "S-stamp", H.P.stores);
  tamper(sh.project, uidB, uidA, uidB);
  const S = await H.start("S-stamp", { port: H.port + 14, project: sh.project, stores: sh.stores });
  try {
    const r = await req(S, "/api/search/library", { jar: cloneJar(jarB) });
    ev.plant = { status: r.status, foreign: foreign(H, "FRIENDB", r.text).slice(0, 4) };
  } finally {
    await H.stop(S);
  }
  assert.ok(ev.plant.foreign.length > 0, "the right-stamp plant was not detected");

  const opts = { port: H.port, stores: H.P.stores };
  await H.stop(H.P);
  const saved = tamper(REPO, uidB, uidA, uidA);
  H.P = await H.start("P", opts);
  const e0 = events(H);
  const s = await statementsOf(H.P, () => req(H.P, "/api/search/library", { jar: cloneJar(jarB) }));
  const e1 = events(H);
  const newEv = e1.filter((e) => !e0.some((b) => b.id === e.id));
  ev.realEntry = {
    tampered: saved.length,
    status: s.r.status,
    foreign: foreign(H, "FRIENDB", s.r.text).slice(0, 4),
    own: own("FRIENDB", s.r.text),
    storeReads: s.stmts.filter((x) => x.db === `lb-u-${uidB}`).length,
    events: newEv.map((e) => [e.code, e.uid === uidB ? "B" : e.uid]),
  };
  // Restore the entries, so later checks meet the cache as P left it.
  await H.stop(H.P);
  for (const x of saved) writeFileSync(path.join(CACHE_DIR(), x.f), x.text);
  H.P = await H.start("P", opts);
  assert.ok(saved.length > 0, "no library entry of B to tamper");
  assert.equal(s.r.status, 200);
  assert.deepEqual(ev.realEntry.foreign, []);
  assert.ok(ev.realEntry.own, "B was not served B's library");
  assert.ok(ev.realEntry.storeReads > 0, "B's library was not read from B's store (served from the cache?)");
  assert.deepEqual(ev.realEntry.events, [["cache-stamp", "B"]]);
}

// ── 7. Deletion reaching backups ───────────────────────────────────────────────────────────
/** Every row of every table, ordered: a logical dump (a file hash would be fooled by WAL). */
function dumpDb(file) {
  const out = {};
  for (const { name } of look(file, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    out[name] = look(file, `SELECT * FROM "${name}"`).map((r) => JSON.stringify(r)).sort();
  }
  return JSON.stringify(out);
}

/** What the app and telemetry stores hold of `uid`, by kind (counts; the uid is a synthetic friend's). */
function holdings(H, uid) {
  const app = H.files().app;
  const tele = H.files().tele;
  const n = (f, sql, ...a) => look(f, sql, ...a)[0].n;
  const hasTable = (f, t) => n(f, "SELECT count(*) AS n FROM sqlite_master WHERE name = ?", t) > 0;
  return {
    database: existsSync(H.files().user(uid)),
    users: look(app, "SELECT status, spotify_id, db_name, account_id IS NOT NULL AS hasAccount, session_epoch FROM users WHERE uid = ?", uid),
    tokens: n(app, "SELECT count(*) AS n FROM user_tokens WHERE uid = ?", uid),
    sync: n(app, "SELECT count(*) AS n FROM sync_state WHERE uid = ?", uid),
    locks: n(app, "SELECT count(*) AS n FROM app_meta WHERE key LIKE 'lock:%' AND key LIKE ?", `%${uid}%`),
    requests: n(app, "SELECT count(*) AS n FROM requests WHERE uid = ?", uid),
    appMetaKeys: look(app, "SELECT key FROM app_meta WHERE key LIKE ?", `%${uid}%`).map((r) => r.key.replace(uid, "<uid>")),
    telemetry: Object.fromEntries(
      ["api_log", "client_metrics", "cpu_meter"].map((t) => [t, hasTable(tele, t) ? n(tele, `SELECT count(*) AS n FROM ${t} WHERE user_id = ?`, uid) : 0]),
    ),
    lifecycle: hasTable(tele, "lifecycle_log") ? look(tele, "SELECT action, by FROM lifecycle_log WHERE uid = ?", uid) : [],
  };
}

async function check7(H, ev) {
  const uidA = H.uidOf("FRIENDA");
  const uidB = H.uidOf("FRIENDB");
  const aState = () => ({
    db: dumpDb(H.files().user(uidA)),
    app: JSON.stringify(look(H.files().app, "SELECT u.*, t.blob FROM users u LEFT JOIN user_tokens t ON t.uid = u.uid WHERE u.uid = ?", uidA)),
  });
  await quiet(H.P, 300);
  ev.before = holdings(H, uidB);
  const aBefore = aState();
  assert.ok(ev.before.database && ev.before.tokens && ev.before.telemetry.api_log > 0 && ev.before.telemetry.cpu_meter > 0, "B holds nothing to delete (no positive control)");

  // Disconnect as B presses it: a fresh sign-in first when the last is over ten minutes old (the
  // page's own button), the export offered and downloaded, the word typed.
  const page = await H.profiles.FRIENDB.ctx.newPage();
  const navs = [];
  ev.navigations = navs;
  page.on("framenavigated", (f) => f === page.mainFrame() && navs.push(`${new URL(f.url()).pathname} +${Date.now() % 100000}`));
  page.on("console", (m) => m.type() === "error" && navs.push(`console: ${m.text().slice(0, 120)}`));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/_next/") || u.pathname.startsWith("/api/now-playing")) return;
    const loc = r.headers().location;
    navs.push(`${r.request().method()} ${r.status()} ${u.pathname}${loc ? ` -> ${loc.slice(0, 90)}` : ""}${r.request().headers()["next-action"] ? " (action)" : ""}`);
    r.headerValues("set-cookie").then((v) => v.filter((c) => c.includes("callback-url")).forEach((c) => navs.push(`  set ${decodeURIComponent(c.slice(0, 120))}`)));
  });
  await page.goto("/disconnect");
  await hydrated(page, "Download my history");
  if (await page.getByRole("button", { name: "Sign in again" }).count()) {
    H.profiles.FRIENDB.who = "FRIENDB";
    await hydrated(page, "Sign in again");
    await page.getByRole("button", { name: "Sign in again" }).click();
    // On 127.0.0.1 Auth.js sees the callback as localhost and so sends it to the root, not back to
    // /disconnect (REHEARSAL.md: local only); the friend goes back to /disconnect.
    await page.waitForURL((u) => u.pathname !== "/disconnect", { timeout: 60_000 });
    ev.freshSignInLandedOn = new URL(page.url()).pathname;
    await page.goto("/disconnect");
    await page.getByRole("button", { name: "Disconnect and delete my data" }).waitFor({ timeout: 30_000 });
    ev.freshSignIn = true;
  }
  await hydrated(page, "Download my history");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download my history" }).click()]);
  const saved = path.join(H.dir, "export-FRIENDB.json");
  await download.saveAs(saved);
  const exported = readFileSync(saved, "utf8");
  ev.export = { bytes: exported.length, own: (exported.match(/FRIENDB-only-song-\d+/g) ?? []).length, foreign: foreign(H, "FRIENDB", exported).slice(0, 3) };
  assert.ok(ev.export.own > 0 && ev.export.foreign.length === 0, `the export: ${JSON.stringify(ev.export)}`);
  await page.fill('input[name="confirm"]', "disconnect");
  const t0 = Date.now();
  await hydrated(page, "Disconnect and delete my data");
  await page.getByRole("button", { name: "Disconnect and delete my data" }).click();
  await page.waitForURL((u) => u.pathname !== "/disconnect", { timeout: 60_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  ev.landedOn = new URL(page.url()).pathname;
  ev.landedText = (await page.locator("main").innerText().catch(() => "")).slice(0, 300);
  await page.close();
  // The job finishes after the lease window (52 s, in after()): wait for its last step, by the row.
  for (;;) {
    if (look(H.files().app, "SELECT status FROM users WHERE uid = ?", uidB)[0]?.status === "deleted") break;
    if (Date.now() - t0 > 180_000) throw new Error("B's deletion did not finish in 180 s");
    await sleep(1000);
  }
  await quiet(H.P, 300);
  ev.deletedAfterMs = Date.now() - t0;
  ev.after = holdings(H, uidB);

  // A second run is a no-op: the Mac's `user.mjs --remove` leaves everything of B's as the
  // first left it.
  const second = runScriptP(H, "scripts/user.mjs", ["--remove", uidB]);
  ev.secondRun = { userMjs: { status: second.status, out: second.out.trim().split("\n").slice(-2) } };
  ev.secondRun.unchanged = JSON.stringify(holdings(H, uidB)) === JSON.stringify(ev.after);
  // The request meter holds a minute of counts per instance, B's last requests (the Disconnect
  // among them) included; its next flush (a minute on, at any request) writes them after the job.
  // The next day's chores delete them again.
  await H.advance(H.P, 61_000);
  await req(H.P, "/api/now-playing", { jar: await H.jarOf(H.profiles.ADMIN) });
  await quiet(H.P, 300);
  ev.lateMeterRows = holdings(H, uidB).telemetry;
  const next9 = Math.floor((H.simNow() - 9 * HOUR) / DAY) * DAY + DAY + 9 * HOUR;
  await H.setClock(H.P, H.offset + (next9 - H.simNow()) + MIN);
  const daily = await H.daily(H.P);
  ev.nextDay = { deletions: daily.body.chores?.deletions, telemetry: holdings(H, uidB).telemetry };
  ev.aIntact = JSON.stringify(aState()) === JSON.stringify(aBefore);

  assert.equal(ev.landedOn, "/disconnected");
  assert.equal(ev.after.database, false, "B's database still exists");
  assert.deepEqual(ev.after.users.map((u) => [u.status, u.spotify_id, u.db_name]), [["deleted", "", `deleted:${uidB}`]]);
  assert.equal(ev.after.tokens + ev.after.sync + ev.after.locks + ev.after.requests, 0, `B's rows remain: ${JSON.stringify(ev.after)}`);
  assert.deepEqual(ev.after.telemetry, { api_log: 0, client_metrics: 0, cpu_meter: 0 }, `B's telemetry remains: ${JSON.stringify(ev.after.telemetry)}`);
  assert.equal(ev.after.lifecycle.length, 1, "one lifecycle line");
  assert.equal(second.status, 0, `user.mjs --remove: ${second.out}`);
  assert.ok(ev.secondRun.unchanged, `the second run changed B's holdings: ${JSON.stringify(holdings(H, uidB))}`);
  assert.deepEqual(ev.nextDay.telemetry, { api_log: 0, client_metrics: 0, cpu_meter: 0 }, `B's telemetry after the next day's chores: ${JSON.stringify(ev.nextDay)}`);
  assert.ok(ev.aIntact, "A's data or rows changed while B was deleted");

  // Backups: backup.py over copies of these stores, lane 19's fixtures, a planted copy of B's
  // database dated five days back. First with the OneDrive purge failing (the check must catch
  // the copy it left), then as on the Zenbook.
  const work = path.join(H.dir, "backup-7");
  const run = (extra = []) => {
    const r = spawnSync("python3", ["-I", path.join(REPO, "tests/rehearsal/backup_check.py"), "deletion", "--stores", H.P.stores, "--work", work, "--admin-uid", H.uidOf("ADMIN"), "--friend", uidA, "--deleted", uidB, ...extra], { encoding: "utf8", timeout: 600_000 });
    if (r.status !== 0) throw new Error(`backup_check.py: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const failing = run(["--fail", "purge"]);
  ev.backupPlant = { rc: failing.rc, plantedBGone: failing.plantedBGone, failCheck: failing.log.some((l) => l.includes("FAIL check")) };
  assert.ok(failing.rc !== 0 && failing.plantedBGone.includes(false) && ev.backupPlant.failCheck, `the failed purge was not caught: ${JSON.stringify(ev.backupPlant)}`);
  const b = run();
  ev.backup = { ...b, log: b.log.filter((l) => !/ ok (zenbook|backstop)/.test(l)) };
  const aDb = `lb-u-${uidA}`;
  assert.equal(b.rc, 0, `backup.py failed: ${b.log.join(" | ")} ${b.stderr}`);
  assert.deepEqual(b.plantedBGone, [true, true]);
  assert.ok(b.pruneBeforeDump, "the friends' prune did not run before the dumps");
  assert.deepEqual(b.dumped, ["lazyboy", "lazyboy-app"], `dumped ${b.dumped}`);
  assert.ok(!b.dumped.includes(aDb));
  const admin = H.uidOf("ADMIN");
  assert.deepEqual(b.app.users, [[admin, 1]]);
  assert.ok(b.app.user_tokens.every(([u]) => u === admin) && b.app.sync_state.every(([u]) => u === admin) && b.app.events.every(([u]) => u === admin) && b.app.requests === 0 && !b.app.friendBytes, `app copy ${JSON.stringify(b.app)}`);
  for (const [t, ids] of Object.entries(b.telemetry.userIds)) assert.ok(ids.every(([u]) => u === admin || u === null), `telemetry ${t}: ${JSON.stringify(ids)}`);
  assert.ok(!b.telemetry.friendBytes, "a friend's bytes in the telemetry copy");
  assert.deepEqual(b.filesNamingAFriend, []);
  assert.ok(b.adminOldUntouched, "the admin's older backups changed");
  ev.aIntactAfterBackup = JSON.stringify(aState()) === JSON.stringify(aBefore);
  assert.ok(ev.aIntactAfterBackup);
}

function runScriptP(H, script, args) {
  const r = spawnSync(process.execPath, [path.join(REPO, script), ...args], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_OPTIONS: `--import ${new URL("./preload.mjs", import.meta.url).href}`,
      REHEARSAL_DIR: H.dir,
      REHEARSAL_NAME: path.basename(script),
      REHEARSAL_SERVER: "scripts",
      REHEARSAL_STORES: H.P.stores,
      REHEARSAL_CLOCK_OFFSET_MS: String(H.offset),
      TURSO_ORG: "rehearsal",
      TELEMETRY_DATABASE_URL: "https://telemetry.rehearsal.invalid",
      TELEMETRY_AUTH_TOKEN: "rehearsal-telemetry-token",
    },
    encoding: "utf8",
    timeout: 180_000,
  });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

// ── 8. The freeze ──────────────────────────────────────────────────────────────────────────
/** Restart P with `env` over its usual environment: the local form of a redeploy. */
async function redeploy(H, env) {
  const opts = { port: H.port, stores: H.P.stores, env };
  await H.stop(H.P);
  H.P = await H.start("P", opts);
}

async function tickClaims(H) {
  await H.advance(H.P, 120_000);
  const c0 = readCalls(H.dir, "P").length;
  const t = await H.tick(H.P);
  const calls = readCalls(H.dir, "P").slice(c0).filter((c) => c.host === "api.spotify.com" || c.host === "accounts.spotify.com");
  const steps = (t.body.steps ?? []).map((s) => Object.entries(H.people).find(([, p]) => p.uid === s.uid)?.[0] ?? s.uid);
  return { status: t.status, steps, spotifyBy: [...new Set(calls.map((c) => c.owner))].sort() };
}

async function check8(H, ev) {
  const jar = { FRIENDA: await H.jarOf(H.profiles.FRIENDA), ADMIN: await H.jarOf(H.profiles.ADMIN) };
  const ask = async (tag) => (await req(H.P, "/api/search/library", { jar: cloneJar(jar[tag]) })).status;
  // Before: A is served and ticked (the check below fails here, as it must). A user who fell behind
  // rejoins at their own phase, 90-210 s after the tick that saw it (harvest-policy.ts nextDue), so
  // one 2-minute tick can miss A; the next one reaches it.
  ev.before = { A: await ask("FRIENDA"), admin: await ask("ADMIN"), tick: await tickClaims(H) };
  if (!ev.before.tick.steps.includes("FRIENDA")) ev.before.tick = await tickClaims(H);
  assert.equal(ev.before.A, 200);
  assert.ok(ev.before.tick.steps.includes("FRIENDA"), "A not claimed before the freeze");
  // The freeze: SIGNUPS=owner and one restart.
  await redeploy(H, { SIGNUPS: "owner" });
  const page = await H.profiles.FRIENDA.ctx.newPage();
  await page.goto("/home");
  ev.frozen = { A: await ask("FRIENDA"), admin: await ask("ADMIN"), aBrowserLandsOn: new URL(page.url()).pathname, tick: await tickClaims(H) };
  await page.close();
  assert.equal(ev.frozen.A, 401, "A served under SIGNUPS=owner");
  assert.equal(ev.frozen.admin, 200, "the admin refused under SIGNUPS=owner");
  assert.equal(ev.frozen.aBrowserLandsOn, "/login");
  assert.deepEqual(ev.frozen.tick.steps, ["ADMIN"], `the frozen tick claimed ${ev.frozen.tick.steps}`);
  assert.ok(!ev.frozen.tick.spotifyBy.some((t) => t !== "ADMIN"), `a friend's Spotify call in the frozen tick: ${ev.frozen.tick.spotifyBy}`);
  // Back to invite: the refusal kept A's cookie (the identity read refuses under SIGNUPS=owner
  // without ending the session), so A's browser is served again with no new sign-in, and ticked.
  await redeploy(H, { SIGNUPS: "invite" });
  const again = await H.profiles.FRIENDA.ctx.newPage();
  await again.goto("/home");
  jar.FRIENDA = await H.jarOf(H.profiles.FRIENDA);
  ev.after = { A: await ask("FRIENDA"), admin: await ask("ADMIN"), aBrowserLandsOn: new URL(again.url()).pathname, tick: await tickClaims(H) };
  await again.close();
  assert.equal(ev.after.A, 200);
  assert.equal(ev.after.aBrowserLandsOn, "/home");
  assert.ok(ev.after.tick.steps.includes("FRIENDA"), "A not claimed after the freeze");
}

// ── 9. The daily cycle on a fast-forwarded clock ──────────────────────────────────────────
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const utcDayOf = (t) => new Date(t).toISOString().slice(0, 10);
// brake.ts: the quota day turns at 14:51 UTC.
const QUOTA_ANCHOR = Date.UTC(2026, 0, 1, 14, 51);
const quotaDayOf = (t) => new Date(QUOTA_ANCHOR + Math.floor((t - QUOTA_ANCHOR) / DAY) * DAY).toISOString().slice(0, 10);
const RP_PATHS = new Set(["/me/player/recently-played", "/me"]);

async function check9(H, ev) {
  const P = H.P;
  const app = H.files().app;
  const tele = H.files().tele;
  // C connects (to be revoked on day 1.5 and deleted on its day 4); D asks, is approved, never
  // connects (its invite expires on day 14). Orphan rows for a uid no users row holds.
  H.profiles.FRIENDC = await H.join("FRIENDC");
  await H.join("FRIENDD", { connect: false });
  const tags = ["ADMIN", "FRIENDA", "FRIENDB", "FRIENDC"];
  const uid = Object.fromEntries([...tags, "FRIENDD"].map((t) => [t, H.uidOf(t)]));
  const tagOfUid = Object.fromEntries(Object.entries(uid).map(([t, u]) => [u, t]));
  const dInvitedAt = look(app, "SELECT invited_at FROM users WHERE uid = ?", uid.FRIENDD)[0].invited_at;
  const ghost = "ghostghost22";
  write(app, [
    { sql: "INSERT INTO user_tokens (uid, blob, expires_at, granted_at) VALUES (?, 'v1.ghost', 0, 0)", args: [ghost] },
    { sql: "INSERT INTO sync_state (uid, state, next_probe_at) VALUES (?, 'idle', 0)", args: [ghost] },
    { sql: "INSERT INTO app_meta (key, value) VALUES (?, '1')", args: [`lock:spotify_refresh:${ghost}`] },
  ]);
  const ghostRows = () =>
    look(app, "SELECT (SELECT count(*) FROM user_tokens WHERE uid = :g) + (SELECT count(*) FROM sync_state WHERE uid = :g) + (SELECT count(*) FROM app_meta WHERE key = 'lock:spotify_refresh:' || :g) AS n", { g: ghost })[0].n;
  const jars = { FRIENDA: await H.jarOf(H.profiles.FRIENDA), FRIENDB: await H.jarOf(H.profiles.FRIENDB) };
  const dailyAt = () => Number(look(app, "SELECT value FROM app_meta WHERE key = 'daily_at'")[0]?.value ?? 0);
  const statusOf = (t) => look(app, "SELECT status, status_at FROM users WHERE uid = ?", uid[t])[0] ?? null;
  const tail = callsTail(H.dir, "P");
  tail();
  const T9 = H.simNow();
  const l0 = look(tele, "SELECT coalesce(max(id), 0) AS m FROM api_log")[0].m;
  ev.start = new Date(T9).toISOString();

  const refreshes = [];
  const storedWrong = [];
  const rpCalls = { FRIENDA: [], FRIENDB: [] };
  const quotaWrong = [];
  const quotaTurns = { FRIENDA: [], FRIENDB: [] };
  const lastQuota = {};
  const dailyRuns = [];
  let lastDaily = dailyAt();
  const cprobe = {};
  let tickN = 0;

  const noteDaily = (via) => {
    const d = dailyAt();
    if (d !== lastDaily) {
      dailyRuns.push({ at: H.simNow(), stamp: d, day: utcDayOf(d), via });
      lastDaily = d;
    }
  };
  const settle = async () => {
    const calls = tail();
    const lastIssued = {};
    for (const c of calls) {
      if (c.grant === "refresh_token") {
        refreshes.push({ tag: c.owner, at: c.at, status: c.status ?? 200, issuedFor: c.issued?.match(/^at-([A-Z]+)/)?.[1] ?? null });
        if ((c.status ?? 200) === 200) lastIssued[c.owner] = c.issued;
      }
      if (c.host === "api.spotify.com" && RP_PATHS.has(c.path) && rpCalls[c.owner]) rpCalls[c.owner].push(c.at);
    }
    // Every refresh lands encrypted under its own uid: the row decrypts, with that uid as its
    // associated data, to the token the stand-in issued for that person.
    for (const [tag, issued] of Object.entries(lastIssued)) {
      if (!uid[tag]) continue;
      const t = await tokenOf(H, P.stores, uid[tag]);
      if (!t || t.accessToken !== issued || t.opensAsOther) storedWrong.push({ tag, at: H.simNow(), has: t?.accessToken?.match(/^at-([A-Z]+)/)?.[1] ?? null });
    }
    // The brake's counter: the day it names is the quota day of that user's last call, and its
    // count is the calls made in that quota day (from the first full one on).
    for (const tag of ["FRIENDA", "FRIENDB"]) {
      const row = look(app, "SELECT quota_day, rp_calls FROM sync_state WHERE uid = ?", uid[tag])[0];
      const calls = rpCalls[tag];
      if (!row?.quota_day || !calls.length) continue;
      const last = calls[calls.length - 1];
      const q = quotaDayOf(last);
      const firstFull = QUOTA_ANCHOR + (Math.floor((T9 - QUOTA_ANCHOR) / DAY) + 1) * DAY;
      const expected = calls.filter((x) => quotaDayOf(x) === q).length;
      if (row.quota_day !== q || (Date.parse(`${q}T14:51:00Z`) >= firstFull && row.rp_calls !== expected)) {
        quotaWrong.push({ tag, at: new Date(H.simNow()).toISOString(), row, expected: { quota_day: q, rp_calls: expected } });
      }
      if (lastQuota[tag] && lastQuota[tag] !== row.quota_day) quotaTurns[tag].push({ at: new Date(last).toISOString(), from: lastQuota[tag], to: row.quota_day, rp_calls: row.rp_calls });
      lastQuota[tag] = row.quota_day;
    }
  };

  /** One step: the clock `ms` on, Vercel's 09:00 UTC cron if it is crossed and wanted, then one
   *  tick (the Zenbook's and cron-job.org's in turn). */
  const step = async (ms, cron) => {
    const before = H.simNow();
    await H.advance(P, ms);
    const now = H.simNow();
    if (Math.floor((before - 9 * HOUR) / DAY) !== Math.floor((now - 9 * HOUR) / DAY) && cron(now)) {
      const r = await H.daily(P);
      noteDaily("route");
      if (r.status !== 200) dailyRuns.push({ at: now, via: "route", failed: r.status });
    }
    const stale = now - lastDaily > 26 * HOUR;
    await H.tick(P, { ext: tickN++ % 2 === 1 });
    if (stale) {
      // The tick started the chores in after(): wait for their stamp.
      const t0 = Date.now();
      while (dailyAt() === lastDaily && Date.now() - t0 < 180_000) await sleep(250);
      await quiet(P, 300, 180_000);
    }
    noteDaily("tick");
    await settle();
  };

  /** A and B use the app: their own requests, metered and logged, every half hour in a window. */
  const activity = async () => {
    for (const tag of ["FRIENDA", "FRIENDB"]) {
      await req(P, "/api/now-playing", { jar: jars[tag] });
      await req(P, "/api/search/history", { jar: jars[tag] });
    }
    await quiet(P, 150);
  };

  /** The cache probe: A's and B's cached reads requested, then every entry of theirs on disk. */
  const probeCache = async (label) => {
    for (const tag of ["FRIENDA", "FRIENDB"]) {
      await req(P, "/api/search/library", { jar: jars[tag] });
      await req(P, "/api/search/history", { jar: jars[tag] });
      await callAction(P, ACTIONS(), "allTimePlaysAction", [], jars[tag]);
      await callAction(P, ACTIONS(), "dockDataAction", [], jars[tag]);
    }
    await quiet(P, 500);
    const dir = CACHE_DIR();
    const out = {};
    for (const f of readdirSync(dir)) {
      const raw = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      const body = JSON.parse(raw.data.body);
      const tag = tagOfUid[body.o];
      if (tag !== "FRIENDA" && tag !== "FRIENDB") continue;
      const v = body.v;
      const kind = Array.isArray(v) ? "list" : v && "playlists" in v ? "library" : v && "plays" in v ? "history" : typeof v;
      out[f] = { tag, revalidate: raw.revalidate, mtime: statSync(path.join(dir, f)).mtimeMs, kind, foreign: foreign(H, tag, raw.data.body).length };
    }
    cprobe[label] = out;
  };

  // ── Days 0-2: a tick every two minutes. Vercel's cron at 09:00, skipped on the first 09:00 so a
  // tick finds daily_at stale and runs the chores itself. C's grant revoked at day 1.5. The cache
  // probe at the first 02:00 UTC, an hour after it, and a day after it.
  const firstNine = Math.floor((T9 - 9 * HOUR) / DAY) * DAY + DAY + 9 * HOUR;
  const skipDay = utcDayOf(firstNine);
  const probeAt = Math.floor((T9 - 2 * HOUR) / DAY) * DAY + DAY + 2 * HOUR;
  const probes = [
    [probeAt, "t0"],
    [probeAt + 61 * MIN, "t0+61m"],
    [probeAt + DAY + MIN, "t0+24h1m"],
  ];
  let cKilled = false;
  const fineEnd = T9 + 2 * DAY + HOUR;
  while (H.simNow() < fineEnd) {
    await step(2 * MIN, (t) => utcDayOf(t) !== skipDay);
    const now = H.simNow();
    if (!cKilled && now >= T9 + 36 * HOUR) {
      await ctl(P, "/standin", { op: "deadRefresh", tag: "FRIENDC", dead: true });
      cKilled = true;
      ev.cKilledAt = new Date(now).toISOString();
    }
    while (probes.length && now >= probes[0][0]) await probeCache(probes.shift()[1]);
    if (Math.floor(now / (30 * MIN)) !== Math.floor((now - 2 * MIN) / (30 * MIN))) await activity();
  }
  ev.fine = { ticks: tickN, end: new Date(H.simNow()).toISOString() };

  // A duplicate delivery of Vercel's cron (the route called twice in a row at 09:00): the chores
  // must not run a second time that day.
  const dup = { before: dailyAt() };
  // ── Days 2-14.6: an hour a step, a tick each, Vercel's cron every 09:00; C and D followed. ──
  const cSeen = [];
  const dSeen = [];
  let dupDone = false;
  const coarseEnd = T9 + 14 * DAY + 14 * HOUR;
  while (H.simNow() < coarseEnd) {
    const runsBefore = dailyRuns.length;
    await step(HOUR, () => true);
    if (dailyRuns.length > runsBefore && dailyRuns[dailyRuns.length - 1].via === "route") {
      if (!dupDone && H.simNow() > T9 + 3 * DAY) {
        const again = await H.daily(P);
        noteDaily("route (duplicate)");
        dupDone = true;
        Object.assign(dup, { at: new Date(H.simNow()).toISOString(), status: again.status, ranAgain: dailyRuns[dailyRuns.length - 1].via === "route (duplicate)" });
      }
      cSeen.push({ at: H.simNow(), status: statusOf("FRIENDC")?.status ?? "gone" });
      dSeen.push({ at: H.simNow(), status: statusOf("FRIENDD")?.status ?? "gone", db: existsSync(H.files().user(uid.FRIENDD)) });
    }
    if (H.simNow() % DAY < HOUR) await activity();
  }
  ev.coarse = { end: new Date(H.simNow()).toISOString(), ticks: tickN };

  // ── The known answers ──
  // Refreshes: per user per full day from T9, 24 or more, every one issued for that user.
  ev.refreshPerDay = {};
  for (const tag of ["ADMIN", "FRIENDA", "FRIENDB"]) {
    ev.refreshPerDay[tag] = [0, 1].map((k) => refreshes.filter((r) => r.tag === tag && r.status === 200 && r.at >= T9 + k * DAY && r.at < T9 + (k + 1) * DAY).length);
  }
  ev.refreshCrossed = refreshes.filter((r) => r.status === 200 && r.issuedFor !== r.tag);
  ev.storedWrong = storedWrong.slice(0, 5);
  // api_log attributes every Spotify call of the window to the uid whose token made it.
  const calls = readCalls(H.dir, "P").filter((c) => c.host === "api.spotify.com" && c.at >= T9);
  const log = look(tele, "SELECT path, user_id FROM api_log WHERE id > ?", l0);
  ev.attribution = Object.fromEntries(
    ["ADMIN", "FRIENDA", "FRIENDB", "FRIENDC"].map((tag) => {
      const a = calls.filter((c) => c.owner === tag).map((c) => c.path).sort();
      const b = log.filter((r) => r.user_id === uid[tag]).map((r) => r.path).sort();
      return [tag, { standin: a.length, apiLog: b.length, same: JSON.stringify(a) === JSON.stringify(b) }];
    }),
  );
  ev.quota = { turns: quotaTurns, wrong: quotaWrong.slice(0, 5) };
  ev.dailyRuns = dailyRuns.map((r) => ({ day: r.day, via: r.via, at: new Date(r.at).toISOString() }));
  ev.duplicate = dup;
  const perDay = {};
  for (const r of dailyRuns.filter((r) => !r.failed)) perDay[r.day] = (perDay[r.day] ?? 0) + 1;
  ev.dailyPerDay = perDay;
  // The 4a chores: the orphans gone at the first run; C deleted at the first run three days after
  // its first failure, not before; D's invite withdrawn at the first run 14 days after it, not before.
  ev.ghostAfter = ghostRows();
  const cRow = look(app, "SELECT status, status_at FROM users WHERE uid = ?", uid.FRIENDC)[0];
  const cRevokedSeen = cSeen.find((x) => x.status === "revoked");
  const events = look(app, "SELECT code, uid, at FROM events WHERE uid = ? ORDER BY id", uid.FRIENDC);
  const firstFail = events.find((e) => e.code === "invalid-grant")?.at ?? null;
  ev.c = { firstFailure: firstFail && new Date(firstFail).toISOString(), seenAtRuns: cSeen.map((x) => `${new Date(x.at).toISOString().slice(0, 16)} ${x.status}`), now: cRow?.status ?? "gone", events: events.map((e) => e.code), dbGone: !existsSync(H.files().user(uid.FRIENDC)) };
  ev.d = { invitedAt: new Date(dInvitedAt).toISOString(), seenAtRuns: dSeen.map((x) => `${new Date(x.at).toISOString().slice(0, 16)} ${x.status}${x.db ? "" : " (db gone)"}`) };
  // The budget record: one write per day, no uid in it, both friends in the meter's counts.
  const budget = look(tele, "SELECT day, count(*) AS dims, count(DISTINCT at) AS writes FROM budget_days GROUP BY day ORDER BY day");
  const meter = look(tele, "SELECT day, user_id FROM cpu_meter WHERE user_id IN (?, ?) GROUP BY day, user_id ORDER BY day", uid.FRIENDA, uid.FRIENDB);
  const budgetCols = look(tele, "SELECT name FROM pragma_table_info('budget_days')").map((r) => r.name);
  ev.budget = { days: budget, columns: budgetCols, meterDaysWithBoth: [...new Set(meter.map((m) => m.day))].filter((d) => meter.filter((m) => m.day === d).length === 2).length };
  ev.cache = summarizeCache(cprobe);

  // Backups: backup.py with its clock two days on prunes by age as on the Zenbook (and with the
  // clock where it is, the same copies are kept: the failing half).
  const work = path.join(H.dir, "backup-9");
  const bc = (days, sub) => {
    const r = spawnSync("python3", ["-I", path.join(REPO, "tests/rehearsal/backup_check.py"), "clock", "--stores", P.stores, "--work", path.join(work, sub), "--admin-uid", uid.ADMIN, "--days", String(days)], { encoding: "utf8", timeout: 600_000 });
    if (r.status !== 0) throw new Error(`backup_check.py clock: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  ev.backupNow = bc(0, "now");
  ev.backupTwoDaysOn = bc(2, "plus2");

  // Assertions last, so the evidence above is whole when one fails.
  for (const tag of ["FRIENDA", "FRIENDB"]) assert.ok(ev.refreshPerDay[tag].every((n) => n >= 24), `${tag} refreshes per day ${ev.refreshPerDay[tag]}`);
  assert.deepEqual(ev.refreshCrossed, []);
  assert.deepEqual(storedWrong, [], `stored tokens not the issued ones: ${JSON.stringify(storedWrong.slice(0, 3))}`);
  for (const tag of ["FRIENDA", "FRIENDB"]) assert.ok(ev.attribution[tag].same && ev.attribution[tag].apiLog > 0, `api_log for ${tag}: ${JSON.stringify(ev.attribution[tag])}`);
  assert.deepEqual(quotaWrong, [], `quota counters: ${JSON.stringify(quotaWrong.slice(0, 3))}`);
  for (const tag of ["FRIENDA", "FRIENDB"]) {
    assert.ok(quotaTurns[tag].length >= 2, `${tag}'s quota day turned ${quotaTurns[tag].length} times in two days`);
    for (const q of quotaTurns[tag]) assert.ok(Date.parse(q.at) >= Date.parse(`${q.to}T14:51:00Z`) && q.rp_calls <= 3, `quota turn ${JSON.stringify(q)}`);
  }
  assert.ok(dailyRuns.some((r) => r.via === "tick"), "no tick ran the chores when daily_at was stale");
  assert.ok(Object.values(perDay).every((n) => n === 1), `chores per day: ${JSON.stringify(perDay)}`);
  assert.ok(!dup.ranAgain, "a duplicate delivery of the daily cron ran the chores again");
  assert.equal(ev.ghostAfter, 0, "the orphan sweep left rows");
  assert.ok(firstFail, "C's grant never failed");
  assert.ok(cRevokedSeen, "C was never seen revoked");
  for (const x of cSeen) {
    const due = x.at - firstFail >= 3 * DAY;
    assert.ok(due ? ["deleted", "gone"].includes(x.status) : x.status !== "deleted", `C at ${new Date(x.at).toISOString()}: ${x.status} (due ${due})`);
  }
  assert.ok(ev.c.dbGone, "C's database survived its deletion");
  for (const x of dSeen) {
    const due = x.at - dInvitedAt >= 14 * DAY;
    assert.ok(due ? x.status === "gone" && !x.db : x.status === "invited", `D at ${new Date(x.at).toISOString()}: ${x.status} (due ${due})`);
  }
  assert.ok(dSeen.some((x) => x.at - dInvitedAt < 14 * DAY && x.at - dInvitedAt >= 13 * DAY), "no daily run on D's day 13");
  assert.ok(budget.every((b) => b.writes === 1), `budget record written more than once a day: ${JSON.stringify(budget)}`);
  assert.ok(!budgetCols.some((c) => /uid|user/.test(c)), "the budget record names a user");
  assert.ok(ev.budget.meterDaysWithBoth >= 2, "the meter did not count both friends on two days");
  assert.ok(ev.cache.ok, `cache lifetimes: ${JSON.stringify(ev.cache)}`);
  assert.deepEqual(ev.backupNow.kept, { local13: true, local11: true, remote59: true, remote57: true });
  assert.deepEqual(ev.backupTwoDaysOn.kept, { local13: false, local11: true, remote59: false, remote57: true });
}

let actionIdsCache = null;
const ACTIONS = () => (actionIdsCache ??= actionIds(REPO));

/** t0: every A/B entry; an hour on, the hour-long ones requested again are rewritten and the
 *  day-long library ones are not; a day on, the library ones are rewritten. The day-long history
 *  index is keyed on its content version, so plays supersede its key before the day is out (a
 *  new entry, never the old one re-served). Every entry, then and later, stamped with its own
 *  uid and holding nothing foreign. */
function summarizeCache(p) {
  const t0 = p["t0"] ?? {};
  const h1 = p["t0+61m"] ?? {};
  const d1 = p["t0+24h1m"] ?? {};
  const rewritten = (a, b, f) => b[f] && a[f] && b[f].mtime > a[f].mtime;
  // Each friend's current library entry (older versions' keys are never asked for again).
  const lib0 = ["FRIENDA", "FRIENDB"]
    .map((tag) => Object.entries(t0).filter(([, x]) => x.kind === "library" && x.tag === tag).sort((a, b) => b[1].mtime - a[1].mtime)[0]?.[0])
    .filter(Boolean);
  const hour0 = Object.entries(t0).filter(([, x]) => x.revalidate === 3600).map(([f]) => f);
  const out = {
    entriesAt: { t0: Object.keys(t0).length, h1: Object.keys(h1).length, d1: Object.keys(d1).length },
    hourLongRewrittenAfterAnHour: hour0.filter((f) => rewritten(t0, h1, f)).length,
    libraryRewrittenAfterAnHour: lib0.filter((f) => rewritten(t0, h1, f)).length,
    libraryRewrittenAfterADay: lib0.filter((f) => rewritten(h1, d1, f)).length,
    libraryEntries: lib0.length,
    historyEntries: { t0: Object.values(t0).filter((x) => x.kind === "history").length, d1: Object.values(d1).filter((x) => x.kind === "history").length },
    foreign: [t0, h1, d1].flatMap((x) => Object.values(x)).filter((x) => x.foreign > 0).length,
  };
  out.ok =
    out.hourLongRewrittenAfterAnHour > 0 &&
    out.libraryEntries === 2 &&
    out.libraryRewrittenAfterAnHour === 0 &&
    out.libraryRewrittenAfterADay === out.libraryEntries &&
    out.historyEntries.d1 > out.historyEntries.t0 &&
    out.foreign === 0;
  return out;
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s.replace(/%2F/gi, "/");
  }
}

function spawnSyncSafe(cmd, args) {
  const r = spawnSync(cmd, args);
  return r.status === 0 ? null : `${cmd} ${args.join(" ")}: ${r.stderr}`;
}

export const CHECKS = [
  { id: 1, title: "cache() in route handlers", run: check1 },
  { id: 3, title: "one instance serving two users", run: check3 },
  { id: 2, title: "the Data Cache across environments", run: check2 },
  { id: 4, title: "two token refreshes in one tick", run: check4 },
  { id: 5, title: "the shared device", run: check5 },
  { id: 6, title: "the probe's e-mail", run: check6 },
  { id: 8, title: "the freeze", run: check8 },
  { id: 9, title: "the daily cycle on a fast-forwarded clock", run: check9 },
  { id: 7, title: "deletion reaching backups", run: check7 },
];
