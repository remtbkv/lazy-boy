// The rehearsal's browser (docs/multi-user/REHEARSAL.md): headless Chromium from handy's Playwright
// (the global copy has no matching browser build), launched as a server so its pid is known and it
// is stopped by pid. accounts.spotify.com/authorize is answered with a redirect to the app's own
// callback carrying a stand-in code (`code-<WHO>`), so sign-in runs the real Auth.js callback, the
// claim and the identity read. Every other non-loopback request from the page is aborted.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PW = process.env.REHEARSAL_PLAYWRIGHT || "/Users/remtbkv/projects/handy/node_modules/playwright";

export async function launchBrowser() {
  const { chromium } = require(PW);
  const server = await chromium.launchServer({ headless: true });
  const pid = server.process().pid;
  const browser = await chromium.connect(server.wsEndpoint());
  return { server, browser, pid, chromium };
}

export async function closeBrowser(b) {
  if (!b) return;
  await b.browser.close().catch(() => {});
  await b.server.close().catch(() => {});
  try {
    process.kill(b.pid, 0);
    process.kill(b.pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

/** A browser profile on `srv`. `profile.who` names the person the Spotify stand-in signs in. */
export async function newProfile(b, srv, blocked = []) {
  const ctx = await b.browser.newContext({ baseURL: srv.origin, acceptDownloads: true });
  const profile = { ctx, who: null, srv };
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "accounts.spotify.com" && u.pathname === "/authorize") {
      const back = new URL(u.searchParams.get("redirect_uri"));
      back.searchParams.set("code", `code-${profile.who}`);
      const state = u.searchParams.get("state");
      if (state) back.searchParams.set("state", state);
      return route.fulfill({ status: 302, headers: { location: back.href } });
    }
    blocked.push(u.href);
    return route.abort();
  });
  return profile;
}

/** Sign `who` in from /login (an existing account) or, with `fromJoin`, from /join's button. A
 *  profile whose grant died is sent on to /reconnect, whose button signs in again, as a friend's
 *  browser would be. */
export async function signIn(profile, who, { fromJoin = false } = {}) {
  profile.who = who;
  const page = await profile.ctx.newPage();
  await page.goto(fromJoin ? "/join" : "/login");
  // /login sends a live session on to /home: this profile is signed in already.
  if (!fromJoin && new URL(page.url()).pathname === "/home") return page;
  const button = page.getByRole("button", { name: /^(Connect Spotify|Sign in again)$/ });
  try {
    await button.waitFor({ timeout: 15_000 });
  } catch {
    throw new Error(`${who}: no sign-in button at ${page.url()}: ${(await page.locator("body").innerText()).slice(0, 300)}`);
  }
  await hydrated(page, /^(Connect Spotify|Sign in again)$/);
  await button.click();
  await page.waitForURL((u) => !/\/(login|join)/.test(u.pathname) || u.searchParams.has("error"), { timeout: 60_000 });
  const url = new URL(page.url());
  if (url.searchParams.has("error")) throw new Error(`${who}'s sign-in refused: ${url.href}`);
  return page;
}

/** Wait until the button named `name` is hydrated (React holds its props), as a person's click
 *  lands after the page has loaded; a click before it posts the form without the client. */
export async function hydrated(page, name) {
  await page.waitForFunction(
    (src) => {
      const re = new RegExp(src);
      const b = [...document.querySelectorAll("button")].find((x) => re.test((x.textContent ?? "").trim()));
      return !!b && Object.keys(b).some((k) => k.startsWith("__reactProps"));
    },
    name instanceof RegExp ? name.source : `^${name}$`,
    { timeout: 30_000 },
  );
}

/** The session cookie the browser holds (http, so no __Secure- prefix). */
export async function sessionCookie(profile) {
  const c = (await profile.ctx.cookies()).find((x) => x.name === "authjs.session-token");
  return c?.value ?? null;
}

/** Everything a profile keeps for the origin: cookies, localStorage, sessionStorage, IndexedDB
 *  (every database, store and record) and Cache Storage, as one string to search. */
export async function dumpProfile(profile, page) {
  const cookies = await profile.ctx.cookies();
  const inPage = await page.evaluate(async () => {
    const out = { local: {}, session: {}, idb: {}, caches: {} };
    for (let i = 0; i < localStorage.length; i++) out.local[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
    for (let i = 0; i < sessionStorage.length; i++) out.session[sessionStorage.key(i)] = sessionStorage.getItem(sessionStorage.key(i));
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    for (const { name } of dbs) {
      out.idb[name] = await new Promise((resolve) => {
        const r = indexedDB.open(name);
        r.onerror = () => resolve({ error: String(r.error) });
        r.onsuccess = async () => {
          const db = r.result;
          const stores = {};
          for (const s of db.objectStoreNames) {
            stores[s] = await new Promise((res) => {
              const tx = db.transaction(s, "readonly");
              const keys = tx.objectStore(s).getAllKeys();
              const vals = tx.objectStore(s).getAll();
              tx.oncomplete = () => res({ keys: keys.result, values: vals.result });
              tx.onerror = () => res({ error: String(tx.error) });
            });
          }
          db.close();
          resolve(stores);
        };
      });
    }
    if (self.caches) {
      for (const k of await caches.keys()) {
        const c = await caches.open(k);
        out.caches[k] = await Promise.all((await c.keys()).map(async (rq) => ({ url: rq.url, body: await (await c.match(rq)).text() })));
      }
    }
    return out;
  });
  return { cookies, ...inPage };
}
