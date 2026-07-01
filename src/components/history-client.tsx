"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { toast } from "@/lib/toast";
import { playTrackAction } from "@/app/(app)/actions";
import { loadDaysAction, syncHistoryAction } from "@/app/(app)/actions";
import { AlbumThumb } from "@/components/album-thumb";
import { AnimatedNumber } from "@/components/animated-number";
import { FloatingBar } from "@/components/floating-bar";
import { HoverScroll } from "@/components/hover-scroll";
import { HoverTip } from "@/components/hover-tip";
import { useNowPlaying } from "@/components/now-playing-context";
import { SortMenu } from "@/components/sort-menu";
import { TrackContextMenu } from "@/components/track-context-menu";
import type { Track } from "@/lib/spotify";
import { dayLabel, exactTime, exactTimeShort, formatDuration, formatListenTime, shortDate, timeAgo } from "@/lib/format";

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
// Day-strip expansion spans: 2 weeks → 4 weeks → everything (a cap large enough to mean
// "all"). Each step's chevron at the right end loads the next span.
const DAY_SPANS = [14, 28, 100000];

// Row cascade: when rows enter — a fresh list, or new plays landing on a background sync — the
// top ones float down one after another. The beat between rows is `STEP_MAX`, but it's squeezed
// so the whole run always finishes inside `WINDOW_MS` no matter how many enter: a couple of new
// songs get a clear one-by-one beat; a dozen fall quicker. Only the top `MAX` animate (the rest
// sit below the fold). `cascadeStep` returns the actual per-row delay for a run of `n` rows.
const CASCADE_MAX = 12;
const CASCADE_STEP_MAX = 85; // ms between consecutive rows when only a few enter
const CASCADE_WINDOW_MS = 600; // ms cap on the spread from the first row's start to the last's
const CASCADE_FALL_MS = 600; // one row's fall — keep in sync with .history-row-in in globals.css
const cascadeStep = (n: number) =>
  n > 1 ? Math.min(CASCADE_STEP_MAX, CASCADE_WINDOW_MS / (n - 1)) : 0;

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
type AllTimeStats = { plays: number; uniqueTracks: number; durationMs: number; since: string | null };

export function HistoryClient({
  initialDaily,
  initialDay,
  initialDayTracks,
  allTime: initialAllTime,
  initialResults,
  initialHasMoreDays = false,
  songListMaxHeightClass = "sm:max-h-[calc(100vh-29rem)]",
}: {
  initialDaily: DayStats[];
  initialDay: string | null;
  initialDayTracks: TrackStats[];
  allTime: AllTimeStats;
  initialResults: TrackStats[];
  // Whether older days exist past the initial 2-week strip (drives the expand control).
  initialHasMoreDays?: boolean;
  // Caps the song table's height. Home passes a viewport-relative value so the merged-in
  // list fills down toward the search bar without overflowing the page.
  songListMaxHeightClass?: string;
}) {
  const { playing } = useNowPlaying();
  const nowPlayingId = playing?.track.id;
  const [daily, setDaily] = useState(initialDaily);
  const [allTime, setAllTime] = useState(initialAllTime);
  const [query, setQuery] = useState("");

  // Day strip expands on demand: 2 weeks → 4 weeks → all. `dayLevel` indexes DAY_SPANS;
  // `hasMoreDays` says whether older days still exist past what's shown.
  const [dayLevel, setDayLevel] = useState(0);
  const [hasMoreDays, setHasMoreDays] = useState(initialHasMoreDays);
  const [expandingDays, setExpandingDays] = useState(false);

  // The main list is scoped to one day (default: most recent / today), so the Plays
  // column reads "times played that day" rather than an ever-growing all-time total.
  // Selecting the "All time" card instead loads the most-played list (capped).
  const [selectedDay, setSelectedDay] = useState(initialDay);
  const [allSelected, setAllSelected] = useState(false);
  const [dayTracks, setDayTracks] = useState(initialDayTracks);
  const [dayLoading, setDayLoading] = useState(false);

  const ALL_TIME_LIMIT = 300;

  // Find's "last played" rows focus a song here via a window event (no URL params): select
  // its day, then scroll to + highlight the row. `nonce` lets the same song re-focus on a
  // repeat click; a refresh fires no event, so it never replays.
  const [focus, setFocus] = useState<{ trackId: string; nonce: number } | null>(null);

  // Search results (all-time) — only shown while there's a query.
  const [results, setResults] = useState(initialResults);
  const logRef = useRef<HTMLDivElement | null>(null);
  const dayScrollRef = useRef<HTMLDivElement | null>(null);
  const activeDayRef = useRef<HTMLButtonElement | null>(null);
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

  // Monotonic request guards: rapid typing / day-clicks fire overlapping fetches, and
  // the slower one can settle last and clobber the view with stale data. Each fetch
  // captures the current sequence and only applies its result if it's still the latest.
  // `searchReq` covers `results`; `dayReq` covers `dayTracks` (selectDay/selectAllTime
  // and the background refresh all write it).
  const searchReq = useRef(0);
  const dayReq = useRef(0);

  // Client cache of already-fetched days (day → its rows). The day list is a per-click fetch
  // to /api/history/day (a Turso round-trip), so without this every tap pays the full network
  // hop. Seeded with the server-rendered initial day; neighbours prefetch on selection so
  // browsing adjacent days is instant. Past days never change; today/yesterday can gain plays,
  // so a cache hit still revalidates quietly in the background.
  const dayCache = useRef<Map<string, TrackStats[]> | null>(null);
  if (dayCache.current === null) {
    dayCache.current = new Map(initialDay ? [[initialDay, initialDayTracks]] : []);
  }
  async function fetchDayTracks(day: string): Promise<TrackStats[]> {
    const res = await fetch(`/api/history/day?day=${day}`);
    if (!res.ok) throw new Error("day fetch failed");
    const rows = (await res.json()).results as TrackStats[];
    dayCache.current!.set(day, rows);
    return rows;
  }
  // Warm the cache for the days either side of `day` so an adjacent tap is instant.
  function prefetchNeighbors(day: string) {
    const i = daily.findIndex((d) => d.day === day);
    if (i < 0) return;
    for (const j of [i - 1, i + 1, i - 2, i + 2]) {
      const nd = daily[j]?.day;
      if (nd && !dayCache.current!.has(nd)) void fetchDayTracks(nd).catch(() => {});
    }
  }

  async function runSearch(q: string) {
    const seq = ++searchReq.current;
    try {
      const res = await fetch(`/api/history/search?q=${encodeURIComponent(q)}`);
      if (res.ok && seq === searchReq.current) {
        setResults((await res.json()).results as TrackStats[]);
      }
    } catch {
      /* network blip — keep the current list; the next keystroke retries */
    }
  }

  async function selectDay(day: string) {
    if (!allSelected && day === selectedDay) return;
    const seq = ++dayReq.current;
    setAllSelected(false);
    setSelectedDay(day);
    setSort("recent");
    setDir("desc");
    const cached = dayCache.current!.get(day);
    if (cached) {
      // Instant from cache; revalidate quietly (today/yesterday may have gained plays).
      setDayTracks(cached);
      setDayLoading(false);
      void fetchDayTracks(day)
        .then((rows) => { if (seq === dayReq.current) setDayTracks(rows); })
        .catch(() => {});
    } else {
      setDayLoading(true);
      try {
        const rows = await fetchDayTracks(day);
        if (seq !== dayReq.current) return;
        setDayTracks(rows);
      } catch {
        // On failure show empty, not the PREVIOUS day's rows under this day's heading.
        if (seq === dayReq.current) setDayTracks([]);
      } finally {
        if (seq === dayReq.current) setDayLoading(false);
      }
    }
    prefetchNeighbors(day);
  }

  // Kept in a ref (refreshed each render) so the mount-only listener always calls the
  // latest selectDay without re-subscribing — same pattern as doRefresh below.
  const focusFromFind = useRef<(day: string | null, trackId: string) => void>(() => {});
  useEffect(() => {
    focusFromFind.current = (day, trackId) => {
      if (day) void selectDay(day);
      setFocus((p) => ({ trackId, nonce: (p?.nonce ?? 0) + 1 }));
    };
  });
  useEffect(() => {
    const onFocus = (e: Event) => {
      const d = (e as CustomEvent<{ day?: string; trackId?: string }>).detail;
      if (d?.trackId) focusFromFind.current(d.day ?? null, d.trackId);
    };
    window.addEventListener("lazyboy:focus-history", onFocus);
    return () => window.removeEventListener("lazyboy:focus-history", onFocus);
  }, []);

  // Prefetch the initial day's neighbours once on mount, so the first adjacent tap is instant.
  useEffect(() => {
    if (initialDay) prefetchNeighbors(initialDay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectAllTime() {
    if (allSelected) return;
    const seq = ++dayReq.current;
    setAllSelected(true);
    setSort("plays");
    setDir("desc");
    setDayLoading(true);
    try {
      const res = await fetch(`/api/history/all?limit=${ALL_TIME_LIMIT}`);
      if (seq !== dayReq.current) return;
      setDayTracks(res.ok ? ((await res.json()).results as TrackStats[]) : []);
    } catch {
      if (seq === dayReq.current) setDayTracks([]);
    } finally {
      if (seq === dayReq.current) setDayLoading(false);
    }
  }

  // Expand the day strip one span (2wk → 4wk → all). The right-end chevron triggers this.
  async function expandDays() {
    if (expandingDays || dayLevel >= DAY_SPANS.length - 1) return;
    const next = dayLevel + 1;
    setExpandingDays(true);
    try {
      const r = await loadDaysAction(DAY_SPANS[next]);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setDaily(r.daily);
      setDayLevel(next);
      setHasMoreDays(next >= DAY_SPANS.length - 1 ? false : r.hasMore);
    } finally {
      setExpandingDays(false);
    }
  }

  // Skip the mount run: it would re-fetch the unfiltered list the server already
  // rendered (`initialResults`) just to replace it with identical data. Clearing the
  // query later still re-runs, restoring the full list.
  const searchedOnce = useRef(false);
  useEffect(() => {
    if (!searchedOnce.current && !query.trim()) return;
    searchedOnce.current = true;
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

  // Pull new plays and update the view in place — no manual refresh, no toast, no
  // yanking the user back to today. Kept in a ref (updated every render) so the triggers
  // below always run the latest version without re-subscribing. Debounced so the
  // track-change trigger and the fallback timer can't double-fire.
  const lastRefresh = useRef(0);
  const doRefresh = useRef<(force?: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    doRefresh.current = async (force = false) => {
      if (document.visibilityState !== "visible") return;
      // `force` skips the debounce — used by the song-change trigger so the just-finished play
      // lands in sync with the now-playing chip rather than waiting out the interval.
      if (!force && Date.now() - lastRefresh.current < 15000) return;
      lastRefresh.current = Date.now();
      try {
        // Fetch as many days as the strip is currently expanded to, so a refresh keeps the
        // expanded view instead of snapping back to 2 weeks.
        const r = await syncHistoryAction(DAY_SPANS[dayLevel]);
        if (!r.ok) return;
        setDaily(r.daily);
        setAllTime(r.allTime);
        // Don't bump the guards (this isn't a new user selection) — just refuse to apply
        // if the user has since switched day/all or changed the search.
        const daySeq = dayReq.current;
        const searchSeq = searchReq.current;
        // If you were following the latest day (not pinned to a past day or All-time) and the
        // day has rolled over since the page loaded — e.g. the tab sat open overnight — advance
        // to the new latest day ("Today") instead of staying on what used to be the latest.
        const newLatest = r.daily[0]?.day ?? null;
        const followingLatest = !allSelected && !searching && selectedDay === (daily[0]?.day ?? null);
        const targetDay =
          followingLatest && newLatest && newLatest !== selectedDay ? newLatest : selectedDay;
        if (targetDay !== selectedDay) setSelectedDay(targetDay);
        if (allSelected) {
          const a = await fetch(`/api/history/all?limit=${ALL_TIME_LIMIT}`);
          if (a.ok && daySeq === dayReq.current) setDayTracks((await a.json()).results as TrackStats[]);
        } else if (targetDay) {
          const d = await fetch(`/api/history/day?day=${targetDay}`);
          if (d.ok && daySeq === dayReq.current) setDayTracks((await d.json()).results as TrackStats[]);
        }
        if (searching && searchSeq === searchReq.current) await runSearch(query);
      } catch {
        /* ignore background sync hiccups */
      }
    };
  });

  // The now-playing chip just swapped to a new song → pull the just-finished play in *now* so
  // its row slides into Today at the same moment, not on the next interval. Force past the
  // debounce, and retry once a few seconds later to catch Spotify's recently-played lag (the
  // finished song sometimes isn't logged at the exact tick the chip changes). Plus a slow
  // fallback below for when playback is idle/stopped.
  useEffect(() => {
    void doRefresh.current(true);
    const t = setTimeout(() => void doRefresh.current(true), 4000);
    return () => clearTimeout(t);
  }, [nowPlayingId]);
  useEffect(() => {
    const id = setInterval(() => void doRefresh.current(), 120000);
    return () => clearInterval(id);
  }, []);
  // Returning to a tab that sat open (e.g. overnight): refresh right away so the counts update
  // and the view rolls to Today — rather than waiting out the interval on a stale "Yesterday".
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void doRefresh.current(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const empty = daily.length === 0;

  // Let a plain mouse wheel scroll the day strip sideways (trackpads already swipe
  // horizontally; this adds wheel support). Native non-passive listener so we can
  // preventDefault — React's onWheel is passive and can't. Only hijacks the wheel when
  // the strip actually overflows and the gesture is vertical-dominant.
  useEffect(() => {
    const el = dayScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [empty]);

  // Keep the selected day card in view in the horizontal strip — needed when arriving from
  // a Find deep link to an older day, whose card sits off-screen to the right. Only nudges
  // when the card isn't already fully visible, so clicking a visible day doesn't jump the
  // strip. Scrolls the strip's own scrollLeft (not scrollIntoView) so the page never moves
  // vertically — that's the focused row's job.
  useEffect(() => {
    const el = dayScrollRef.current;
    const btn = activeDayRef.current;
    if (!el || !btn || allSelected) return;
    const left = btn.offsetLeft;
    const right = left + btn.offsetWidth;
    if (left >= el.scrollLeft && right <= el.scrollLeft + el.clientWidth) return;
    el.scrollTo({ left: left - (el.clientWidth - btn.offsetWidth) / 2, behavior: "smooth" });
  }, [selectedDay, allSelected, daily]);

  return (
    <div className="space-y-6">
      {empty ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No history yet — it fills in automatically as you listen (synced every
          minute). Give it a moment after playing something.
        </div>
      ) : (
        <>
          {/* Day cards scroll horizontally inside a framed tray (same border as the song
              table below); the all-time card sits outside that tray on the right, so the
              scrollable days read as one group, clearly separate from the fixed all-time
              reference. flex-1 + min-w-0 makes the tray take the leftover width and clip
              its own overflow, so it can never run under the all-time card. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
            <div className="min-w-0 flex-1 rounded-xl border border-border bg-white/[0.02] p-2">
              <div ref={dayScrollRef} className="thin-scroll flex gap-3 overflow-x-auto overscroll-x-contain pb-1 [touch-action:pan-x]">
              {daily.map((d) => {
                const active = !allSelected && d.day === selectedDay;
                return (
                  <button
                    key={d.day}
                    ref={active ? activeDayRef : undefined}
                    type="button"
                    onClick={() => selectDay(d.day)}
                    aria-pressed={active}
                    className={
                      "min-w-[120px] shrink-0 rounded-xl border p-3 text-left transition-colors hover:border-white/20 sm:min-w-[140px] " +
                      (active ? "border-white/25 bg-white/[0.06]" : "border-border bg-card")
                    }
                  >
                    <div className="text-sm font-semibold">{dayLabel(d.day)}</div>
                    <div className="mt-2 text-2xl font-bold tabular-nums">
                      <AnimatedNumber value={d.plays} />
                    </div>
                    <div className="text-xs text-muted-foreground">plays</div>
                    <div className="mt-2 text-xs tabular-nums text-muted-foreground">
                      <AnimatedNumber value={d.durationMs} format={formatListenTime} /> listened
                    </div>
                  </button>
                );
              })}
              {/* At the right end, expand the strip: 2wk → 4wk (chevron) → all ("See all").
                  Just the chevron (or "See all" text) — no card/box, so it stays minimal. */}
              {hasMoreDays && dayLevel < DAY_SPANS.length - 1 ? (
                <button
                  type="button"
                  onClick={expandDays}
                  disabled={expandingDays}
                  aria-label={dayLevel === 0 ? "Show two more weeks" : "Show all days"}
                  title={dayLevel === 0 ? "Show two more weeks" : "Show all days"}
                  className="flex shrink-0 items-center gap-1 self-stretch px-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground disabled:opacity-50"
                >
                  {dayLevel >= 1 ? <span>See all</span> : null}
                  <ChevronRight
                    className={(dayLevel >= 1 ? "size-4" : "size-5") + (expandingDays ? " animate-pulse" : "")}
                  />
                </button>
              ) : null}
              </div>
            </div>

            <button
              type="button"
              onClick={selectAllTime}
              aria-pressed={allSelected}
              className={
                "min-w-[150px] shrink-0 rounded-xl border p-3 text-left transition-colors hover:border-white/20 " +
                (allSelected ? "border-white/25 bg-white/[0.06]" : "border-white/15 bg-secondary/40")
              }
            >
              <div className="text-sm font-semibold">All time</div>
              <div className="mt-2 text-2xl font-bold tabular-nums">
                <AnimatedNumber value={allTime.plays} />
              </div>
              <div className="text-xs text-muted-foreground">plays</div>
              <div className="mt-2 text-xs tabular-nums text-muted-foreground">
                <AnimatedNumber value={allTime.durationMs} format={formatListenTime} /> listened
              </div>
              {allTime.since ? (
                <div className="text-xs text-muted-foreground">since {shortDate(allTime.since)}</div>
              ) : null}
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
              mode={searching ? "log" : "aggregate"}
              focusTrackId={searching ? null : (focus?.trackId ?? null)}
              focusNonce={focus?.nonce ?? 0}
              maxHeightClass={songListMaxHeightClass}
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
          placeholder="Search history for a song or artist…"
        />
      ) : null}
    </div>
  );
}

// Scrollable table for the day view and search results.
// "aggregate" (day / all-time): one row per song with a Plays count + last-played.
// "log" (search): one row per individual play with its own actual timestamp — listens
// are never collapsed, so you see every time you played it.
function TrackTable({
  tracks,
  empty,
  mode = "aggregate",
  loading = false,
  focusTrackId = null,
  focusNonce = 0,
  maxHeightClass = "sm:max-h-[calc(100vh-29rem)]",
}: {
  tracks: TrackStats[];
  empty: string;
  mode?: "aggregate" | "log";
  loading?: boolean;
  focusTrackId?: string | null;
  // Bumps on each Find click so the same song can be re-focused; `handledNonce` below makes
  // the scroll/highlight fire once per request, not again on background `tracks` refreshes.
  focusNonce?: number;
  maxHeightClass?: string;
}) {
  const isLog = mode === "log";
  const { playing, playOptimistic } = useNowPlaying();
  const currentId = playing?.track.id;
  const [menu, setMenu] = useState<{ x: number; y: number; track: Track } | null>(null);

  // The scrollable list box. When new plays land at the top we ride the view up to them
  // (below). `lastUserScroll` lets us bow out if you're actively scrolling; `programmaticScroll`
  // marks our own scroll so it isn't mistaken for yours. `scrollCue` bumps on each batch of new
  // plays to trigger the ride-up.
  const scrollBox = useRef<HTMLDivElement | null>(null);
  const lastUserScroll = useRef(0);
  const programmaticScroll = useRef(false);
  const [scrollCue, setScrollCue] = useState(0);

  // Deep-link focus: once the row for `focusTrackId` is present, scroll it into view and
  // flash it briefly. Each focus request carries a `focusNonce`; we act once per nonce, so
  // a background refresh swapping in a new `tracks` array doesn't re-fire it.
  const focusRow = useRef<HTMLTableRowElement | null>(null);
  const handledNonce = useRef(-1);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusTrackId || handledNonce.current === focusNonce) return;
    if (!tracks.some((t) => t.id === focusTrackId)) return; // wait for the day's rows to load
    // Deferred (next frame) so it isn't a synchronous setState in the effect body, and so
    // the row ref is laid out before we scroll to it. Mark the nonce handled only once the
    // frame runs: setting it up front let Strict Mode's mount→cleanup→mount cancel the rAF
    // and then bail on the re-mount, so the highlight never fired.
    const raf = requestAnimationFrame(() => {
      handledNonce.current = focusNonce;
      setHighlightId(focusTrackId);
      focusRow.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [tracks, focusTrackId, focusNonce]);

  // Clear the highlight on its own timer keyed to `highlightId`. Kept separate from the
  // focus effect so a background refresh (which changes `tracks` and re-runs that effect)
  // can't cancel the pending clear — otherwise the row stayed grey forever.
  useEffect(() => {
    if (!highlightId) return;
    const id = setTimeout(() => setHighlightId(null), 1400);
    return () => clearTimeout(id);
  }, [highlightId]);

  // Double-click → play just that song; right-click → the same action menu as in a
  // playlist (Add to queue / Save to Liked / Share — no "remove", since it's not a
  // playlist). History rows are TrackStats, so map them to the menu's Track shape.
  const toTrack = (t: TrackStats): Track => ({
    id: t.id,
    uri: t.uri,
    title: t.name,
    artist: t.artist,
    album: t.album ?? undefined,
    albumImage: t.albumImage,
    durationMs: t.durationMs ?? undefined,
  });
  // The specific row the user played from this table — so the search log highlights just that
  // one, not every row of the same song.
  const [playedKey, setPlayedKey] = useState<string | null>(null);
  const play = (t: TrackStats, rowKey: string) => {
    window.getSelection?.()?.removeAllRanges();
    setPlayedKey(rowKey);
    playTrackAction(t.uri).then((r) => {
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      // Move the "now playing" highlight to this row immediately (optimistic) instead
      // of waiting up to a full poll cycle; the poll confirms shortly after.
      playOptimistic(
        { id: t.id, title: t.name, artist: t.artist, albumImage: t.albumImage },
        t.durationMs ?? 0,
      );
    });
  };

  // Slide newly-synced rows in: compare this render's row keys to the previous set and animate
  // only the few that just appeared on a background sync — not the first load or a day-switch
  // (which replaces the whole list). State updated during render (React's "info from previous
  // renders" pattern, same as track-list's prevTracks) so the class is present on the row's
  // first paint (no flicker) without reading a ref in render. Aggregate view only.
  const rowKeys = tracks.map((t) => `${t.id}-${t.lastPlayed}`);
  const keySig = rowKeys.join("");
  const [prevSig, setPrevSig] = useState(keySig);
  const [prevKeys, setPrevKeys] = useState<Set<string>>(() => new Set(rowKeys));
  // `anim` maps a row key to its stagger slot (0 = first to fall). A handful of genuinely-new
  // keys (a background sync) fall in together where they land; a wholesale change (you picked
  // another day / All time) cascades the top rows in, each a beat after the one above, so the
  // list pours into the box top-first. The rest sit below the fold and need no entrance.
  const [anim, setAnim] = useState<Map<string, number>>(() => new Map());
  if (prevSig !== keySig) {
    const fresh = rowKeys.filter((k) => !prevKeys.has(k));
    const bulk = fresh.length > Math.max(3, Math.floor(rowKeys.length * 0.3));
    setPrevSig(keySig);
    setPrevKeys(new Set(rowKeys));
    if (isLog || fresh.length === 0) {
      setAnim(new Map());
    } else if (bulk) {
      // New list → cascade the top rows, top-first.
      setAnim(new Map(rowKeys.slice(0, CASCADE_MAX).map((k, i) => [k, i])));
    } else {
      // A few new plays → each falls a beat after the one above (top-first), never all at once.
      setAnim(new Map(fresh.slice(0, CASCADE_MAX).map((k, i) => [k, i])));
      // …and ride the view up to them (handled by the effect below).
      setScrollCue((n) => n + 1);
    }
  }
  useEffect(() => {
    if (anim.size === 0) return;
    // Hold the class until the last (most-delayed) row finishes its fall, then reset so the next
    // diff starts clean.
    const maxSlot = Math.max(...anim.values());
    const id = setTimeout(
      () => setAnim(new Map()),
      maxSlot * cascadeStep(anim.size) + CASCADE_FALL_MS + 80,
    );
    return () => clearTimeout(id);
  }, [anim]);

  // New plays just landed at the top → ride the view up to reveal them, as if you already knew
  // the song was there. A smooth, lightly-hijacked scroll: eased in-and-out, with travel time
  // scaling to the distance so a long way up moves with more pace. Skips it when you're already
  // at the top (the row's float-in alone shows the song) or actively scrolling (don't fight you),
  // and honors prefers-reduced-motion (jumps instead of gliding).
  useEffect(() => {
    if (scrollCue === 0) return;
    const el = scrollBox.current;
    if (!el || el.scrollTop <= 4) return;
    if (Date.now() - lastUserScroll.current < 1200) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      el.scrollTop = 0;
      return;
    }
    const start = el.scrollTop;
    const duration = Math.min(900, 300 + start * 0.5);
    const t0 = performance.now();
    const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
    programmaticScroll.current = true;
    let raf = requestAnimationFrame(function step(now: number) {
      const p = Math.min(1, (now - t0) / duration);
      el.scrollTop = start * (1 - ease(p));
      if (p < 1) raf = requestAnimationFrame(step);
      else programmaticScroll.current = false;
    });
    return () => {
      cancelAnimationFrame(raf);
      programmaticScroll.current = false;
    };
  }, [scrollCue]);

  return (
    <div
      ref={scrollBox}
      onScroll={() => {
        if (!programmaticScroll.current) lastUserScroll.current = Date.now();
      }}
      className={"thin-scroll rounded-lg border border-border sm:overflow-y-auto " + maxHeightClass}
    >
      {/* Fixed layout: column widths stay constant and long text clips (then scrolls
          on hover) instead of widening the table into a horizontal scroll. Song and
          Album get the generous, roughly-equal flexible columns; From is narrower;
          the numeric/time columns are fixed and small. */}
      <table className="w-full table-fixed text-sm">
        <thead className="static z-10 bg-background sm:sticky sm:top-0">
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 font-medium">Song</th>
            <th className="hidden px-4 py-2 font-medium md:table-cell">Album</th>
            <th className="hidden w-20 px-4 py-2 text-right font-medium sm:table-cell">Length</th>
            {isLog ? null : <th className="w-16 px-4 py-2 text-right font-medium">Plays</th>}
            <th
              className={
                "hidden px-4 py-2 font-medium sm:table-cell " + (isLog ? "w-36" : "w-28")
              }
            >
              {isLog ? "Played" : "Last played"}
            </th>
            <th className="hidden w-40 px-4 py-2 font-medium lg:table-cell">From</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((t) => {
            const rowKey = `${t.id}-${t.lastPlayed}`;
            // In the day/all-time view there's one row per song, so matching by track id is
            // right. In the search log the same song repeats (one row per play) — matching by id
            // would turn ALL of them green, so there we light only the row you actually played.
            const isCurrent =
              !!currentId && currentId === t.id && (!isLog || rowKey === playedKey);
            const slot = anim.get(rowKey);
            const animating = slot !== undefined;
            return (
            <tr
              key={rowKey}
              ref={t.id === focusTrackId ? focusRow : undefined}
              // Stagger the fall: each cascading row waits its slot before easing in. `backwards`
              // fill (in the CSS) keeps it hidden during that wait so there's no pre-flash.
              style={animating && slot ? { animationDelay: `${Math.round(slot * cascadeStep(anim.size))}ms` } : undefined}
              className={
                "cursor-default border-b border-border last:border-0 transition-colors hover:bg-accent/30" +
                // The deep-linked row fades its grey wash out slowly/smoothly (vs the
                // default 150ms snap) — applied to the focus row itself so the longer
                // duration is in effect when the highlight clears, not just while it's on.
                (t.id === focusTrackId ? " duration-700 ease-out" : "") +
                // A freshly-synced play (or each row of a freshly-loaded list) eases down from
                // under the header instead of popping.
                (animating ? " history-row-in" : "") +
                (highlightId === t.id ? " bg-white/15" : isCurrent ? " bg-white/5" : "")
              }
              onDoubleClick={() => play(t, rowKey)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, track: toTrack(t) });
              }}
            >
              <td className="px-4 py-2">
                <div className="flex min-w-0 items-center gap-3">
                  <AlbumThumb src={t.albumImage} />
                  <div className="min-w-0 flex-1">
                    <HoverScroll
                      className={"font-medium" + (isCurrent ? " text-[#1db954]" : "")}
                    >
                      {t.name}
                    </HoverScroll>
                    <HoverScroll className="text-xs text-muted-foreground">
                      {t.artist}
                    </HoverScroll>
                    {/* Mobile only: the Album/Length/Last-played/From columns are hidden on
                        small screens, so fold the two most useful bits — when it was played and
                        which playlist it's from — into a compact line under the artist. */}
                    <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground/70 sm:hidden">
                      <span className="shrink-0">
                        {isLog ? exactTimeShort(t.lastPlayed) : timeAgo(t.lastPlayed)}
                      </span>
                      {t.source ? <span className="truncate">· {t.source}</span> : null}
                    </div>
                  </div>
                </div>
              </td>
              <td className="hidden px-4 py-2 text-muted-foreground md:table-cell">
                <HoverScroll>{t.album ?? "—"}</HoverScroll>
              </td>
              <td className="hidden px-4 py-2 text-right tabular-nums text-muted-foreground sm:table-cell">
                {formatDuration(t.durationMs)}
              </td>
              {isLog ? null : (
                <td className="px-4 py-2 text-right tabular-nums">{t.plays}</td>
              )}
              <td className="hidden px-4 py-2 text-muted-foreground sm:table-cell">
                <HoverTip
                  label={isLog ? timeAgo(t.lastPlayed) : exactTime(t.lastPlayed)}
                  className="cursor-default"
                >
                  {isLog ? exactTimeShort(t.lastPlayed) : timeAgo(t.lastPlayed)}
                </HoverTip>
              </td>
              <td className="hidden px-4 py-2 text-muted-foreground lg:table-cell">
                <HoverScroll>{t.source ?? "—"}</HoverScroll>
              </td>
            </tr>
            );
          })}
          {tracks.length === 0 ? (
            <tr>
              <td colSpan={isLog ? 5 : 6} className="px-4 py-8 text-center text-muted-foreground">
                {loading ? "Loading…" : empty}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {menu ? (
        <TrackContextMenu
          track={menu.track}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
