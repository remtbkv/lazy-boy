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

// Single source of truth for "what's playing": polled once here (every 6s, visible tab)
// and shared by the header chip and the playlist track list, so we don't double-poll
// Spotify and both stay in sync.
export function NowPlayingProvider({ children }: { children: React.ReactNode }) {
  const [playing, setPlaying] = useState<Playing>(null);
  const aliveRef = useRef(true);
  const playingRef = useRef<Playing>(null);
  // After an optimistic change, ignore poll results briefly so a mid-flight 6s poll
  // (carrying the pre-change state) can't clobber it and cause a visible flicker.
  const suppressUntil = useRef(0);
  useEffect(() => {
    playingRef.current = playing; // keep the ref current for toggle() without reading state in render
  }, [playing]);

  // Monotonic guard: refresh() is called from the 6s interval AND ad hoc (after
  // next/prev) — a slow older response must not overwrite a newer one.
  const refreshSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (Date.now() < suppressUntil.current) return;
    const seq = ++refreshSeq.current;
    try {
      const res = await fetch("/api/now-playing", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { playing: Playing };
      // Re-check after the await — an optimistic change may have happened mid-fetch,
      // and a newer refresh may have already applied a fresher answer.
      if (
        aliveRef.current &&
        seq === refreshSeq.current &&
        Date.now() >= suppressUntil.current
      ) {
        setPlaying(data.playing);
      }
    } catch {
      /* transient — keep the last known state rather than flicker */
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    // refresh() only setState()s after an awaited fetch — async, not a sync cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 6000);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  // Show a track as playing immediately (e.g. double-click a song); the next poll confirms.
  const playOptimistic = useCallback((track: NowPlayingTrack, durationMs = 0) => {
    suppressUntil.current = Date.now() + 2000;
    setPlaying({ track, isPlaying: true, progressMs: 0, durationMs, context: null });
  }, []);

  // Toggle play/pause for whatever's playing (track-list row button + header chip).
  // Owns the optimistic flip AND the poll suppression — callers that flip state on
  // their own would race the 6s poll (a mid-flight response would snap the icon back).
  const toggle = useCallback(
    async (progressMs?: number) => {
      const cur = playingRef.current;
      if (!cur) return { ok: true };
      const next = !cur.isPlaying;
      suppressUntil.current = Date.now() + 2000;
      setPlaying((p) =>
        p
          ? { ...p, isPlaying: next, ...(progressMs !== undefined ? { progressMs } : {}) }
          : p,
      ); // optimistic
      const r = await playerSetPlayingAction(next);
      if (!r.ok) {
        suppressUntil.current = 0; // failed → drop the optimistic flip, show real state
        refresh();
      }
      return r;
    },
    [refresh],
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
