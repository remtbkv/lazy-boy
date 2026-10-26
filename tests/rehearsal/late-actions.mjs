#!/usr/bin/env node
// Actions that land after the person has moved on, in a real browser (lane 0597, Oct 26, 2026).
// Rem's ←/→ run ended on Playlists seconds after his last ← had brought Home back, while he was
// typing in its search. A production build under the rehearsal's preload (synthetic admin,
// stand-in Spotify, throwaway stores; docs/multi-user/REHEARSAL.md), headless Chromium, requests
// slowed per route so each cause happens on cue:
//
//   edge-drop  the first cause (src/lib/tab-nav.ts): Playlists answers in 1.5 s. → then ← 150 ms
//              later, then a click in the search pill and typing. The old handler moved from the
//              committed tab, dropped the ← as the left end, and Playlists landed under the search.
//   enter      the same timing, then Enter: the old handler left focus on the Playlists tab it had
//              pushed, so Enter opened the tab the person had just left.
//   queue      the second cause (scripts/patch-next-router-queue.mjs): Playlists 0.4 s, Friends
//              1.6 s, the search payloads 9 s and no stored copy of them, so typing asks the server.
//              → → ← ←: the discarded Playlists settles while Friends loads, Next 16.2 loses track
//              of Friends, Friends settles last as the router's state, and the search's server
//              action renders it.
//   save-queue the sweep (home/dock.tsx QueuePopover): a save that takes 3 s, the bubble closed
//              while it runs, the bubble opened again; the first save's end closed the new bubble.
//
// A tab run passes when, after the last arrow key, nothing commits a page other than the one the
// keys asked for, the app ends there, and anything typed is still in the search box.
//
//   npm run build && node tests/rehearsal/late-actions.mjs [--runs 3] [--only edge-drop,queue]
//                                                          [--port 3150] [--dir <dir>] [--project <built tree>]
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { closeBrowser, launchBrowser, newProfile, signIn } from "./browser.mjs";
import { cleanupSecrets, makeSecrets, quiet, REPO, req, runScript, sleep, startServer, stopServer, write } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const runs = Number(opt("--runs", 3));
const only = opt("--only", null)?.split(",");
const port = Number(opt("--port", 3150));
const project = path.resolve(opt("--project", REPO));
const dir = path.resolve(opt("--dir", path.join(os.tmpdir(), `lazyboy-late-actions-${Date.now()}`)));
mkdirSync(dir, { recursive: true });

// In the page: key presses, commits (Next's history write at React commit, `__NA`), and RSC
// requests (navigations, prefetches, server actions) with their ends.
const RECORD = `(() => {
  const log = (window.__late = []);
  const now = () => Math.round(performance.now());
  addEventListener("keydown", (e) => { log.push({ t: now(), ev: "key", key: e.key }); }, true);
  for (const name of ["pushState", "replaceState"]) {
    const orig = History.prototype[name];
    History.prototype[name] = function (data, u, url) {
      if (data && data.__NA) {
        const p = new URL(String(url), location.href).pathname;
        if (name === "pushState" || p !== location.pathname) log.push({ t: now(), ev: "commit", path: p, from: location.pathname });
      }
      return orig.apply(this, arguments);
    };
  }
  const of = window.fetch;
  window.fetch = function (input, init) {
    let h;
    try { h = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined)); } catch { h = new Headers(); }
    const kind = h.get("next-action") ? "action" : h.get("rsc") ? "rsc" : null;
    if (!kind) return of.apply(this, arguments);
    const p = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    log.push({ t: now(), ev: kind, path: p });
    return of.apply(this, arguments).then((r) => { log.push({ t: now(), ev: kind + "-end", path: p }); return r; });
  };
})();`;

const TAB_RUNS = [
  { name: "edge-drop", delays: { "/playlists": 1500 }, keys: [[0, "ArrowRight"], [150, "ArrowLeft"]], typeAt: 400, want: "/home" },
  { name: "enter", delays: { "/playlists": 1500 }, keys: [[0, "ArrowRight"], [150, "ArrowLeft"], [300, "Enter"]], want: "/home" },
  {
    name: "queue",
    delays: { "/playlists": 400, "/friends": 1600, "/api/search/library": 9000, "/api/search/history": 9000 },
    keys: [[0, "ArrowRight"], [100, "ArrowRight"], [600, "ArrowLeft"], [700, "ArrowLeft"]],
    typeAt: 2600,
    noStoredSearch: true,
    want: "/home",
  },
];

async function setup() {
  const secrets = makeSecrets(dir);
  const stores = path.join(dir, "P", "stores");
  mkdirSync(stores, { recursive: true });
  const { USER_SCHEMA_STATEMENTS, userMetaStatement } = await import("../../src/lib/user-schema.ts");
  const meta = userMetaStatement(secrets.OWNER_UID, randomBytes(16).toString("hex"));
  write(path.join(stores, "lazyboy.db"), [...USER_SCHEMA_STATEMENTS, { sql: meta.sql, args: meta.args }]);
  write(path.join(stores, "telemetry.db"), []);
  const p2 = runScript(dir, stores, "scripts/phase2-app-db.mjs", ["--org", "rehearsal"], {
    OWNER_UID: secrets.OWNER_UID,
    SPOTIFY_OWNER_ID: secrets.SPOTIFY_OWNER_ID,
  });
  if (p2.status !== 0) throw new Error(`phase2-app-db.mjs: ${p2.out}`);
  const env = {};
  for (const k of ["AUTH_SECRET", "CRON_SECRET", "CRON_SECRET_EXT", "TOKEN_KEYS", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_OWNER_ID", "OWNER_UID"]) env[k] = secrets[k];
  const srv = await startServer({ dir, name: "P", port, stores, project, env: { ...env, VERCEL_ENV: "production", SIGNUPS: "invite" } });
  return { secrets, srv };
}

/** A fresh Home, hydrated, with its record emptied. `slow(request)` returns a delay in ms. */
async function openHome(ctx, slow, { noStoredSearch = false } = {}) {
  const page = await ctx.newPage();
  await page.route("**/*", async (route) => {
    const d = slow(route.request());
    if (d) await sleep(d);
    return route.fallback();
  });
  // The browser's copy of the search payloads (search-cache.ts) fails to open, as in private
  // mode: a miss, so the box asks the server until the payloads land.
  if (noStoredSearch) {
    await page.addInitScript(() => {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (name, ...rest) => {
        if (String(name).includes("lb-search")) throw new DOMException("off for this run", "SecurityError");
        return open(name, ...rest);
      };
    });
  }
  await page.goto("/home");
  await page.waitForFunction(() => {
    const a = document.querySelector('header nav a[href="/friends"]');
    return !!a && Object.keys(a).some((k) => k.startsWith("__reactProps"));
  }, null, { timeout: 60_000 });
  await sleep(200);
  await page.evaluate(() => (window.__late.length = 0));
  return page;
}

async function tabRun(ctx, s) {
  // Each route's RSC requests (navigation and prefetch) and the named fetches wait their delay.
  const page = await openHome(
    ctx,
    (r) => {
      const p = new URL(r.url()).pathname;
      return s.delays[p] && (p.startsWith("/api/") || r.headers()["rsc"] === "1") ? s.delays[p] : 0;
    },
    s,
  );
  const t0 = Date.now();
  for (const [at, key] of s.keys) {
    await sleep(Math.max(0, t0 + at - Date.now()));
    await page.keyboard.press(key);
  }
  const input = page.locator("input[aria-label]").last();
  if (s.typeAt !== undefined) {
    await sleep(Math.max(0, t0 + s.typeAt - Date.now()));
    try {
      await input.click({ timeout: 2000 });
      await page.keyboard.type("song", { delay: 90 });
    } catch {
      /* no search pill: the app is not on Home */
    }
  }
  await sleep(4000);
  const typed = s.typeAt === undefined ? null : await input.inputValue({ timeout: 500 }).catch(() => "(gone)");
  const shown = await page.evaluate(() => document.querySelector("header nav a.text-foreground")?.getAttribute("href") ?? null);
  const at = await page.evaluate(() => location.pathname);
  const log = await page.evaluate(() => window.__late);
  await page.close();
  const lastKey = Math.max(...log.filter((e) => e.ev === "key" && /^Arrow|^Enter$/.test(e.key)).map((e) => e.t));
  const stray = log.filter((e) => e.ev === "commit" && e.t > lastKey && e.path !== s.want);
  const ok = shown === s.want && at === s.want && stray.length === 0 && (typed === null || typed === "song");
  const first = log.find((e) => e.ev === "key")?.t ?? 0;
  const timeline = log.filter((e) => e.t >= first - 20).map((e) => ({ ...e, t: e.t - first }));
  const say = `ended ${at} (tab ${shown}), wanted ${s.want}${typed === null ? "" : `; search box "${typed}"`}; stray commits after the last key: ${stray.map((e) => `${e.path}@${e.t - first}ms`).join(", ") || "none"}`;
  return { ok, say, timeline };
}

async function saveQueueRun(ctx) {
  let slowActions = false;
  const page = await openHome(ctx, (r) => (slowActions && r.method() === "POST" && r.headers()["next-action"] ? 3000 : 0));
  const pill = page.locator("button:visible", { hasText: "Save queue" }).first();
  const bubble = page.locator(".den-pop");
  await pill.click();
  await bubble.waitFor();
  slowActions = true;
  await bubble.locator("button", { hasText: "Save queue" }).click();
  const savedAt = Date.now();
  await sleep(200);
  await page.locator("button.fixed[aria-label='Close']").click(); // the outside tap: close while saving
  await bubble.waitFor({ state: "detached" });
  slowActions = false;
  await pill.click(); // open it again
  await bubble.waitFor();
  await sleep(Math.max(0, savedAt + 3000 + 1500 - Date.now())); // the first save has ended
  const open = (await bubble.count()) === 1 && !(await bubble.getAttribute("class"))?.includes("den-closing");
  await page.close();
  return { ok: open, say: open ? "the reopened bubble stayed open after the first save ended" : "the first save's end closed the reopened bubble", timeline: [] };
}

let failed = 0;
const results = [];
const { secrets, srv } = await setup();
let b = null;
try {
  console.log(`server pid ${srv.pid} on ${srv.origin}, project ${project}`);
  b = await launchBrowser();
  const profile = await newProfile(b, srv, []);
  (await signIn(profile, "ADMIN")).close();
  // One harvest so Home and the search have the admin's plays and library.
  await req(srv, "/api/cron/sync", { headers: { authorization: `Bearer ${secrets.CRON_SECRET}`, "user-agent": "curl/8.5.0" } });
  await quiet(srv, 150);
  await profile.ctx.addInitScript(RECORD);
  const all = [...TAB_RUNS.map((s) => ({ name: s.name, run: () => tabRun(profile.ctx, s) })), { name: "save-queue", run: () => saveQueueRun(profile.ctx) }];
  for (const s of all) {
    if (only && !only.includes(s.name)) continue;
    for (let i = 0; i < runs; i++) {
      const r = await s.run();
      results.push({ scenario: s.name, run: i, ...r });
      if (!r.ok) failed++;
      console.log(`${r.ok ? "PASS" : "FAIL"} ${s.name} #${i}: ${r.say}`);
      if (!r.ok) for (const e of r.timeline) if (!/\/playlists\/./.test(e.path ?? "")) console.log(`    ${String(e.t).padStart(6)} ${e.ev.padEnd(10)} ${e.path ?? e.key ?? ""}${e.from ? ` (from ${e.from})` : ""}`);
    }
  }
} finally {
  writeFileSync(path.join(dir, "late-actions.json"), JSON.stringify(results, null, 2));
  await closeBrowser(b);
  await stopServer(srv);
  cleanupSecrets(secrets);
}
console.log(`${failed ? "FAIL" : "PASS"}: ${results.length - failed} of ${results.length} runs; ${path.join(dir, "late-actions.json")}`);
process.exit(failed ? 1 : 0);
