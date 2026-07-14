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
  | { type: "state"; playing: Playing; at: number } // a real poll result
  | { type: "optimistic"; playing: Playing; until: number; at: number } // a user action
  | { type: "request" }; // a new tab asking the leader for the current state

const CHANNEL = "lb-nowplaying";
const CACHE_KEY = "lb-nowplaying";
const LEADER_LOCK = "lb-nowplaying-leader";
const POLL_MS = 6000;

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

  // Monotonic guard for our own fetches: a slow older response must not overwrite a newer one.
  const refreshSeq = useRef(0);

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

  // One network poll (used by the leader's interval and by ad-hoc refresh()). On success,
  // updates locally AND broadcasts so every other tab updates without its own fetch.
  const pollOnce = useCallback(async () => {
    if (Date.now() < suppressUntil.current) return;
    const seq = ++refreshSeq.current;
    try {
      const res = await fetch("/api/now-playing", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { playing: Playing };
      if (aliveRef.current && seq === refreshSeq.current && Date.now() >= suppressUntil.current) {
        const at = Date.now();
        lastAppliedAt.current = at;
        setPlaying(data.playing);
        broadcast({ type: "state", playing: data.playing, at });
      }
    } catch {
      /* transient — keep the last known state rather than flicker */
    }
  }, [broadcast]);

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

    // Fallback for browsers without Web Locks / BroadcastChannel: poll per tab (old behavior).
    if (!canCoordinate) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void pollOnce();
      const id = setInterval(() => {
        if (document.visibilityState === "visible") void pollOnce();
      }, POLL_MS);
      return () => {
        aliveRef.current = false;
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
        broadcast({ type: "state", playing: playingRef.current, at: lastAppliedAt.current });
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
      ac.abort(); // stop waiting for the lock if we never got it
      release(); // release the lock if we held it → another tab becomes leader
      bc.close();
      bcRef.current = null;
    };
  }, [pollOnce, applyShared, broadcast]);

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
