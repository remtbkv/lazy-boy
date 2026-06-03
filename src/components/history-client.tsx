"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { syncHistoryAction } from "@/app/(app)/history/actions";
import { AlbumThumb } from "@/components/album-thumb";
import { FloatingBar } from "@/components/floating-bar";
import { HoverScroll } from "@/components/hover-scroll";
import { HoverTip } from "@/components/hover-tip";
import { SortMenu } from "@/components/sort-menu";
import { dayLabel, exactTime, formatDuration, formatListenTime, timeAgo } from "@/lib/format";

type Sort = "recent" | "plays" | "title" | "artist" | "album";
const SORTS: { key: Sort; label: string }[] = [
  { key: "recent", label: "Recently played" },
  { key: "plays", label: "Plays" },
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
];

// Ascending comparator per field; direction is applied on top so each sort can be
// flipped from the menu.
function compareTracks(a: TrackStats, b: TrackStats, sort: Sort): number {
  switch (sort) {
    case "recent":
      return a.lastPlayed.localeCompare(b.lastPlayed);
    case "plays":
      return a.plays - b.plays || a.lastPlayed.localeCompare(b.lastPlayed);
    case "title":
      return a.name.localeCompare(b.name);
    case "artist":
      return a.artist.localeCompare(b.artist);
    case "album":
      return (a.album ?? "").localeCompare(b.album ?? "");
  }
}
function sortTracks(list: TrackStats[], sort: Sort, dir: "asc" | "desc"): TrackStats[] {
  const f = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => f * compareTracks(a, b, sort));
}
// The direction each sort opens in (most-recent / most-played first; A→Z for text).
const DEFAULT_DIR: Record<Sort, "asc" | "desc"> = {
  recent: "desc",
  plays: "desc",
  title: "asc",
  artist: "asc",
  album: "asc",
};

type TrackStats = {
  id: string;
  name: string;
  artist: string;
  uri: string;
  album: string | null;
  albumImage: string | null;
  durationMs: number | null;
  plays: number;
  lastPlayed: string;
  firstPlayed: string;
  source: string | null;
};
type DayStats = { day: string; plays: number; uniqueTracks: number; durationMs: number };
type AllTimeStats = { plays: number; uniqueTracks: number; durationMs: number };

export function HistoryClient({
  initialDaily,
  initialDay,
  initialDayTracks,
  allTime: initialAllTime,
  initialResults,
}: {
  initialDaily: DayStats[];
  initialDay: string | null;
  initialDayTracks: TrackStats[];
  allTime: AllTimeStats;
  initialResults: TrackStats[];
}) {
  const [daily, setDaily] = useState(initialDaily);
  const [allTime, setAllTime] = useState(initialAllTime);
  const [query, setQuery] = useState("");

  // The main list is scoped to one day (default: most recent / today), so the Plays
  // column reads "times played that day" rather than an ever-growing all-time total.
  // Selecting the "All time" card instead loads the most-played list (capped).
  const [selectedDay, setSelectedDay] = useState(initialDay);
  const [allSelected, setAllSelected] = useState(false);
  const [dayTracks, setDayTracks] = useState(initialDayTracks);
  const [dayLoading, setDayLoading] = useState(false);

  const ALL_TIME_LIMIT = 300;

  // Search results (all-time) — only shown while there's a query.
  const [results, setResults] = useState(initialResults);
  const logRef = useRef<HTMLDivElement | null>(null);
  const searching = query.trim().length > 0;

  // Day/search lists read newest-first; the all-time list reads most-played. The
  // sort menu overrides the field, and clicking the active field flips direction.
  const [sort, setSort] = useState<Sort>("recent");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  function selectSort(k: Sort) {
    if (k === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(k);
      setDir(DEFAULT_DIR[k]);
    }
  }
  const visibleTracks = useMemo(
    () => sortTracks(searching ? results : dayTracks, sort, dir),
    [searching, results, dayTracks, sort, dir],
  );

  async function runSearch(q: string) {
    const res = await fetch(`/api/history/search?q=${encodeURIComponent(q)}`);
    if (res.ok) setResults((await res.json()).results as TrackStats[]);
  }

  async function selectDay(day: string) {
    if (!allSelected && day === selectedDay) return;
    setAllSelected(false);
    setSelectedDay(day);
    setSort("recent");
    setDir("desc");
    setDayLoading(true);
    try {
      const res = await fetch(`/api/history/day?day=${day}`);
      if (res.ok) setDayTracks((await res.json()).results as TrackStats[]);
    } finally {
      setDayLoading(false);
    }
  }

  async function selectAllTime() {
    if (allSelected) return;
    setAllSelected(true);
    setSort("plays");
    setDir("desc");
    setDayLoading(true);
    try {
      const res = await fetch(`/api/history/all?limit=${ALL_TIME_LIMIT}`);
      if (res.ok) setDayTracks((await res.json()).results as TrackStats[]);
    } finally {
      setDayLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => runSearch(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  // Searching brings the log up so the (highlighted) match is front-and-center.
  useEffect(() => {
    if (!searching) return;
    const el = logRef.current;
    if (el && el.getBoundingClientRect().top < 72) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [searching]);

  // Auto-sync every minute (visible tab only): pull any new plays and refresh the
  // current view in place — without yanking the user to today or showing a toast.
  useEffect(() => {
    const id = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await syncHistoryAction();
        if (!r.ok) return;
        setDaily(r.daily);
        setAllTime(r.allTime);
        if (allSelected) {
          const a = await fetch(`/api/history/all?limit=${ALL_TIME_LIMIT}`);
          if (a.ok) setDayTracks((await a.json()).results as TrackStats[]);
        } else if (selectedDay) {
          const d = await fetch(`/api/history/day?day=${selectedDay}`);
          if (d.ok) setDayTracks((await d.json()).results as TrackStats[]);
        }
        if (searching) await runSearch(query);
      } catch {
        /* ignore background sync hiccups */
      }
    }, 60000);
    return () => clearInterval(id);
  }, [allSelected, selectedDay, searching, query]);

  const empty = daily.length === 0;

  return (
    <div className="space-y-6">
      {empty ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No history yet — it fills in automatically as you listen (synced every
          minute). Give it a moment after playing something.
        </div>
      ) : (
        <>
          {/* Day cards scroll horizontally; the all-time card stays parked on the
              right, outside that scroll, as a fixed reference point. */}
          <div className="flex items-stretch gap-3">
            <div className="flex min-w-0 flex-initial gap-3 overflow-x-auto pb-2">
              {daily.map((d) => {
                const active = !allSelected && d.day === selectedDay;
                return (
                  <button
                    key={d.day}
                    type="button"
                    onClick={() => selectDay(d.day)}
                    aria-pressed={active}
                    className={
                      "min-w-[140px] shrink-0 rounded-xl border p-3 text-left transition-colors hover:border-white/40 hover:bg-white/10 " +
                      (active ? "border-white/40 bg-white/10" : "border-border bg-card")
                    }
                  >
                    <div className="text-sm font-semibold">{dayLabel(d.day)}</div>
                    <div className="mt-2 text-2xl font-bold tabular-nums">{d.plays}</div>
                    <div className="text-xs text-muted-foreground">plays</div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {d.uniqueTracks} songs · {formatListenTime(d.durationMs)}
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={selectAllTime}
              aria-pressed={allSelected}
              className={
                "min-w-[150px] shrink-0 rounded-xl border p-3 text-left transition-colors hover:border-white/40 hover:bg-white/10 " +
                (allSelected ? "border-white/40 bg-white/10" : "border-white/15 bg-secondary/40")
              }
            >
              <div className="text-sm font-semibold">All time</div>
              <div className="mt-2 text-2xl font-bold tabular-nums">
                {allTime.plays.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground">plays</div>
              <div className="mt-2 text-xs text-muted-foreground">
                {allTime.uniqueTracks.toLocaleString()} songs · {formatListenTime(allTime.durationMs)}
              </div>
            </button>
          </div>

          <section ref={logRef} className="scroll-mt-24 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {searching
                  ? "Matches · all time"
                  : allSelected
                    ? "All time · most played"
                    : selectedDay
                      ? dayLabel(selectedDay)
                      : "Today"}
              </h2>
              <SortMenu value={sort} direction={dir} options={SORTS} onSelect={selectSort} />
            </div>
            <TrackTable
              tracks={visibleTracks}
              loading={!searching && dayLoading}
              empty={
                searching
                  ? `No songs match “${query.trim()}”.`
                  : allSelected
                    ? "No plays yet."
                    : "No plays recorded for this day."
              }
            />
          </section>
        </>
      )}

      {!empty ? (
        <FloatingBar
          query={query}
          onQuery={setQuery}
          placeholder="Search a song or artist…"
        />
      ) : null}
    </div>
  );
}

// Scrollable table for the day view and search results.
function TrackTable({
  tracks,
  empty,
  loading = false,
}: {
  tracks: TrackStats[];
  empty: string;
  loading?: boolean;
}) {
  return (
    <div className="max-h-[calc(100vh-29rem)] min-h-[200px] overflow-y-auto rounded-lg border border-border">
      {/* Fixed layout: column widths stay constant and long text clips (then scrolls
          on hover) instead of widening the table into a horizontal scroll. Song and
          Album get the generous, roughly-equal flexible columns; From is narrower;
          the numeric/time columns are fixed and small. */}
      <table className="w-full table-fixed text-sm">
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 font-medium">Song</th>
            <th className="hidden px-4 py-2 font-medium md:table-cell">Album</th>
            <th className="hidden w-20 px-4 py-2 text-right font-medium sm:table-cell">Length</th>
            <th className="w-16 px-4 py-2 text-right font-medium">Plays</th>
            <th className="hidden w-28 px-4 py-2 font-medium sm:table-cell">Last played</th>
            <th className="hidden w-40 px-4 py-2 font-medium lg:table-cell">From</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((t) => (
            <tr
              key={t.id}
              className="border-b border-border last:border-0 transition-colors hover:bg-accent/30"
            >
              <td className="px-4 py-2">
                <div className="flex min-w-0 items-center gap-3">
                  <AlbumThumb src={t.albumImage} />
                  <div className="min-w-0 flex-1">
                    <HoverScroll className="font-medium">{t.name}</HoverScroll>
                    <HoverScroll className="text-xs text-muted-foreground">
                      {t.artist}
                    </HoverScroll>
                  </div>
                </div>
              </td>
              <td className="hidden px-4 py-2 text-muted-foreground md:table-cell">
                <HoverScroll>{t.album ?? "—"}</HoverScroll>
              </td>
              <td className="hidden px-4 py-2 text-right tabular-nums text-muted-foreground sm:table-cell">
                {formatDuration(t.durationMs)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{t.plays}</td>
              <td className="hidden px-4 py-2 text-muted-foreground sm:table-cell">
                <HoverTip label={exactTime(t.lastPlayed)} className="cursor-default">
                  {timeAgo(t.lastPlayed)}
                </HoverTip>
              </td>
              <td className="hidden px-4 py-2 text-muted-foreground lg:table-cell">
                <HoverScroll>{t.source ?? "—"}</HoverScroll>
              </td>
            </tr>
          ))}
          {tracks.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                {loading ? "Loading…" : empty}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
