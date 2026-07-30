"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "@/lib/toast";
import { HoverScroll } from "@/components/hover-scroll";
import { useNowPlaying } from "@/components/now-playing-context";

// Compact now-playing chip in the header (left of the avatar). Purely a display of what's
// playing — album art, title/artist, and a thin in-track progress bar. On touch a tap
// toggles play/pause (the art's green ring shows the state); long titles clip and slide on
// hover to reveal the rest. The box width is fixed so changing songs doesn't shift the
// header (den.css pins it further).
export function NowPlaying() {
  const { playing, toggle: ctxToggle } = useNowPlaying();
  const [pos, setPos] = useState(0); // interpolated position, ms
  const [pending, setPending] = useState(false);
  // Chip width = the widest of title / artist, clamped, so the slot doesn't jump as songs
  // change. Measured from a hidden sizer.
  const sizerRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState<number | null>(null);
  // Hover reveals the sliding title on pointer devices; tap toggles on touch (no hover).
  const canHover = useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(hover: hover)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(hover: hover)").matches,
    () => true,
  );
  // Baseline for interpolation: Spotify reports position only every few seconds, so we
  // advance it locally from this anchor between polls.
  const base = useRef({ progressMs: 0, at: 0, isPlaying: false });

  // What the chip DISPLAYS. On a song change the swap waits until the incoming album art
  // is decoded, so the np-swap fade shows a ready bitmap — swapping immediately faded in
  // an empty box and the art popped in whenever the network got around to it, which is
  // the choppiness. Same-song updates (every poll) pass straight through.
  const [shown, setShown] = useState(playing?.track ?? null);
  const shownId = useRef(shown?.id);
  useEffect(() => {
    const t = playing?.track ?? null;
    // Nothing playing, no art to wait for, or the same song (a poll refresh): show as-is.
    // Same-id updates don't re-animate — the np-swap spans are keyed by track id.
    if (!t || !t.albumImage || t.id === shownId.current) {
      shownId.current = t?.id;
      setShown(t);
      return;
    }
    let stale = false;
    const commit = () => {
      if (stale) return;
      shownId.current = t.id;
      setShown(t);
    };
    const img = new window.Image();
    img.src = t.albumImage;
    // decode() resolves once the bitmap is paint-ready; on failure just swap anyway.
    img.decode().then(commit, commit);
    const to = setTimeout(commit, 800); // slow network: don't hold the old song hostage
    return () => {
      stale = true;
      clearTimeout(to);
    };
  }, [playing?.track]);

  // Measure the widest line and clamp it. Deferred to a frame so it isn't a synchronous
  // setState in the effect body.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = sizerRef.current;
      const widths = el ? Array.from(el.children, (c) => (c as HTMLElement).scrollWidth) : [];
      const max = widths.length ? Math.max(...widths) : 0;
      const MIN = 104;
      const MAX = 184; // longer text clips and scrolls on hover
      setBoxW(max ? Math.min(MAX, Math.max(MIN, max)) : null);
    });
    return () => cancelAnimationFrame(id);
  }, [shown?.title, shown?.artist]);

  // Re-anchor the local progress ticker whenever fresh data arrives from the shared poller.
  useEffect(() => {
    if (!playing) return;
    base.current = {
      progressMs: playing.progressMs,
      at: Date.now(),
      isPlaying: playing.isPlaying,
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos(playing.progressMs);
  }, [playing]);

  // Advance the progress bar each second while playing (between polls).
  useEffect(() => {
    const duration = playing?.durationMs ?? 0;
    const id = setInterval(() => {
      const b = base.current;
      if (!b.isPlaying) return;
      const next = b.progressMs + (Date.now() - b.at);
      setPos(duration > 0 ? Math.min(next, duration) : next);
    }, 1000);
    return () => clearInterval(id);
  }, [playing?.durationMs]);

  if (!playing || !shown) return null;
  const { isPlaying, durationMs } = playing;
  const track = shown; // what the chip displays — lags `playing` until the new art is ready
  const pct = durationMs > 0 ? Math.min(100, (pos / durationMs) * 100) : 0;

  function toggle() {
    const next = !isPlaying;
    // Freeze/resume the local ticker immediately; the context owns the optimistic state
    // flip AND poll suppression. Pass `pos` so the bar doesn't jump back to the last poll.
    base.current = { progressMs: pos, at: Date.now(), isPlaying: next };
    setPending(true);
    ctxToggle(pos)
      .then((r) => {
        if (!r.ok) toast.error(r.error ?? "Playback control failed");
      })
      .finally(() => setPending(false));
  }

  const art = (cls: string) =>
    track.albumImage ? (
      <img src={track.albumImage} alt="" className={cls} />
    ) : (
      <div className={`${cls} bg-muted`} />
    );

  return (
    <div className="relative">
      {/* Resting display: album art (green ring while playing) + title/artist + a thin
          in-track progress bar. No chip-wide hover state — it's just a display (long titles
          still slide on hover of the text itself). */}
      <button
        type="button"
        aria-label={`Now playing: ${track.title} by ${track.artist}`}
        disabled={pending}
        // Touch: a tap toggles play/pause (the art ring shows state). No-op on desktop —
        // it's a display; control playback in Spotify.
        onClick={() => {
          if (!canHover) toggle();
        }}
        className="flex cursor-default items-center gap-2.5 rounded-xl px-1 py-1 text-left sm:gap-3 sm:px-2.5 sm:py-2"
      >
        <span key={`art-${track.id}`} className="np-swap flex shrink-0">
          {art(
            "size-8 rounded-md object-cover sm:size-9" +
              (isPlaying
                ? " shadow-[0_0_0_2px_#1db954] sm:shadow-none"
                : " opacity-60 sm:opacity-100"),
          )}
        </span>
        <span
          className="hidden min-w-0 transition-[width] duration-300 ease-out sm:block"
          style={{ width: boxW ?? undefined }}
        >
          <span key={track.id} className="np-swap block">
            <HoverScroll className="text-xs font-medium leading-tight">{track.title}</HoverScroll>
            <HoverScroll className="text-[11px] leading-tight text-muted-foreground">
              {track.artist}
            </HoverScroll>
          </span>
          {/* Minimal in-track progress: fills left→right as the song plays. */}
          <span className="mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-white/15">
            <span
              className="block h-full rounded-full bg-foreground"
              style={{ width: `${pct}%` }}
            />
          </span>
        </span>
      </button>

      {/* Hidden sizer: the natural widths of the two lines drive the shared box width. */}
      <div
        ref={sizerRef}
        aria-hidden
        className="pointer-events-none invisible absolute h-0 overflow-hidden whitespace-nowrap"
      >
        <span className="block text-xs font-medium">{track.title}</span>
        <span className="block text-[11px]">{track.artist}</span>
      </div>
    </div>
  );
}
