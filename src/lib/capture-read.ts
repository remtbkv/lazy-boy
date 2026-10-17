import "server-only";
import { readIdentityRow } from "@/lib/app-db";
import { captureHealth, type CaptureHealth } from "@/lib/capture-health";
import type { Uid } from "@/lib/identity";

/** Whether a user's history is still being captured, and the recently-played cooldown that
 *  explains a pause, from the identity read's one statement on the app database (multi-user
 *  PLAN §5.1, §7.10): their status, their token row, their sync_state row. Home's banner, the
 *  /usage card and the hourly health check read it. */
export async function readCapture(uid: Uid, now = Date.now()): Promise<{ health: CaptureHealth; rpCooldownUntil: number }> {
  const row = await readIdentityRow(uid);
  return {
    health: captureHealth(now, { lastOkAt: row?.lastOkAt ?? null, hasToken: !!row?.blob, status: row?.status ?? null }),
    rpCooldownUntil: Number(row?.rpCooldown) || 0,
  };
}
