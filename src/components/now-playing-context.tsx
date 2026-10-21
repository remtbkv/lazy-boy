"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { playerSetPlayingAction } from "@/app/(app)/actions";
import {
  AUTH_MAX_AGE_MS,
  NO_SKEW,
  evaluateSkew,
  probeDue,
  relayedReading,
  type SkewSource,
  type SkewStreak,
} from "@/lib/build-skew";
import { recordAppEvent } from "@/lib/metrics-client";
import { npChange, npChangeMeta } from "@/lib/np-change";
import {
  agePlaying,
  holdWhile,
  leaderElection,
  NO_SCREEN_MEMORY,
  PollLoop,
  screenAnswer,
  STEADY_MS,
  type PollOutcome,
  type ScreenMemory,
} from "@/lib/now-playing-poll";
import { leaveForAnotherUser, namesAnotherUser, userStorageName } from "@/lib/user-storage";
import { useUid } from "@/components/user-context";

export type NowPlayingTrack = {
  id: string;
  title: string;
  artist: string;
  albumImage: string | null;
  /** Album NAME. /api/now-playing returns normTrack's track whole (spotify/resources.ts), so
   *  it has always been on the wire; Home's play handoff needs it to put a finished song in
   *  today's list with its Album column already filled. Optional because playOptimistic builds
   *  a track from a row that may not carry one. */
  album?: string | null;
};
export type Playing = {
  track: NowPlayingTrack;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  context: { name: string; type: string } | null;
  /** Spotify's playback-state `timestamp` (epoch ms on Spotify's clock): a cross-check only. */
  timestamp?: number;
  /** The device is in a private session: Spotify lists none of its plays, so Home mints none. */
  privateSession?: boolean;
} | null;

type NowPlayingValue = {
  playing: Playing;
  refresh: () => void;
  setPlaying: React.Dispatch<React.SetStateAction<Playing>>;
  /** Optimistic play/pause. `progressMs` pins the position at flip time (the header
   *  chip passes its interpolated position so the bar doesn't jump back to the last
   *  polled value). Resolves with the action result so callers can toast failures. */
  toggle: (progressMs?: number) => Promise<{ ok: boolean; error?: string }>;
  /** Show a song as playing now. `startedAt` = when the in-app action behind it went out: the
   *  np-change beacon times click → render from it. */
  playOptimistic: (track: NowPlayingTrack, durationMs?: number, startedAt?: number) => void;
  /** Hold every tab's polls while `work` runs (Save Queue's walk), then poll at once. */
  holdDuring: <T>(work: () => Promise<T>) => Promise<T>;
};

const Ctx = createContext<NowPlayingValue | null>(null);

// Cross-tab messages on the shared BroadcastChannel.
type NPMessage =
  // A poll result. `authAt` is when the sender's /api/build probe ran — the relayed reading
  // keeps its own age instead of looking fresh on receipt (src/lib/build-skew.ts).
  | { type: "state"; playing: Playing; at: number; build?: string; authBuild?: string; authAt?: number }
  | { type: "optimistic"; playing: Playing; until: number; at: number } // a user action
  // Save Queue's walk: no tab polls until `until` (0 = released). Unlike `optimistic`, it may
  // shorten the suppression, which is how the release reaches the other tabs.
  | { type: "hold"; until: number }
  | { type: "request" }; // a new tab asking the leader for the current state

// The channel, the cache key and the leader lock are per user: userStorageName(uid,
// "lb-nowplaying") for the first two and (uid, "lb-nowplaying-leader") for the lock, so two
// users' tabs in one browser neither read nor relay each other's player (multi-user PLAN §6.2
// layer 6).
// How old a cached entry may be and still paint. The cache exists so a NEW tab shows the
// chip instantly while a sibling tab's poll is seconds old — it must never resurrect a dead
// session: a tab reopened a day later painted yesterday's song as "playing now", and that
// stale state flowed into Home's instant-handoff as if freshly observed, minting a phantom
// play stamped with the reopen time (等一個人 5:37 PM, Rem 2026-08-19). 30s covers a
// throttled background leader; anything older waits the ~1s for the live poll.
const CACHE_MAX_AGE_MS = 30_000;
// This bundle's build id (inlined by next.config.ts), and where the last skew reload was
// stamped — the throttle that keeps a broken beacon from reload-looping.
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID;
const RELOAD_STAMP_KEY = "lb-build-reload-at";
// The follower rescue's clock. The leader's own schedule — steady while playing, the poll timed
// to a track's end and its burst, the paused/idle and 429 back-offs — is PollLoop's
// (src/lib/now-playing-poll.ts; docs/NOW_PLAYING_LATENCY.md).
const POLL_MS = STEADY_MS;

// When the player first KNOWS what to show on this page load — the first live answer about
// what's playing, whether that is a track or nothing. Idle counts: "there is nothing playing"
// is the display being ready, not a missing measurement.
//
// Two deliberate exclusions. The instant paint from the localStorage cache does not count (it
// is the last sitting's answer, not this load's), and a soft navigation does not re-mark: this
// provider lives in the (app) layout and keeps polling across routes, so the player is already
// ready when you arrive — a second mark would be measuring the 6s poll cadence, not a wait.
// Module scope is exactly the right lifetime for that: one document load, one mark.
let markedNowPlayingReady = false;
// The np-change beacon's per-tab sequence number: a batch lost on its way to the telemetry
// store shows as a gap (NOW_PLAYING_2S.md REVIEW H4.3).
let npChangeSeq = 0;
function markNowPlayingReady(): void {
  if (markedNowPlayingReady) return;
  markedNowPlayingReady = true;
  try {
    performance.mark("lb:now-playing-ready");
  } catch {
    /* an unsupported API here must never break the player it measures */
  }
}

// Single source of truth for "what's playing". Critically, it's polled by only ONE tab at
// a time — the tab holding the `lb-nowplaying-leader` Web Lock — which broadcasts each
// result to every other tab over a BroadcastChannel. This stops N open tabs from each
// hammering Spotify's `/me/player/currently-playing` every 6s (which shares a rate-limit
// bucket with the login profile fetch and was tripping Spotify's 429). If the browser
// lacks Web Locks / BroadcastChannel, it falls back to per-tab polling.
export function NowPlayingProvider({ children }: { children: React.ReactNode }) {
  const uid = useUid();
  const [playing, setPlaying] = useState<Playing>(null);
  const aliveRef = useRef(true);
  const playingRef = useRef<Playing>(null);
  // After an optimistic change, ignore poll results briefly so a mid-flight 6s poll
  // (carrying the pre-change state) can't clobber it and cause a visible flicker.
  const suppressUntil = useRef(0);
  // Timestamp of the newest state we've applied — so an older broadcast (or a slow poll)
  // can never overwrite a newer one, across tabs.
  const lastAppliedAt = useRef(0);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const isLeaderRef = useRef(false);
  // When the last in-app play went out (the beacon's "in-app" kind), or null.
  const inAppAtRef = useRef<number | null>(null);
  useEffect(() => {
    playingRef.current = playing; // keep the ref current for toggle() without reading state in render
  }, [playing]);

  // The leader's poll loop (null while this tab follows), and a ref-indirection to pollOnce for
  // the BroadcastChannel handlers and the rescue timer, which outlive any one pollOnce.
  const loopRef = useRef<PollLoop | null>(null);
  const pollOnceRef = useRef<() => Promise<PollOutcome>>(async () => ({ kind: "skipped", retryInMs: 0 }));

  // Monotonic guard for our own fetches: a slow older response must not overwrite a newer one.
  const refreshSeq = useRef(0);
  // screenAnswer's memory: a held empty answer, and the last change (for the flip-back rule).
  const screenRef = useRef<ScreenMemory>(NO_SCREEN_MEMORY);

  // Stale-build detection. The poll's reply carries the server's build id; a tab whose own
  // id no longer matches is running a bundle the deploy left behind and must reload itself
  // (docs/GOTCHAS.md "Deployment skew + stale tabs"). Every tab evaluates — followers see
  // the id on the leader's broadcast, so a non-polling tab is covered too.
  const streakRef = useRef<SkewStreak>(NO_SKEW);
  const serverBuildRef = useRef<string | undefined>(undefined);
  const authBuildRef = useRef<string | undefined>(undefined);
  // When the authoritative id was last OBSERVED — by this tab's probe, or by the probe of the
  // tab that relayed it. The visibilitychange re-check replays the refs as if current;
  // replaying a pre-deploy authoritative match with no age bound could clear a genuine skew
  // streak indefinitely while probes fail (audit 2026-08-19, T2.15).
  const authBuildAtRef = useRef(0);
  // This tab's own last /api/build attempt (probeDue's clock).
  const lastProbeAtRef = useRef<number | null>(null);
  const lastInteractionRef = useRef<number | null>(null);

  const checkSkew = useCallback((serverBuild: string | undefined, source: SkewSource) => {
    // No beacon = no information (an older server, a probe that didn't come back). Leave the
    // streak untouched rather than reading silence as either agreement or skew.
    if (!serverBuild) return;
    if (source === "poll") serverBuildRef.current = serverBuild;
    else authBuildRef.current = serverBuild;
    let lastReloadAt: number | null = null;
    try {
      const raw = localStorage.getItem(RELOAD_STAMP_KEY);
      if (raw) lastReloadAt = Number(raw) || null;
    } catch {
      /* storage unavailable */
    }
    const now = Date.now();
    const decision = evaluateSkew({
      clientBuild: BUILD_ID,
      serverBuild,
      source,
      now,
      streak: streakRef.current,
      lastReloadAt,
      visible: document.visibilityState === "visible",
      lastInteractionAt: lastInteractionRef.current,
    });
    streakRef.current = decision.streak;
    if (decision.reload) {
      try {
        localStorage.setItem(RELOAD_STAMP_KEY, String(now));
      } catch {
        /* storage unavailable — the debounce still bounds the rate */
      }
      location.reload();
    }
  }, []);

  // The unpinned reading: no credentials means no deployment-pinning cookie, so this lands on
  // the CURRENT deployment even when everything else this tab does is pinned to an old one.
  // Cheap (no auth, no DB) but not free, so it rides the existing poll — whichever tab polls,
  // at most every PROBE_EVERY_MS (probeDue) — rather than a timer of its own.
  const probeCurrentBuild = useCallback(async () => {
    lastProbeAtRef.current = Date.now();
    try {
      const res = await fetch("/api/build", { credentials: "omit", cache: "no-store" });
      if (!res.ok) return;
      const { build } = (await res.json()) as { build?: string };
      authBuildAtRef.current = Date.now();
      checkSkew(build, "authoritative");
    } catch {
      /* transient — the next tick probes again */
    }
  }, [checkSkew]);

  // Interaction is what defers a reload, and hiding the tab is what un-defers it: a hidden
  // tab stops polling, so without this re-check a deferred reload would wait for the tab to
  // be looked at again — exactly the tab we most want to reload.
  useEffect(() => {
    const touch = () => {
      lastInteractionRef.current = Date.now();
    };
    const onVisibilityChange = () => {
      checkSkew(serverBuildRef.current, "poll");
      // Replay the authoritative reading only while it's reasonably current (2 probe
      // periods) — an undated replay could keep absolving a genuinely stale tab.
      if (Date.now() - authBuildAtRef.current < AUTH_MAX_AGE_MS) {
        checkSkew(authBuildRef.current, "authoritative");
      }
    };
    window.addEventListener("pointerdown", touch, { passive: true, capture: true });
    window.addEventListener("keydown", touch, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pointerdown", touch, { capture: true });
      window.removeEventListener("keydown", touch, { capture: true });
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkSkew]);

  // Post a message on the shared channel (+ mirror state to localStorage so a brand-new tab
  // can paint instantly before the leader answers its `request`).
  const broadcast = useCallback((msg: NPMessage) => {
    try {
      bcRef.current?.postMessage(msg);
    } catch {
      /* channel closed */
    }
    if (msg.type === "state" || msg.type === "optimistic") {
      try {
        localStorage.setItem(
          userStorageName(uid, "lb-nowplaying"),
          JSON.stringify({ playing: msg.playing, at: msg.at }),
        );
      } catch {
        /* storage unavailable */
      }
    }
  }, [uid]);

  // Apply an incoming shared state, honoring suppression, monotonic ordering — and AGE.
  // The age gate lives HERE, not just on the localStorage seed: the leader's `request`
  // answer carries whatever it last applied, hours old if that tab has been hidden, and a
  // fresh tab (lastAppliedAt = 0) used to accept it. That was the still-open phantom-play
  // vector after the 2026-08-19 cache fix — same laundering, sibling path (audit T1.1).
  // A rejected stale state costs nothing: the newcomer's own live poll answers within ~1s.
  const applyShared = useCallback((p: Playing, at: number) => {
    if (Date.now() - at > CACHE_MAX_AGE_MS) return;
    if (Date.now() < suppressUntil.current) return;
    if (at <= lastAppliedAt.current) return;
    lastAppliedAt.current = at;
    // Its progress is as old as `at`: move it on, or Home dates the song's start late.
    if (aliveRef.current) setPlaying(agePlaying(p, at, Date.now()));
  }, []);

  // One network poll (the leader's PollLoop, a follower's rescue, ad-hoc refresh()). On
  // success, updates locally AND broadcasts so every other tab updates without its own fetch.
  // The outcome is what the loop schedules the next poll from.
  const pollOnce = useCallback(async (): Promise<PollOutcome> => {
    if (Date.now() < suppressUntil.current) {
      return { kind: "skipped", retryInMs: suppressUntil.current - Date.now() + 50 };
    }
    // Whichever tab is polling probes too — the leader, or a follower's one-off refresh (a
    // starved follower now takes the lead instead). A leader-only probe left a visible stale follower of a hidden idle leader with no
    // probe at all (review K1). Other tabs get the reading off this tab's broadcast.
    if (probeDue(Date.now(), lastProbeAtRef.current)) void probeCurrentBuild();
    const seq = ++refreshSeq.current;
    try {
      const sentAt = Date.now();
      const res = await fetch("/api/now-playing", { cache: "no-store" });
      if (!res.ok) {
        const retryAfterS = res.status === 429 ? Number(res.headers.get("Retry-After")) : NaN;
        return Number.isFinite(retryAfterS) && retryAfterS > 0
          ? { kind: "error", retryAfterMs: retryAfterS * 1000 }
          : { kind: "error" };
      }
      const data = (await res.json()) as { playing: Playing; build?: string; u?: string };
      const receivedAt = Date.now();
      // The browser's cookie names someone else now (a sign-in in another tab): this answer is
      // theirs, so it is neither shown, cached nor relayed, and the page reloads as theirs.
      if (namesAnotherUser(data, uid)) {
        leaveForAnotherUser(uid);
        return { kind: "error" };
      }
      // The answer is here. Marked before the ordering/suppression guards below for the same
      // reason checkSkew is: those decide whether to DISPLAY this reply, not whether it landed.
      markNowPlayingReady();
      // Independent of the ordering/suppression guards below: the build id is about this
      // tab's code, not about what's playing, and a superseded reply reports it just as well.
      checkSkew(data.build, "poll");
      if (aliveRef.current && seq === refreshSeq.current && Date.now() >= suppressUntil.current) {
        // A lone empty answer is asked again before Home finishes the song on it, and a flip back
        // to the song that just ended is ignored (now-playing-poll.ts screenAnswer).
        const screened = screenAnswer(playingRef.current, data.playing, Date.now(), screenRef.current);
        screenRef.current = screened.mem;
        if (screened.action === "hold") return { kind: "skipped", retryInMs: screened.retryInMs };
        if (screened.action === "ignore") return { kind: "ok", playing: playingRef.current };
        const shown = playingRef.current;
        const shownAt = lastAppliedAt.current;
        const at = Date.now();
        lastAppliedAt.current = at;
        setPlaying(data.playing);
        // np-change: an upper bound on change → render for a song change this visible tab shows
        // (lib/np-change.ts). The frame after the state is set stands in for the render.
        const next = data.playing;
        if (next && document.visibilityState === "visible") {
          requestAnimationFrame(() => {
            const c = npChange({ shown, shownAt, next, sentAt, receivedAt, renderedAt: Date.now(), inAppAt: inAppAtRef.current });
            if (c) recordAppEvent("np-change", npChangeMeta(c, "poll", ++npChangeSeq), c.value);
          });
        }
        broadcast({
          type: "state",
          playing: data.playing,
          at,
          build: data.build,
          authBuild: authBuildRef.current,
          authAt: authBuildAtRef.current,
        });
      }
      return { kind: "ok", playing: data.playing };
    } catch {
      /* transient — keep the last known state rather than flicker */
      return { kind: "error" };
    }
  }, [broadcast, checkSkew, probeCurrentBuild, uid]);

  useEffect(() => {
    pollOnceRef.current = pollOnce;
  }, [pollOnce]);

  // Ad-hoc refresh (after next/prev, or when an optimistic action fails). The leader routes it
  // through its loop (one request in flight; an answer already on its way may predate the
  // action, so the loop asks once more after it). A follower runs a one-off fetch — it's
  // user-initiated and rare, so it doesn't reintroduce the poll storm.
  const refresh = useCallback(() => {
    if (loopRef.current?.running) loopRef.current.kick();
    else void pollOnce();
  }, [pollOnce]);

  useEffect(() => {
    aliveRef.current = true;
    const canCoordinate =
      typeof BroadcastChannel !== "undefined" &&
      typeof navigator !== "undefined" &&
      "locks" in navigator;

    const isVisible = () => document.visibilityState === "visible";
    const loop = new PollLoop(() => pollOnceRef.current(), isVisible);
    loopRef.current = loop;
    let election: ReturnType<typeof leaderElection> | null = null;

    // Coming back to the tab is exactly when a stale display is most visible to the user, so
    // re-poll immediately on return instead of waiting out the rest of the cadence. A follower
    // coming into view takes the lead first (a hidden leader only polls track boundaries).
    const onVisible = () => {
      if (!isVisible()) return;
      if (isLeaderRef.current) loop.wake();
      else election?.claim();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    // Fallback for browsers without Web Locks / BroadcastChannel: poll per tab (old behavior).
    // This tab is its own de-facto leader — there's no election to lose.
    if (!canCoordinate) {
      isLeaderRef.current = true;
      loop.start();
      return () => {
        aliveRef.current = false;
        isLeaderRef.current = false;
        loop.stop();
        loopRef.current = null;
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", onVisible);
      };
    }

    const bc = new BroadcastChannel(userStorageName(uid, "lb-nowplaying"));
    bcRef.current = bc;

    // Paint instantly from the shared cache while we wait for a live answer.
    try {
      const cached = localStorage.getItem(userStorageName(uid, "lb-nowplaying"));
      if (cached) {
        const { playing: p, at } = JSON.parse(cached) as { playing: Playing; at: number };
        if (Date.now() - at < CACHE_MAX_AGE_MS) applyShared(p, at);
      }
    } catch {
      /* ignore */
    }

    // A build id another tab relayed. The sender may be the stale one (its pinned poll and
    // its pre-deploy probe both report its old id), so a mismatch only counts once this
    // tab's own probe has seen one; until then it prompts that probe (relayedReading).
    const onRelayed = (build: string | undefined, source: SkewSource, authAt?: number) => {
      const act = relayedReading({
        clientBuild: BUILD_ID,
        build,
        source,
        authAt,
        now: Date.now(),
        heldAuthAt: authBuildAtRef.current,
        lastProbeAt: lastProbeAtRef.current,
        confirmed: streakRef.current.authMismatch,
      });
      if (act === "apply") {
        if (source === "authoritative" && authAt !== undefined) authBuildAtRef.current = authAt;
        checkSkew(build, source);
      } else if (act === "probe") {
        void probeCurrentBuild();
      }
    };

    bc.onmessage = (e: MessageEvent<NPMessage>) => {
      const msg = e.data;
      if (msg.type === "state") {
        applyShared(msg.playing, msg.at);
        // Freshness-gated: a STALE state message (a hidden leader answering `request` with
        // hours-old state) must neither count as "the first live answer" nor feed its
        // equally-old build ids into skew clearing — a replayed pre-deploy "authoritative"
        // match could absolve a genuine streak forever (audit 2026-08-19, T1.1/T2.15).
        if (Date.now() - msg.at <= CACHE_MAX_AGE_MS) {
          markNowPlayingReady();
          // Authoritative goes LAST: it is the one reading allowed to clear the streak, so
          // it must land after the poll id it overrules.
          onRelayed(msg.build, "poll");
          onRelayed(msg.authBuild, "authoritative", msg.authAt);
        }
      } else if (msg.type === "optimistic") {
        // A user action elsewhere — apply it and match its suppression so neither this tab's
        // view nor the leader's next poll clobbers it before Spotify catches up.
        suppressUntil.current = Math.max(suppressUntil.current, msg.until);
        if (msg.at > lastAppliedAt.current) {
          lastAppliedAt.current = msg.at;
          if (aliveRef.current) setPlaying(msg.playing);
        }
      } else if (msg.type === "hold") {
        suppressUntil.current = msg.until;
        if (msg.until === 0 && isLeaderRef.current) loop.kick();
      } else if (msg.type === "request" && isLeaderRef.current) {
        // Only the leader answers a newcomer — and only with state fresh enough to trust.
        // A hidden leader answering with hours-old state was the request-path phantom
        // vector; a stale-holding leader now polls instead, and the poll's own broadcast
        // reaches the newcomer with genuinely current state (audit 2026-08-19, T1.1).
        if (Date.now() - lastAppliedAt.current <= CACHE_MAX_AGE_MS) {
          broadcast({
            type: "state",
            playing: playingRef.current,
            at: lastAppliedAt.current,
            build: serverBuildRef.current,
            authBuild: authBuildRef.current,
            authAt: authBuildAtRef.current,
          });
        } else {
          loop.wake();
        }
      }
    };

    // Ask whoever's leading for the current state (covers a fresh non-leader tab).
    broadcast({ type: "request" });

    // Follower self-rescue: every poll trigger is gated on the LEADER's visibility, so a
    // visible follower whose leader is hidden used to freeze — its chip showed the last
    // broadcast forever (audit 2026-08-19, T2.15). A visible tab that hasn't applied a
    // fresh state in 4 poll periods takes the lead (its first poll broadcasts, so one rescue
    // feeds every other starved tab). The visibilitychange steal covers a tab brought forward;
    // this covers a window that was already visible when the leader's window was hidden.
    const rescue = setInterval(() => {
      if (document.visibilityState !== "visible" || isLeaderRef.current) return;
      if (Date.now() - lastAppliedAt.current > POLL_MS * 4) election?.claim();
    }, POLL_MS * 2);

    // Leader election: the lock holder is the sole poller. A visible tab takes the lock (from a
    // hidden holder too); a hidden one queues and takes over when the holder closes. A new
    // leader holding a state under one steady period old continues that schedule rather than
    // asking again at once — tab switches between two app tabs cost no extra request.
    election = leaderElection(navigator.locks, userStorageName(uid, "lb-nowplaying-leader"), isVisible(), (lead) => {
      isLeaderRef.current = lead;
      if (!lead) {
        loop.stop();
        return;
      }
      const at = lastAppliedAt.current;
      loop.start(Date.now() - at < POLL_MS ? { playing: playingRef.current, at } : undefined);
    });

    return () => {
      aliveRef.current = false;
      isLeaderRef.current = false;
      clearInterval(rescue);
      loop.stop();
      loopRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      election?.dispose(); // release the lock if we held it → another tab becomes leader
      bc.close();
      bcRef.current = null;
    };
  }, [applyShared, broadcast, checkSkew, probeCurrentBuild, uid]);

  // Show a track as playing immediately (e.g. double-click a song); the next poll confirms.
  const playOptimistic = useCallback(
    (track: NowPlayingTrack, durationMs = 0, startedAt?: number) => {
      const until = Date.now() + 2000;
      suppressUntil.current = until;
      const next: Playing = { track, isPlaying: true, progressMs: 0, durationMs, context: null };
      const at = Date.now();
      lastAppliedAt.current = at;
      setPlaying(next);
      broadcast({ type: "optimistic", playing: next, until, at });
      if (startedAt === undefined) return;
      inAppAtRef.current = startedAt;
      // The in-app path's beacon: click → render, the action's round trip included.
      if (document.visibilityState === "visible") {
        requestAnimationFrame(() => {
          const renderedAt = Date.now();
          const c = { value: renderedAt - startedAt, kind: "in-app" as const, pNew: 0, rtt: at - startedAt, render: renderedAt - at, lagHint: 0 };
          recordAppEvent("np-change", npChangeMeta(c, "in-app", ++npChangeSeq), c.value);
        });
      }
    },
    [broadcast],
  );

  const holdDuring = useCallback(
    <T,>(work: () => Promise<T>): Promise<T> =>
      holdWhile(work, (until) => {
        suppressUntil.current = until;
        broadcast({ type: "hold", until });
        if (until === 0) refresh();
      }),
    [broadcast, refresh],
  );

  // Toggle play/pause for whatever's playing (track-list row button + header chip).
  // Owns the optimistic flip AND the poll suppression — callers that flip state on
  // their own would race the 6s poll (a mid-flight response would snap the icon back).
  const toggle = useCallback(
    async (progressMs?: number) => {
      const cur = playingRef.current;
      if (!cur) return { ok: true };
      const nextPlaying = !cur.isPlaying;
      const until = Date.now() + 2000;
      suppressUntil.current = until;
      const optimistic: Playing = {
        ...cur,
        isPlaying: nextPlaying,
        ...(progressMs !== undefined ? { progressMs } : {}),
      };
      const at = Date.now();
      lastAppliedAt.current = at;
      setPlaying(optimistic);
      broadcast({ type: "optimistic", playing: optimistic, until, at });
      const r = await playerSetPlayingAction(nextPlaying);
      if (!r.ok) {
        suppressUntil.current = 0; // failed → drop the optimistic flip, show real state
        refresh();
      }
      return r;
    },
    [broadcast, refresh],
  );

  return (
    <Ctx.Provider value={{ playing, refresh, setPlaying, toggle, playOptimistic, holdDuring }}>
      {children}
    </Ctx.Provider>
  );
}

export function useNowPlaying(): NowPlayingValue {
  const v = useContext(Ctx);
  // Inert fallback if used outside the provider (shouldn't happen in the app shell).
  return (
    v ?? {
      playing: null,
      refresh: () => {},
      setPlaying: () => {},
      toggle: async () => ({ ok: true }),
      playOptimistic: () => {},
      holdDuring: (work) => work(),
    }
  );
}
