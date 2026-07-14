"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown } from "lucide-react";
import type { DayStats, TrackStats } from "@/lib/db";
import { exactTimeShort, formatDuration, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useNowPlaying } from "@/components/now-playing-context";
import {
  allTimePlaysAction,
  dailyStatsAction,
  dayTracksAction,
  refreshHistoryAction,
  searchPlaysAction,
} from "../history-actions";
import { DayCards } from "./day-cards";

import { SearchIsland } from "../search-island";

// Time-of-day only — the rows already sit under a picked day, so repeating the date
// on every line would be noise.
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Sorting for the day / all-time list. The sort keys ARE the table's columns, so the column
// headers are the control — no separate dropdown restating them (see the header row below).
// Every column sorts; `length` and `source` came free once the headers became the affordance.
type Sort = "recent" | "plays" | "title" | "artist" | "album" | "length" | "source";
const DEFAULT_DIR: Record<Sort, "asc" | "desc"> = {
  recent: "desc",
  plays: "desc",
  title: "asc",
  artist: "asc",
  album: "asc",
  length: "desc",
  source: "asc",
};
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
    case "length":
      return (a.durationMs ?? 0) - (b.durationMs ?? 0);
    case "source":
      // Unattributed plays ("(queued)") sort together at the end rather than under "".
      return (a.source ?? "￿").localeCompare(b.source ?? "￿");
  }
}

// One search result: a song with all its plays collapsed behind it (expandable),
// or an artist with their play total.
type SongGroup = { kind: "song"; t: TrackStats; count: number; plays: TrackStats[] };
type ArtistGroup = {
  kind: "artist";
  artist: string;
  count: number;
  lastPlayed: string;
  image: string | null;
};

// The history half of Home: day strip → list → search island. The greeting and the action
// dock render in the page shell instead, OUTSIDE this component's Suspense boundary, so they
// paint immediately while these (heavier) reads stream in behind a skeleton.
//
// Day switching fetches once per day through a server action and caches the result
// client-side, so revisiting a day is instant and nothing else on the page re-renders.
// Search hits the full history on the server (debounced), then groups per song or
// artist — repeated plays collapse into one row you can expand for the exact times.
export function DenHome({
  daily: initialDaily,
  allTime: initialAllTime,
  initialDay,
  initialTracks,
}: {
  daily: DayStats[];
  allTime: { plays: number; durationMs: number; since: string | null };
  initialDay: string;
  initialTracks: TrackStats[];
}) {
  // ---- Day selection (client cache, one action call per uncached day) ----
  const [daily, setDaily] = useState(initialDaily);
  const [allTime, setAllTime] = useState(initialAllTime);
  const [selected, setSelected] = useState(initialDay);
  const [tracks, setTracks] = useState(initialTracks);
  const [dayPending, setDayPending] = useState(false);
  // Bottom scroll cue for the day list: true while more rows sit below the fold. The fade
  // signals "there's more"; its absence at the end reads clearly as "you're at the bottom".
  const dayScrollRef = useRef<HTMLDivElement>(null);
  const [dayMoreBelow, setDayMoreBelow] = useState(false);
  const cache = useRef(new Map<string, TrackStats[]>([[initialDay, initialTracks]]));
  const dayReq = useRef(0);

  // A past day's plays can never change — once fetched it's frozen history. So persist those
  // to sessionStorage and they survive navigation entirely (no server round-trip on return).
  // Today is deliberately NOT persisted (it grows as you listen), and the store is capped so
  // it can't balloon: this is text only, a few KB a day.
  const DAY_STORE = "lb-days";
  const DAY_STORE_MAX = 20;
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DAY_STORE);
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, TrackStats[]>;
      for (const [day, rows] of Object.entries(saved)) {
        if (!cache.current.has(day)) cache.current.set(day, rows);
      }
    } catch {
      /* storage unavailable / corrupt — just fetch as usual */
    }
  }, []);
  const persistDay = (day: string, rows: TrackStats[]) => {
    // `initialDay` is the most recent day with plays — treat it as live, everything older is frozen.
    if (day === "all" || day >= initialDay) return;
    try {
      const raw = sessionStorage.getItem(DAY_STORE);
      const saved = raw ? (JSON.parse(raw) as Record<string, TrackStats[]>) : {};
      saved[day] = rows;
      const keys = Object.keys(saved).sort();
      while (keys.length > DAY_STORE_MAX) delete saved[keys.shift() as string];
      sessionStorage.setItem(DAY_STORE, JSON.stringify(saved));
    } catch {
      /* quota / unavailable — the in-memory cache still works */
    }
  };

  // Extend the day strip further back (2wk → 4wk → all). The whole daily set is one fast
  // query, so we fetch it ONCE and reveal more by slicing on the client — the chevron and
  // "See all" are then instant instead of paying a server round-trip each press. Prefetched
  // on mount so the full set is usually already in hand before the first click.
  const allDailyPromise = useRef<ReturnType<typeof dailyStatsAction> | null>(null);
  const loadAllDaily = () => {
    allDailyPromise.current ??= dailyStatsAction(100000);
    return allDailyPromise.current;
  };
  useEffect(() => {
    void loadAllDaily();
  }, []);
  const extendDays = async (days: number) => {
    const all = await loadAllDaily();
    if (all.length) setDaily(all.slice(0, days));
  };

  const select = (day: string) => {
    if (day === selected) return;
    setSelected(day);
    const hit = cache.current.get(day);
    if (hit) {
      setTracks(hit);
      return;
    }
    const req = ++dayReq.current;
    setDayPending(true);
    const load = day === "all" ? allTimePlaysAction() : dayTracksAction(day);
    load
      .then((rows) => {
        cache.current.set(day, rows);
        persistDay(day, rows);
        if (dayReq.current === req) setTracks(rows);
      })
      .finally(() => {
        if (dayReq.current === req) setDayPending(false);
      });
  };

  // ---- Search (debounced server action over the FULL history) ----
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"songs" | "artists">("songs");
  // The last query the server answered, with its rows. "Pending" is derived (the
  // typed query hasn't been answered yet) instead of set synchronously in the effect.
  const [resolved, setResolved] = useState<{ q: string; rows: TrackStats[] }>({
    q: "",
    rows: [],
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const searching = query.trim().length > 0;
  const searchPending = searching && resolved.q !== query.trim();
  const results = resolved.rows;

  // What's in the input right now — checked when a response lands so a slow answer
  // to an old query can never overwrite a newer one. Updated in the effect (which
  // runs on every query change), not during render.
  const liveQuery = useRef("");

  useEffect(() => {
    const q = query.trim();
    liveQuery.current = q;
    if (!q) return;
    const id = setTimeout(() => {
      searchPlaysAction(q).then((rows) => {
        if (liveQuery.current === q) setResolved({ q, rows });
      });
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  // ---- Live refresh: pull new plays from Spotify -----------------------------------------
  // Everything else on this page reads the local store, and the store only grows when
  // something calls Spotify. Nothing on this page did — so a song that finished never
  // appeared in the list, however long you waited or how often you came back. This is the
  // sync that was missing.
  //
  // Three triggers, each catching a case the others can't:
  //   • the now-playing chip changes song → the play that just ENDED is now loggable. Spotify's
  //     recently-played endpoint lags the chip by a beat, so ask once more 4s later.
  //   • the tab becomes visible → you were away; catch up now instead of waiting out a timer.
  //   • a slow interval → covers idle/stopped playback, where neither of the above ever fires.
  const { playing } = useNowPlaying();
  const nowPlayingId = playing?.track.id ?? null;
  // What the user is looking at right now, readable from inside an in-flight refresh so a slow
  // response can't overwrite a view they've since moved away from.
  const selRef = useRef(selected);
  useEffect(() => {
    selRef.current = selected;
  }, [selected]);

  const doRefresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    doRefresh.current = async () => {
      const at = selected;
      // A pinned past day is frozen history, and a search owns its own result set: in both
      // cases refresh the stats but skip rows we'd only overwrite with identical ones.
      const followingLatest = selected === (daily[0]?.day ?? null);
      const want = searching ? null : selected === "all" ? "all" : followingLatest ? "latest" : null;
      const r = await refreshHistoryAction(want, daily.length);
      if (!r.ok || selRef.current !== at) return;
      setDaily(r.daily);
      setAllTime(r.allTime);
      if (!r.day || !r.tracks) return;
      cache.current.set(r.day, r.tracks);
      // The local day rolled over while the tab sat open — follow it onto the new day instead
      // of leaving you parked on what used to be "today".
      if (r.day !== at) setSelected(r.day);
      setTracks(r.tracks);
    };
  });

  useEffect(() => {
    void doRefresh.current();
    const t = setTimeout(() => void doRefresh.current(), 4000);
    return () => clearTimeout(t);
  }, [nowPlayingId]);

  useEffect(() => {
    const id = setInterval(() => void doRefresh.current(), 120_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void doRefresh.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const groups = useMemo<(SongGroup | ArtistGroup)[]>(() => {
    if (!searching) return [];
    const q = query.trim().toLowerCase();
    if (mode === "songs") {
      // Songs mode matches the TITLE only — artist matches belong to the other tab.
      const byId = new Map<string, SongGroup>();
      for (const r of results) {
        if (!r.name.toLowerCase().includes(q)) continue;
        const g = byId.get(r.id);
        if (g) {
          g.count++;
          g.plays.push(r);
        } else {
          byId.set(r.id, { kind: "song", t: r, count: 1, plays: [r] });
        }
      }
      return [...byId.values()];
    }
    // Artists: only rows whose ARTIST matched the query, grouped per artist.
    const byArtist = new Map<string, ArtistGroup>();
    for (const r of results) {
      if (!r.artist.toLowerCase().includes(q)) continue;
      const g = byArtist.get(r.artist);
      if (g) {
        g.count++;
      } else {
        byArtist.set(r.artist, {
          kind: "artist",
          artist: r.artist,
          count: 1,
          lastPlayed: r.lastPlayed, // rows come newest-first
          image: r.albumImage,
        });
      }
    }
    return [...byArtist.values()];
  }, [results, searching, mode, query]);

  // ---- Sort (day / all-time list) ----
  const [sort, setSort] = useState<Sort>("recent");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  // Click a column to sort by it; click the active column again to flip direction. In a
  // table that re-click IS the convention (it was only opaque inside a dropdown), and the
  // arrow on the active header shows the state.
  const sortBy = (key: Sort) => {
    if (key === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(DEFAULT_DIR[key]);
    }
  };

  const dayRows = useMemo(() => {
    const f = dir === "asc" ? 1 : -1;
    return [...tracks].sort((a, b) => f * compareTracks(a, b, sort));
  }, [tracks, sort, dir]);

  // Recompute the bottom cue whenever the visible rows change (new day / re-sort).
  useEffect(() => {
    const el = dayScrollRef.current;
    setDayMoreBelow(!!el && el.scrollHeight - el.clientHeight - el.scrollTop > 2);
  }, [dayRows]);

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="shrink-0">
          <DayCards
            daily={daily}
            selected={selected}
            allTime={allTime}
            onSelect={select}
            onExtend={extendDays}
          />
        </div>

        {searching ? (
          <div
            className={cn(
              "thin-scroll min-h-0 flex-1 overflow-y-auto",
              searchPending && "opacity-60 transition-opacity",
            )}
          >
            {groups.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {searchPending
                  ? "Searching…"
                  : `No ${mode === "songs" ? "songs" : "artists"} match “${query.trim()}”.`}
              </p>
            ) : (
              <ul className="divide-y divide-border/50">
                {groups.map((g) =>
                  g.kind === "song" ? (
                    <SongResult
                      key={g.t.id}
                      group={g}
                      expanded={expanded === g.t.id}
                      onToggle={() => setExpanded((e) => (e === g.t.id ? null : g.t.id))}
                    />
                  ) : (
                    <li key={g.artist}>
                      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2 sm:gap-4">
                        <Art image={g.image} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium select-text">{g.artist}</p>
                          <p className="text-[13px] text-muted-foreground">
                            {g.count} {g.count === 1 ? "play" : "plays"}
                          </p>
                        </div>
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {timeAgo(g.lastPlayed)}
                        </p>
                      </div>
                    </li>
                  ),
                )}
              </ul>
            )}
          </div>
        ) : (
          <div className={cn("min-h-0 flex-1", dayPending && "opacity-60 transition-opacity")}>
            {dayRows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No plays recorded here.
              </p>
            ) : (
              // Fixed-layout table (like the live history table): column widths stay put
              // and long text clips instead of pushing the columns apart. Song + Album take
              // the flexible share; the numeric/time columns are right-aligned and narrow so
              // Length / Plays / Played read as one tight cluster next to From, rather than
              // drifting apart. The box fills the remaining height and scrolls inside; the
              // header stays pinned. No max-height cap any more: with the sort row gone, the
              // list absorbs that reclaimed space instead of leaving a dead gap above the island.
              <div className="relative h-full">
                <div
                  ref={dayScrollRef}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    setDayMoreBelow(el.scrollHeight - el.clientHeight - el.scrollTop > 2);
                  }}
                  // Indented to the day cards' text, not the tray's outer edge (see
                  // --day-text-inset in den.css). Right edge is unchanged, so From stays
                  // flush with the All-time card.
                  className="thin-scroll h-full overflow-y-auto pl-[var(--day-text-inset)]"
                >
                <table className="w-full table-fixed text-[15px]">
                  <thead className="sticky top-0 z-10 bg-background">
                    {/* The header row IS the sort control — the sort keys were always just the
                        columns, so a dropdown restating them (in its own full-width row) was
                        redundant. The Song column holds title + artist, so it offers both. */}
                    <tr className="border-b border-border/60 text-left text-[11px] whitespace-nowrap uppercase tracking-wide text-muted-foreground/70">
                      <th className="py-2 pr-4 font-medium">
                        <SortHead k="title" label="Song" sort={sort} dir={dir} onSort={sortBy} />
                        <span className="px-1.5 text-muted-foreground/40">·</span>
                        <SortHead k="artist" label="Artist" sort={sort} dir={dir} onSort={sortBy} />
                      </th>
                      <th className="hidden w-56 py-2 pr-4 font-medium md:table-cell">
                        <SortHead k="album" label="Album" sort={sort} dir={dir} onSort={sortBy} />
                      </th>
                      <th className="hidden w-16 py-2 pr-6 text-right font-medium sm:table-cell">
                        <SortHead k="length" label="Length" sort={sort} dir={dir} onSort={sortBy} />
                      </th>
                      <th className="w-14 py-2 pr-6 text-right font-medium">
                        <SortHead k="plays" label="Plays" sort={sort} dir={dir} onSort={sortBy} />
                      </th>
                      <th className="hidden w-24 py-2 pr-6 text-right font-medium sm:table-cell">
                        <SortHead
                          k="recent"
                          label={selected === "all" ? "Last played" : "Played"}
                          sort={sort}
                          dir={dir}
                          onSort={sortBy}
                        />
                      </th>
                      <th className="hidden w-20 py-2 text-right font-medium lg:table-cell">
                        <SortHead k="source" label="From" sort={sort} dir={dir} onSort={sortBy} />
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {dayRows.map((t) => (
                      <tr key={`${t.id}-${t.lastPlayed}`}>
                        <td className="py-2 pr-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <Art image={t.albumImage} size={10} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate select-text">{t.name}</p>
                              <p className="truncate text-[13px] text-muted-foreground select-text">
                                {t.artist}
                              </p>
                              {/* Phones hide the side columns — fold time + source here. */}
                              <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70 sm:hidden">
                                {selected === "all" ? timeAgo(t.lastPlayed) : clockTime(t.lastPlayed)}
                                {t.source ? ` · ${t.source}` : ""}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="hidden truncate py-2 pr-4 text-muted-foreground md:table-cell">
                          {t.album ?? "—"}
                        </td>
                        <td className="hidden py-2 pr-6 text-right tabular-nums text-muted-foreground sm:table-cell">
                          {formatDuration(t.durationMs)}
                        </td>
                        <td className="py-2 pr-6 text-right tabular-nums text-muted-foreground">
                          {t.plays}
                        </td>
                        <td className="hidden py-2 pr-6 text-right tabular-nums text-muted-foreground sm:table-cell">
                          {selected === "all" ? timeAgo(t.lastPlayed) : clockTime(t.lastPlayed)}
                        </td>
                        <td className="hidden truncate py-2 text-right text-muted-foreground lg:table-cell">
                          {t.source ?? "(queued)"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                {/* Fades the last rows while more sits below; gone at the end, so reaching
                    the bottom of the list is unmistakable. */}
                <div
                  className={cn(
                    "pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background to-transparent transition-opacity duration-200",
                    dayMoreBelow ? "opacity-100" : "opacity-0",
                  )}
                />
              </div>
            )}
          </div>
        )}
      </section>

      {/* Bottom-centered search island. Sits below the content (the page reserves room), so
          it also reads as the bottom of the screen. Carries the songs/artists switch. */}
      <SearchIsland
        query={query}
        onQuery={setQuery}
        placeholder={mode === "songs" ? "Search your songs…" : "Search artists…"}
      >
        <div className="flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-muted/60 p-0.5">
          {(["songs", "artists"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setExpanded(null);
              }}
              aria-pressed={mode === m}
              className={cn(
                "h-7 rounded-full px-3 text-[12px] font-medium capitalize transition-colors",
                mode === m
                  ? "bg-secondary text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </SearchIsland>
    </>
  );
}

// One clickable column header. Inactive: the same muted caps as any other header, brightening
// on hover. Active: full ink + the direction arrow — so the sort state is read off the column
// it applies to, not off a separate control.
function SortHead({
  k,
  label,
  sort,
  dir,
  onSort,
}: {
  k: Sort;
  label: string;
  sort: Sort;
  dir: "asc" | "desc";
  onSort: (k: Sort) => void;
}) {
  const on = sort === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      aria-label={`Sort by ${label}`}
      className={cn(
        "inline-flex items-center gap-1 uppercase transition-colors",
        on ? "text-foreground" : "hover:text-foreground",
      )}
    >
      {label}
      {on ? (
        dir === "asc" ? (
          <ArrowUp className="size-3" />
        ) : (
          <ArrowDown className="size-3" />
        )
      ) : null}
    </button>
  );
}

function Art({ image, size = 11 }: { image: string | null; size?: 9 | 10 | 11 }) {
  const cls = size === 9 ? "size-9" : size === 10 ? "size-10" : "size-11";
  return image ? (
    <img src={image} alt="" loading="lazy" className={`${cls} shrink-0 rounded-md object-cover`} />
  ) : (
    <span className={`${cls} shrink-0 rounded-md bg-secondary`} />
  );
}

// A matched song: one row no matter how many times it was played; the play count sits
// on the right and the row expands to the exact listen times.
function SongResult({
  group,
  expanded,
  onToggle,
}: {
  group: SongGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, count, plays } = group;
  const SHOW = 12;
  const [showAllPlays, setShowAllPlays] = useState(false);
  const listed = showAllPlays ? plays : plays.slice(0, SHOW);
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 py-2 text-left sm:gap-4 md:grid-cols-[auto_minmax(0,5fr)_minmax(0,4fr)_auto_auto]"
      >
        <Art image={t.albumImage} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium select-text">{t.name}</p>
          <p className="truncate text-[13px] text-muted-foreground select-text">{t.artist}</p>
        </div>
        <p className="hidden truncate text-[13px] text-muted-foreground md:block">{t.album}</p>
        <div className="text-right">
          {count > 1 ? <p className="text-sm font-medium tabular-nums">×{count}</p> : null}
          <p className="text-xs tabular-nums text-muted-foreground">{timeAgo(t.lastPlayed)}</p>
        </div>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground/60 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <ul className="mb-2 ml-[3.75rem] space-y-1 border-l border-border/60 pl-4">
          {listed.map((p, i) => (
            <li key={i} className="text-[13px] tabular-nums text-muted-foreground">
              {exactTimeShort(p.lastPlayed)}
            </li>
          ))}
          {plays.length > SHOW && !showAllPlays ? (
            <li>
              <button
                type="button"
                onClick={() => setShowAllPlays(true)}
                className="text-[13px] font-medium text-muted-foreground/80 transition-colors hover:text-foreground"
              >
                Show all {plays.length}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
