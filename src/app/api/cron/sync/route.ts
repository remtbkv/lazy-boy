import { after } from "next/server";
import { getValidAccessTokenFor } from "@/lib/auth";
import { cronCaller, type CronCaller } from "@/lib/cron-auth";
import { forUser, type UserStore } from "@/lib/db";
import { phase1Owner } from "@/lib/identity";
import { spotifyClient, SpotifyError, type OwnedToken } from "@/lib/spotify";
import { syncRecentPlays } from "@/lib/sync/history";
import { syncLibrary } from "@/lib/sync/library";
import { shouldHarvest } from "@/lib/harvest-gate";
import { currentMode } from "@/lib/budget/mode";
import { LIBRARY_RESCAN_MS } from "@/lib/budget/modes";

// Rebuild the library index at most every 30 min (snapshot-diffing makes a run cheap, but no
// need to do it every 2-minute tick). This tick is the AUTHORITATIVE refresh for the stored
// library: the playlists page renders from the store and only kicks its own scan when the
// store is empty or this tick has clearly stopped running. Takes a token getter — a cold full
// scan can outlive the ~1h access token. The 30 min is the budget's normal mode: 2 hours in
// economy, no rescans in freeze (lib/budget/modes.ts).
async function maybeSyncLibrary(store: UserStore, token: () => Promise<OwnedToken>): Promise<string> {
  const maxAge = LIBRARY_RESCAN_MS[await currentMode()];
  if (maxAge === null) return "frozen";
  const at = await store.getLibrarySyncedAt();
  if (at && Date.now() - Date.parse(at) < maxAge) return "fresh";
  // Attempt stamp, checked as well as the completion stamp: the completion stamp only
  // lands at the END of a successful scan, so a scan that kept throwing was retried on
  // every 2-minute tick — an unpaced failure storm (audit 2026-08-19, T2.9). One attempt
  // per 10 min, however it ended.
  const attemptAt = await store.getLibraryScanAttemptAt();
  if (attemptAt && Date.now() - attemptAt < 10 * 60 * 1000) return "cooling";
  await store.setLibraryScanAttemptAt();
  await syncLibrary(spotifyClient(store.uid, token, true, "cron-library-scan"), store, undefined, { paceMs: 150 });
  return "synced";
}

// At most one tick per 90 s, whoever calls: with the two pingers on alternate minutes every
// second call ticks, so Spotify sees the 2-minute cadence either pinger alone keeps
// (docs/multi-user/PLAN.md §7.9). The window becomes 45 s with Phase 3's per-user claim.
const TICK_WINDOW_MS = 90_000;

// Backstop sync, triggered by the schedulers: the Zenbook's user timer
// `lazyboy-cron-sync.timer` every 2 min with CRON_SECRET (the working closed-app path), the
// cron-job.org job every 2 min with CRON_SECRET_EXT (the second pinger, so capture survives a
// Zenbook outage; PLAN §7.9), and Vercel's daily 07:00 UTC cron (vercel.json) with
// CRON_SECRET, the last-resort capture when both pingers are down. The daily chores have their
// own route, /api/cron/daily. The Zenbook's root-level `lazyboy-sync.timer` (the "second ~5-min
// pinger" of 2026-08-06) only ever 401s, stale since the 07-01 rotation (burn lazyboy-review
// 2026-10-03, Z1/Z2). Runs without a session using the stored token, so history stays current
// even when the app hasn't been opened. Callers send `Authorization: Bearer <secret>`; anything
// else is rejected so the endpoint can't be triggered by randoms. Every holder of either secret
// is listed in docs/SECURITY.md.
export async function GET(req: Request) {
  // Fails closed when a secret is unset (cron-auth.ts).
  const caller = cronCaller(req.headers.get("authorization"));
  if (!caller) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  // cron-job.org keeps every reply's body and duration in its execution history, where per-user
  // outcomes, or a reply that took longer because a harvest ran, would record when each person
  // listens, and it disables a job after a run of failures, its 30 s timeout included: it gets a
  // bare {"ok":true} at once, never the outcome or the owner alarm, and the tick runs after the
  // reply (PLAN §7.2 step 0, security R14).
  if (caller === "ext") {
    after(() => tick(caller));
    return Response.json({ ok: true });
  }
  return tick(caller);
}

async function tick(caller: CronCaller): Promise<Response> {
  // Phase 1 has one user, the owner (OWNER_UID); Phase 3's claim hands this tick each due user
  // instead (multi-user PLAN §7.2). No owner configured: capture cannot run, and says so.
  const uid = phase1Owner();
  if (!uid) return Response.json({ ok: false, error: "no owner" }, { status: 503 });
  const store = forUser(uid);
  // The owner alarm, read before the stamp so the Zenbook sees it whichever pinger's tick ran
  // this window (PLAN §7.2 step 0). A store error here is no verdict: the stamp decides.
  if (caller === "zenbook" && (await store.getSpotifyTokens().catch(() => undefined)) === null) {
    return Response.json({ ok: false, error: "no token" }, { status: 503 });
  }
  // The stamp (PLAN §7.2 step 1): one compare-and-set on a meta row, so a burst of calls does
  // one tick's work and a leaked secret called in a loop costs one tick per window. A failed
  // stamp skips the tick: nothing runs past the guard unless it holds the window.
  let stamped: string | null;
  try {
    stamped = await store.acquireLock("tick", TICK_WINDOW_MS);
  } catch (e) {
    console.error("[cron] tick stamp failed", e);
    return Response.json({ ok: true, skipped: "store unavailable" });
  }
  if (!stamped) return Response.json({ ok: true, skipped: "recent tick" });
  // Guarded: this runs OUTSIDE the try below, and a store hiccup inside the token read
  // used to escape as a 500 — feeding the external pinger's auto-disable, the exact storm
  // the 429 branch dodges (wave-2 audit, B5).
  let tokenReadFailed = false;
  const token = await getValidAccessTokenFor(uid).catch((e) => {
    // Logged: a persistent store outage otherwise reads as an endless silent
    // "nobody signed in" (wave-3 adversarial review, F1).
    console.error("[cron] token read failed", e);
    tokenReadFailed = true;
    return null;
  });
  if (!token) {
    // No stored token at all (signed out, or a dead refresh token cleared it): closed-app
    // capture has STOPPED, and a 200 here let the pinger log success for weeks (burn review
    // 2026-10-03, M1). 503 so the pinger's unit fails visibly. A store hiccup or a transient
    // refresh failure still answers 200 — those heal on their own.
    const signedOut =
      !tokenReadFailed && (await store.getSpotifyTokens().then((t) => t === null, () => false));
    if (signedOut) return Response.json({ ok: false, error: "no token" }, { status: 503 });
    return Response.json({ ok: true, skipped: "no token" });
  }
  // Getter for the longer-running work below — re-validates through the shared
  // refresh lock if the run crosses the token's expiry.
  const freshToken = async () => {
    const t = await getValidAccessTokenFor(uid);
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
    const gate = await store.getHarvestGate();
    // `isPlaying`, not just "a track is loaded": currentlyPlaying() reports a PAUSED
    // device too, and `!!state` read a client left paused overnight as active — sustaining
    // the every-2-min harvests the gate exists to stop (audit 2026-08-19, T1.2).
    const playingNow = !!(
      await spotifyClient(uid, token, false, "cron-player-check")
        .currentlyPlaying()
        .catch(() => null)
    )?.isPlaying;
    if (playingNow) await store.setHarvestGate({ lastActive: now });
    // `>=`, not `>`: playing ticks stamp lastActive and lastHarvest with the SAME `now`,
    // so strict-greater made the session-tail branch unreachable — the last plays of every
    // session waited for the hourly backstop (audit 2026-08-19, T1.3). With `>=`, the
    // first idle tick after playback harvests the tail once (equal stamps), then its own
    // fresher lastHarvest closes the branch.
    if (!shouldHarvest(gate, playingNow, now)) {
      return Response.json({ ok: true, added: 0, idle: true });
    }
    // A THROWING harvest still stamps lastHarvest: with `>=` above, an unstamped failure
    // would hold the tail branch open and re-poke the quota'd endpoint every 2 minutes for
    // as long as the failure lasted (wave-2 adversarial review, finding H). Stamping on
    // failure degrades to the hourly backstop — the pre-fix cadence. The cooldown-skip
    // case still deliberately withholds the stamp (it made no Spotify call).
    let harvest: { added: number; skipped?: string };
    try {
      harvest = await syncRecentPlays(spotifyClient(uid, token, false, "cron-sync"), store);
    } catch (e) {
      // Only a SPOTIFY failure stamps: it means a call was actually spent. A store error
      // thrown before the call (the cooldown read) must not burn an hour of harvesting
      // over a 2-minute store blip (wave-3 adversarial review, F2).
      if (e instanceof SpotifyError) await store.setHarvestGate({ lastHarvest: now }).catch(() => {});
      throw e;
    }
    const { added, skipped } = harvest;
    if (!skipped) await store.setHarvestGate({ lastHarvest: now });
    // Attribution for the dominant traffic on this database: ~720 of these a day, and which
    // of the two costs a tick paid depends entirely on whether it landed a play. A skipped
    // tick short-circuits on the cooldown for ~2 rows and is deliberately not ledgered.
    if (!skipped) void store.ledgerSyncCall(added > 0 ? "sync_tick_landed" : "sync_tick_steady", added);
    // Rate-limited/cooling down: don't pile the heavier library scan onto a throttle.
    if (skipped) return Response.json({ ok: true, added, skipped });
    // Heavier, lower-frequency upkeep — each self-gates so this stays cheap on most ticks.
    const library = await maybeSyncLibrary(store, freshToken);
    return Response.json({ ok: true, added, library });
  } catch (e) {
    // A rate-limit is transient and self-heals — never surface it as a 5xx. An external
    // scheduler like cron-job.org auto-disables a job after N consecutive failures, so a
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
