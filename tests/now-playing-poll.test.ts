// Known answers for the now-playing poll schedule (src/lib/now-playing-poll.ts): when the
// leader asks /api/now-playing next, that only one tab asks, and how fast a track change is
// seen. Fake timers drive a scripted Spotify: a request leaves at t, Spotify samples the
// player at t + SAMPLE_MS (the route's auth + token read), the reply lands at t + RTT_MS.
// docs/NOW_PLAYING_LATENCY.md quotes the latency table the last describe block prints.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BURST_GAP_MS,
  BURST_MAX,
  END_MARGIN_MS,
  IDLE_MS,
  INITIAL_POLL_STATE,
  leaderElection,
  MAX_RETRY_AFTER_MS,
  PAUSED_MS,
  planNextPoll,
  PollLoop,
  STEADY_MS,
  type LockManagerLike,
  type PolledPlaying,
  type PollOutcome,
} from "@/lib/now-playing-poll";

const SAMPLE_MS = 200;
const RTT_MS = 300;

const playing = (id: string, progressMs: number, durationMs: number, isPlaying = true): PolledPlaying => ({
  track: { id },
  isPlaying,
  progressMs,
  durationMs,
});

// A scripted player: tracks back to back from t=0. `lagMs` is how long after a change
// Spotify's API keeps reporting the old song (pinned at its end).
type Track = { id: string; durationMs: number };
function player(tracks: Track[], lagMs = 0) {
  const starts: number[] = [];
  let t = 0;
  for (const tr of tracks) {
    starts.push(t);
    t += tr.durationMs;
  }
  return (at: number): PolledPlaying => {
    for (let i = tracks.length - 1; i >= 0; i--) {
      if (at >= starts[i] + (i === 0 ? 0 : lagMs)) {
        const tr = tracks[i];
        return playing(tr.id, Math.min(at - starts[i], tr.durationMs), tr.durationMs);
      }
    }
    return null;
  };
}

// A poll against the scripted player that records when each request left and what came back.
function scriptedPoll(stateAt: (t: number) => PolledPlaying, log: { sentAt: number; landedAt: number; p: PolledPlaying }[]) {
  return async (): Promise<PollOutcome> => {
    const sentAt = Date.now();
    const p = stateAt(sentAt + SAMPLE_MS);
    await new Promise((r) => setTimeout(r, RTT_MS));
    log.push({ sentAt, landedAt: Date.now(), p });
    return { kind: "ok", playing: p };
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("planNextPoll", () => {
  it("mid-track and visible: the steady cadence", () => {
    const r = planNextPoll(INITIAL_POLL_STATE, { kind: "ok", playing: playing("a", 10_000, 200_000) }, true);
    expect(r.delay).toBe(STEADY_MS);
    expect(r.state.boundaryOf).toBeNull();
  });

  it("a track ending inside the steady gap: the poll lands at its end plus the margin", () => {
    const r = planNextPoll(INITIAL_POLL_STATE, { kind: "ok", playing: playing("a", 196_000, 200_000) }, true);
    expect(r.delay).toBe(4000 + END_MARGIN_MS);
    expect(r.state).toEqual({ failures: 0, boundaryOf: "a", burstLeft: BURST_MAX });
  });

  it("Spotify still on the old song at the boundary: a short burst, bounded", () => {
    let s = { failures: 0, boundaryOf: "a", burstLeft: BURST_MAX };
    const stuck: PollOutcome = { kind: "ok", playing: playing("a", 200_000, 200_000) };
    const delays: (number | null)[] = [];
    for (let i = 0; i <= BURST_MAX; i++) {
      const r = planNextPoll(s, stuck, true);
      delays.push(r.delay);
      s = r.state;
    }
    expect(delays).toEqual([...Array(BURST_MAX).fill(BURST_GAP_MS), STEADY_MS]);
  });

  it("a seek back at the boundary re-arms the end poll instead of bursting", () => {
    const s = { failures: 0, boundaryOf: "a", burstLeft: BURST_MAX };
    const r = planNextPoll(s, { kind: "ok", playing: playing("a", 197_000, 200_000) }, true);
    expect(r.delay).toBe(3000 + END_MARGIN_MS);
  });

  it("paused and idle poll slowly; hidden, they do not poll at all", () => {
    const paused: PollOutcome = { kind: "ok", playing: playing("a", 50_000, 200_000, false) };
    const idle: PollOutcome = { kind: "ok", playing: null };
    expect(planNextPoll(INITIAL_POLL_STATE, paused, true).delay).toBe(PAUSED_MS);
    expect(planNextPoll(INITIAL_POLL_STATE, idle, true).delay).toBe(IDLE_MS);
    expect(planNextPoll(INITIAL_POLL_STATE, paused, false).delay).toBeNull();
    expect(planNextPoll(INITIAL_POLL_STATE, idle, false).delay).toBeNull();
  });

  it("hidden and playing: only the track boundary", () => {
    const r = planNextPoll(INITIAL_POLL_STATE, { kind: "ok", playing: playing("a", 100_000, 200_000) }, false);
    expect(r.delay).toBe(100_000 + END_MARGIN_MS);
  });

  it("a 429 waits out Retry-After, capped; plain errors back off exponentially", () => {
    const r429 = planNextPoll(INITIAL_POLL_STATE, { kind: "error", retryAfterMs: 30_000 }, true);
    expect(r429.delay).toBe(30_000);
    const ban = planNextPoll(INITIAL_POLL_STATE, { kind: "error", retryAfterMs: 3 * 3600_000 }, true);
    expect(ban.delay).toBe(MAX_RETRY_AFTER_MS);
    const short = planNextPoll(INITIAL_POLL_STATE, { kind: "error", retryAfterMs: 1000 }, true);
    expect(short.delay).toBe(2 * STEADY_MS); // never sooner than the error backoff
    let s = INITIAL_POLL_STATE;
    const delays: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const r = planNextPoll(s, { kind: "error" }, true);
      delays.push(r.delay);
      s = r.state;
    }
    expect(delays).toEqual([12_000, 24_000, 48_000, 60_000, 60_000]);
    // One good answer resets it.
    expect(planNextPoll(s, { kind: "ok", playing: playing("a", 0, 200_000) }, true).delay).toBe(STEADY_MS);
  });
});

describe("PollLoop", () => {
  it("a track ending at t is seen at about t + margin + one round trip", async () => {
    const log: { sentAt: number; landedAt: number; p: PolledPlaying }[] = [];
    const stateAt = player([
      { id: "a", durationMs: 20_000 },
      { id: "b", durationMs: 200_000 },
    ]);
    const loop = new PollLoop(scriptedPoll(stateAt, log), () => true);
    loop.start();
    await vi.advanceTimersByTimeAsync(25_000);
    loop.stop();
    const firstB = log.find((x) => x.p?.track.id === "b")!;
    // The boundary is at 20,000. The reply that last saw "a" landed at L with progress
    // sampled at L − 100, so the end poll leaves within ~100 ms of 20,000 + margin.
    expect(firstB.sentAt).toBeGreaterThanOrEqual(20_000 + END_MARGIN_MS - SAMPLE_MS);
    expect(firstB.landedAt - 20_000).toBeLessThanOrEqual(END_MARGIN_MS + RTT_MS + 150);
  });

  it("Spotify lagging 1.2 s at the boundary: the burst catches it within one gap + round trip", async () => {
    const log: { sentAt: number; landedAt: number; p: PolledPlaying }[] = [];
    const stateAt = player(
      [
        { id: "a", durationMs: 20_000 },
        { id: "b", durationMs: 200_000 },
      ],
      1200,
    );
    const loop = new PollLoop(scriptedPoll(stateAt, log), () => true);
    loop.start();
    await vi.advanceTimersByTimeAsync(30_000);
    loop.stop();
    const firstB = log.find((x) => x.p?.track.id === "b")!;
    // Visible to the API from 21,200; a poll leaves at least every BURST_GAP + RTT.
    expect(firstB.landedAt - 21_200).toBeLessThanOrEqual(BURST_GAP_MS + 2 * RTT_MS);
  });

  it("paused polls every PAUSED_MS", async () => {
    let n = 0;
    const loop = new PollLoop(async () => {
      n++;
      return { kind: "ok", playing: playing("a", 50_000, 200_000, false) };
    }, () => true);
    loop.start();
    await vi.advanceTimersByTimeAsync(60_000);
    loop.stop();
    expect(n).toBe(1 + Math.floor(60_000 / PAUSED_MS)); // 5, against 11 at the steady rate
  });

  it("a 429 backs off for Retry-After before the next request", async () => {
    const sent: number[] = [];
    const loop = new PollLoop(async () => {
      sent.push(Date.now());
      return sent.length === 1
        ? { kind: "error", retryAfterMs: 30_000 }
        : { kind: "ok", playing: playing("a", 0, 200_000) };
    }, () => true);
    loop.start();
    await vi.advanceTimersByTimeAsync(40_000);
    loop.stop();
    expect(sent.slice(0, 3)).toEqual([0, 30_000, 36_000]);
  });

  it("keeps one request in flight: a kick during a request runs once, right after it", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sent: number[] = [];
    const loop = new PollLoop(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      sent.push(Date.now());
      await new Promise((r) => setTimeout(r, 1000));
      inFlight--;
      return { kind: "ok", playing: playing("a", 0, 200_000) };
    }, () => true);
    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    loop.kick();
    loop.kick();
    await vi.advanceTimersByTimeAsync(3000);
    loop.stop();
    expect(maxInFlight).toBe(1);
    expect(sent).toEqual([0, 1000]); // the two kicks coalesce into one follow-up
  });
});

// A Web Locks stand-in with the two behaviours the election relies on: a queue, and steal
// (the holder's request promise rejects with AbortError, the stealer is granted at once).
class FakeLocks implements LockManagerLike {
  private holder: { reject: (e: unknown) => void; resolve: () => void } | null = null;
  private queue: { cb: () => Promise<void>; resolve: () => void; reject: (e: unknown) => void }[] = [];
  request(_name: string, opts: { signal?: AbortSignal; steal?: boolean }, cb: () => Promise<void>) {
    return new Promise<void>((resolve, reject) => {
      const entry = { cb, resolve, reject };
      if (opts.steal) {
        this.holder?.reject(new DOMException("stolen", "AbortError"));
        this.holder = null;
        this.grant(entry);
        return;
      }
      if (!this.holder) {
        this.grant(entry);
        return;
      }
      this.queue.push(entry);
      opts.signal?.addEventListener("abort", () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) {
          this.queue.splice(i, 1);
          reject(new DOMException("aborted", "AbortError"));
        }
      });
    });
  }
  private grant(entry: { cb: () => Promise<void>; resolve: () => void; reject: (e: unknown) => void }) {
    const held = { reject: entry.reject, resolve: entry.resolve };
    this.holder = held;
    void entry.cb().then(() => {
      if (this.holder !== held) return; // stolen meanwhile; already rejected
      this.holder = null;
      entry.resolve();
      const next = this.queue.shift();
      if (next) this.grant(next);
    });
  }
}

describe("one leader polls for every tab", () => {
  // `shared.last` stands in for the BroadcastChannel: every tab holds the leader's last answer,
  // and a tab that takes the lead continues the schedule from it (PollLoop.start's seed).
  type Shared = { n: number; last?: { playing: PolledPlaying; at: number } };
  function tab(locks: FakeLocks, visible: boolean, shared: Shared) {
    const t = { visible, loop: null as PollLoop | null, election: null as ReturnType<typeof leaderElection> | null };
    t.loop = new PollLoop(async () => {
      shared.n++;
      const p = playing("a", 0, 200_000);
      shared.last = { playing: p, at: Date.now() };
      return { kind: "ok", playing: p };
    }, () => t.visible);
    t.election = leaderElection(locks, "lb-nowplaying-leader", visible, (lead) => {
      if (lead) t.loop!.start(shared.last);
      else t.loop!.stop();
    });
    return t;
  }

  it("two tabs make one request per tick", async () => {
    const locks = new FakeLocks();
    const counter: Shared = { n: 0 };
    const a = tab(locks, true, counter);
    await vi.advanceTimersByTimeAsync(0);
    const b = tab(locks, true, counter); // opened in front: takes the lead, inherits the schedule
    await vi.advanceTimersByTimeAsync(60_000);
    expect(counter.n).toBe(1 + Math.floor(60_000 / STEADY_MS)); // 11, as for one tab
    expect([a.election!.isLeader(), b.election!.isLeader()].filter(Boolean)).toHaveLength(1);
  });

  it("a tab becoming visible takes the lead from a hidden leader; still one request per tick", async () => {
    const locks = new FakeLocks();
    const counter: Shared = { n: 0 };
    const a = tab(locks, true, counter);
    await vi.advanceTimersByTimeAsync(1000);
    const b = tab(locks, false, counter); // opened in the background: queues
    expect(a.election!.isLeader()).toBe(true);
    expect(b.election!.isLeader()).toBe(false);
    // A goes to the background, B comes forward.
    a.visible = false;
    b.visible = true;
    b.election!.claim();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.election!.isLeader()).toBe(true);
    expect(a.election!.isLeader()).toBe(false);
    expect(a.loop!.running).toBe(false);
    // A last asked at 0; B continues that cadence: 6 s, 12 s, … 60 s — no extra handover poll.
    const before = counter.n;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(counter.n - before).toBe(Math.floor(60_000 / STEADY_MS));
    // B closes: A, queued again after the steal, takes over.
    b.election!.dispose();
    b.loop!.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.election!.isLeader()).toBe(true);
  });
});

// The chain before and after, on the same scripted player and the same round trip. "Before" is
// the provider as it ran until this change: a 6 s setInterval, plus one poll at the reply's
// remaining + 1000 ms, with no retry when Spotify had not moved yet and overlapping requests
// allowed (only the newest one applied).
async function oldSchedule(stateAt: (t: number) => PolledPlaying, phaseMs: number, untilMs: number) {
  const seen: { landedAt: number; p: PolledPlaying }[] = [];
  let seq = 0;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  const pollOnce = async () => {
    const my = ++seq;
    const p = stateAt(Date.now() + SAMPLE_MS);
    await new Promise((r) => setTimeout(r, RTT_MS));
    if (my !== seq) return;
    seen.push({ landedAt: Date.now(), p });
    if (endTimer) clearTimeout(endTimer);
    endTimer = null;
    if (!p?.isPlaying || p.durationMs <= 0) return;
    const remaining = p.durationMs - p.progressMs;
    if (remaining <= 0) return;
    endTimer = setTimeout(() => void pollOnce(), remaining + 1000);
  };
  let interval: ReturnType<typeof setInterval> | null = null;
  setTimeout(() => {
    void pollOnce();
    interval = setInterval(() => void pollOnce(), STEADY_MS);
  }, phaseMs);
  await vi.advanceTimersByTimeAsync(untilMs);
  if (interval) clearInterval(interval);
  if (endTimer) clearTimeout(endTimer);
  return seen;
}

async function newSchedule(stateAt: (t: number) => PolledPlaying, phaseMs: number, untilMs: number) {
  const log: { sentAt: number; landedAt: number; p: PolledPlaying }[] = [];
  const loop = new PollLoop(scriptedPoll(stateAt, log), () => true);
  setTimeout(() => loop.start(), phaseMs);
  await vi.advanceTimersByTimeAsync(untilMs);
  loop.stop();
  return log;
}

const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

describe("track change → seen: before and after (the doc's table)", () => {
  // Track "a" ends at 60 s. The page opened at every 100 ms phase of the 6 s cadence.
  const BOUNDARY = 60_000;
  const tracks = [
    { id: "a", durationMs: BOUNDARY },
    { id: "b", durationMs: 200_000 },
  ];
  const phases = Array.from({ length: 60 }, (_, i) => i * 100);

  for (const lag of [0, 500, 1500]) {
    it(`natural end, Spotify lag ${lag} ms`, async () => {
      const stateAt = player(tracks, lag);
      const before: number[] = [];
      const after: number[] = [];
      let callsBefore = 0;
      let callsAfter = 0;
      for (const ph of phases) {
        vi.setSystemTime(0);
        const o = await oldSchedule(stateAt, ph, BOUNDARY + 20_000);
        before.push(o.find((x) => x.p?.track.id === "b")!.landedAt - BOUNDARY);
        callsBefore += o.length;
        vi.setSystemTime(0);
        const n = await newSchedule(stateAt, ph, BOUNDARY + 20_000);
        after.push(n.find((x) => x.p?.track.id === "b")!.landedAt - BOUNDARY);
        callsAfter += n.length;
      }
      console.log(
        `[latency] lag=${lag}ms before p50=${pct(before, 0.5)} p95=${pct(before, 0.95)} max=${Math.max(...before)}` +
          ` | after p50=${pct(after, 0.5)} p95=${pct(after, 0.95)} max=${Math.max(...after)}` +
          ` | polls per 80 s: before ${(callsBefore / phases.length).toFixed(1)}, after ${(callsAfter / phases.length).toFixed(1)}`,
      );
      // The target: seen within ~1 s of the change when Spotify reports it promptly, and
      // never worse than before.
      if (lag === 0) expect(pct(after, 0.95)).toBeLessThanOrEqual(END_MARGIN_MS + RTT_MS + 150);
      expect(pct(after, 0.95)).toBeLessThanOrEqual(pct(before, 0.95));
      expect(Math.max(...after)).toBeLessThanOrEqual(lag + BURST_GAP_MS + 2 * RTT_MS + END_MARGIN_MS);
    });
  }
});
