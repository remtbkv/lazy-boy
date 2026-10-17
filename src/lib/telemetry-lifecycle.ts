// The deletion job's telemetry step and the lifecycle log, in the runtime (docs/multi-user/PLAN.md
// §12.3 step 3, §12.5), over deletion.ts's TELEMETRY_SQL so `user.mjs` on the Mac runs the same
// statements. The telemetry store is TELEMETRY_DATABASE_URL when set (STORE_MIGRATION's split),
// otherwise the one store, as db.ts's getTelemetryClient() decides on main; Phase 4a's turn may
// hand this db.ts's client instead. Never on a user path: only the deletion job awaits it (S7).
import "server-only";
import { createClient, type Client } from "@libsql/client";
import { deleteTelemetryRows, TELEMETRY_SQL, type LifecycleEntry } from "@/lib/deletion";
import { makeStoreFetch } from "@/lib/store-fetch";

function open(): Client {
  const url = process.env.TELEMETRY_DATABASE_URL || process.env.TURSO_DATABASE_URL || "file:data/listens.db";
  const authToken = process.env.TELEMETRY_DATABASE_URL ? process.env.TELEMETRY_AUTH_TOKEN : process.env.TURSO_AUTH_TOKEN;
  return createClient({ url, authToken: url.startsWith("file:") ? undefined : authToken, intMode: "number", fetch: makeStoreFetch() });
}

async function withClient<T>(run: (c: Client) => Promise<T>): Promise<T> {
  const c = open();
  try {
    return await run(c);
  } finally {
    c.close();
  }
}

/** Delete every telemetry row tagged with this uid, in every table with a `user_id` column. */
export function deleteUserTelemetry(uid: string): Promise<void> {
  return withClient((c) => deleteTelemetryRows(uid, (s) => c.execute(s)));
}

/** One line in the lifecycle log, which an app-database restore re-applies (§12.5). */
export function appendLifecycle(e: LifecycleEntry): Promise<void> {
  return withClient(async (c) => {
    await c.execute(TELEMETRY_SQL.lifecycleTable);
    await c.execute({ sql: TELEMETRY_SQL.appendLifecycle, args: e });
  });
}
