// What a confirmed dead grant means (docs/multi-user/PLAN.md §5.4 steps 3-5; decision 21 as ruled:
// "A friend who revokes access has their data deleted on day 4 unless they reconnect. Rem's own
// data is never deleted by any automatic path"). Pure, so each branch has a known answer (T14).
//   - the admin: never revoked; he stays needs_reconnect and the health check alarms;
//   - app-wide: two or more users, or the admin, hit within 24 hours, or a `grant-wide` event that
//     still stands: Spotify's event, not the person's; everyone stays needs_reconnect, nothing is
//     scheduled;
//   - expired: a refresh token at least ~170 days old (Spotify documents six months); the person is
//     asked to reconnect at their next visit and the data stays;
//   - revoked: anything younger most likely means the person removed the app at Spotify, which the
//     Developer Terms treat as a disconnect: deleted on day 4 unless they sign in first.

export const EXPIRY_AGE_S = 170 * 86_400;
/** Day 4 after the first failure (status_at): inside Spotify's five days even if one daily run is missed. */
export const REVOKED_DELETE_AFTER_MS = 3 * 86_400_000;
/** "Within 24 hours" (§5.4 step 3): failures of two users this close are one app-wide event. */
export const GRANT_WINDOW_MS = 24 * 3_600_000;
/** How long a `grant-wide` event stands against any automatic deletion. */
export const GRANT_WIDE_HOLD_MS = 4 * 86_400_000;

export type GrantVerdict = "admin" | "app-wide" | "expired" | "revoked";

export function confirmedDeadGrant(c: {
  isAdmin: boolean;
  grantedAt: number | null;
  users24h: number;
  admin24h: boolean;
  grantWide: number;
  nowMs: number;
}): GrantVerdict {
  if (c.isAdmin) return "admin";
  if (c.users24h >= 2 || c.admin24h || c.grantWide > 0) return "app-wide";
  // No token row to date it: nothing says it was revoked, so it waits for its owner.
  if (c.grantedAt === null || Math.floor(c.nowMs / 1000) - c.grantedAt >= EXPIRY_AGE_S) return "expired";
  return "revoked";
}
