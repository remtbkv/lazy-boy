"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { toast } from "@/lib/toast";
import { playerNextAction, playerPreviousAction } from "@/app/(app)/actions";
import { HoverScroll } from "@/components/hover-scroll";
import { useNowPlaying } from "@/components/now-playing-context";

// Compact now-playing chip that lives in the header (to the left of the avatar).
// At rest it just displays the song — album art, title/artist, and a thin in-track
// progress bar. Hovering reveals a chip-width popover with the skip/pause controls
// and where it's playing from.
export function NowPlaying() {
  const { playing, toggle: ctxToggle, refresh } = useNowPlaying();
  const [pos, setPos] = useState(0); // interpolated position, ms
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false); // controls popover (on hover)
  const rootRef = useRef<HTMLDivElement>(null);
  // Chip + popover share one width = the widest of title / artist / "from", capped,
  // so the popover never juts out wider than the chip. Measured from a hidden sizer.
  const sizerRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState<number | null>(null);
  // Hover to reveal on pointer devices; tap to toggle on touch (no hover there).
  const canHover = useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(hover: hover)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(hover: hover)").matches,
    () => true,
  );
  // Baseline for interpolation: Spotify reports position only every few seconds,
  // so we advance it locally from this anchor between polls.
  const base = useRef({ progressMs: 0, at: 0, isPlaying: false });

  // Measure the widest line and clamp it; both the chip text and the popover use it.
  // Deferred to a frame so it isn't a synchronous setState in the effect body.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = sizerRef.current;
      const widths = el ? Array.from(el.children, (c) => (c as HTMLElement).scrollWidth) : [];
      const max = widths.length ? Math.max(...widths) : 0;
      const MIN = 104; // keeps the popover wide enough for the controls
      const MAX = 184; // cap; longer text clips and scrolls on hover
      setBoxW(max ? Math.min(MAX, Math.max(MIN, max)) : null);
    });
    return () => cancelAnimationFrame(id);
  }, [playing?.track.title, playing?.track.artist, playing?.context?.name]);

  // Re-anchor the local progress ticker whenever fresh data arrives from the shared
  // poller (NowPlayingProvider), so the bar interpolates smoothly between updates.
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

  // Open the controls on hover; a short close delay bridges the gap between the
  // chip and the popover below it so the menu doesn't flicker shut in transit.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openControls = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };
  // Clear a pending close on unmount — playback ending unmounts this mid-hover, and the
  // stray timer would otherwise fire setOpen on a gone component.
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  if (!playing) return null;
  const { track, isPlaying, durationMs, context } = playing;
  const pct = durationMs > 0 ? Math.min(100, (pos / durationMs) * 100) : 0;

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setPending(true);
    action()
      .then((r) => {
        if (!r.ok) toast.error(r.error ?? "Playback control failed");
        // Give Spotify a beat to apply the change, then resync from the source.
        return new Promise((res) => setTimeout(res, 400)).then(() => refresh());
      })
      .finally(() => setPending(false));
  }

  function toggle() {
    const next = !isPlaying;
    // Freeze/resume the local ticker immediately; the context owns the optimistic
    // state flip AND the poll suppression (flipping state here directly would let a
    // mid-flight 6s poll snap the icon back). Pass `pos` so the bar doesn't jump
    // back to the last polled position.
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

  const playPauseBtn = (size: string, icon: string) => (
    <button
      type="button"
      aria-label={isPlaying ? "Pause" : "Play"}
      onClick={toggle}
      disabled={pending}
      className={`flex ${size} shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-transform hover:scale-105 disabled:opacity-50`}
    >
      {isPlaying ? (
        <Pause className={icon} fill="currentColor" />
      ) : (
        <Play className={`${icon} translate-x-px`} fill="currentColor" />
      )}
    </button>
  );

  return (
    <div
      ref={rootRef}
      className="relative"
      onMouseEnter={canHover ? openControls : undefined}
      onMouseLeave={canHover ? scheduleClose : undefined}
    >
      {/* Resting state: just a "now playing" display — album art (with an animated
          equalizer while playing) and the title/artist, no enclosing pill. A faint
          hover background signals it's interactive; hovering reveals the controls. */}
      <button
        type="button"
        aria-label={`Now playing: ${track.title} by ${track.artist}`}
        aria-expanded={open}
        // Pointer devices reveal on hover (handled on the wrapper); touch devices
        // toggle on tap, since there's no hover.
        onClick={() => {
          if (!canHover) setOpen((o) => !o);
        }}
        className="flex items-center gap-2.5 rounded-xl px-1 py-1 text-left transition-colors hover:bg-secondary/60 sm:gap-3 sm:px-2.5 sm:py-2"
      >
        <span key={`art-${track.id}`} className="np-swap flex shrink-0">
          {art("size-8 rounded-md object-cover sm:size-9")}
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
          {/* Minimal in-track progress: fills left→right as the song plays, sitting
              right under the title so a glance reads as "you're here in this song". */}
          <span className="mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-white/15">
            <span
              className="block h-full rounded-full bg-foreground"
              style={{ width: `${pct}%` }}
            />
          </span>
        </span>
      </button>

      {/* Hidden sizer: the natural widths of the three lines drive the shared box
          width (measured above). */}
      <div
        ref={sizerRef}
        aria-hidden
        className="pointer-events-none invisible absolute h-0 overflow-hidden whitespace-nowrap"
      >
        <span className="block text-xs font-medium">{track.title}</span>
        <span className="block text-[11px]">{track.artist}</span>
        {context ? <span className="block text-[11px]">from {context.name}</span> : null}
      </div>

      {/* Controls popover (on hover): where it's playing from + skip/pause. Same width
          as the chip (inset-x-0) so it reads as one element; only widens on phones to
          fit the controls. Progress already lives in the chip, so it's not repeated. */}
      {open ? (
        <div className="absolute inset-x-0 top-full z-50 mt-2 min-w-[12rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover/95 p-3 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur sm:min-w-0">
          {context ? (
            <HoverScroll className="text-center text-[11px] text-muted-foreground/80">
              from {context.name}
            </HoverScroll>
          ) : null}

          <div className="mt-2 flex items-center justify-center gap-2">
            <Ctl label="Previous" onClick={() => run(playerPreviousAction)} disabled={pending}>
              <SkipBack className="size-4" fill="currentColor" />
            </Ctl>
            {playPauseBtn("size-9", "size-4")}
            <Ctl label="Next" onClick={() => run(playerNextAction)} disabled={pending}>
              <SkipForward className="size-4" fill="currentColor" />
            </Ctl>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Ctl({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}
