// Minimal "this is playing" indicator: a few green bars bouncing (CSS only, keyframes
// `eq` in globals.css). Used where there's no track number to swap for a play/pause
// button (e.g. the history list) — it reads clearly as "playing" without an icon or
// shifting the row layout.
export function PlayingBars({ className }: { className?: string }) {
  const delays = [0, 180, 90, 270]; // staggered so the bars look alive, not in lockstep
  return (
    <span aria-hidden className={`flex h-3.5 items-end gap-[2px] ${className ?? ""}`}>
      {delays.map((d, i) => (
        <span
          key={i}
          className="w-[2px] origin-bottom rounded-full bg-[#1db954]"
          style={{ height: "100%", animation: `eq 0.9s ease-in-out ${d}ms infinite` }}
        />
      ))}
    </span>
  );
}
