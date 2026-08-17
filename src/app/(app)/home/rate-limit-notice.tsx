"use client";

// One quiet line when Spotify has the app in a rate-limit cooldown — otherwise a frozen
// Today card next to a live now-playing chip reads as the app being broken (Rem,
// 2026-08-17). The server passes `until` only while the cooldown is ACTIVE (0 otherwise),
// so this stays a pure formatter; the value is capped at ~30 min per probe and renews
// itself for as long as Spotify keeps refusing.
export function RateLimitNotice({ until }: { until: number }) {
  if (until <= 0) return null;
  const time = new Date(until).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <p
      // suppressHydrationWarning: toLocaleTimeString renders in the RENDERING zone —
      // UTC on the server, local in the browser (same mechanism as the day cells).
      suppressHydrationWarning
      className="den-home-band shrink-0 text-[13px] text-muted-foreground"
    >
      Spotify is rate-limiting this app — new plays are held up; next retry ~{time}.
    </p>
  );
}
