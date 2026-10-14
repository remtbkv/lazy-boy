// Simulation: the multi-tab build-skew wiring of now-playing-context.tsx against the REAL
// decision helpers in src/lib/build-skew.ts (review K1, ~/.claude/burn/20261003/
// lazyboy-review.md). Each Tab method mirrors one provider code path:
//   checkSkew  -> the provider's checkSkew (evaluateSkew + reload stamp)
//   pollOnce   -> pollOnce: probe /api/build when probeDue, then the pinned now-playing poll,
//                 then broadcast { build, authBuild, authAt }
//   onState    -> the "state" branch of bc.onmessage (freshness + ordering gates, then the
//                 relayed ids per relayedReading: apply a match, probe on an unconfirmed mismatch)
//   onRequest  -> the "request" branch (leader answers fresh state or polls)
// Polls are PINNED: a tab's /api/now-playing answers with the tab's own build id. Only
// /api/build reports the current deployment.
import { describe, expect, it } from "vitest";
import {
  evaluateSkew,
  NO_SKEW,
  probeDue,
  relayedReading,
  type SkewSource,
  type SkewStreak,
} from "@/lib/build-skew";

const POLL_MS = 6000;
const FRESH = 30_000;
const T0 = 10_000_000;
const CURRENT = "NEW"; // what /api/build answers after the deploy

type Msg = { build?: string; authBuild?: string; authAt?: number; at: number };

class Tab {
  streak: SkewStreak = NO_SKEW;
  serverBuild?: string;
  authBuild?: string;
  authAt = 0;
  lastProbeAt: number | null = null;
  lastApplied = 0;
  reloads: number[] = [];
  probes = 0;
  polls = 0;
  peer: Tab | null = null;
  constructor(
    public client: string,
    public visible: boolean,
    public leader: boolean,
    private shared: { lastReloadAt: number | null },
  ) {}
  checkSkew(build: string | undefined, source: SkewSource, now: number) {
    if (!build) return;
    if (source === "poll") this.serverBuild = build;
    else this.authBuild = build;
    const d = evaluateSkew({
      clientBuild: this.client,
      serverBuild: build,
      source,
      now,
      streak: this.streak,
      lastReloadAt: this.shared.lastReloadAt,
      visible: this.visible,
      lastInteractionAt: null,
    });
    this.streak = d.streak;
    if (d.reload) {
      this.shared.lastReloadAt = now;
      this.reloads.push(now);
      // A reload fetches the current deployment's bundle and starts from scratch.
      this.client = CURRENT;
      this.streak = NO_SKEW;
      this.serverBuild = this.authBuild = undefined;
      this.authAt = 0;
      this.lastProbeAt = null;
      this.lastApplied = 0;
      if (!this.leader) this.peer?.onRequest(now);
    }
  }
  probe(now: number) {
    this.lastProbeAt = now;
    this.probes++;
    this.authAt = now;
    this.checkSkew(CURRENT, "authoritative", now);
  }
  pollOnce(now: number) {
    this.polls++;
    if (probeDue(now, this.lastProbeAt)) this.probe(now);
    this.checkSkew(this.client, "poll", now); // pinned: the tab's own id
    this.lastApplied = now;
    this.broadcast(now, now);
  }
  broadcast(now: number, at: number) {
    this.peer?.onState(
      { build: this.serverBuild, authBuild: this.authBuild, authAt: this.authBuild ? this.authAt : undefined, at },
      now,
    );
  }
  onState(m: Msg, now: number) {
    if (now - m.at > FRESH || m.at <= this.lastApplied) return;
    this.lastApplied = m.at;
    this.relayed(m.build, "poll", undefined, now);
    this.relayed(m.authBuild, "authoritative", m.authAt, now);
  }
  relayed(build: string | undefined, source: SkewSource, authAt: number | undefined, now: number) {
    const act = relayedReading({
      clientBuild: this.client,
      build,
      source,
      authAt,
      now,
      heldAuthAt: this.authAt,
      lastProbeAt: this.lastProbeAt,
      confirmed: this.streak.authMismatch,
    });
    if (act === "apply") {
      if (source === "authoritative") this.authAt = authAt!;
      this.checkSkew(build, source, now);
    } else if (act === "probe") this.probe(now);
  }
  onRequest(now: number) {
    if (!this.leader) return;
    if (now - this.lastApplied <= FRESH) this.broadcast(now, this.lastApplied);
    else this.pollOnce(now);
  }
}

// The follower's self-rescue: a visible non-leader that hasn't applied a state in 4 poll
// periods polls once itself, checked every 2 poll periods.
function rescueTick(f: Tab, t: number) {
  return f.visible && !f.leader && (t - T0) % (POLL_MS * 2) === 0 && t - f.lastApplied > POLL_MS * 4;
}

describe("build-skew across tabs (K1)", () => {
  it("a visible stale follower of a hidden idle leader reloads within ~8 min", () => {
    const shared = { lastReloadAt: null };
    const L = new Tab("NEW", false, true, shared); // hidden, nothing playing: never polls
    const F = new Tab("OLD", true, false, shared);
    L.peer = F;
    F.peer = L;
    for (let t = T0 + 1000; t <= T0 + 6 * 3600_000 && F.reloads.length === 0; t += 1000) {
      if (rescueTick(F, t)) F.pollOnce(t);
    }
    expect(F.probes).toBeGreaterThan(0);
    expect(F.reloads.length).toBe(1);
    expect(F.reloads[0] - T0).toBeLessThanOrEqual(8 * 60_000);
  });

  it("a hidden stale leader's pre-deploy probe never reloads a fresh visible follower", () => {
    const shared = { lastReloadAt: null };
    const L = new Tab("OLD", false, true, shared); // hidden, playing: polls at track ends
    const F = new Tab("NEW", true, false, shared); // opened after the deploy
    L.peer = F;
    F.peer = L;
    // L's last probe ran 1 min before the deploy, when OLD was current.
    L.authBuild = "OLD";
    L.authAt = T0 - 60_000;
    L.lastProbeAt = T0 - 60_000;
    L.serverBuild = "OLD";
    L.lastApplied = T0 - 60_000;
    L.onRequest(T0); // F's mount-time request
    const TRACK_MS = 210_000;
    for (let t = T0 + 1000; t <= T0 + 3 * 3600_000; t += 1000) {
      if ((t - T0) % TRACK_MS === 0) L.pollOnce(t); // end-of-track poll
      if (rescueTick(F, t)) F.pollOnce(t);
    }
    expect(F.reloads).toEqual([]);
    expect(L.reloads.length).toBe(1); // and the stale leader does get fixed
  });

  it("a VISIBLE stale leader relaying its pre-deploy probe every poll never reloads a fresh follower", () => {
    const shared = { lastReloadAt: null };
    const L = new Tab("OLD", true, true, shared); // polls every 6s, so F is never starved
    const F = new Tab("NEW", true, false, shared);
    L.peer = F;
    F.peer = L;
    L.authBuild = "OLD";
    L.authAt = T0 - 60_000;
    L.lastProbeAt = T0 - 60_000;
    L.serverBuild = "OLD";
    L.lastApplied = T0 - 1000;
    L.onRequest(T0);
    for (let t = T0 + 1000; t <= T0 + 3 * 3600_000; t += 1000) {
      if ((t - T0) % POLL_MS === 0) L.pollOnce(t);
      if (rescueTick(F, t)) F.pollOnce(t);
    }
    expect(F.reloads).toEqual([]);
    expect(L.reloads.length).toBe(1);
    expect(L.reloads[0] - T0).toBeLessThanOrEqual(8 * 60_000);
  });

  it("a non-polling stale follower of a visible fresh leader reloads within ~8 min", () => {
    const shared = { lastReloadAt: null };
    const L = new Tab("NEW", true, true, shared);
    const F = new Tab("OLD", true, false, shared);
    L.peer = F;
    F.peer = L;
    for (let t = T0 + 1000; t <= T0 + 6 * 3600_000 && F.reloads.length === 0; t += 1000) {
      if ((t - T0) % POLL_MS === 0) L.pollOnce(t);
      if (rescueTick(F, t)) F.pollOnce(t);
    }
    expect(F.polls).toBe(0);
    expect(F.reloads.length).toBe(1);
    expect(F.reloads[0] - T0).toBeLessThanOrEqual(8 * 60_000);
  });
});

describe("relayedReading known answers (K1)", () => {
  const base = {
    clientBuild: "NEW",
    build: "NEW",
    source: "authoritative" as SkewSource,
    authAt: T0 - 60_000,
    now: T0,
    heldAuthAt: 0,
    lastProbeAt: null as number | null,
    confirmed: false,
  };
  it("applies a fresh relayed match", () => {
    expect(relayedReading(base)).toBe("apply");
    expect(relayedReading({ ...base, source: "poll", authAt: undefined })).toBe("apply");
  });
  it("ignores a probe relay with no authAt (an older bundle), and a relay with no id", () => {
    expect(relayedReading({ ...base, authAt: undefined })).toBe("ignore");
    expect(relayedReading({ ...base, build: undefined })).toBe("ignore");
  });
  it("ignores a probe reading older than 10 min, and one older than the reading held", () => {
    expect(relayedReading({ ...base, authAt: T0 - 10 * 60_000 - 1 })).toBe("ignore");
    expect(relayedReading({ ...base, authAt: T0 - 10 * 60_000 })).toBe("apply");
    expect(relayedReading({ ...base, heldAuthAt: T0 - 30_000 })).toBe("ignore");
  });
  it("answers an unconfirmed mismatch (poll or probe) with an own probe, at most every 5 min", () => {
    for (const source of ["poll", "authoritative"] as SkewSource[]) {
      const m = { ...base, source, build: "OLD" };
      expect(relayedReading(m)).toBe("probe");
      expect(relayedReading({ ...m, lastProbeAt: T0 - 5 * 60_000 })).toBe("probe");
      expect(relayedReading({ ...m, lastProbeAt: T0 - 60_000 })).toBe("ignore");
    }
  });
  it("applies a mismatch once the tab's own probe has confirmed one", () => {
    expect(relayedReading({ ...base, build: "OLD", source: "poll", confirmed: true, lastProbeAt: T0 })).toBe("apply");
    expect(relayedReading({ ...base, build: "OLD", confirmed: true, lastProbeAt: T0 })).toBe("apply");
    // …but never a probe reading that is too old to trust.
    expect(relayedReading({ ...base, build: "OLD", confirmed: true, authAt: T0 - 11 * 60_000 })).toBe("ignore");
  });
  it("probeDue: first poll, then every 5 min", () => {
    expect(probeDue(T0, null)).toBe(true);
    expect(probeDue(T0, T0 - 5 * 60_000 + 1)).toBe(false);
    expect(probeDue(T0, T0 - 5 * 60_000)).toBe(true);
  });
});
