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
import { evaluateSkew } from "@/lib/build-skew";

export type NowPlayingTrack = {
  id: string;
  title: string;
  artist: string;
  albumImage: string | null;
};
export type Playing = {
  track: NowPlayingTrack;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  context: { name: string; type: string } | null;
} | null;

type NowPlayingValue = {
  playing: Playing;
  refresh: () => void;
  setPlaying: React.Dispatch<React.SetStateAction<Playing>>;
  /** Optimistic play/pause. `progressMs` pins the position at flip time (the header
   *  chip passes its interpolated position so the bar doesn't jump back to the last
   *  polled value). Resolves with the action result so callers can toast failures. */
  toggle: (progressMs?: number) => Promise<{ ok: boolean; error?: string }>;
  playOptimistic: (track: NowPlayingTrack, durationMs?: number) => void;
};

const Ctx = createContext<NowPlayingValue | null>(null);

// Cross-tab messages on the shared BroadcastChannel.
type NPMessage =
  | { type: "state"; playing: Playing; at: number; build?: string } // a real poll result
  | { type: "optimistic"; playing: Playing; until: number; at: number } // a user action
  | { type: "request" }; // a new tab asking the leader for the current state

const CHANNEL = "lb-nowplaying";
const CACHE_KEY = "lb-nowplaying";
const LEADER_LOCK = "lb-nowplaying-leader";
// This bundle's build id (inlined by next.config.ts), and where the last skew reload was
// stamped — the throttle that keeps a broken beacon from reload-looping.
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID;
const RELOAD_STAMP_KEY = "lb-build-reload-at";
const POLL_MS = 6000;
// A track boundary is predictable (progress + duration are both known), so instead of
// waiting up to POLL_MS for the steady interval to notice a song change, the poller that
// owns real network calls (leader, or the sole tab in the no-Web-Locks fallback) schedules
// ONE extra poll timed to land just after the current track is expected to end. This is
// additive, not a faster steady rate: at most one extra Spotify call per track, and it's
// rescheduled (not stacked) on every poll.
const END_OF_TRACK_BUFFER_MS = 1000;
const MAX_SCHEDULE_MS = 20 * 60 * 1000; // sanity cap — no real track runs this long

// Single source of truth for "what's playing". Critically, it's polled by only ONE tab at
// a time — the tab holding the `lb-nowplaying-leader` Web Lock — which broadcasts each
// result to every other tab over a BroadcastChannel. This stops N open tabs from each
// hammering Spotify's `/me/player/currently-playing` every 6s (which shares a rate-limit
// bucket with the login profile fetch and was tripping Spotify's 429). If the browser
// lacks Web Locks / BroadcastChannel, it falls back to per-tab polling.
export function NowPlayingProvider({ children }: { children: React.ReactNode }) {
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
  useEffect(() => {
    playingRef.current = playing; // keep the ref current for toggle() without reading state in render
  }, [playing]);

  // The pending end-of-track timer, and a ref-indirection to pollOnce so scheduling it
  // doesn't create a circular useCallback dependency (pollOnce schedules it; it calls
  // pollOnce back).
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollOnceRef = useRef<() => Promise<void>>(async () => {});

  // Monotonic guard for our own fetches: a slow older response must not overwrite a newer one.
  const refreshSeq = useRef(0);

  // Stale-build detection. The poll's reply carries the server's build id; a tab whose own
  // id no longer matches is running a bundle the deploy left behind and must reload itself
  // (docs/GOTCHAS.md "Deployment skew + stale tabs"). Every tab evaluates — followers see
  // the id on the leader's broadcast, so a non-polling tab is covered too.
  const mismatchSinceRef = useRef<number | null>(null);
  const serverBuildRef = useRef<string | undefined>(undefined);
  const lastInteractionRef = useRef<number | null>(null);

  const checkSkew = useCallback((serverBuild: string | undefined) => {
    // No beacon = no information (an older server, a mid-propagation reply). Leave the
    // streak untouched rather than reading silence as either agreement or skew.
    if (!serverBuild) return;
    serverBuildRef.current = serverBuild;
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
      now,
      mismatchSince: mismatchSinceRef.current,
      lastReloadAt,
      visible: document.visibilityState === "visible",
      lastInteractionAt: lastInteractionRef.current,
    });
    mismatchSinceRef.current = decision.mismatchSince;
    if (decision.reload) {
      try {
        localStorage.setItem(RELOAD_STAMP_KEY, String(now));
      } catch {
        /* storage unavailable — the debounce still bounds the rate */
      }
      location.reload();
    }
  }, []);

  // Interaction is what defers a reload, and hiding the tab is what un-defers it: a hidden
  // tab stops polling, so without this re-check a deferred reload would wait for the tab to
  // be looked at again — exactly the tab we most want to reload.
  useEffect(() => {
    const touch = () => {
      lastInteractionRef.current = Date.now();
    };
    const onVisibilityChange = () => checkSkew(serverBuildRef.current);
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
    if (msg.type !== "request") {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ playing: msg.playing, at: msg.at }));
      } catch {
        /* storage unavailable */
      }
    }
  }, []);

  // Apply an incoming shared state, honoring both suppression and monotonic ordering.
  const applyShared = useCallback((p: Playing, at: number) => {
    if (Date.now() < suppressUntil.current) return;
    if (at <= lastAppliedAt.current) return;
    lastAppliedAt.current = at;
    if (aliveRef.current) setPlaying(p);
  }, []);

  // Arm (or re-arm) the one-shot end-of-track poll from a freshly polled state. Only the
  // tab actually doing real network calls (leader, or the fallback path's sole tab — both
  // mark themselves via isLeaderRef) should call this; every poll result rearms it, so it
  // always reflects the current track rather than stacking timers across song changes.
  const scheduleEndOfTrackPoll = useCallback((p: Playing) => {
    if (endTimerRef.current) {
      clearTimeout(endTimerRef.current);
      endTimerRef.current = null;
    }
    if (!p?.isPlaying || p.durationMs <= 0) return;
    const remaining = p.durationMs - p.progressMs;
    if (remaining <= 0) return;
    const delay = Math.min(remaining + END_OF_TRACK_BUFFER_MS, MAX_SCHEDULE_MS);
    endTimerRef.current = setTimeout(() => {
      endTimerRef.current = null;
      void pollOnceRef.current();
    }, delay);
  }, []);

  // One network poll (used by the leader's interval, its end-of-track timer, visibility/focus
  // re-polls, and ad-hoc refresh()). On success, updates locally AND broadcasts so every other
  // tab updates without its own fetch.
  const pollOnce = useCallback(async () => {
    if (Date.now() < suppressUntil.current) return;
    const seq = ++refreshSeq.current;
    try {
      const res = await fetch("/api/now-playing", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { playing: Playing; build?: string };
      // Independent of the ordering/suppression guards below: the build id is about this
      // tab's code, not about what's playing, and a superseded reply reports it just as well.
      checkSkew(data.build);
      if (aliveRef.current && seq === refreshSeq.current && Date.now() >= suppressUntil.current) {
        const at = Date.now();
        lastAppliedAt.current = at;
        setPlaying(data.playing);
        broadcast({ type: "state", playing: data.playing, at, build: data.build });
        // Only the owner of real polling schedules the next boundary poll — otherwise every
        // open tab would independently hit Spotify at track boundaries, multiplying the rate
        // the leader election exists to prevent.
        if (isLeaderRef.current) scheduleEndOfTrackPoll(data.playing);
      }
    } catch {
      /* transient — keep the last known state rather than flicker */
    }
  }, [broadcast, scheduleEndOfTrackPoll, checkSkew]);

  // Keep the ref-indirection current so scheduleEndOfTrackPoll's timeout always calls the
  // latest pollOnce without depending on it directly (see the comment above it).
  useEffect(() => {
    pollOnceRef.current = pollOnce;
  }, [pollOnce]);

  // Ad-hoc refresh (after next/prev, or when an optimistic action fails). Any tab may run a
  // one-off fetch — it's user-initiated and rare, so it doesn't reintroduce the poll storm.
  const refresh = useCallback(() => {
    void pollOnce();
  }, [pollOnce]);

  useEffect(() => {
    aliveRef.current = true;
    const canCoordinate =
      typeof BroadcastChannel !== "undefined" &&
      typeof navigator !== "undefined" &&
      "locks" in navigator;

    // Coming back to the tab is exactly when a stale display is most visible to the user, so
    // re-poll immediately on return instead of waiting out the rest of the steady interval.
    // Gated the same way as the end-of-track timer: only the tab actually doing real network
    // calls acts on it.
    const onVisible = () => {
      if (document.visibilityState === "visible" && isLeaderRef.current) void pollOnce();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    // Fallback for browsers without Web Locks / BroadcastChannel: poll per tab (old behavior).
    // This tab is its own de-facto leader — there's no election to lose — so it also owns the
    // end-of-track and visibility polls.
    if (!canCoordinate) {
      isLeaderRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void pollOnce();
      const id = setInterval(() => {
        if (document.visibilityState === "visible") void pollOnce();
      }, POLL_MS);
      return () => {
        aliveRef.current = false;
        isLeaderRef.current = false;
        if (endTimerRef.current) clearTimeout(endTimerRef.current);
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", onVisible);
        clearInterval(id);
      };
    }

    const bc = new BroadcastChannel(CHANNEL);
    bcRef.current = bc;

    // Paint instantly from the shared cache while we wait for a live answer.
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const { playing: p, at } = JSON.parse(cached) as { playing: Playing; at: number };
        applyShared(p, at);
      }
    } catch {
      /* ignore */
    }

    bc.onmessage = (e: MessageEvent<NPMessage>) => {
      const msg = e.data;
      if (msg.type === "state") {
        applyShared(msg.playing, msg.at);
        // A follower never fetches, so the leader's broadcast is its only view of the
        // server's build id.
        checkSkew(msg.build);
      } else if (msg.type === "optimistic") {
        // A user action elsewhere — apply it and match its suppression so neither this tab's
        // view nor the leader's next poll clobbers it before Spotify catches up.
        suppressUntil.current = Math.max(suppressUntil.current, msg.until);
        if (msg.at > lastAppliedAt.current) {
          lastAppliedAt.current = msg.at;
          if (aliveRef.current) setPlaying(msg.playing);
        }
      } else if (msg.type === "request" && isLeaderRef.current) {
        // Only the leader answers a newcomer, with the freshest state it has.
        broadcast({
          type: "state",
          playing: playingRef.current,
          at: lastAppliedAt.current,
          build: serverBuildRef.current,
        });
      }
    };

    // Ask whoever's leading for the current state (covers a fresh non-leader tab).
    broadcast({ type: "request" });

    // Leader election: the tab that acquires the lock is the sole poller and holds the lock
    // until it unmounts/closes; then a queued tab takes over.
    const ac = new AbortController();
    let release: () => void = () => {};
    const held = new Promise<void>((res) => {
      release = res;
    });
    let leaderInterval: ReturnType<typeof setInterval> | null = null;

    navigator.locks
      .request(LEADER_LOCK, { signal: ac.signal }, async () => {
        isLeaderRef.current = true;
        void pollOnce(); // immediate
        leaderInterval = setInterval(() => {
          if (document.visibilityState === "visible") void pollOnce();
        }, POLL_MS);
        await held; // hold leadership until this tab unmounts
      })
      .catch(() => {
        /* aborted on unmount before we got the lock — fine */
      });

    return () => {
      aliveRef.current = false;
      isLeaderRef.current = false;
      if (leaderInterval) clearInterval(leaderInterval);
      if (endTimerRef.current) clearTimeout(endTimerRef.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      ac.abort(); // stop waiting for the lock if we never got it
      release(); // release the lock if we held it → another tab becomes leader
      bc.close();
      bcRef.current = null;
    };
  }, [pollOnce, applyShared, broadcast, checkSkew]);

  // Show a track as playing immediately (e.g. double-click a song); the next poll confirms.
  const playOptimistic = useCallback(
    (track: NowPlayingTrack, durationMs = 0) => {
      const until = Date.now() + 2000;
      suppressUntil.current = until;
      const next: Playing = { track, isPlaying: true, progressMs: 0, durationMs, context: null };
      const at = Date.now();
      lastAppliedAt.current = at;
      setPlaying(next);
      broadcast({ type: "optimistic", playing: next, until, at });
    },
    [broadcast],
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
        void pollOnce();
      }
      return r;
    },
    [broadcast, pollOnce],
  );

  return (
    <Ctx.Provider value={{ playing, refresh, setPlaying, toggle, playOptimistic }}>
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
    }
  );
}
