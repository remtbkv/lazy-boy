import { captureHealthMessage, type CaptureHealth } from "@/lib/capture-health";

// One line when listen history has stopped being recorded (burn review 2026-10-03, M1): every
// capture failure found that night had been silent for weeks. Same quiet shape as
// RateLimitNotice, in the warning colour — this one needs action, not patience.
export function CaptureHealthNotice({ health }: { health: CaptureHealth | null }) {
  if (!health || health.ok) return null;
  return (
    <p className="den-home-band shrink-0 text-[13px] text-amber-400/90">
      {captureHealthMessage(health)}
    </p>
  );
}
