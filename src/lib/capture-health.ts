// Is listen history still being recorded? (burn review 2026-10-03, M1.) Every capture failure
// found that night — a 401ing pinger, dead cron jobs, a dead refresh token — had been silent
// for weeks. This is the rule behind the Home banner and the /usage card; db.ts's
// getCaptureHealth() feeds it. Pure, so it is known-answer tested and safe in client code.

/** `last_sync` is stamped by every harvest, and the harvest gate runs one at least hourly
 *  when healthy (harvest-gate.ts backstop) — so two hours without one means capture stopped. */
export const CAPTURE_STALE_MS = 2 * 3_600_000;

export type CaptureHealth = {
  ok: boolean;
  /** How long since the last harvest; null when there has never been one. */
  staleForMs: number | null;
  reason: "signed out" | "stale" | null;
};

export function captureHealth(now: number, lastSync: string | null, hasTokens: boolean): CaptureHealth {
  const at = lastSync ? Date.parse(lastSync) : NaN;
  const staleForMs = Number.isFinite(at) ? Math.max(0, now - at) : null;
  // No tokens: the cron has nothing to harvest with, however fresh the last stamp is.
  if (!hasTokens) return { ok: false, staleForMs, reason: "signed out" };
  if (staleForMs === null || staleForMs > CAPTURE_STALE_MS) {
    return { ok: false, staleForMs, reason: "stale" };
  }
  return { ok: true, staleForMs, reason: null };
}

/** The one line the banner and the card show; empty when healthy. */
export function captureHealthMessage(h: CaptureHealth): string {
  if (h.ok) return "";
  const hours = h.staleForMs === null ? null : Math.floor(h.staleForMs / 3_600_000);
  const age =
    hours === null ? "" : hours < 48 ? ` ${hours} h ago` : ` ${Math.floor(hours / 24)} days ago`;
  return h.reason === "signed out"
    ? `History capture stopped${age} — Spotify is signed out. Sign in again.`
    : `History capture stopped${age} — check the Zenbook pinger.`;
}
