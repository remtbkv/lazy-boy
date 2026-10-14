// When to reload a tab that is running an old build.
//
// A tab left open across a deploy keeps its old bundle forever, and keeps calling whatever
// that code called: one such tab burned ~2.55M Turso rows/h, flat, for 15+ hours on Aug 7→8.
// So the build tells the tab who it is, and the tab checks.
//
// TWO SOURCES, and the difference between them is the whole design:
//
//   • "poll" — the build id `/api/now-playing` returns on the 6s poll the app already makes.
//     Free, immediate, and untrustworthy in one direction: Vercel's skew protection pins a
//     tab's requests to the deployment it was served from, so a stale tab's poll answers
//     with the stale tab's own id. Its "match" therefore means nothing.
//   • "authoritative" — `/api/build`, fetched with `credentials: "omit"` so the pinning
//     cookie never goes out and the request reaches the CURRENT deployment (~every 5 min).
//     This one can be believed both ways.
//
// Hence the asymmetry below: an authoritative match clears the streak; a poll match clears
// only a streak no unpinned probe has contradicted. Authoritative mismatch alongside poll
// match is not a contradiction to average away — it is the signature of a pinned tab, and it
// counts as mismatch.
//
// The decision is pure so it can be tested against known answers (scripts/test-build-skew.mjs);
// the caller owns the clock, the stored stamp and the actual location.reload().
//
// Three brakes, each for a different failure:
//   • debounce — a deploy mid-propagation can serve mixed old/new responses. Only a mismatch
//     held CONTINUOUSLY for MISMATCH_GRACE_MS reloads, so a flapping edge can't.
//   • throttle — if the beacon itself is ever broken (say the ids can never agree), one
//     reload per RELOAD_THROTTLE_MS bounds the damage to a slow blink, not a reload loop.
//   • deferral — never yank the page out from under someone using it. While the tab is
//     visible and was touched within INTERACTION_IDLE_MS the reload waits; the streak keeps
//     running, so it fires at the next idle or hidden moment instead.

export const MISMATCH_GRACE_MS = 3 * 60_000;
export const RELOAD_THROTTLE_MS = 10 * 60_000;
export const INTERACTION_IDLE_MS = 60_000;

/** Where a build id came from — see the two-sources note above. */
export type SkewSource = "poll" | "authoritative";

export type SkewStreak = {
  /** Start of the current uninterrupted mismatch streak, or null if there isn't one. */
  since: number | null;
  /** An unpinned probe reported a mismatch during this streak — so a poll "match" is a
   *  pinned-tab artifact and must not clear it. */
  authMismatch: boolean;
};

export const NO_SKEW: SkewStreak = { since: null, authMismatch: false };

export type SkewInput = {
  /** This bundle's build id. */
  clientBuild: string | undefined;
  /** The build id just observed. */
  serverBuild: string | undefined;
  source: SkewSource;
  now: number;
  streak: SkewStreak;
  /** When this browser last reloaded for skew (localStorage), or null if never. */
  lastReloadAt: number | null;
  visible: boolean;
  /** Last pointer/key interaction in this tab, or null if none since load. */
  lastInteractionAt: number | null;
};

export type SkewDecision = {
  /** The streak to carry into the next evaluation. */
  streak: SkewStreak;
  reload: boolean;
};

export function evaluateSkew(input: SkewInput): SkewDecision {
  const { clientBuild, serverBuild, source, now, streak } = input;

  // No signal (an older server with no beacon, a probe that failed to parse) is evidence of
  // nothing. Carry the streak through untouched — silence must neither reload nor absolve.
  if (!clientBuild || !serverBuild) return { streak, reload: false };

  // Agreement is only believed from the unpinned probe, or from a poll no probe has yet
  // contradicted. A poll that agrees while a probe says otherwise is not a tie to average
  // away — a pinned tab answering itself is what that looks like — so it falls through as
  // mismatch evidence and keeps the streak running toward its reload.
  if (clientBuild === serverBuild && (source === "authoritative" || !streak.authMismatch)) {
    return { streak: NO_SKEW, reload: false };
  }

  const since = streak.since ?? now;
  const next: SkewStreak = {
    since,
    authMismatch: streak.authMismatch || source === "authoritative",
  };

  if (now - since < MISMATCH_GRACE_MS) return { streak: next, reload: false };

  // A stamp in the FUTURE (corrupt storage, a clock step) must not suppress reloads
  // indefinitely — only a genuine recent past reload throttles (wave-3 independent suite).
  const sinceReload = input.lastReloadAt !== null ? now - input.lastReloadAt : null;
  if (sinceReload !== null && sinceReload >= 0 && sinceReload < RELOAD_THROTTLE_MS) {
    return { streak: next, reload: false };
  }

  const busy =
    input.visible &&
    input.lastInteractionAt !== null &&
    now - input.lastInteractionAt < INTERACTION_IDLE_MS;
  if (busy) return { streak: next, reload: false };

  return { streak: next, reload: true };
}

// ── Who probes, and which relayed probes count ─────────────────────────────────────────────
// Only polls reach the server, and which tab polls changes: the leader while visible or at a
// track end, a starved visible follower on its self-rescue. So the probe rides whichever tab
// actually polls, on a wall clock per tab — a leader-only poll counter left a visible stale
// follower of a hidden idle leader with no probe at all, forever (review K1, 2026-10-03).
export const PROBE_EVERY_MS = 5 * 60_000;
// A probe's answer describes the deployment at the moment it ran. Relayed to another tab it
// keeps that age: re-stamped as fresh on receipt, a hidden old leader's pre-deploy probe kept
// telling a fresh follower it was stale, once per throttle window, for hours (review K1).
export const AUTH_MAX_AGE_MS = 10 * 60_000;

/** Whether a tab about to poll should also probe /api/build. `lastProbeAt` is this tab's own
 *  last attempt (successful or not), so a failing probe still waits its turn. */
export function probeDue(now: number, lastProbeAt: number | null): boolean {
  return lastProbeAt === null || now - lastProbeAt >= PROBE_EVERY_MS;
}

export type RelayedReading = {
  /** This bundle's build id. */
  clientBuild: string | undefined;
  /** A build id another tab relayed: its poll's id, or its probe's answer. */
  build: string | undefined;
  source: SkewSource;
  /** When the relayed probe ran. Absent from bundles older than this field — their probe
   *  relays can't be dated, so they are not believed. Unused for poll ids. */
  authAt?: number;
  now: number;
  /** When this tab's newest probe reading (own or relayed) was taken; 0 if none. */
  heldAuthAt: number;
  /** This tab's own last probe attempt, for probeDue. */
  lastProbeAt: number | null;
  /** This tab's own probe has already reported a mismatch in the current streak
   *  (streak.authMismatch — only an own probe can set it, see "probe" below). */
  confirmed: boolean;
};

/** What a tab does with a build id relayed by another tab.
 *  "apply" — feed it to evaluateSkew. A MATCH always applies (it is what lets a relay clear a
 *  streak); a MISMATCH applies only once this tab's own probe has confirmed one.
 *  "probe" — an unconfirmed MISMATCH. The sender may be the stale one: a stale leader's
 *  pinned poll reports its own old id, and up to AUTH_MAX_AGE_MS after a deploy its
 *  pre-deploy probe still reads as fresh — either would mark a tab loaded since then as
 *  stale. So the tab asks /api/build itself (when due), and its own answer decides.
 *  "ignore" — no id; a probe reading undated, too old, or older than one this tab holds; or
 *  an unconfirmed mismatch while this tab's own probe isn't due. */
export function relayedReading(r: RelayedReading): "apply" | "probe" | "ignore" {
  if (!r.build) return "ignore";
  if (r.source === "authoritative") {
    if (r.authAt === undefined) return "ignore";
    if (r.now - r.authAt > AUTH_MAX_AGE_MS || r.authAt < r.heldAuthAt) return "ignore";
  }
  if (r.build === r.clientBuild || r.confirmed) return "apply";
  return probeDue(r.now, r.lastProbeAt) ? "probe" : "ignore";
}
