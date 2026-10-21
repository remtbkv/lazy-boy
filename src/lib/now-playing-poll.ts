// When the now-playing leader polls /api/now-playing next, and who the leader is.
// Framework-free so the timing is known-answer tested with fake timers
// (tests/now-playing-poll.test.ts); now-playing-context.tsx wires it to React.
// docs/NOW_PLAYING_LATENCY.md has the chain, the budget and the measurements.
//
// The one thing that makes a track change show fast without a faster steady rate: a track's
// end is predictable (duration − progress), so the poll is timed to land just after it, and
// if Spotify still reports the old song there, a short burst re-asks until it moves. Manual
// skips are unpredictable and stay bounded by the steady cadence.

/** Playing, tab visible: the steady cadence (a manual skip shows within this + a round trip). */
export const STEADY_MS = 6000;
/** Paused or idle: nothing changes on its own, so ask less often. A visibility return or any
 *  in-app player action polls at once regardless. */
export const PAUSED_MS = 15_000;
export const IDLE_MS = 15_000;
/** How long after the predicted end the boundary poll fires. The anchor is when the previous
 *  reply ARRIVED, which is already later than when Spotify measured the progress. */
export const END_MARGIN_MS = 300;
/** Spotify still reporting the old song at the boundary (its state lags the device): re-ask
 *  this long after each reply, up to BURST_MAX times, then fall back to the steady cadence. */
export const BURST_GAP_MS = 700;
export const BURST_MAX = 6;
/** "Still at the end": the old song with at most this much left counts as Spotify not having
 *  caught up, not as a seek back. */
export const BOUNDARY_SLACK_MS = 1500;
export const MAX_BACKOFF_MS = 60_000;
/** A 429's Retry-After is honored up to this; a multi-hour quota ban still gets one cheap
 *  look every 5 min (the server's cooldown answers it without calling Spotify). */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;
const MAX_SCHEDULE_MS = 20 * 60_000; // sanity cap — no real track runs this long

export type PolledPlaying = {
  track: { id: string };
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
} | null;

export type PollOutcome =
  | { kind: "ok"; playing: PolledPlaying }
  /** Non-200. `retryAfterMs` is set on a 429. */
  | { kind: "error"; retryAfterMs?: number }
  /** The poll was not sent (an optimistic action is suppressing polls); try again after this. */
  | { kind: "skipped"; retryInMs: number };

export type PollState = {
  failures: number;
  /** The track the pending poll was timed to catch the end of, or null. */
  boundaryOf: string | null;
  burstLeft: number;
};

export const INITIAL_POLL_STATE: PollState = { failures: 0, boundaryOf: null, burstLeft: 0 };

/** The delay before the next poll (null = none until something kicks the loop) and the new
 *  state. Hidden tabs only follow track boundaries — the old behaviour, which keeps a hidden
 *  Home tab's play handoff working at ~1 call per track. */
export function planNextPoll(
  state: PollState,
  outcome: PollOutcome,
  visible: boolean,
): { delay: number | null; state: PollState } {
  if (outcome.kind === "skipped") return { delay: Math.max(0, outcome.retryInMs), state };
  if (outcome.kind === "error") {
    const failures = state.failures + 1;
    const backoff = Math.min(STEADY_MS * 2 ** failures, MAX_BACKOFF_MS);
    const delay =
      outcome.retryAfterMs !== undefined
        ? Math.min(Math.max(outcome.retryAfterMs, backoff), MAX_RETRY_AFTER_MS)
        : backoff;
    return { delay, state: { ...state, failures } };
  }
  const p = outcome.playing;
  const calm = { failures: 0, boundaryOf: null, burstLeft: 0 };
  if (!p) return { delay: visible ? IDLE_MS : null, state: calm };
  if (!p.isPlaying) return { delay: visible ? PAUSED_MS : null, state: calm };
  const steady = visible ? STEADY_MS : null;
  if (p.durationMs <= 0) return { delay: steady, state: calm };
  const remaining = Math.max(0, p.durationMs - p.progressMs);
  if (state.boundaryOf === p.track.id && remaining <= BOUNDARY_SLACK_MS) {
    if (state.burstLeft > 0) {
      return {
        delay: BURST_GAP_MS,
        state: { failures: 0, boundaryOf: p.track.id, burstLeft: state.burstLeft - 1 },
      };
    }
    return { delay: steady, state: calm };
  }
  const toEnd = Math.min(remaining + END_MARGIN_MS, MAX_SCHEDULE_MS);
  if (steady === null || toEnd <= steady) {
    return { delay: toEnd, state: { failures: 0, boundaryOf: p.track.id, burstLeft: BURST_MAX } };
  }
  return { delay: steady, state: calm };
}

// ── What reaches the bar (NOW_PLAYING_2S.md L2; its review, M3) ─────────────────────────────
/** A lone empty answer while a song is shown is held: asked again, and applied only when a
 *  second empty answer comes at least this long after the first. Home finishes the shown song
 *  on "nothing playing", and Spotify's player endpoints have answered empty mid-playback. */
export const EMPTY_CONFIRM_MS = 500;
/** A return to the song that just ended, within this long of the change and within
 *  BOUNDARY_SLACK_MS of its end, is Spotify catching up (A → B → A at its end → B), ignored. A
 *  return near its start is a real "previous". */
export const FLIP_BACK_MS = 3_000;

export type ScreenMemory = {
  /** When the first of a run of empty answers came, or null. */
  emptySince: number | null;
  /** The last change applied: the song it left and when. */
  lastChange: { fromId: string; at: number } | null;
};
export const NO_SCREEN_MEMORY: ScreenMemory = { emptySince: null, lastChange: null };

export function screenAnswer(
  shown: PolledPlaying,
  incoming: PolledPlaying,
  now: number,
  mem: ScreenMemory,
): { action: "apply" | "ignore"; mem: ScreenMemory } | { action: "hold"; retryInMs: number; mem: ScreenMemory } {
  if (!incoming) {
    if (!shown) return { action: "apply", mem: { ...mem, emptySince: null } };
    const since = mem.emptySince ?? now;
    if (now - since >= EMPTY_CONFIRM_MS) return { action: "apply", mem: { ...mem, emptySince: null } };
    return { action: "hold", retryInMs: EMPTY_CONFIRM_MS - (now - since) + 100, mem: { ...mem, emptySince: since } };
  }
  const calm = { ...mem, emptySince: null };
  const back = mem.lastChange;
  if (
    shown &&
    back &&
    incoming.track.id === back.fromId &&
    shown.track.id !== incoming.track.id &&
    now - back.at < FLIP_BACK_MS &&
    incoming.durationMs > 0 &&
    incoming.durationMs - incoming.progressMs <= BOUNDARY_SLACK_MS
  ) {
    return { action: "ignore", mem: calm };
  }
  const changed = shown && shown.track.id !== incoming.track.id;
  return { action: "apply", mem: changed ? { ...calm, lastChange: { fromId: shown.track.id, at: now } } : calm };
}

/** A state received `at` (a relayed broadcast, the localStorage cache) with a playing song's
 *  progress moved on to `now`, capped at the song. Home dates a song's start as receipt minus
 *  progress, so an unaged 30-second-old cache paint made the song look 30 s younger. */
export function agePlaying<P extends PolledPlaying>(p: P, at: number, now: number): P {
  if (!p || !p.isPlaying || now <= at) return p;
  const progressMs = p.progressMs + (now - at);
  return { ...p, progressMs: p.durationMs > 0 ? Math.min(p.durationMs, progressMs) : progressMs };
}

/** The longest a Save Queue walk holds the polls (it walks ≤ ~105 steps at ~0.3-0.8 s and gives up
 *  after 15 s stuck); past it the polls resume even if the action never answers. */
export const HOLD_MAX_MS = 3 * 60_000;

/** Hold the polls for the length of `work` (Save Queue's walk: it skips through the queue and
 *  comes back to the song, and every song it passes would otherwise "end" on Home), then release
 *  them, whether the work succeeded or not. `hold(until)` sets the provider's suppression; 0
 *  releases it. */
export async function holdWhile<T>(
  work: () => Promise<T>,
  hold: (until: number) => void,
  now: () => number = Date.now,
): Promise<T> {
  hold(now() + HOLD_MAX_MS);
  try {
    return await work();
  } finally {
    hold(0);
  }
}

/** One timer, at most one request in flight. `kick()` polls now — or, if a request is already
 *  out, once more right after it lands (its answer may predate whatever prompted the kick). */
export class PollLoop {
  private state: PollState = INITIAL_POLL_STATE;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private again = false;
  private stopped = true;

  constructor(
    private readonly poll: () => Promise<PollOutcome>,
    private readonly visible: () => boolean,
  ) {}

  /** `seed` = the last state this tab already holds (a new leader inheriting the old one's
   *  broadcast): the schedule continues from it instead of re-asking at once. */
  start(seed?: { playing: PolledPlaying; at: number }): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.state = INITIAL_POLL_STATE;
    if (!seed) {
      this.kick();
      return;
    }
    const next = planNextPoll(this.state, { kind: "ok", playing: seed.playing }, this.visible());
    this.state = next.state;
    const delay = next.delay === null ? null : Math.max(0, next.delay - (Date.now() - seed.at));
    if (delay === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  stop(): void {
    this.stopped = true;
    this.again = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** Poll now unless a request is already out (its answer is fresh enough): the tab coming
   *  back into view, a newcomer asking for state. */
  wake(): void {
    if (!this.inFlight) this.kick();
  }

  kick(): void {
    if (this.stopped) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.run();
  }

  private async run(): Promise<void> {
    this.inFlight = true;
    let outcome: PollOutcome;
    try {
      outcome = await this.poll();
    } catch {
      outcome = { kind: "error" };
    }
    this.inFlight = false;
    if (this.stopped) return;
    const next = planNextPoll(this.state, outcome, this.visible());
    this.state = next.state;
    if (this.again) {
      this.again = false;
      void this.run();
      return;
    }
    if (next.delay === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, next.delay);
  }
}

/** The subset of the Web Locks API the election uses (a fake in tests). */
export type LockManagerLike = {
  request(
    name: string,
    options: { signal?: AbortSignal; steal?: boolean },
    callback: () => Promise<void>,
  ): Promise<unknown>;
};

/** One leader per browser, and the leader is a VISIBLE tab whenever one exists: `claim()`
 *  steals the lock (call it when the tab becomes visible). The tab it was stolen from hears
 *  `onChange(false)` and queues again, so it takes over when the stealer closes. Before this a
 *  hidden leader kept the lock and a visible follower saw changes only through its ~24 s
 *  rescue poll. */
export function leaderElection(
  locks: LockManagerLike,
  name: string,
  /** A visible tab takes the lead at once; a hidden one queues. */
  visible: boolean,
  onChange: (leader: boolean) => void,
): { claim: () => void; dispose: () => void; isLeader: () => boolean } {
  let gen = 0;
  let disposed = false;
  let leader = false;
  let abortQueued: (() => void) | null = null;
  let releaseHeld: (() => void) | null = null;
  const set = (v: boolean) => {
    if (leader === v) return;
    leader = v;
    onChange(v);
  };
  const enter = (steal: boolean) => {
    if (disposed) return;
    const my = ++gen;
    abortQueued?.();
    abortQueued = null;
    let granted = false;
    const ac = steal ? null : new AbortController();
    if (ac) abortQueued = () => ac.abort();
    locks
      .request(name, ac ? { signal: ac.signal } : { steal: true }, () => {
        granted = true;
        if (disposed || my !== gen) return Promise.resolve();
        abortQueued = null;
        return new Promise<void>((res) => {
          releaseHeld = res;
          set(true);
        });
      })
      .catch(() => {
        // Not granted = we aborted it ourselves (a steal superseding it, or dispose). Granted
        // = it was stolen from us: stand down and wait in line again.
        if (!granted || my !== gen || disposed) return;
        releaseHeld = null;
        set(false);
        enter(false);
      });
  };
  enter(visible);
  return {
    claim: () => {
      if (!leader) enter(true);
    },
    dispose: () => {
      disposed = true;
      abortQueued?.();
      releaseHeld?.();
      releaseHeld = null;
      leader = false;
    },
    isLeader: () => leader,
  };
}

