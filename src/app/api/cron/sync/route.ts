import { runDailyChores } from "@/lib/daily-chores";
import { adminStore } from "@/lib/identity-read";
import { runTick } from "@/lib/sync/tick";
import { liveTickDeps } from "@/lib/sync/tick-deps";

// The cron tick (docs/multi-user/PLAN.md §7.2; src/lib/sync/tick.ts). Its callers: the Zenbook's
// user timer `lazyboy-cron-sync.timer` on even minutes with CRON_SECRET, cron-job.org on odd
// minutes with CRON_SECRET_EXT (the second pinger, so capture survives a Zenbook outage; §7.9),
// and Vercel's daily 07:00 UTC cron (vercel.json) with CRON_SECRET, the last-resort capture when
// both pingers are down. The Zenbook's root-level `lazyboy-sync.timer` (the "second ~5-min
// pinger" of 2026-08-06) only ever 401s, stale since the 07-01 rotation (burn lazyboy-review
// 2026-10-03, Z1/Z2). Callers send `Authorization: Bearer <secret>`; anything else is refused.
// Every holder of either secret is listed in docs/SECURITY.md.
//
// One tick per 45 s whoever calls (`app_meta.tick_at`): with both pingers a tick a minute, each
// user still probed every 2 minutes. It claims the due users, runs each one's step (the
// /me/player probe, a harvest when the policy says so) under a 15 s deadline, at most one
// library rescan, and the daily chores when `daily_at` is over 26 hours old; the Zenbook hears
// within 20 s and the rest finishes in after(). cron-job.org hears {"ok":true} at once.
export const maxDuration = 60;

// The chores' per-user half runs for the admin until Phase 4a (src/lib/daily-chores.ts), at the
// database his `users` row names (multi-user Phase 2).
async function dailyChores(): Promise<void> {
  const store = await adminStore();
  if (!store) throw new Error("no admin row");
  await runDailyChores(store);
}

export async function GET(req: Request) {
  const r = await runTick(liveTickDeps(dailyChores), req.headers.get("authorization"));
  return Response.json(r.body, { status: r.status });
}
