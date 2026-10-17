// Phase 3's probe and harvest policy (docs/multi-user/PLAN.md §7.2-7.4), pure, in place of the
// single-user harvest gate. Known answers in tests/harvest-policy.test.ts.
//
// The probe is `/me/player` alone: it reports the active device's track, and 204 only when no
// device is active (GOTCHAS "Player simulation"). What it last saw lives in the user's own
// `meta` (`probe`), written only when the track or the play state changes, so a probe that
// changes nothing writes nothing (scale 8). A **track change** is a different track id, the same
// track with progress lower than the time since the last write allows (a repeat), or playback
// stopped (the session tail).
//
// A harvest is one recently-played call (the last 50 plays). Each is tagged with the trigger
// that fired, which `api_log.source` records as `harvest:<trigger>` for Phase 3's soak.
import type { BrakeMode } from "@/lib/brake";

/** What `/me/player` answered: null for a 204 (no active device). */
export type PlayerObservation = { trackId: string | null; isPlaying: boolean; progressMs: number } | null;

/** The user's `meta.probe`. Times are epoch ms. */
export type ProbeState = {
  v: 1;
  /** The last track seen; kept when the device goes away, so a resume is not a change. */
  track: string | null;
  /** Its progress at `at`. */
  progressMs: number;
  /** When this state was written: the anchor a repeat is measured from. */
  at: number;
  /** When playback was seen stopped (paused or no device); null while playing. */
  stoppedAt: number | null;
  /** Track changes since the last harvest that landed. */
  changes: number;
  /** A session tail waiting for its harvest. */
  tail: boolean;
  /** The tail's one retry, due at this time. */
  retryAt: number | null;
};

export type HarvestTrigger = "change" | "tail" | "tail-retry" | "completeness" | "backstop" | "open-app";

// A report or clock lag of a few seconds is not a repeat.
const REPEAT_SLACK_MS = 10_000;

export function observe(
  prev: ProbeState | null,
  obs: PlayerObservation,
  now: number,
): { next: ProbeState; write: boolean; change: boolean } {
  const playingNow = obs !== null && obs.isPlaying;
  const trackNow = obs?.trackId ?? null;
  const progressNow = obs?.progressMs ?? 0;
  if (!prev) {
    return {
      next: {
        v: 1,
        track: trackNow,
        progressMs: progressNow,
        at: now,
        stoppedAt: playingNow ? null : now,
        changes: 0,
        tail: false,
        retryAt: null,
      },
      write: true,
      change: false,
    };
  }
  const wasPlaying = prev.stoppedAt === null;
  const newTrack = trackNow !== null && trackNow !== prev.track;
  // Where the same track would be had it simply played on since the last write.
  const expected = prev.progressMs + (wasPlaying ? now - prev.at : 0);
  const repeat = !newTrack && playingNow && trackNow === prev.track && progressNow < expected - REPEAT_SLACK_MS;
  const stopped = wasPlaying && !playingNow;
  const change = newTrack || repeat || stopped;
  if (!change && playingNow === wasPlaying) return { next: prev, write: false, change: false };
  return {
    next: {
      v: 1,
      track: trackNow ?? prev.track,
      progressMs: obs ? progressNow : prev.progressMs,
      at: now,
      stoppedAt: playingNow ? null : wasPlaying ? now : prev.stoppedAt,
      changes: prev.changes + (change ? 1 : 0),
      tail: prev.tail || stopped,
      retryAt: prev.retryAt,
    },
    write: true,
    change,
  };
}

/** Half of the 50-play window (B §7.4): fires whatever the brake says. */
export const COMPLETENESS_CHANGES = 25;
/** The session tail's one retry (§7.4, late listings: p95 end-to-stored 300 s). */
export const TAIL_RETRY_MS = 5 * 60_000;
/** Every due time counts 30 s early, so a late tick does not stretch two minutes to four. */
export const EARLY_MS = 30_000;
/** Opening the app harvests a change the brake held back, at most this often (B's H4). */
const OPEN_APP_MIN_GAP_MS = 60_000;
/** A player-endpoint refusal (§7.8): users active in the last 3 hours, every 30 minutes. */
const BLIND_ACTIVE_MS = 3 * 3_600_000;
const BLIND_EVERY_MS = 30 * 60_000;
const BATCH_MS: Record<BrakeMode, number> = { normal: 0, share: 15 * 60_000, all: 30 * 60_000 };

export type HarvestInput = {
  now: number;
  /** The probe state after this tick's observation, or the stored one when the probe failed. */
  probe: ProbeState | null;
  /** False when `/me/player` could not be asked (refused, cooling down, failed). */
  probeOk: boolean;
  lastHarvestAt: number | null;
  brake: BrakeMode;
  /** Hourly until the first friend, 2 hours from Phase 4a (§7.4). */
  backstopMs: number;
  /** The recently-played bucket's cooldown (`app_meta` `cooldown:recently-played`). */
  cooldownUntil: number;
  /** A load or a return to the tab (/api/sync, §7.6). */
  openApp: boolean;
};

/** Which trigger fires, or null. Ordered so a harvest the cron would make anyway is tagged as
 *  the cron's, and `open-app` marks only the catch-ups opening the app added. */
export function decideHarvest(i: HarvestInput): HarvestTrigger | null {
  if (i.now < i.cooldownUntil) return null;
  const since = i.lastHarvestAt === null ? Infinity : i.now - i.lastHarvestAt;
  const p = i.probe;
  if (p?.tail) return "tail";
  if (p && p.changes >= COMPLETENESS_CHANGES) return "completeness";
  if (p && p.changes > 0 && since >= BATCH_MS[i.brake]) return "change";
  if (p?.retryAt != null && i.now >= p.retryAt - EARLY_MS) return "tail-retry";
  if (since >= i.backstopMs) return "backstop";
  if (!i.probeOk && p && (p.stoppedAt === null || i.now - p.stoppedAt <= BLIND_ACTIVE_MS) && since >= BLIND_EVERY_MS) {
    return "backstop";
  }
  if (i.openApp && p && p.changes > 0 && since >= OPEN_APP_MIN_GAP_MS) return "open-app";
  return null;
}

/** The probe state once a harvest has landed: every change it covered is cleared, and a tail
 *  harvest books its one retry. Any other harvest covers a pending retry. */
export function afterHarvest(p: ProbeState, trigger: HarvestTrigger, now: number): ProbeState {
  return { ...p, changes: 0, tail: false, retryAt: trigger === "tail" ? now + TAIL_RETRY_MS : null };
}

// ── cadence (§7.2; decision 28 as ruled: every user every 2 minutes, whatever N) ─────────────

export const PROBE_EVERY_MS = 2 * 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

/** FNV-1a over the uid: where in the 2-minute cycle this user's probes fall, so users spread
 *  across the even and odd minutes' ticks. */
export function uidPhase(uid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < uid.length; i++) {
    h ^= uid.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % PROBE_EVERY_MS;
}

/** The next due time after a step claimed at `tickAt`. Two minutes after the due time it served,
 *  so a tick a minute (both pingers) or every two minutes (either alone) probes each user every
 *  two minutes. A user who fell behind (first step, an outage, a backoff) rejoins at their own
 *  phase, more than 90 s out, so the next minute's tick does not take them again. */
export function nextDue(uid: string, prevDue: number, tickAt: number): number {
  const next = prevDue + PROBE_EVERY_MS;
  if (next > tickAt + EARLY_MS) return next;
  const from = tickAt + 3 * EARLY_MS;
  const phase = uidPhase(uid);
  const k = Math.floor((from - phase) / PROBE_EVERY_MS) + 1;
  return k * PROBE_EVERY_MS + phase;
}

/** `backoff` after the n-th failure in a row: 2, 4, 8 … 60 minutes. */
export function backoffMs(failures: number): number {
  return Math.min(PROBE_EVERY_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

const ACTIVE_WINDOW_MS = 30 * 60_000;

/** `sync_state.state` for a step that succeeded: `active` within 30 minutes of a play. */
export function syncStateFor(p: ProbeState | null, now: number): "active" | "idle" {
  if (p && (p.stoppedAt === null || now - p.stoppedAt <= ACTIVE_WINDOW_MS)) return "active";
  return "idle";
}
