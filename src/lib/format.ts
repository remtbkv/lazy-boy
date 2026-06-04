// Small, dependency-free formatting helpers shared by the track and history UIs.

/** Track length, e.g. 5:29. */
export function formatDuration(ms?: number | null): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Total listening time, e.g. "2h 14m" or "45m". */
export function formatListenTime(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "<1m";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Relative time, e.g. "2h ago". (Client-only — reads the current time.) */
export function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/** Exact local timestamp for hover titles, e.g. "06/01/26, 4:30 PM". */
export function exactTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Today" / "Yesterday", else short month + day (e.g. "Jun 2") — no weekday. */
export function dayLabel(day: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = new Date();
  const yest = new Date(today);
  yest.setDate(yest.getDate() - 1);
  if (day === local(today)) return "Today";
  if (day === local(yest)) return "Yesterday";
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
