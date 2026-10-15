// Runtime isolation events (docs/multi-user/PLAN.md §6.5): a check that caught one user's data,
// token or database on its way to another records the uid and a code, never the data. In
// production a count above zero is a bug report; the hourly health check turns red on one.
//
// Phase 1 has no app database, so an event goes to the log (a fixed prefix) and to telemetry
// as a `client_metrics` row (`page` and `session` "server", `event` "isolation", `meta`
// "<code>|<uid>"). Phase 2 adds the awaited row in `lazyboy-app.events`.
import "server-only";
import { recordClientMetrics } from "@/lib/db";

export type IsolationCode = "owner-mismatch" | "cache-stamp" | "token-owner" | "decrypt";

export const ISOLATION_EVENT = "isolation";

export async function reportIsolation(code: IsolationCode, uid: string): Promise<void> {
  console.error(`[isolation] ${code} uid=${uid}`);
  await recordClientMetrics([
    { session: "server", page: "server", event: ISOLATION_EVENT, value: null, meta: `${code}|${uid}` },
  ]).catch(() => {});
}
