// When to reload a tab that is running an old build.
//
// The now-playing poll carries the SERVER's build id; the client compares it with its own
// (`NEXT_PUBLIC_BUILD_ID`, inlined by next.config.ts). A mismatch means this tab's bundle
// predates the deployed one — it will keep executing the old client code, and calling
// whatever the old code called, for as long as it stays open. Left alone that is unbounded:
// one such tab polling twice a minute for 15 h is what burned ~38M Turso rows on Aug 7→8.
//
// The decision is pure so it can be tested against known answers (scripts/test-build-skew.mjs);
// the caller owns the clock, the stored stamp and the actual location.reload().
//
// Three brakes, each for a different failure:
//   • debounce — a deploy mid-propagation can serve mixed old/new responses. Only a mismatch
//     seen CONTINUOUSLY for MISMATCH_GRACE_MS reloads, so a flapping edge can't.
//   • throttle — if the beacon itself is ever broken (say the ids can never agree), one
//     reload per RELOAD_THROTTLE_MS bounds the damage to a slow blink, not a reload loop.
//   • deferral — never yank the page out from under someone using it. While the tab is
//     visible and was touched within INTERACTION_IDLE_MS the reload waits; the streak keeps
//     running, so it fires at the next idle or hidden moment instead.

export const MISMATCH_GRACE_MS = 3 * 60_000;
export const RELOAD_THROTTLE_MS = 10 * 60_000;
export const INTERACTION_IDLE_MS = 60_000;

export type SkewInput = {
  /** This bundle's build id. */
  clientBuild: string | undefined;
  /** The build id the server just reported. */
  serverBuild: string | undefined;
  now: number;
  /** Start of the current uninterrupted mismatch streak, or null if there isn't one. */
  mismatchSince: number | null;
  /** When this browser last reloaded for skew (localStorage), or null if never. */
  lastReloadAt: number | null;
  visible: boolean;
  /** Last pointer/key interaction in this tab, or null if none since load. */
  lastInteractionAt: number | null;
};

export type SkewDecision = {
  /** The streak start to carry into the next evaluation. */
  mismatchSince: number | null;
  reload: boolean;
};

export function evaluateSkew(input: SkewInput): SkewDecision {
  const { clientBuild, serverBuild, now } = input;

  // No signal (an old server with no beacon, a build id that never got inlined) is not
  // evidence of skew. Silence must never reload.
  if (!clientBuild || !serverBuild) return { mismatchSince: null, reload: false };
  if (clientBuild === serverBuild) return { mismatchSince: null, reload: false };

  const mismatchSince = input.mismatchSince ?? now;
  if (now - mismatchSince < MISMATCH_GRACE_MS) return { mismatchSince, reload: false };

  if (input.lastReloadAt !== null && now - input.lastReloadAt < RELOAD_THROTTLE_MS) {
    return { mismatchSince, reload: false };
  }

  const busy =
    input.visible &&
    input.lastInteractionAt !== null &&
    now - input.lastInteractionAt < INTERACTION_IDLE_MS;
  if (busy) return { mismatchSince, reload: false };

  return { mismatchSince, reload: true };
}
