// T3's census as requests one person can send (tests/isolation/entry-points.test.ts lists the
// entry points; authz-registry.ts gives each its arguments): every gated page (as a document and
// as an RSC payload), route handler and server action, with the person's own identifiers as
// input. Server actions are called the way the browser calls them: a POST to a page that holds
// the action, its id from the build's server-reference manifest in `Next-Action`, the arguments
// encoded as React's encodeReply encodes them.
import { readFileSync } from "node:fs";
import path from "node:path";
import { req } from "./lib.mjs";
import { PEOPLE } from "./personas.mjs";

export function actionIds(projectDir) {
  const m = JSON.parse(readFileSync(path.join(projectDir, ".next/server/server-reference-manifest.json"), "utf8"));
  const out = {};
  for (const [id, v] of Object.entries(m.node)) {
    const workers = Object.keys(v.workers);
    const w = workers.includes("app/(app)/home/page") ? "app/(app)/home/page" : workers.find((x) => x.startsWith("app/(app)")) ?? workers[0];
    out[v.exportedName ?? Object.values(v.workers)[0].exportedName] = { id, page: "/" + w.replace(/^app\//, "").replace(/\/page$/, "").replace(/\([^)]+\)\//g, "") };
  }
  return out;
}

/** Call a server action as the browser does. `args` are the action's arguments; a FormData
 *  argument is given as { $form: {field: value} }. */
export async function callAction(srv, ids, name, args, jar) {
  const a = ids[name];
  if (!a) throw new Error(`no action ${name} in the manifest`);
  const headers = { "next-action": a.id, accept: "text/x-component" };
  let body;
  if (args.length === 1 && args[0]?.$form) {
    const fd = new FormData();
    fd.set("0", JSON.stringify(["$K1"]));
    for (const [k, v] of Object.entries(args[0].$form)) fd.set(`1_${k}`, v);
    body = fd;
  } else {
    headers["content-type"] = "text/plain;charset=UTF-8";
    body = JSON.stringify(args, (_k, v) => (typeof v === "string" && v.startsWith("$") ? `$${v}` : v));
  }
  return req(srv, a.page, { method: "POST", headers, body, jar });
}

/** Every census entry as a request `tag` sends with its own identifiers. Each item: { id, run(jar) }. */
export function censusFor(srv, ids, tag, state = {}) {
  const p = PEOPLE[tag];
  const [pl1, pl2, pl3] = p.playlists;
  const t1 = p.tracks[0];
  const uri = `spotify:track:${t1.id}`;
  const day = () => new Date(Date.now() + (state.offset?.() ?? 0)).toISOString().slice(0, 10);
  const act = (name, ...args) => ({ id: `action ${name}`, run: (jar) => callAction(srv, ids, name, args, jar) });
  const get = (u, h = {}) => ({ id: `GET ${u}${h.rsc ? " (RSC)" : ""}`, run: (jar) => req(srv, u, { jar, headers: h.rsc ? { rsc: "1" } : {} }) });
  const post = (u, body, headers = {}) => ({ id: `POST ${u}`, run: (jar) => req(srv, u, { method: "POST", jar, body, headers }) });
  return [
    // Pages, as a document and as the RSC payload a soft navigation fetches.
    get("/home"),
    get("/home", { rsc: true }),
    get("/playlists"),
    get("/playlists", { rsc: true }),
    get(`/playlists/${pl1.id}`),
    get(`/playlists/${pl1.id}`, { rsc: true }),
    get("/usage"),
    get("/disconnect"),
    // Route handlers.
    get("/api/now-playing"),
    post("/api/sync", undefined, { "x-sync": "load" }),
    post("/api/metrics", JSON.stringify({ session: `s-${tag}`, events: [{ page: "/home", event: "ttfb", value: 100, meta: `pv:${tag}` }] }), { "content-type": "application/json" }),
    get("/api/search/library"),
    get("/api/search/history"),
    { id: "GET /api/tasks/[id]", run: (jar) => req(srv, `/api/tasks/${state.task?.[tag] ?? "00000000-0000-4000-8000-000000000000"}`, { jar }) },
    post(`/api/playlists/${pl2.id}/tracks`, JSON.stringify({}), { "content-type": "application/json" }),
    post("/api/playlists/sync"),
    // Server actions: actions.ts.
    act("mergeAction", [pl1.id, pl2.id]),
    act("saveQueueAction"),
    act("subtractPreviewAction", pl1.id, [{ id: pl2.id, name: pl2.name }]),
    act("saveCompareDiffAction", `${tag}-only-diff`, [uri]),
    act("addToQueueAction", uri),
    act("playTrackAction", uri),
    act("playFromPlaylistAction", pl1.id, uri),
    act("playPlaylistAction", pl1.id),
    act("saveToLikedAction", t1.id),
    act("removeFromPlaylistAction", pl3.id, `spotify:track:${pl3.tracks[pl3.tracks.length - 1].id}`, pl3.tracks.length - 1),
    act("playerSetPlayingAction", true),
    act("playPlaylistTrackAction", pl1.id, uri),
    act("resumePlaylistAction", pl1.id),
    act("startCleanAction", pl2.id),
    act("deletePlaylistAction", `${tag}xpl9`),
    act("trackMenuAction", t1.name, t1.artist),
    act("disconnectAction", { $form: { confirm: "not the word" } }),
    act("login"),
    act("reauthForDisconnect"),
    // Server actions: history-actions.ts.
    act("dockDataAction"),
    { id: "action dayTracksAction", run: (jar) => callAction(srv, ids, "dayTracksAction", [day()], jar) },
    act("dailyStatsAction", 100_000),
    act("allTimePlaysAction"),
    act("searchPlaysAction", `${tag}-only`),
    act("refreshHistoryAction", "latest", 14, null),
  ];
}
