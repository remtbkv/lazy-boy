"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, SearchIcon, X } from "lucide-react";
import type { DayStats, StoredPlaylist, TrackStats } from "@/lib/db";
import { exactTimeShort, formatDuration, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SortMenu } from "@/components/sort-menu";
import {
  allTimePlaysAction,
  dailyStatsAction,
  dayTracksAction,
  searchPlaysAction,
} from "./actions";
import { DayCards } from "./day-cards";
import { ActionDock } from "./dock";

const PAGE = 80; // rows shown before "Show all" — keeps the DOM light on phones

// Time-of-day only — the rows already sit under a picked day, so repeating the date
// on every line would be noise.
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Sorting for the day / all-time list — the live app's set, compact labels.
type Sort = "recent" | "plays" | "title" | "artist" | "album";
const SORTS: { key: Sort; label: string }[] = [
  { key: "recent", label: "Recently played" },
  { key: "plays", label: "Plays" },
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
];
const DEFAULT_DIR: Record<Sort, "asc" | "desc"> = {
  recent: "desc",
  plays: "desc",
  title: "asc",
  artist: "asc",
  album: "asc",
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

// The draft home composition: greeting → actions → rhythm spine → history.
// Day switching fetches once per day through a server action and caches the result
// client-side, so revisiting a day is instant and nothing else on the page re-renders.
// Search hits the full history on the server (debounced), then groups per song or
// artist — repeated plays collapse into one row you can expand for the exact times.
export function DenHome({
  greeting,
  daily: initialDaily,
  allTime,
  initialDay,
  initialTracks,
  playlists,
}: {
  greeting: string;
  daily: DayStats[];
  allTime: { plays: number; durationMs: number; since: string | null };
  initialDay: string;
  initialTracks: TrackStats[];
  playlists: StoredPlaylist[];
}) {
  // ---- Day selection (client cache, one action call per uncached day) ----
  const [daily, setDaily] = useState(initialDaily);
  const [selected, setSelected] = useState(initialDay);
  const [tracks, setTracks] = useState(initialTracks);
  const [dayPending, setDayPending] = useState(false);
  const cache = useRef(new Map<string, TrackStats[]>([[initialDay, initialTracks]]));
  const dayReq = useRef(0);

  // Extend the day strip further back (2wk → 4wk → all).
  const extendDays = async (days: number) => {
    const rows = await dailyStatsAction(days);
    if (rows.length) setDaily(rows);
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
  const searchRef = useRef<HTMLInputElement>(null);
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
  const selectSort = (key: Sort) => {
    if (key === sort) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(key);
      setDir(DEFAULT_DIR[key]);
    }
  };

  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(() => {
    const f = dir === "asc" ? 1 : -1;
    return [...tracks].sort((a, b) => f * compareTracks(a, b, sort));
  }, [tracks, sort, dir]);
  const dayRows = showAll ? sorted : sorted.slice(0, PAGE);

  return (
    <div className="space-y-8">
      {/* Just the greeting — today's numbers already live on the Today card below;
          repeating them here said the same thing twice within an inch. */}
      <header>
        <h1 className="den-display text-[27px] leading-tight sm:text-4xl">{greeting}</h1>
      </header>

      <ActionDock playlists={playlists} />

      <section className="space-y-5">
        <DayCards
          daily={daily}
          selected={selected}
          allTime={allTime}
          onSelect={select}
          onExtend={extendDays}
        />

        {/* Search row: field + the song/artist switch (the two things history search
            can look for — same split as the live Find feature). */}
        <div className="flex items-center gap-2">
          <div className="flex h-11 flex-1 items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 focus-within:border-[color-mix(in_srgb,var(--border)_30%,var(--muted-foreground))]">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={mode === "songs" ? "Search your songs…" : "Search artists…"}
              aria-label="Search listening history"
              className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
            {searching ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          {/* One contextual control beside the field: while typing, the songs/artists
              switch (it only affects search); otherwise the sort menu for the list
              below. Never both — two idle controls was clutter. */}
          {searching ? (
            <div className="flex h-11 shrink-0 items-center gap-0.5 rounded-xl border border-border bg-card p-1">
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
                    "h-full rounded-lg px-2.5 text-[13px] font-medium capitalize transition-colors sm:px-3",
                    mode === m ? "bg-secondary text-foreground" : "text-muted-foreground",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          ) : (
            <div className="shrink-0">
              <SortMenu value={sort} direction={dir} options={SORTS} onSelect={selectSort} />
            </div>
          )}
        </div>

        {searching ? (
          <div className={cn(searchPending && "opacity-60 transition-opacity")}>
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
          <div className={cn(dayPending && "opacity-60 transition-opacity")}>
            {dayRows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No plays recorded here.
              </p>
            ) : (
              // Fixed-layout table (like the live history table): column widths stay put
              // and long text clips instead of pushing the columns apart. Song + Album take
              // the flexible share; the numeric/time/source columns are narrow and fixed.
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground/70">
                    <th className="py-2 pr-3 font-medium">Song</th>
                    <th className="hidden py-2 pr-3 font-medium md:table-cell">Album</th>
                    <th className="hidden w-16 py-2 pr-3 text-right font-medium sm:table-cell">
                      Length
                    </th>
                    <th className="w-14 py-2 pr-3 text-right font-medium">Plays</th>
                    <th className="hidden w-24 py-2 pr-3 font-medium sm:table-cell">
                      {selected === "all" ? "Last played" : "Played"}
                    </th>
                    <th className="hidden w-32 py-2 font-medium lg:table-cell">From</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {dayRows.map((t) => (
                    <tr key={`${t.id}-${t.lastPlayed}`}>
                      <td className="py-2 pr-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <Art image={t.albumImage} size={9} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium select-text">{t.name}</p>
                            <p className="truncate text-xs text-muted-foreground select-text">
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
                      <td className="hidden truncate py-2 pr-3 text-muted-foreground md:table-cell">
                        {t.album ?? "—"}
                      </td>
                      <td className="hidden py-2 pr-3 text-right tabular-nums text-muted-foreground sm:table-cell">
                        {formatDuration(t.durationMs)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{t.plays}</td>
                      <td className="hidden truncate py-2 pr-3 text-muted-foreground sm:table-cell">
                        {selected === "all" ? timeAgo(t.lastPlayed) : clockTime(t.lastPlayed)}
                      </td>
                      <td className="hidden truncate py-2 text-muted-foreground lg:table-cell">
                        {t.source ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tracks.length > PAGE && !showAll ? (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="mt-3 w-full rounded-lg border border-border/70 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Show all {tracks.length}
              </button>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function Art({ image, size = 11 }: { image: string | null; size?: 9 | 11 }) {
  const cls = size === 9 ? "size-9" : "size-11";
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
