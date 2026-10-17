// The scripted world the rehearsal's server talks to (docs/multi-user/REHEARSAL.md): Spotify's Web
// API and accounts service, and Turso's Platform API, answered in-process by the preload. It keeps
// tests/isolation/authz-harness.ts's grammar (a code `code-<WHO>`, bearers `at-<WHO>-<n>`, refresh
// tokens `rt-<WHO>-<n>`, `<WHO>-only-` names, a 403 for an unregistered account) and extends it with
// each person's library, Liked Songs and recently-played from personas.mjs, real token lifetimes on
// the server's clock, and a record of every call with the person its token belongs to.
//
// Plants (REHEARSAL_PLANT, comma-separated), each a fault a check must catch:
//   leak-library   FRIENDB's bearer is answered with FRIENDA's playlists and Liked
//   swap-refresh   a refresh of FRIENDB's grant answers with a token minted for FRIENDA
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { PEOPLE, playingAt, playsBefore, tagOf } from "./personas.mjs";

const LIFETIME_S = 3600;
export const PLATFORM_TOKEN = "rehearsal-platform-token";
export const HOST_SUFFIX = ".rehearsal.invalid";

/** A token names its person and when it was minted, so any process's stand-in can check one
 *  another minted (a shadow server runs on copies of the stores): `at-<WHO>-<n>r<rand>-<mint36>`,
 *  `rt-<WHO>-<n>r<rand>`. */
function parseToken(tok) {
  const m = String(tok ?? "").match(/^(at|rt)-(ADMIN|FRIEND[ABCD])-\d+r[0-9a-z]+(?:-([0-9a-z]+))?$/);
  return m ? { kind: m[1], tag: m[2], mint: m[3] ? parseInt(m[3], 36) : null } : null;
}

export function createStandin({ callsFile, stores, plants = new Set(), log = () => {} }) {
  let seq = 0;
  const rand = () => Math.random().toString(36).slice(2, 6);
  // Per person, the time before which every access token counts as expired (the `expire` op).
  const expiredBefore = new Map();
  const access = {
    get(tok) {
      const t = parseToken(tok);
      if (!t || t.kind !== "at") return null;
      const exp = Math.min(t.mint + LIFETIME_S * 1000, t.mint < (expiredBefore.get(t.tag) ?? 0) ? 0 : Infinity);
      return { tag: t.tag, exp };
    },
  };
  const refresh = { get: (tok) => (parseToken(tok)?.kind === "rt" ? parseToken(tok).tag : undefined), set() {} };
  // Per person, the time before which every refresh token is dead (a revoked grant): a new
  // consent mints one after it, which lives, as a sign-in after a revocation does at Spotify.
  const deadBefore = new Map();
  const extra = Object.fromEntries(Object.keys(PEOPLE).map((t) => [t, { playlists: [], liked: [], removed: new Set() }]));
  const notRegistered = new Set();

  const record = (e) => {
    try {
      appendFileSync(callsFile, JSON.stringify({ seq: ++seq, at: Date.now(), ...e }) + "\n");
    } catch {
      /* the record is the evidence; a full disk shows as a missing line */
    }
  };

  const mint = (tag) => `at-${tag}-${++seq}r${rand()}-${Date.now().toString(36)}`;

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const err = (status, message) => json({ error: { status, message } }, status);

  const trackJson = (t) => ({
    id: t.id,
    name: t.name,
    uri: `spotify:track:${t.id}`,
    duration_ms: t.duration_ms,
    artists: [{ id: `${t.artist}`, name: t.artist }],
    album: { id: `${t.album}`, name: t.album, images: [] },
    type: "track",
    is_local: false,
  });

  function libraryOf(tag) {
    const p = PEOPLE[tag];
    const x = extra[tag];
    const lists = [...p.playlists, ...x.playlists].filter((pl) => !x.removed.has(pl.id));
    return { p, lists, liked: [...x.liked, ...p.liked] };
  }

  const plJson = (owner, pl) => ({
    id: pl.id,
    name: pl.name,
    description: "",
    owner: { id: owner.spotifyId, display_name: owner.displayName },
    images: [],
    public: false,
    collaborative: false,
    items: { total: pl.tracks.length },
    tracks: { total: pl.tracks.length },
    snapshot_id: `snap-${pl.id}-${pl.tracks.length}`,
  });

  async function bodyOf(init, input) {
    const b = init?.body ?? null;
    if (b == null && input instanceof Request) return input.clone().text();
    if (typeof b === "string") return b;
    if (b instanceof URLSearchParams) return b.toString();
    if (b instanceof Uint8Array || b instanceof ArrayBuffer) return Buffer.from(b).toString();
    return b == null ? "" : String(b);
  }

  async function accounts(url, method, text) {
    if (url.pathname !== "/api/token") return err(404, "no such accounts endpoint");
    const form = new URLSearchParams(text);
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const tag = tagOf(form.get("code"));
      record({ host: "accounts.spotify.com", method, path: "/api/token", grant, owner: tag, code: form.get("code") });
      if (!tag) return json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400);
      const rt = `rt-${tag}-${++seq}r${rand()}-${Date.now().toString(36)}`;
      return json({ access_token: mint(tag), token_type: "Bearer", expires_in: LIFETIME_S, refresh_token: rt, scope: "user-read-private" });
    }
    if (grant === "refresh_token") {
      const rt = form.get("refresh_token");
      const tag = refresh.get(rt) ?? null;
      const dead = !tag || (parseToken(rt)?.mint ?? 0) < (deadBefore.get(tag) ?? 0);
      let issued = tag && !dead ? mint(plants.has("swap-refresh") && tag === "FRIENDB" ? "FRIENDA" : tag) : null;
      record({ host: "accounts.spotify.com", method, path: "/api/token", grant, owner: tag, refreshToken: rt, issued, status: dead ? 400 : 200 });
      if (dead) return json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400);
      return json({ access_token: issued, token_type: "Bearer", expires_in: LIFETIME_S, scope: "user-read-private" });
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  async function api(url, method, bearer, text) {
    const tok = bearer ? access.get(bearer) : null;
    const owner = tok?.tag ?? tagOf(bearer);
    const p = url.pathname.replace(/^\/v1/, "");
    const expired = tok ? tok.exp <= Date.now() : true;
    record({ host: "api.spotify.com", method, path: p, query: url.search, owner, bearer, status: !tok ? 401 : expired ? 401 : undefined });
    if (!tok) return err(401, "Invalid access token");
    if (expired) return err(401, "The access token expired");
    const tag = tok.tag;
    if (notRegistered.has(tag)) {
      return new Response("Check settings on developer.spotify.com/dashboard, the user may not be registered.", { status: 403 });
    }
    // The leak plant: B's bearer reads A's library.
    const libTag = plants.has("leak-library") && tag === "FRIENDB" ? "FRIENDA" : tag;
    const { p: person, lists, liked } = libraryOf(libTag);
    const me = PEOPLE[tag];
    const now = Date.now();

    if (method !== "GET") {
      if (p === "/me/playlists" && method === "POST") {
        const b = JSON.parse(text || "{}");
        const pl = { id: `${tag}xnew${++seq}`, name: `${tag}-only-made-${String(b.name ?? "").slice(0, 40)}`, tracks: [] };
        extra[tag].playlists.push(pl);
        return json({ ...plJson(me, pl) }, 201);
      }
      const items = p.match(/^\/playlists\/([^/]+)\/items$/);
      if (items) {
        const pl = libraryOf(tag).lists.find((x) => x.id === items[1]);
        if (!pl) return err(404, "Not found");
        if (method === "POST") {
          const b = JSON.parse(text || "{}");
          for (const u of b.uris ?? []) {
            const t = PEOPLE[tag].tracks.find((x) => `spotify:track:${x.id}` === u) ?? { id: String(u).split(":").pop(), name: `${tag}-only-added`, artist: `${tag}-only-artist-x`, album: `${tag}-only-album-x`, duration_ms: 200000 };
            pl.tracks.push(t);
          }
          return json({ snapshot_id: `snap-${pl.id}-${pl.tracks.length}` }, 201);
        }
        return json({ snapshot_id: `snap-${pl.id}-${pl.tracks.length}` });
      }
      if (/^\/playlists\/[^/]+\/followers$/.test(p) && method === "DELETE") {
        extra[tag].removed.add(p.split("/")[2]);
        return new Response(null, { status: 200 });
      }
      if (p === "/me/tracks" && method === "PUT") return new Response(null, { status: 200 });
      if (p.startsWith("/me/player")) return new Response(null, { status: 204 });
      return json({}, 200);
    }

    if (p === "/me") {
      return json({ id: me.spotifyId, account_id: me.accountId, display_name: me.displayName, email: null, images: [], product: "premium", country: "US" });
    }
    if (p === "/me/player" || p === "/me/player/currently-playing") {
      const now2 = playingAt(person, now);
      if (!now2) return new Response(null, { status: 204 });
      return json({
        is_playing: true,
        progress_ms: now2.progressMs,
        timestamp: now,
        item: trackJson(now2.track),
        context: { type: "playlist", uri: `spotify:playlist:${now2.context.id}` },
        currently_playing_type: "track",
        device: { id: `${tag}xdevice`, name: `${tag}-only-device`, is_active: true, volume_percent: 50 },
      });
    }
    if (p === "/me/player/recently-played") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json({
        items: playsBefore(person, now, limit).map((x) => ({
          track: trackJson(x.track),
          played_at: new Date(x.playedAt).toISOString(),
          context: { type: "playlist", uri: `spotify:playlist:${x.context.id}` },
        })),
        next: null,
      });
    }
    if (p === "/me/player/queue") {
      return json({ currently_playing: trackJson(person.tracks[0]), queue: person.tracks.slice(1, 4).map(trackJson) });
    }
    if (p === "/me/playlists") return json(page(url, lists.map((pl) => plJson(person, pl))));
    if (p === "/me/tracks") {
      const all = liked.map((t, i) => ({ added_at: new Date(Date.UTC(2026, 0, 1) + (liked.length - i) * 86_400_000).toISOString(), track: trackJson(t) }));
      return json(page(url, all));
    }
    const pl = p.match(/^\/playlists\/([^/]+)(\/items|\/tracks)?$/);
    if (pl) {
      const found = lists.find((x) => x.id === pl[1]);
      if (!found) return err(404, "Not found");
      if (pl[2] === "/tracks") return err(403, "Forbidden");
      if (pl[2]) return json(page(url, found.tracks.map((t) => ({ added_at: "2026-01-01T00:00:00Z", item: trackJson(t), track: trackJson(t) }))));
      if (url.searchParams.get("fields") === "name") return json({ name: found.name });
      return json(plJson(person, found));
    }
    const u = p.match(/^\/users\/([^/]+)$/);
    if (u) return json({ id: u[1], display_name: u[1], images: [] });
    return err(404, `no stand-in for ${p}`);
  }

  function page(url, all) {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const items = all.slice(offset, offset + limit);
    const next = offset + limit < all.length ? `${url.origin}${url.pathname}?offset=${offset + limit}&limit=${limit}` : null;
    return { items, total: all.length, limit, offset, next };
  }

  // ── Turso's Platform API over the stores directory ───────────────────────────────────────
  const fileOf = (name) => path.join(stores, `${name}.db`);
  const dbJson = (name) => ({ Name: name, DbId: `id-${name}`, Hostname: `${name}${HOST_SUFFIX}`, group: "default" });
  let usageRowsRead = 1_000;

  async function platform(url, method, auth, text) {
    const m = url.pathname.match(/^\/v1\/organizations\/([^/]+)(\/.*)?$/);
    const rest = m?.[2] ?? "";
    record({ host: "api.turso.tech", method, path: url.pathname, status: auth === `Bearer ${PLATFORM_TOKEN}` ? undefined : 401 });
    if (auth !== `Bearer ${PLATFORM_TOKEN}`) return json({ error: "unauthorized" }, 401);
    if (rest === "/usage") {
      usageRowsRead += 10_000;
      return json({ organization: { usage: { rows_read: usageRowsRead, rows_written: 5_000, storage_bytes: 1_000_000, databases: 3 } } });
    }
    if (rest === "/databases" && method === "POST") {
      const b = JSON.parse(text || "{}");
      if (!/^[a-z0-9-]+$/.test(b.name ?? "")) return json({ error: "bad name" }, 400);
      if (existsSync(fileOf(b.name))) return json({ error: "exists" }, 409);
      mkdirSync(stores, { recursive: true });
      writeFileSync(fileOf(b.name), "");
      return json({ database: dbJson(b.name) });
    }
    if (rest === "/databases" && method === "GET") {
      const names = existsSync(stores) ? readdirSync(stores).filter((n) => n.endsWith(".db")).map((n) => n.slice(0, -3)) : [];
      return json({ databases: names.map(dbJson) });
    }
    const d = rest.match(/^\/databases\/([^/]+)(\/.*)?$/);
    if (d) {
      const name = decodeURIComponent(d[1]);
      const sub = d[2] ?? "";
      if (!existsSync(fileOf(name))) return json({ error: "database not found" }, 404);
      if (sub === "" && method === "GET") return json({ database: dbJson(name) });
      if (sub === "" && method === "DELETE") {
        for (const s of ["", "-wal", "-shm", "-journal"]) rmSync(fileOf(name) + s, { force: true });
        log(`platform: destroyed ${name}`);
        return json({ database: name });
      }
      if (sub === "/auth/tokens" && method === "POST") return json({ jwt: `rehearsal-db-token-${name}` });
      if (sub === "/usage") return json({ database: { total: { rows_read: Math.floor(statSync(fileOf(name)).size / 100) } } });
    }
    return json({ error: "no stand-in" }, 404);
  }

  async function handle(input, init) {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const auth = headers.get("authorization");
    const text = method === "GET" ? "" : await bodyOf(init, input);
    if (url.hostname === "accounts.spotify.com") return accounts(url, method, text);
    if (url.hostname === "api.spotify.com") return api(url, method, auth?.startsWith("Bearer ") ? auth.slice(7) : null, text);
    if (url.hostname === "api.turso.tech") return platform(url, method, auth, text);
    return null;
  }

  return {
    handle,
    /** Every access token of `tags` minted so far expires now (the stand-in's view; the app's own
     *  expiry is its row). */
    expire(tags) {
      for (const t of tags) expiredBefore.set(t, Date.now() + 1);
    },
    setDeadRefresh(tag, dead) {
      if (dead) deadBefore.set(tag, Date.now() + 1);
      else deadBefore.delete(tag);
    },
    setNotRegistered(tag, on) {
      if (on) notRegistered.add(tag);
      else notRegistered.delete(tag);
    },
    state() {
      return { expiredBefore: Object.fromEntries(expiredBefore), deadBefore: Object.fromEntries(deadBefore), notRegistered: [...notRegistered], plants: [...plants] };
    },
  };
}
