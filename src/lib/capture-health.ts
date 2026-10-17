// Is listen history still being recorded? (burn review 2026-10-03, M1.) Every capture failure
// found that night — a 401ing pinger, dead cron jobs, a dead refresh token — had been silent
// for weeks. This is the rule behind the Home banner, the /usage card and the hourly health
// check's owner-capture condition; capture-read.ts feeds it from the user's sync_state row.
// Pure, so it is known-answer tested and safe in client code.

/** Every successful cron step stamps `sync_state.last_ok_at`, and a healthy user's step runs
 *  every 2 minutes (multi-user PLAN §7.2), so 30 minutes without one means capture stopped
 *  (§7.10: "the admin is active and his last successful tick is over 30 minutes old"). */
export const CAPTURE_STALE_MS = 30 * 60_000;

export type CaptureHealth = {
  ok: boolean;
  /** How long since the last successful step; null when there has never been one. */
  staleForMs: number | null;
  reason: "signed out" | "stale" | null;
};

export type CaptureInputs = {
  /** `sync_state.last_ok_at`, epoch ms. */
  lastOkAt: number | null;
  /** A `user_tokens` row exists. */
  hasToken: boolean;
  /** `users.status`; `needs_reconnect` is a dead grant waiting for a sign-in. */
  status: string | null;
};

export function captureHealth(now: number, i: CaptureInputs): CaptureHealth {
  const staleForMs = i.lastOkAt === null ? null : Math.max(0, now - i.lastOkAt);
  // No usable grant: the cron has nothing to harvest with, however fresh the last step is.
  if (!i.hasToken || i.status !== "active") return { ok: false, staleForMs, reason: "signed out" };
  if (staleForMs === null || staleForMs > CAPTURE_STALE_MS) {
    return { ok: false, staleForMs, reason: "stale" };
  }
  return { ok: true, staleForMs, reason: null };
}

/** The one line the banner and the card show; empty when healthy. */
export function captureHealthMessage(h: CaptureHealth): string {
  if (h.ok) return "";
  const min = h.staleForMs === null ? null : Math.floor(h.staleForMs / 60_000);
  const age =
    min === null
      ? ""
      : min < 60
        ? ` ${min} min ago`
        : min < 48 * 60
          ? ` ${Math.floor(min / 60)} h ago`
          : ` ${Math.floor(min / (24 * 60))} days ago`;
  return h.reason === "signed out"
    ? `History capture stopped${age} — Spotify is signed out. Sign in again.`
    : `History capture stopped${age} — check the Zenbook pinger.`;
}
