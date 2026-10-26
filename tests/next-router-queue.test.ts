// Next's router action queue (next/dist/client/components/app-router-instance.js) driven with a
// stand-in reducer whose navigations settle when the test says: the second cause of lane 0597's
// ghost navigation (src/lib/tab-nav.ts, scripts/patch-next-router-queue.mjs). Navigation B
// supersedes A, A settles first, C starts while B still loads, and B settles last. Next 16.2.6
// makes B the router's state; the screen stays on C until the next server action renders the
// router's state (server-action-reducer returns `state` when nothing was revalidated): the ghost.
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs script, no types
import { patchQueue } from "../scripts/patch-next-router-queue.mjs";

const require = createRequire(import.meta.url);
const CJS = require.resolve("next/dist/client/components/app-router-instance.js");
const ESM = CJS.replace("/dist/client/", "/dist/esm/client/");
const installed = readFileSync(CJS, "utf8");
const FIXED = "actionQueue.pending === settledAction";

type M = { _load: (r: string, ...a: unknown[]) => unknown; _nodeModulePaths: (d: string) => string[] };

/** The queue module compiled from `src` at its real path, so its own requires resolve. */
function compileQueue(src: string) {
  const Mod = Module as unknown as M & (new (id: string) => { filename: string; paths: string[]; exports: Record<string, unknown>; _compile(s: string, f: string): void });
  const load = Mod._load;
  // The module imports the RSC client, which needs a bundler; the queue never calls it.
  Mod._load = function (r: string, ...a: unknown[]) {
    return r.startsWith("react-server-dom-webpack") ? {} : load.call(this, r, ...a);
  };
  try {
    const m = new Mod(CJS);
    m.filename = CJS;
    m.paths = Mod._nodeModulePaths(CJS.slice(0, CJS.lastIndexOf("/")));
    m._compile(src, CJS);
    return m.exports as { createMutableActionQueue: (s: unknown, h: unknown) => Queue };
  } finally {
    Mod._load = load;
  }
}

type State = { page: string };
type Queue = {
  state: State;
  action: (s: State, p: { type: string; page: string }) => Promise<State>;
  dispatch: (p: { type: string; page: string }, set: (s: unknown) => void) => void;
};
const { ACTION_NAVIGATE, ACTION_SERVER_ACTION } = require("next/dist/client/components/router-reducer/router-reducer-types.js");

/** A, B, C as above; returns the router's state after B and what the next server action renders. */
async function ghostRun(src: string) {
  const q = compileQueue(src).createMutableActionQueue({ page: "/home" }, null);
  const settle: Record<string, () => void> = {};
  q.action = (state, p) =>
    p.type === ACTION_SERVER_ACTION ? Promise.resolve(state) : new Promise<State>((res) => (settle[p.page] = () => res({ page: p.page })));
  let rendered: unknown = q.state;
  const setState = (s: unknown) => (rendered = s);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const nav = (page: string) => q.dispatch({ type: ACTION_NAVIGATE, page }, setState);
  nav("/playlists"); // A
  await tick();
  nav("/friends"); // B: A is discarded
  await tick();
  settle["/playlists"](); // A settles first
  await tick();
  nav("/home"); // C, while B still loads
  await tick();
  settle["/home"]?.();
  await tick();
  const onScreen = await rendered;
  settle["/friends"]?.(); // B settles last (a no-op when C discarded it)
  await tick();
  const routerState = q.state;
  q.dispatch({ type: ACTION_SERVER_ACTION, page: "-" }, setState);
  await tick();
  return { onScreen, routerState, afterAction: await rendered };
}

describe("Next's router queue", () => {
  it.skipIf(installed.includes(FIXED))("unpatched 16.2: the left navigation becomes the router's state and a server action shows it", async () => {
    const r = await ghostRun(installed);
    expect(r.onScreen).toEqual({ page: "/home" });
    expect(r.routerState).toEqual({ page: "/friends" });
    expect(r.afterAction).toEqual({ page: "/friends" });
  });

  it("patched: C discards B, and the server action renders C", async () => {
    const r = await ghostRun(patchQueue(installed));
    expect(r).toEqual({ onScreen: { page: "/home" }, routerState: { page: "/home" }, afterAction: { page: "/home" } });
  });

  it("the patch is idempotent and applies to the ESM copy the client bundle uses", () => {
    const once = patchQueue(installed);
    expect(patchQueue(once)).toBe(once);
    const esm = patchQueue(readFileSync(ESM, "utf8"));
    expect(esm).toContain(FIXED);
    expect(esm).not.toContain("runRemainingActions(actionQueue, setState);");
    expect(esm).toContain("actionQueue.last = newAction;\n        }\n        runAction");
  });

  it("refuses a queue it does not recognise", () => {
    expect(() => patchQueue("function somethingElse() {}\n")).toThrow(/runRemainingActions/);
  });
});
