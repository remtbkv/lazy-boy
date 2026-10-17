// The CPU meter's known answers (docs/multi-user/CAPACITY.md §6; src/lib/budget/meter.ts,
// request-meter.ts): a 50 ms busy loop metered within 20%; one invocation per request however
// many gates it passes; the route and the user it is keyed by; the cold start's own row; a
// telemetry store that refuses keeps the counts and the next flush carries them; the flush
// cadence (a minute, or 200 invocations). Next's request scope is a real AsyncLocalStorage
// standing in for the one Next runs each request inside; after() runs when the test drains it.
import { beforeEach, describe, expect, it, vi } from "vitest";

// One request scope for every copy of the modules, as Next's `.external` modules are.
const hooks = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    tasks: [] as (() => unknown)[],
    session: null as unknown,
    work: new AsyncLocalStorage(),
    action: new AsyncLocalStorage(),
  };
});

vi.mock("next/server", () => ({ after: (t: () => unknown) => void hooks.tasks.push(t) }));
vi.mock("next/dist/server/app-render/work-async-storage.external", () => ({ workAsyncStorage: hooks.work }));
vi.mock("next/dist/server/app-render/action-async-storage.external", () => ({ actionAsyncStorage: hooks.action }));
vi.mock("@/lib/auth", () => ({ auth: async () => hooks.session }));

const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
const { actionAsyncStorage } = await import("next/dist/server/app-render/action-async-storage.external");
const { MeterAggregate, FLUSH_EVERY_INVOCATIONS, FLUSH_EVERY_MS } = await import("@/lib/budget/meter");
const { appMeter, meterRequest, meterStart, meteredBody } = await import("@/lib/budget/request-meter");
const { meterFlush, readMeter } = await import("@/lib/db");
const { requireRouteUser } = await import("@/lib/require-user");
const { cronAuthorized } = await import("@/lib/cron-auth");
const { rawClient, resetStore } = await import("./adversarial/helpers");

type Scope = { route: string; isStaticGeneration: boolean };
const scope = (route: string, isStaticGeneration = false): Scope => ({ route, isStaticGeneration });
function inRequest<T>(s: Scope, fn: () => T): T {
  return (workAsyncStorage as unknown as { run<R>(s: unknown, f: () => R): R }).run(s, fn);
}
async function drainAfter(): Promise<void> {
  while (hooks.tasks.length) await hooks.tasks.shift()!();
}
/** Spin until this process has spent `ms` of CPU (the clock Vercel bills on). */
function burnCpu(ms: number): number {
  const t0 = process.cpuUsage();
  let x = 0;
  for (;;) {
    for (let i = 0; i < 20_000; i++) x = (x + i * i) % 1_000_003;
    const d = process.cpuUsage(t0);
    if ((d.user + d.system) / 1000 >= ms) return x;
  }
}
/** As if every CPU microsecond this process has spent so far were already in a row. */
function rebase(): void {
  const c = process.cpuUsage();
  (globalThis as unknown as { __lbMeter: { bookedUs: number } }).__lbMeter.bookedUs = c.user + c.system;
}
const today = () => new Date().toISOString().slice(0, 10);
const row = (route: string, uid = "-") =>
  appMeter.rows().find((r) => r.route === route && r.uid === uid);

beforeEach(async () => {
  hooks.tasks.length = 0;
  hooks.session = null;
  await resetStore();
  // As if a flush just ran: the requests below stay in the aggregate, where the tests read them.
  appMeter.reset(Date.now());
  rebase();
});

describe("the request meter", () => {
  // First in the file on purpose: the cold-start row is recorded by the process's first metered
  // request.
  it("the first flush lands in the telemetry store, with the process's cold start as its own row", async () => {
    appMeter.reset(0); // never flushed in this process
    await inRequest(scope("/api/now-playing"), async () => meterRequest(meterStart(), "u1"));
    await drainAfter();
    const c = await rawClient();
    const rows = (await c.execute("SELECT day, route, user_id, invocations, cpu_us FROM cpu_meter ORDER BY route")).rows;
    expect(rows.map((r) => [r.day, r.route, r.user_id, r.invocations])).toEqual([
      [today(), "(boot)", "-", 0],
      [today(), "/api/now-playing", "u1", 1],
    ]);
    expect(Number(rows[0].cpu_us)).toBeGreaterThan(0);
    // Flushed rows leave the aggregate: the next flush carries only what came after.
    expect(appMeter.rows()).toEqual([]);
  });
  it("a second copy of the module (Next bundles routes and pages apart) shares the process's meter", async () => {
    vi.resetModules();
    const copy = await import("@/lib/budget/request-meter");
    expect(copy.meterRequest).not.toBe(meterRequest);
    await inRequest(scope("/home"), async () => copy.meterRequest(copy.meterStart(), "u1"));
    await drainAfter();
    // Loading the copy is CPU outside any request: "(unattributed)" holds it.
    expect(appMeter.rows().filter((r) => r.route !== "(unattributed)").map((r) => [r.route, r.uid])).toEqual([
      ["/home", "u1"],
    ]);
    expect(copy.appMeter).toBe(appMeter);
  });

  it("a 50 ms busy loop is metered within 20%", async () => {
    await inRequest(scope("/api/busy"), async () => {
      meterRequest(meterStart(), "u1");
      burnCpu(50);
    });
    // Counted when after() runs, as the request ends.
    expect(row("/api/busy", "u1")).toBeUndefined();
    await drainAfter();
    const r = row("/api/busy", "u1")!;
    expect(r.invocations).toBe(1);
    expect(r.cpuUs / 1000).toBeGreaterThan(40);
    expect(r.cpuUs / 1000).toBeLessThan(60);
    expect(r.wallMs).toBeGreaterThanOrEqual(r.cpuUs / 1000 - 5);
  });

  it("one invocation per request however many gates it passes; the later gate names the user", async () => {
    await inRequest(scope("/home"), async () => {
      meterRequest(meterStart(), null); // the layout's gate, before it knows anything
      meterRequest(meterStart(), "u1"); // the page's
      meterRequest(meterStart(), "u1");
    });
    await inRequest(scope("/home"), async () => meterRequest(meterStart(), "u1"));
    await drainAfter();
    expect(row("/home", "u1")!.invocations).toBe(2);
    expect(row("/home", "-")).toBeUndefined();
  });

  it("keys by route and user; a server action is named as one; no user is '-'", async () => {
    await inRequest(scope("/api/now-playing"), async () => meterRequest(meterStart(), null));
    await inRequest(scope("/api/now-playing"), async () => meterRequest(meterStart(), "u2"));
    await (actionAsyncStorage as unknown as { run<R>(s: unknown, f: () => R): R }).run({ isAction: true }, () =>
      inRequest(scope("/home"), async () => meterRequest(meterStart(), "u1")),
    );
    await drainAfter();
    expect(row("/api/now-playing", "-")!.invocations).toBe(1);
    expect(row("/api/now-playing", "u2")!.invocations).toBe(1);
    expect(row("/home (action)", "u1")!.invocations).toBe(1);
  });

  it("outside a request, and in a build-time prerender, it meters nothing", async () => {
    meterRequest(meterStart(), "u1");
    await inRequest(scope("/home", true), async () => meterRequest(meterStart(), "u1"));
    await drainAfter();
    expect(appMeter.rows().filter((r) => r.route !== "(boot)")).toEqual([]);
    expect(hooks.tasks).toEqual([]);
  });

  it("response bytes where a route reports them, in UTF-8", async () => {
    await inRequest(scope("/api/search/history"), async () => {
      meterRequest(meterStart(), "u1");
      expect(meteredBody('{"a":"é"}')).toBe('{"a":"é"}');
    });
    expect(meteredBody("outside a request: counted nowhere")).toBe("outside a request: counted nowhere");
    await drainAfter();
    expect(row("/api/search/history", "u1")!.bytes).toBe(10);
  });

  it("CPU spent in a route's own after() work is counted: cron-job.org's tick runs there", async () => {
    rebase();
    await inRequest(scope("/api/cron/sync"), async () => {
      meterRequest(meterStart(), null);
      // The route's after(() => tick(caller)), registered after the gate's: in Next both start
      // when the reply closes, the meter's first, so the meter reads the CPU before the tick.
      hooks.tasks.push(() => burnCpu(50));
    });
    await drainAfter();
    // The instance's next request books what the process spent outside every request.
    await inRequest(scope("/api/now-playing"), async () => meterRequest(meterStart(), "u1"));
    await drainAfter();
    const totalMs = appMeter.rows().reduce((s, r) => s + r.cpuUs, 0) / 1000;
    expect(totalMs).toBeGreaterThan(40);
    expect(row("(unattributed)")!.invocations).toBe(0);
  });

  it("CPU of a request still in flight is left to its own record, never booked twice", async () => {
    rebase();
    const a = scope("/api/cron/sync");
    let releaseA!: () => void;
    const aDone = inRequest(a, async () => {
      meterRequest(meterStart(), null);
      burnCpu(30);
      await new Promise<void>((r) => (releaseA = r));
    });
    // B starts and ends while A is out: B's record must not book A's 30 ms as unattributed.
    await inRequest(scope("/api/now-playing"), async () => meterRequest(meterStart(), "u1"));
    await hooks.tasks.pop()!();
    releaseA();
    await aDone;
    await drainAfter();
    const totalMs = appMeter.rows().reduce((s, r) => s + r.cpuUs, 0) / 1000;
    expect(totalMs).toBeGreaterThan(25);
    expect(totalMs).toBeLessThan(50);
  });

  it("the gates are the choke points: requireUser and the cron secret check", async () => {
    hooks.session = { user: {}, uid: "aaaaaaaaaaaa", admin: true };
    await inRequest(scope("/api/sync"), async () => {
      expect(await requireRouteUser()).toMatchObject({ uid: "aaaaaaaaaaaa" });
    });
    hooks.session = null;
    await inRequest(scope("/api/sync"), async () => {
      expect(await requireRouteUser()).toBeInstanceOf(Response);
    });
    await inRequest(scope("/api/cron/sync"), async () => {
      cronAuthorized(new Request("http://x/api/cron/sync"));
    });
    await drainAfter();
    expect(row("/api/sync", "aaaaaaaaaaaa")!.invocations).toBe(1);
    expect(row("/api/sync", "-")!.invocations).toBe(1);
    expect(row("/api/cron/sync", "-")!.invocations).toBe(1);
  });

});

describe("the aggregate and its flush", () => {
  const sample = (route: string, cpuUs: number) => ({
    day: today(),
    route,
    uid: "u1",
    invocations: 1,
    cpuUs,
    wallMs: 2,
    bytes: 10,
  });

  it("a telemetry store that refuses keeps the counts, and the next flush carries them", async () => {
    const m = new MeterAggregate();
    m.record(sample("/a", 1000));
    m.record(sample("/a", 500));
    const c = await rawClient();
    await c.execute("ALTER TABLE cpu_meter RENAME TO cpu_meter_off");
    expect(await m.flush(meterFlush, Date.now())).toBe(false);
    expect(m.rows()).toEqual([{ ...sample("/a", 1500), invocations: 2, wallMs: 4, bytes: 20 }]);
    m.record(sample("/a", 250));
    await c.execute("ALTER TABLE cpu_meter_off RENAME TO cpu_meter");
    expect(await m.flush(meterFlush, Date.now())).toBe(true);
    expect(m.rows()).toEqual([]);
    const got = (await c.execute("SELECT invocations, cpu_us, wall_ms, bytes FROM cpu_meter WHERE route = '/a'")).rows[0];
    expect([got.invocations, got.cpu_us, got.wall_ms, got.bytes].map(Number)).toEqual([3, 1750, 6, 30]);
  });

  it("flushes add to what is stored (one upsert per key, one batch per flush)", async () => {
    const m = new MeterAggregate();
    m.record(sample("/a", 100));
    m.record({ ...sample("/b", 7), uid: "-" });
    const batches: number[] = [];
    const counting = async (rows: Parameters<typeof meterFlush>[0]) => {
      batches.push(rows.length);
      await meterFlush(rows);
    };
    await m.flush(counting, Date.now());
    m.record(sample("/a", 100));
    await m.flush(counting, Date.now());
    expect(batches).toEqual([2, 1]);
    const total = await readMeter(today());
    expect(total.cpuUs).toBe(207);
    expect(total.invocations).toBe(3);
    expect(total.lastAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it("is due a minute after the last flush, or at 200 invocations, and never with nothing to write", async () => {
    const m = new MeterAggregate();
    const t0 = 1_000_000_000;
    expect(m.due(t0)).toBe(false);
    m.record(sample("/a", 1));
    expect(m.due(t0)).toBe(true); // never flushed in this process
    await m.flush(async () => {}, t0);
    m.record(sample("/a", 1));
    expect(m.due(t0 + FLUSH_EVERY_MS - 1)).toBe(false);
    expect(m.due(t0 + FLUSH_EVERY_MS)).toBe(true);
    for (let i = 1; i < FLUSH_EVERY_INVOCATIONS; i++) m.record(sample("/a", 1));
    expect(m.due(t0 + 1)).toBe(true);
  });

  it("a failed flush waits a minute before the next attempt", async () => {
    const m = new MeterAggregate();
    const t0 = 2_000_000_000;
    m.record(sample("/a", 1));
    expect(await m.flush(async () => Promise.reject(new Error("refused")), t0)).toBe(false);
    m.record(sample("/a", 1));
    expect(m.due(t0 + 1)).toBe(false);
    expect(m.due(t0 + FLUSH_EVERY_MS)).toBe(true);
  });
});
