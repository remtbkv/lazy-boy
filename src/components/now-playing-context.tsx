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
  toggle: () => void;
};

const Ctx = createContext<NowPlayingValue | null>(null);

// Single source of truth for "what's playing": polled once here (every 6s, visible tab)
// and shared by the header chip and the playlist track list, so we don't double-poll
// Spotify and both stay in sync.
export function NowPlayingProvider({ children }: { children: React.ReactNode }) {
  const [playing, setPlaying] = useState<Playing>(null);
  const aliveRef = useRef(true);
  const playingRef = useRef<Playing>(null);
  useEffect(() => {
    playingRef.current = playing; // keep the ref current for toggle() without reading state in render
  }, [playing]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/now-playing", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { playing: Playing };
      if (aliveRef.current) setPlaying(data.playing);
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

  // Toggle play/pause for whatever's playing (used by the track-list row button).
  const toggle = useCallback(() => {
    const cur = playingRef.current;
    if (!cur) return;
    const next = !cur.isPlaying;
    setPlaying((p) => (p ? { ...p, isPlaying: next } : p)); // optimistic
    playerSetPlayingAction(next).finally(() => {
      setTimeout(() => refresh(), 400); // resync from Spotify
    });
  }, [refresh]);

  return <Ctx.Provider value={{ playing, refresh, setPlaying, toggle }}>{children}</Ctx.Provider>;
}

export function useNowPlaying(): NowPlayingValue {
  const v = useContext(Ctx);
  // Inert fallback if used outside the provider (shouldn't happen in the app shell).
  return v ?? { playing: null, refresh: () => {}, setPlaying: () => {}, toggle: () => {} };
}
