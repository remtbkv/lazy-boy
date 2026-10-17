// The daily chores Phase 4a adds (docs/multi-user/PLAN.md §7.11, as RULINGS Oct 15 change it: no
// dormant move, no twelve-month deletion). `/api/cron/daily` (lane 1901's route) runs them beside
// its own, and so does the tick when `daily_at` is over 26 hours old (Phase 4a's turn wires both).
// Each is idempotent and resumable, so a run cut off finishes on the next:
//   - deletion retries: every `deleting` user through the deletion job until it answers done;
//   - day 4 of `revoked` (§5.4 step 5): a friend whose grant was confirmed revoked three days
//     after the first failure is deleted, unless a `grant-wide` event stands (no automatic
//     deletion during an app-wide event) or they signed in again (the job's compare-and-set); one
//     whose first failure had another user's (or the admin's) within 24 hours either side was part
//     of an app-wide event however the failures were ordered, and goes back to needs_reconnect;
//   - the 14-day invite expiry: an unclaimed invite withdrawn, its empty database destroyed;
//   - what a deletion leaves behind it, for every friend whose `deleted` row is still kept: the
//     telemetry rows a request or task in flight wrote after the job's telemetry step, and the
//     user's entries in Vercel's Data Cache (deletion-runtime.ts purgeDeparted);
//   - the sweeps: `deleted` rows past five days, orphan token, queue and lock rows, requests still
//     pending after 14 days, health records past 30 days;
//   - re-enabling the two cron-job.org jobs.
import "server-only";
import { dailyCandidates, dailySweeps, moveStatus } from "@/lib/app-db";
import { ensureCronJobsEnabled } from "@/lib/cronjob-jobs";
import { DELETED_ROW_TTL_MS, LEASE_WINDOW_MS, type DeletionOutcome } from "@/lib/deletion";
import { deleteAccount, purgeDeparted, withdrawExpiredInvite } from "@/lib/deletion-runtime";
import { GRANT_WIDE_HOLD_MS, GRANT_WINDOW_MS, REVOKED_DELETE_AFTER_MS } from "@/lib/grant-policy";

export type Chore = [name: string, run: () => Promise<unknown>];

export type DailyDeps = {
  now: () => number;
  deleteAccount: (uid: string) => Promise<DeletionOutcome>;
  withdrawInvite: (uid: string) => Promise<DeletionOutcome>;
  /** A departed friend's late telemetry rows and Data Cache entries (deletion-runtime.ts). */
  purgeDeparted: (uid: string) => Promise<void>;
  reenableJobs: () => Promise<unknown>;
  /** Waits out the lease window before a deletion's last step (real time in the runtime). */
  wait?: (ms: number) => Promise<void>;
};

const runtime: DailyDeps = {
  now: Date.now,
  deleteAccount,
  withdrawInvite: withdrawExpiredInvite,
  purgeDeparted,
  reenableJobs: () => ensureCronJobsEnabled(),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function each(
  uids: string[],
  run: (uid: string) => Promise<DeletionOutcome>,
  waiting: string[] = [],
): Promise<string> {
  const out: string[] = [];
  for (const uid of uids) {
    const o = await run(uid).catch((e): DeletionOutcome | null => {
      console.error(`[daily] ${uid}: ${String(e)}`);
      return null;
    });
    if (o?.kind === "pending" && o.step === "window") waiting.push(uid);
    out.push(o === null ? "error" : o.kind === "done" ? "done" : o.kind === "pending" ? `pending:${o.step}` : `refused:${o.reason}`);
  }
  // Outcome codes only: the uids are in the log line above when something failed, never in a reply.
  return out.length ? out.join(",") : "none";
}

export function phase4aChores(deps: DailyDeps = runtime): Chore[] {
  return [
    [
      "deletions",
      async () => {
        const now = deps.now();
        const c = await dailyCandidates(now, { revokedAfterMs: REVOKED_DELETE_AFTER_MS, grantWideHoldMs: GRANT_WIDE_HOLD_MS, grantWindowMs: GRANT_WINDOW_MS });
        const waiting: string[] = [];
        const retried = await each(c.deleting, deps.deleteAccount, waiting);
        for (const uid of c.revokedWide) await moveStatus(uid, "revoked", "needs_reconnect", now);
        const day4 = c.grantWideRecent > 0 ? (c.revokedDue.length ? "held:grant-wide" : "none") : await each(c.revokedDue, deps.deleteAccount, waiting);
        const invites = await each(c.invitesExpired, deps.withdrawInvite);
        // A deletion this run started waits out the lease window before its last step; finish it
        // in this run, once, rather than leave it `deleting` until tomorrow's, past the health
        // check's one-day alarm.
        let finished = "";
        if (waiting.length && deps.wait) {
          await deps.wait(LEASE_WINDOW_MS + 2_000);
          finished = `; after the window ${await each(waiting, deps.deleteAccount)}`;
        }
        const departed = await each(c.departed, async (uid) => (await deps.purgeDeparted(uid), { kind: "done" }));
        return `retried ${retried}; day4 ${day4}${c.revokedWide.length ? " held:app-wide" : ""}; invites ${invites}${finished}${
          c.departed.length ? `; departed ${departed}` : ""
        }`;
      },
    ],
    ["sweeps", async () => JSON.stringify(await dailySweeps(deps.now(), DELETED_ROW_TTL_MS))],
    ["cronJobs", async () => JSON.stringify(await deps.reenableJobs())],
  ];
}

/** Run every chore, each isolated, as the daily route runs its own; outcome per chore. */
export async function runPhase4aChores(deps: DailyDeps = runtime): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, run] of phase4aChores(deps)) {
    try {
      const r = await run();
      out[name] = typeof r === "string" ? r : "ok";
    } catch (e) {
      console.error(`[daily] ${name} failed`, e);
      out[name] = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return out;
}
