// decideHarvest with Phase 3's defaults, for tests/brake.test.ts.
import { decideHarvest as decide, type HarvestInput, type ProbeState } from "@/lib/harvest-policy";

export function state0(over: Partial<ProbeState> = {}): ProbeState {
  return { v: 1, track: "x", progressMs: 0, at: 0, stoppedAt: null, changes: 0, tail: false, retryAt: null, ...over };
}

export function decideHarvest(i: Partial<HarvestInput> & Pick<HarvestInput, "now" | "brake">) {
  return decide({
    probe: state0(),
    probeOk: true,
    lastHarvestAt: null,
    backstopMs: 3_600_000,
    cooldownUntil: 0,
    openApp: false,
    ...i,
  });
}
