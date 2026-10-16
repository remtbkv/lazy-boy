// Log out and Disconnect (RULINGS Oct 15 1:17 PM and 1:33 PM; PLAN.md §5.4, §12.3), the decisions
// behind the two server actions in src/app/(app)/actions.ts, kept here so the simulated
// environment can run them (actions.ts imports auth.ts, which it cannot load).
//   - Log out: every browser signed out and the listening history no longer recorded, for anyone,
//     Rem included; the page after it says so and how to resume (sign in again).
//   - Disconnect: the account removed through the deletion job, after the export is offered, the
//     word typed and a sign-in within the last 10 minutes; never the admin (decision 21 as ruled:
//     nothing ever deletes Rem's data).
import "server-only";
import { endSessionsAndCapture } from "@/lib/app-db";
import type { DeletionOutcome } from "@/lib/deletion";
import { deleteAccount } from "@/lib/deletion-runtime";
import type { Gate, GateResult } from "@/lib/session-gate";

export const DISCONNECT_WORD = "disconnect";
export const FRESH_SIGN_IN_S = 10 * 60;

export async function logOutEverywhere(gate: Gate): Promise<void> {
  await endSessionsAndCapture(gate.uid);
}

/** Log out for whatever the session gate answered. Unavailable (the identity check could not run)
 *  throws: nothing could be ended, and the page after Log out would say every browser was signed
 *  out and recording stopped. Refused has nothing left to end: its epoch already moved, or its
 *  status keeps it from being synced. */
export async function logOutFrom(g: GateResult): Promise<void> {
  if (g.kind === "unavailable") throw new Error("log out: the identity check could not run, so nothing was ended; try again");
  if (g.kind === "allowed") await logOutEverywhere(g.gate);
}

export type DisconnectRefusal = "admin" | "word" | "stale";

/** Whether this session may disconnect now (§5.4): not the admin; the word typed; signed in within
 *  the last ten minutes by the cookie's auth_time (otherwise a fresh Spotify sign-in first). */
export function disconnectRefusal(
  gate: Gate,
  o: { typed: string; authTime: number | undefined; nowMs: number },
): DisconnectRefusal | null {
  if (gate.admin) return "admin";
  if (o.typed.trim().toLowerCase() !== DISCONNECT_WORD) return "word";
  if (typeof o.authTime !== "number" || Math.floor(o.nowMs / 1000) - o.authTime > FRESH_SIGN_IN_S) return "stale";
  return null;
}

export async function disconnect(
  gate: Gate,
  o: { typed: string; authTime: number | undefined; nowMs: number },
  run: (uid: string) => Promise<DeletionOutcome> = deleteAccount,
): Promise<{ ok: true; outcome: DeletionOutcome } | { ok: false; reason: DisconnectRefusal }> {
  const refused = disconnectRefusal(gate, o);
  if (refused) return { ok: false, reason: refused };
  return { ok: true, outcome: await run(gate.uid) };
}
