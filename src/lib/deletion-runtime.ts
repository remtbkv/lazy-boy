// The deletion job as the runtime runs it (docs/multi-user/PLAN.md §12.3): deletion.ts's steps over
// the app database (app-db.ts, its listed statements only), Turso's Platform API
// (turso-platform.ts) and the telemetry store (telemetry-lifecycle.ts). A friend's Disconnect and
// the daily chores call it; `user.mjs --remove` runs the same module from the Mac.
import "server-only";
import { execDeletionStatements } from "@/lib/app-db";
import { runDeletion, withdrawInvite, type DeletionDeps, type DeletionOutcome } from "@/lib/deletion";
import { appendLifecycle, deleteUserTelemetry } from "@/lib/telemetry-lifecycle";
import { destroyUserDatabase, userDatabaseOwner } from "@/lib/turso-platform";

export function runtimeDeletionDeps(): DeletionDeps {
  return {
    exec: execDeletionStatements,
    ownerOf: userDatabaseOwner,
    destroy: destroyUserDatabase,
    telemetry: { deleteUser: deleteUserTelemetry, appendLifecycle },
    now: Date.now,
    by: "runtime",
  };
}

export const deleteAccount = (uid: string): Promise<DeletionOutcome> => runDeletion(uid, runtimeDeletionDeps());
export const withdrawExpiredInvite = (uid: string): Promise<DeletionOutcome> => withdrawInvite(uid, runtimeDeletionDeps());
