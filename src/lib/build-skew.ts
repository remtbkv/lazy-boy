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
