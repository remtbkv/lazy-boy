// Runtime isolation events (docs/multi-user/PLAN.md §6.5): a check that caught one user's data,
// token or database on its way to another records the uid and a code, never the data. In
// production a count above zero is a bug report; the hourly health check turns red on one.
//
// Phase 1 has no app database, so an event goes to the log (a fixed prefix) and to telemetry
// as a `client_metrics` row (`page` and `session` "server", `event` "isolation", `meta`
// "<code>|<uid>"). Phase 2 adds the awaited row in `lazyboy-app.events`.
import "server-only";

export type IsolationCode = "owner-mismatch" | "cache-stamp" | "token-owner" | "decrypt";

export const ISOLATION_EVENT = "isolation";
/** Event names only the server writes: /api/metrics drops them from a client's batch. */
export const SERVER_ONLY_EVENTS: ReadonlySet<string> = new Set([ISOLATION_EVENT]);

export async function reportIsolation(code: IsolationCode, uid: string): Promise<void> {
  console.error(`[isolation] ${code} uid=${uid}`);
  // Imported here, not at the top: db.ts reports owner mismatches through this module and
  // builds its cached reads with userCache, which reports here too, so a static import would
  // close a cycle that leaves userCache uninitialised while db.ts loads.
  const { recordClientMetrics } = await import("@/lib/db");
  await recordClientMetrics(
    [{ session: "server", page: "server", event: ISOLATION_EVENT, value: null, meta: `${code}|${uid}` }],
    uid,
  ).catch(() => {});
}
