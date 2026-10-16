// How Home recovers when one of its client fetches fails, extracted from den-home/dock so the
// rules are pure, known-answer-tested functions (burn review 2026-10-03, U1/U2). Each of these
// used to turn one transient store or network error into a view that stayed broken until a
// reload. No React, no network.

/** A server action's own result shape: errors are mapped to `{ok:false}` server-side. */
type ActionResult = { ok: boolean };

/** Await a server action, mapping a TRANSPORT failure (deploy skew "Server Action not found",
 *  a dropped connection, a platform timeout) into the action's own `{ok:false}` shape. A
 *  rejection thrown inside a transition goes to the nearest error boundary, which replaced
 *  the whole of Home instead of showing a toast. */
export async function settleAction<T extends ActionResult>(
  p: Promise<T>,
): Promise<T | { ok: false; error: string }> {
  try {
    return await p;
  } catch {
    return { ok: false, error: "Couldn't reach the server — try again" };
  }
}

export type DaySettle<T> =
  /** A newer selection owns the view; this answer changes nothing. */
  | { kind: "superseded" }
  | { kind: "show"; rows: T }
  /** The fetch failed: put the highlight back on the day whose rows are still on screen. */
  | { kind: "restore"; selected: string };

/** What a settled day fetch does to the view. `req` is the counter the fetch started under,
 *  `current` the counter now, `prev` the day selected before the click. */
export function settleDayFetch<T>(
  req: number,
  current: number,
  prev: string,
  result: { ok: true; rows: T } | { ok: false },
): DaySettle<T> {
  if (req !== current) return { kind: "superseded" };
  return result.ok ? { kind: "show", rows: result.rows } : { kind: "restore", selected: prev };
}

export type PayloadSettle = {
  /** Where a query is answered from: the in-browser set, or the server fallback. */
  status: "memory" | "fallback";
  /** Drop the request ref so the next loadIndex refetches that half. A half that resolved to
   *  null and kept its ref answered null for the rest of the visit. */
  clearLib: boolean;
  clearHist: boolean;
  /** Hold the refetch for one retry window, so a run of keystrokes can't loop requests. */
  armRetry: boolean;
  /** Build the search set from what arrived. */
  build: boolean;
  /** Whether the set may claim a song was never played (only when the history half is in). */
  playsKnown: boolean;
};

type Payload = { tracks: unknown[] } | null;

/** The settle step of den-home's loadIndex, once both payload requests have answered. */
export function settlePayloads(l: Payload, h: Payload): PayloadSettle {
  const clearLib = l === null;
  const clearHist = h === null;
  const armRetry = clearLib || clearHist;
  // Nothing to match against — both failed, or a cold store answered `{tracks: []}` for both
  // (an empty set is truthy and rendered "No songs match" for the visit; audit 2026-08-19,
  // T2.6). Queries go to the server.
  if (!l?.tracks.length && !h?.tracks.length) {
    return { status: "fallback", clearLib, clearHist, armRetry, build: false, playsKnown: true };
  }
  return { status: "memory", clearLib, clearHist, armRetry, build: true, playsKnown: h !== null };
}

/** loadIndex's settle once the browser's copy exists (search-cache.ts, STORE_MIGRATION §10): a
 *  half the network failed to deliver is answered by the stored half, so a history 500 doesn't
 *  turn the plays the stored set was showing into "didn't load". The ref-clearing and the retry
 *  stay the network's own. An EMPTY network half is the server's answer and is not replaced.
 *  `status` is "idb" when only the stored copy could build a set. */
export function settleWithStored<L extends Payload, H extends Payload>(
  l: L | null,
  h: H | null,
  storedLib: L | null,
  storedHist: H | null,
): Omit<PayloadSettle, "status"> & { status: "memory" | "idb" | "fallback"; lib: L | null; hist: H | null } {
  const net = settlePayloads(l, h);
  const lib = l ?? storedLib;
  const hist = h ?? storedHist;
  const both = settlePayloads(lib, hist);
  return {
    ...net,
    status: net.build ? "memory" : both.build ? "idb" : "fallback",
    build: both.build,
    playsKnown: both.playsKnown,
    lib,
    hist,
  };
}

/** The server's FROZEN_AFTER_DAYS (db.ts): a day is final once it is today-2 or older in the
 *  user's zone. Yesterday stays live — late harvests and the backstop replay land there. */
const FROZEN_AFTER_DAYS = 2;

/** Whether a day's rows may be persisted across reloads. Persisting a still-live day pinned
 *  its pre-harvest copy for the tab's life (U2). `offsetMin` = minutes to ADD to UTC. */
export function persistableDay(
  day: string,
  now: number = Date.now(),
  offsetMin: number = -new Date(now).getTimezoneOffset(),
): boolean {
  if (day === "all") return false;
  const cutoff = new Date(now + offsetMin * 60_000 - FROZEN_AFTER_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return day <= cutoff;
}
