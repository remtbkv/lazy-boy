// The CPU meter on the request path (docs/multi-user/CAPACITY.md §6). Vercel's Active CPU, the
// one Hobby limit no API reports, is what this measures: each function invocation's process CPU
// (process.cpuUsage(), user + system), wall time and, where the route reports them, response
// bytes, keyed by (UTC day, route, user or "-") and summed in meter.ts until a flush.
//
// The hooks sit at the two choke points every metered request passes, not in each route:
// requireUser() (require-user.ts: every page, gated route and server action) and the cron
// secret check (cron-auth.ts: every /api/cron/* route); /api/build, which every open tab calls
// every ~5 minutes, meters itself. Not metered: Auth.js's own routes, /login and the legal
// pages, which pass neither; CAPACITY counts them as ~10 ms each.
// A request's own row starts its clock where the hook runs; the CPU before it, and theirs, lands
// in "(unattributed)" (below), so their invocations are uncounted but not their CPU.
//
// Under Fluid compute one instance serves overlapping requests, and process CPU cannot be split
// between them: each counts all the CPU spent while it ran, so overlap is counted twice. That
// errs high, the safe side for a budget. The process's CPU before its first metered request
// (module load, the cold start nothing on Hobby reports) is its own row, `(boot)`.
//
// The route name and the one-record-per-request rule come from the request scope Next runs every
// request inside (workAsyncStorage, the same store after() reads): its `route` is the app path
// ("/api/now-playing", "/home"), and the (app) layout and its page, which both gate, share it.
// That module is Next-internal; outside a request (tests, scripts) or if a Next upgrade moves
// it, the meter records nothing, and the health check turns red when it has written nothing for
// six hours (health.ts). The flush runs in after(), never on a user's awaited path.
import "server-only";
import { after } from "next/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { actionAsyncStorage } from "next/dist/server/app-render/action-async-storage.external";
import { meterFlush } from "@/lib/db";
import { MeterAggregate } from "@/lib/budget/meter";

export type MeterStart = { cpu: NodeJS.CpuUsage; at: number };
type Open = { route: string; uid: string; start: MeterStart; bytes: number };

// One per process, on globalThis: Next bundles route handlers and pages separately, and each
// bundle gets its own copy of this module, so module-level state would mean one aggregate per
// bundle and a second "(boot)" row, re-counting all the process's CPU so far, the first time a
// page ran after a route (seen on a local `next start`, Oct 16).
//
// `bookedUs` is how much of the process's CPU (process.cpuUsage()'s running total) some row
// already holds, and `inflight` the requests metered but not yet finished. Each finish tops the
// rows up to the process's own total as "(unattributed)": CPU no request's window held. The
// largest part is after() work, which starts beside the meter's own after() and so after its
// reading (cron-job.org's tick, background scans), then routes no gate meters and work between
// requests. The top-up stops where the oldest in-flight request began, whose own record will
// hold what follows; so the rows never hold less than the process spent, and the top-up never
// counts a microsecond a request's record also counts.
type MeterGlobals = {
  __lbMeter?: {
    meter: MeterAggregate;
    open: WeakMap<object, Open>;
    booted: boolean;
    bookedUs: number;
    inflight: Set<Open>;
  };
};
const g = globalThis as unknown as MeterGlobals;
const shared = (g.__lbMeter ??= {
  meter: new MeterAggregate(),
  open: new WeakMap(),
  booted: false,
  bookedUs: 0,
  inflight: new Set(),
});
/** This process's counts since its last flush. */
export const appMeter = shared.meter;
// Per in-flight request, keyed by Next's request scope object (gone with the request).
const open = shared.open;

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const cpuTotal = (c: NodeJS.CpuUsage) => c.user + c.system;
/** Vercel Hobby's longest function run (CAPACITY §2.2). */
const MAX_FUNCTION_MS = 300_000;

/** The clock reading a hook takes first, before the gate's own work. */
export function meterStart(): MeterStart {
  return { cpu: process.cpuUsage(), at: performance.now() };
}

function requestScope(): { route: string; isStaticGeneration: boolean } | undefined {
  try {
    return workAsyncStorage.getStore();
  } catch {
    return undefined;
  }
}

/** Meter the request this runs in, once however many gates it passes; a later call can name
 *  the user an earlier one did not know. Never throws. */
export function meterRequest(start: MeterStart, uid: string | null): void {
  try {
    const scope = requestScope();
    // A build-time prerender is not an invocation.
    if (!scope || scope.isStaticGeneration) return;
    const cur = open.get(scope);
    if (cur) {
      if (cur.uid === "-" && uid) cur.uid = uid;
      return;
    }
    if (!shared.booted) {
      shared.booted = true;
      appMeter.record({
        day: utcDay(Date.now()),
        route: "(boot)",
        uid: "-",
        invocations: 0,
        cpuUs: cpuTotal(start.cpu),
        wallMs: 0,
        bytes: 0,
      });
      shared.bookedUs = Math.max(shared.bookedUs, cpuTotal(start.cpu));
    }
    const action = actionAsyncStorage.getStore()?.isAction === true;
    const rec: Open = { route: action ? `${scope.route} (action)` : scope.route, uid: uid ?? "-", start, bytes: 0 };
    open.set(scope, rec);
    shared.inflight.add(rec);
    after(() => finish(rec));
  } catch {
    /* the meter never costs a request */
  }
}

/** A route's response body, counted toward Fast Origin Transfer as it goes out. UTF-8 bytes of
 *  the uncompressed body: if Vercel counts the compressed transfer, this errs high. */
export function meteredBody(body: string): string {
  try {
    const scope = requestScope();
    const rec = scope && open.get(scope);
    if (rec) rec.bytes += Buffer.byteLength(body);
  } catch {
    /* uncounted */
  }
  return body;
}

async function finish(rec: Open): Promise<void> {
  try {
    shared.inflight.delete(rec);
    const total = cpuTotal(process.cpuUsage());
    const cpuUs = total - cpuTotal(rec.start.cpu);
    const now = Date.now();
    const day = utcDay(now);
    appMeter.record({
      day,
      route: rec.route,
      uid: rec.uid,
      invocations: 1,
      cpuUs,
      wallMs: Math.round(performance.now() - rec.start.at),
      bytes: rec.bytes,
    });
    shared.bookedUs += cpuUs;
    topUp(day, total);
    if (appMeter.due(now)) await appMeter.flush(meterFlush, now);
  } catch {
    /* counts that could not be taken are lost; the request is long answered */
  }
}

/** The rows up to the process's CPU `total`, short of the oldest request still in flight (see
 *  `bookedUs` above). A request older than a function may run never finished; it stops counting. */
function topUp(day: string, total: number): void {
  let upTo = total;
  const at = performance.now();
  for (const r of shared.inflight) {
    if (at - r.start.at > MAX_FUNCTION_MS) shared.inflight.delete(r);
    else upTo = Math.min(upTo, cpuTotal(r.start.cpu));
  }
  if (upTo <= shared.bookedUs) return;
  appMeter.record({ day, route: "(unattributed)", uid: "-", invocations: 0, cpuUs: upTo - shared.bookedUs, wallMs: 0, bytes: 0 });
  shared.bookedUs = upTo;
}
