import "server-only";
import { cookies } from "next/headers";

// The user's UTC offset in minutes (minutes to ADD to UTC for their local time, e.g.
// +120 for UTC+2). Set from the browser by TimezoneCookie and read here so day-bucketed
// history queries group by the user's local day, not Turso's UTC. Defaults to 0 (UTC)
// when the cookie isn't present yet (first paint before the client sets it).
export async function tzOffsetMinutes(): Promise<number> {
  const v = (await cookies()).get("tzoffset")?.value;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(-720, Math.min(840, Math.round(n)));
  // No cookie (first paint, or a request that lost it): the last offset any browser
  // published beats UTC — a cookie-less refresh used to re-bucket the whole strip in UTC
  // against a payload bucketed locally (audit 2026-08-19, T2.20).
  const { getUserTzOffset } = await import("@/lib/db");
  return (await getUserTzOffset().catch(() => null)) ?? 0;
}
