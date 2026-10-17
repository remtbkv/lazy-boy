import { cookies, headers } from "next/headers";
import { forUser } from "@/lib/db";
import { requireRouteUser } from "@/lib/require-user";
import { runOpenApp } from "@/lib/sync/tick";
import { liveTickDeps } from "@/lib/sync/tick-deps";

// The open app's sync (docs/multi-user/PLAN.md §7.6). SyncOnLoad pings this on load, every 2 min
// while the tab is visible, and on a return to the tab; `x-sync: load` marks the load and the
// return. It runs the cron's own step (sync/tick.ts runOpenApp) under the cron's own lease, so an
// open tab and a tick never work on one user at once:
//   - a load or a return probes /me/player and harvests when the policy says so: a track change
//     the probe saw, or a change the brake held back, at least 60 s after the last harvest;
//   - the 2-minute timer runs a step only when no tick has stamped `tick_at` in 5 minutes (both
//     pingers down), so an open app keeps capturing on its own.
// Before Phase 3 this harvested whenever the last harvest was a minute old, playing or not,
// which an app-heavy friend's open tab would have turned into ~240 scarce calls a day.
export async function POST() {
  // The gate first, so an unauthenticated POST costs no tokens read.
  const user = await requireRouteUser();
  if (user instanceof Response) return user;
  // The browser's offset and IANA zone, written only when they change (PLAN §4.3): the Home
  // payload buckets days in them on the write path, where there is no cookie.
  const store = forUser(user.uid);
  const jar = await cookies();
  const offset = Number(jar.get("tzoffset")?.value);
  if (Number.isFinite(offset)) {
    void store.setUserTzOffset(Math.max(-720, Math.min(840, Math.round(offset)))).catch(() => {});
  }
  const zone = jar.get("tzname")?.value;
  if (zone) void store.setUserTz(zone).catch(() => {});
  const load = (await headers()).get("x-sync") === "load";
  try {
    const r = await runOpenApp(liveTickDeps(), { uid: user.uid, load });
    return Response.json({ ok: true, ...r });
  } catch (e) {
    console.error("[sync] open-app step failed", e);
    return Response.json({ ok: false, error: "sync failed" }, { status: 500 });
  }
}
