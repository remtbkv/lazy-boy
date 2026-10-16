// /api/metrics answers before it records (docs/STORE_MIGRATION.md §6.4): the insert goes to the
// telemetry store, which may be a frozen Zenbook, and a beacon must never wait on that. The
// route validates, returns 204 and hands the insert to Next's after().
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  signedIn: true,
  afterQueue: [] as (() => unknown)[],
  recorded: [] as unknown[][],
  uids: [] as unknown[],
  // A telemetry store that never answers.
  record: (rows: unknown[]) => {
    state.recorded.push(rows);
    return new Promise<void>(() => {});
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: async () => (state.signedIn ? { user: {}, uid: "aaaaaaaaaaaa", admin: true } : null),
}));
vi.mock("@/lib/db", () => ({
  recordClientMetrics: (rows: unknown[], uid: unknown) => {
    state.uids.push(uid);
    return state.record(rows);
  },
}));
vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    state.afterQueue.push(task);
  },
}));

const { POST } = await import("@/app/api/metrics/route");

const beacon = (body: unknown) =>
  new Request("http://127.0.0.1:3000/api/metrics", { method: "POST", body: JSON.stringify(body) });

/** The response, or "timeout" if the route is still waiting after `ms`. */
async function within(p: Promise<Response>, ms = 500): Promise<Response | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
}

describe("/api/metrics", () => {
  beforeEach(() => {
    state.signedIn = true;
    state.afterQueue = [];
    state.recorded = [];
    state.uids = [];
    state.record = (rows: unknown[]) => {
      state.recorded.push(rows);
      return new Promise<void>(() => {});
    };
  });

  it("answers 204 at once and records after the response", async () => {
    const res = await within(
      POST(beacon({ session: "s1", events: [{ page: "/home", event: "fcp", value: 812 }] })),
    );
    expect(res).not.toBe("timeout");
    expect((res as Response).status).toBe(204);
    // Nothing recorded yet: the insert is queued, not run inline.
    expect(state.recorded).toHaveLength(0);
    expect(state.afterQueue).toHaveLength(1);
    void state.afterQueue[0]();
    expect(state.recorded).toEqual([
      [{ session: "s1", page: "/home", event: "fcp", value: 812, meta: null, at: null }],
    ]);
  });

  it("an insert that throws after the response is swallowed", async () => {
    state.record = () => Promise.reject(new Error("store down"));
    const res = await POST(beacon({ session: "s", events: [{ page: "/", event: "pageview" }] }));
    expect(res.status).toBe(204);
    await expect(Promise.resolve(state.afterQueue[0]())).resolves.toBeUndefined();
  });

  it("still validates before answering: 401, 413, and nothing queued for junk", async () => {
    state.signedIn = false;
    expect((await POST(beacon({ events: [] }))).status).toBe(401);
    state.signedIn = true;
    const many = Array.from({ length: 51 }, () => ({ page: "/", event: "x" }));
    expect((await POST(beacon({ session: "s", events: many }))).status).toBe(413);
    const bad = await POST(
      new Request("http://127.0.0.1:3000/api/metrics", { method: "POST", body: "{not json" }),
    );
    expect(bad.status).toBe(204);
    expect(state.afterQueue).toHaveLength(0);
  });

  // T15's client half (PLAN.md §6.2 layer 7, security R7): the rows are filed under the
  // session's uid, and an event name only the server writes never lands from a client.
  it("files rows under the session's uid, never one from the body, and drops server-only events", async () => {
    const res = await POST(
      beacon({
        session: "s1",
        uid: "zzzzzzzzzzzz",
        events: [
          { page: "/home", event: "fcp", value: 1, uid: "zzzzzzzzzzzz" },
          { page: "server", event: "isolation", meta: "owner-mismatch|aaaaaaaaaaaa" },
        ],
      }),
    );
    expect(res.status).toBe(204);
    void state.afterQueue[0]();
    expect(state.recorded).toEqual([[{ session: "s1", page: "/home", event: "fcp", value: 1, meta: null, at: null }]]);
    expect(state.uids).toEqual(["aaaaaaaaaaaa"]);
  });

  it("a batch of nothing but server-only events records nothing", async () => {
    await POST(beacon({ session: "s1", events: [{ page: "server", event: "isolation" }] }));
    expect(state.afterQueue).toHaveLength(0);
  });
});
