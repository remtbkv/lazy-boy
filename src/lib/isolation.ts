// Runtime isolation events (docs/multi-user/PLAN.md §6.5): a check that caught one user's data,
// token or database on its way to another records the uid and a code, never the data. In
// production a count above zero is a bug report; the hourly health check turns red on one.
//
// Each event is a log line with a fixed prefix, a telemetry row (`client_metrics`, `page` and
// `session` "server", `event` "isolation", `meta` "<code>|<uid>"), and, from Phase 2, an awaited
// row in the app database's `events` table, which the client cannot write (§6.2 layer 7).
import "server-only";
import { recordAppEvent } from "@/lib/app-db";

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
  await Promise.all([
    recordAppEvent(code, uid).catch((e) => console.error(`[isolation] events row not written: ${String(e)}`)),
    recordClientMetrics(
      [{ session: "server", page: "server", event: ISOLATION_EVENT, value: null, meta: `${code}|${uid}` }],
      uid,
    ).catch(() => {}),
  ]);
}
