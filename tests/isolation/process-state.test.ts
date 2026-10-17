// Process state that would mix users once a second one exists (PLAN.md §6.2 layer 4, M5 and
// M8; parts of T3 and T4): the playlist-list cache, the task registry and its polling route,
// and requireUser()'s route answers. Each test here failed against main at 6577f4b (see
// docs/multi-user/PHASE1.md §3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A, B } from "./harness";

const state = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
}));
vi.mock("@/lib/auth", () => ({
  auth: async () => state.session,
}));

const { Resources } = await import("@/lib/spotify/resources");
const { runTask, getTaskFor, taskDone } = await import("@/lib/tasks/registry");
const { GET: taskRoute } = await import("@/app/api/tasks/[id]/route");
const { requireRouteUser } = await import("@/lib/require-user");

const asUser = (uid: string) => ({ user: {}, expires: "", uid, admin: uid === A });

/** /me/playlists answers with one playlist named for the bearer's owner. */
function playlistsByBearer() {
  const bearers: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const bearer = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
    bearers.push(bearer);
    if (url.includes("/me/playlists")) {
      const who = bearer.replace("tok-", "");
      return Response.json({
        items: [{ id: `pl-${who}`, name: `${who}-only list`, owner: { id: who }, tracks: { total: 1 }, images: [], snapshot_id: "s" }],
        next: null,
        total: 1,
      });
    }
    return Response.json({});
  });
  return bearers;
}

beforeEach(() => {
  state.session = null;
});
afterEach(() => vi.unstubAllGlobals());

describe("the playlist-list cache (01b A6)", () => {
  it("B's library read within 60 s of A's reaches Spotify on B's bearer and returns B's list", async () => {
    const bearers = playlistsByBearer();
    const a = await new Resources("tok-A").myPlaylistsAll();
    const b = await new Resources("tok-B").myPlaylistsAll();
    expect(a.map((p) => p.name)).toEqual(["A-only list"]);
    expect(b.map((p) => p.name)).toEqual(["B-only list"]);
    expect(bearers.filter((x) => x === "tok-B").length).toBeGreaterThan(0);
  });
});

describe("tasks have owners (01b S7)", () => {
  it("a task is visible to its owner and to nobody else", async () => {
    const t = runTask("t", async () => "A's result", A);
    await taskDone(t.id);
    expect(getTaskFor(t.id, A)?.result).toBe("A's result");
    expect(getTaskFor(t.id, B)).toBeUndefined();
  });

  it("/api/tasks/[id]: no session 401; B polling A's task 404; A gets it", async () => {
    const t = runTask("t", async () => "A's result", A);
    await taskDone(t.id);
    const call = () => taskRoute(new Request("http://x") as never, { params: Promise.resolve({ id: t.id }) });

    state.session = null;
    expect((await call()).status).toBe(401);

    state.session = asUser(B);
    const asB = await call();
    expect(asB.status).toBe(404);
    expect(await asB.text()).not.toContain("A's result");

    state.session = asUser(A);
    const asA = await call();
    expect(asA.status).toBe(200);
    expect((await asA.json()).result).toBe("A's result");
  });
});

describe("requireRouteUser", () => {
  it("refused: 401 with the signed-out marker; unavailable: 503, retryable, no marker", async () => {
    state.session = null;
    const refused = await requireRouteUser();
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(401);
    expect((refused as Response).headers.get("x-lb-signed-out")).toBe("1");

    state.session = { user: {}, expires: "", idUnavailable: true };
    const down = await requireRouteUser();
    expect((down as Response).status).toBe(503);
    expect((down as Response).headers.get("x-lb-signed-out")).toBeNull();

    state.session = asUser(B);
    expect(await requireRouteUser()).toEqual({ uid: B, admin: false });
  });
});
