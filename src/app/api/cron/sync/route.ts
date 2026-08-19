import { timingSafeEqual } from "node:crypto";
import { getValidAccessToken } from "@/lib/auth";
import { spotifyClient, SpotifyError } from "@/lib/spotify";
import { syncRecentPlays } from "@/lib/sync/history";
import { syncLibrary } from "@/lib/sync/library";
import {
  getHarvestGate,
  getLibraryScanAttemptAt,
  getLibrarySyncedAt,
  ledgerSyncCall,
  pruneApiLog,
  pruneClientMetrics,
  rebuildHomePayload,
  recomputeAllTimeStats,
  setHarvestGate,
  setLibraryScanAttemptAt,
} from "@/lib/db";
import { ensureCronJobEnabled } from "@/lib/cronjob";

// Rebuild the library index at most every 30 min (snapshot-diffing makes a run cheap, but no
// need to do it every 2-minute tick). This tick is the AUTHORITATIVE refresh for the stored
// library: the playlists page renders from the store and only kicks its own scan when the
// store is empty or this tick has clearly stopped running. Takes a token getter — a cold full
// scan can outlive the ~1h access token.
const LIBRARY_MAX_AGE_MS = 30 * 60 * 1000;

async function maybeSyncLibrary(token: () => Promise<string>): Promise<string> {
  const at = await getLibrarySyncedAt();
  if (at && Date.now() - Date.parse(at) < LIBRARY_MAX_AGE_MS) return "fresh";
  // Attempt stamp, checked as well as the completion stamp: the completion stamp only
  // lands at the END of a successful scan, so a scan that kept throwing was retried on
  // every 2-minute tick — an unpaced failure storm (audit 2026-08-19, T2.9). One attempt
  // per 10 min, however it ended.
  const attemptAt = await getLibraryScanAttemptAt();
  if (attemptAt && Date.now() - attemptAt < 10 * 60 * 1000) return "cooling";
  await setLibraryScanAttemptAt();
  await syncLibrary(spotifyClient(token, true, "cron-library-scan"), undefined, { paceMs: 150 });
  return "synced";
}

// Constant-time string compare so the cron secret can't be guessed via response timing.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Backstop sync, triggered by the schedulers: cron-job.org every 2 min, a second external
// ~5-min pinger (measured in production logs 2026-08-06 — the GitHub Actions workflow that
// used to be the 5-min source was deleted, so its identity is unconfirmed), and Vercel's
// daily cron (vercel.json). Runs without a session using the stored token, so history stays
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
    // Each daily chore is isolated: a failure in one must not take down the tick (a 500
    // here feeds the external pinger's auto-disable — the exact storm the 429 branch
    // below was written to dodge).
    await ensureCronJobEnabled().catch((e) => console.error("[cron] pinger heal failed", e));
    // Daily heal for the throttled all-time recompute: a listening session's last plays
    // can land inside the 10-min gate and stay uncounted until the next session — this
    // bounds that staleness at a day for the cost of one full scan.
    await recomputeAllTimeStats().catch((e) => console.error("[cron] alltime heal failed", e));
    // …and the heal must reach Home: the card renders the COPY embedded in home_payload,
    // which only rebuilds when a play lands — without this the healed number was invisible
    // until the next listen (audit 2026-08-19, T2.2).
    await rebuildHomePayload().catch((e) => console.error("[cron] payload rebuild failed", e));
    // Retention is enforced here, not on the write path — the write-path counter resets
    // with every serverless instance and may never fire (audit 2026-08-19, T2.17).
    await pruneApiLog().catch(() => {});
    await pruneClientMetrics().catch(() => {});
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
    // GATE the recently-played harvest on actual playback (Rem, 2026-08-17: two multi-
    // hour QUOTA_EXCEEDED penalties on that endpoint in two days — this app is on a tight
    // Spotify quota, and ~720 harvests/day around the clock is what keeps hitting it).
    // currently-playing lives in its OWN quota bucket, so the tick checks it first and
    // harvests only when something is playing, when something HAS played since the last
    // harvest (the session's tail), or hourly as a backstop (other-device edge cases;
    // recently-played buffers 50 plays, so nothing is lost by waiting).
    const now = Date.now();
    const gate = await getHarvestGate();
    // `isPlaying`, not just "a track is loaded": currentlyPlaying() reports a PAUSED
    // device too, and `!!state` read a client left paused overnight as active — sustaining
    // the every-2-min harvests the gate exists to stop (audit 2026-08-19, T1.2).
    const playingNow = !!(
      await spotifyClient(token, false, "cron-player-check")
        .currentlyPlaying()
        .catch(() => null)
    )?.isPlaying;
    if (playingNow) await setHarvestGate({ lastActive: now });
    // `>=`, not `>`: playing ticks stamp lastActive and lastHarvest with the SAME `now`,
    // so strict-greater made the session-tail branch unreachable — the last plays of every
    // session waited for the hourly backstop (audit 2026-08-19, T1.3). With `>=`, the
    // first idle tick after playback harvests the tail once (equal stamps), then its own
    // fresher lastHarvest closes the branch.
    const shouldHarvest =
      playingNow ||
      gate.lastActive >= gate.lastHarvest ||
      now - gate.lastHarvest > 60 * 60 * 1000;
    if (!shouldHarvest) {
      return Response.json({ ok: true, added: 0, idle: true });
    }
    const { added, skipped } = await syncRecentPlays(spotifyClient(token, false, "cron-sync"));
    if (!skipped) await setHarvestGate({ lastHarvest: now });
    // Attribution for the dominant traffic on this database: ~720 of these a day, and which
    // of the two costs a tick paid depends entirely on whether it landed a play. A skipped
    // tick short-circuits on the cooldown for ~2 rows and is deliberately not ledgered.
    if (!skipped) void ledgerSyncCall(added > 0 ? "sync_tick_landed" : "sync_tick_steady", added);
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
