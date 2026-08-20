// The recently-played harvest decision, extracted from the cron route so the one subtle
// boolean (two audit findings lived in it: paused-as-playing, and the `>` that made the
// session-tail branch unreachable) is a pure, known-answer-testable function.
//
// The contract, matching the stamping rules in src/app/api/cron/sync/route.ts:
//   - a PLAYING tick stamps lastActive = now, harvests, and stamps lastHarvest = now
//     (equal stamps);
//   - the first IDLE tick after playback sees lastActive >= lastHarvest (equal) → harvests
//     the session's tail once, and its own fresher lastHarvest closes the branch;
//   - a cooldown-skipped harvest withholds the lastHarvest stamp (no Spotify call was
//     made), so the branch stays open and retries next tick;
//   - a THROWING harvest still stamps (route-side), or the open branch would re-poke the
//     quota'd endpoint every tick for the length of the failure;
//   - the hourly backstop covers devices the probe can't see.

export type HarvestGate = { lastActive: number; lastHarvest: number };

export const HARVEST_BACKSTOP_MS = 60 * 60 * 1000;

export function shouldHarvest(gate: HarvestGate, playingNow: boolean, now: number): boolean {
  return (
    playingNow || gate.lastActive >= gate.lastHarvest || now - gate.lastHarvest > HARVEST_BACKSTOP_MS
  );
}
