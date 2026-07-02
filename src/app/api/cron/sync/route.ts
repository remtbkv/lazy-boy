import { timingSafeEqual } from "node:crypto";
import { getValidAccessToken } from "@/lib/auth";
import { spotifyClient, SpotifyError } from "@/lib/spotify";
import { syncRecentPlays } from "@/lib/sync/history";
import { syncLibrary } from "@/lib/sync/library";
import { getLibrarySyncedAt } from "@/lib/db";
import { ensureCronJobEnabled } from "@/lib/cronjob";

// Rebuild the library index at most hourly (snapshot-diffing makes a run cheap, but no
// need to do it every 5-minute tick). Takes a token getter — a cold full scan can
// outlive the ~1h access token.
async function maybeSyncLibrary(token: () => Promise<string>): Promise<string> {
  const at = await getLibrarySyncedAt();
  if (at && Date.now() - Date.parse(at) < 55 * 60 * 1000) return "fresh";
  await syncLibrary(spotifyClient(token, true));
  return "synced";
}

// Constant-time string compare so the cron secret can't be guessed via response timing.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Backstop sync, triggered by the schedulers (GitHub Actions every 5 min + Vercel daily
// cron, see vercel.json). Runs without a session using the stored token, so history stays
// current even when the app hasn't been opened. Callers send `Authorization: Bearer
// $CRON_SECRET`; anything else is rejected so the endpoint can't be triggered by randoms.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  // Fail closed: a missing secret must reject every caller, not wave them through. (An
  // unset CRON_SECRET in a deploy would otherwise leave this endpoint open to anyone.)
  if (!secret || !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  // The daily Vercel cron doubles as a watchdog: re-enable the every-2-min cron-job.org
  // pinger if it auto-disabled after a failure storm, so closed-app sync self-heals. Only
  // Vercel's cron carries this header, so the 2-min pings themselves skip the check.
  if (req.headers.get("x-vercel-cron")) {
    await ensureCronJobEnabled();
  }
  const token = await getValidAccessToken();
  if (!token) {
    // Nobody signed in / refresh token dead — nothing to do, not an error.
    return Response.json({ ok: true, skipped: "no token" });
  }
  // Getter for the longer-running work below — re-validates through the shared
  // refresh lock if the run crosses the token's expiry.
  const freshToken = async () => {
    const t = await getValidAccessToken();
    if (!t) throw new Error("token expired mid-sync");
    return t;
  };
  try {
    const { added, skipped } = await syncRecentPlays(spotifyClient(token));
    // Rate-limited/cooling down: don't pile the heavier library scan onto a throttle.
    if (skipped) return Response.json({ ok: true, added, skipped });
    // Heavier, lower-frequency upkeep — each self-gates so this stays cheap on most ticks.
    const library = await maybeSyncLibrary(freshToken);
    return Response.json({ ok: true, added, library });
  } catch (e) {
    // A rate-limit is transient and self-heals — never surface it as a 5xx. An external
    // scheduler (cron-job.org) auto-disables a job after N consecutive failures, so a
    // 500 here on a passing Spotify throttle would take the whole closed-app sync offline.
    if (e instanceof SpotifyError && e.status === 429) {
      return Response.json({ ok: true, skipped: "rate-limited" });
    }
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "sync failed" },
      { status: 500 },
    );
  }
}
