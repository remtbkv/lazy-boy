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
  playsForTracksAction,
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
//
// Title and artist come from the client-side index and are on screen the moment you type.
// Everything derived from the plays themselves — count, lastPlayed, album, art — is null until
// the stats for the matched ids land a beat later, so each of those is optional by
// construction rather than by convention. See the search block below.
type SongGroup = {
  kind: "song";
  id: string;
  name: string;
  artist: string;
  album: string | null;
  image: string | null;
  count: number | null;
  lastPlayed: string | null;
  plays: TrackStats[];
};
type ArtistGroup = {
  kind: "artist";
  artist: string;
  count: number | null;
  lastPlayed: string | null;
  image: string | null;
};

// One track in the client-side search index. `ln`/`la` are the lower-cased name/artist,
// folded once when the index loads so a keystroke is ~3,000 String.includes calls over
// strings already in the right case instead of ~3,000 fresh toLowerCase allocations.
// `image` is resolved from the payload's interned URL table at load time.
type IndexEntry = {
  id: string;
  name: string;
  artist: string;
  image: string | null;
  ln: string;
  la: string;
};

// Cap on how many matched tracks a query may carry: a one-letter query matches thousands, and
// these ids are exactly what the hydration call asks about. Mirrored server-side in
// playsForTracksAction.
const MAX_MATCHES = 400;
// The row cap in getPlaysForTracks (db.ts). A hydration that comes back at the cap may be
// missing plays, which makes its counts unsafe to re-use for a narrower query.
const HYDRATE_ROW_CAP = 3000;
const SEARCH_DEBOUNCE_MS = 120;

type SearchPlays = {
  rows: TrackStats[];
  /** Index path: the ids these rows cover. */
  ids: Set<string>;
  /** The `mode:query` these rows answer. Set on failure too — it is what stops the effect
   *  re-firing forever, and what tells the view the query has been answered at all. */
  key: string;
  /** False when the server hit its row cap — see HYDRATE_ROW_CAP. */
  complete: boolean;
  /** The request for `key` failed. Distinguishes "no results" from "no answer". */
  failed: boolean;
};
const NO_PLAYS: SearchPlays = { rows: [], ids: new Set(), key: "", complete: true, failed: false };

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

  // One day into the cache. Shared by the click path and the neighbour prefetch below so a
  // day fetched either way is stored — and persisted — identically.
  const fetchDay = (day: string) =>
    (day === "all" ? allTimePlaysAction() : dayTracksAction(day)).then((rows) => {
      cache.current.set(day, rows);
      persistDay(day, rows);
      return rows;
    });

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
    fetchDay(day)
      .then((rows) => {
        if (dayReq.current === req) setTracks(rows);
      })
      .finally(() => {
        if (dayReq.current === req) setDayPending(false);
      });
  };

  // Prefetch the two days either side of the one you're on. Day switching was a server round
  // trip per uncached day — 294ms median (229-334, n=8, dev + replica, 2026-08-05), and the
  // dominant term in production is the read itself — paid AFTER the click, which is what made
  // walking the strip feel slow. The neighbours are the days a click is actually going to ask
  // for next, so they're fetched while you're reading the current one and the click becomes a
  // cache hit. Cheap to be wrong: a past day's server-side entry is cached (db.ts "Read
  // caching"), so an unused warm costs one indexed ~90-row read at most, and nothing after.
  const warming = useRef(new Set<string>());
  useEffect(() => {
    const i = daily.findIndex((d) => d.day === selected);
    if (i < 0) return; // "all", or a day the strip hasn't loaded — nothing adjacent to warm
    for (const day of [daily[i + 1]?.day, daily[i - 1]?.day]) {
      if (!day || cache.current.has(day) || warming.current.has(day)) continue;
      warming.current.add(day);
      void fetchDay(day)
        .catch(() => {
          /* a failed warm is invisible: the click path fetches it again for real */
        })
        .finally(() => warming.current.delete(day));
    }
    // fetchDay/persistDay are re-created every render but close over refs only; listing them
    // would re-run this on every render instead of when the day (or the strip) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, daily]);

  // ---- Search (matched in the browser; stats hydrated behind the rows) -------------------
  // Every keystroke used to be a debounced server action running `LIKE '%q%'` over the whole
  // history — unindexable by construction (GOTCHAS: count the rows a query SCANS), so each
  // character paid a round trip plus a full `tracks` scan against remote Turso: 1,904.5ms
  // median (1,382.8-3,132.7), n=7, 2026-08-05, `bench-reads.mjs search`. Matching now runs in
  // this browser against a compact index of every played track
  // ([id, name, artist, albumImage], 156,863 B gzipped, /api/history/search-index), so typing
  // costs no network at all.
  //
  // The index carries everything a row needs to look FINISHED — title, artist, art — and
  // nothing that changes per play (db.ts, "The client-side search index"). So the contract on
  // screen is: complete-looking rows appear instantly from the index, and ONE debounced call
  // fills in the play counts and times behind them.
  //
  // The match is a plain case-insensitive substring, per mode: the title in Songs, the artist
  // in Artists. That is exactly what the SQL path answered (LIKE on name OR artist, then the
  // grouping below kept only rows whose relevant field matched), so this moved WHERE matching
  // runs, not WHAT matches. lib/filter.ts's fuzzyFilter is the other shared matcher and is
  // deliberately not used here: it splits the query into order-independent tokens and re-ranks,
  // which is a different — and for this box, wider — answer than the one being replaced.
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"songs" | "artists">("songs");
  const [expanded, setExpanded] = useState<string | null>(null);
  const searching = query.trim().length > 0;

  // The index is fetched off the render path and then held in memory for the rest of the visit.
  // Persistence across visits is the browser's HTTP cache plus the route's ETag: a reload
  // revalidates in one 304 with no body.
  const [index, setIndex] = useState<IndexEntry[] | null>(null);
  const indexReq = useRef<Promise<void> | null>(null);
  const loadIndex = () => {
    indexReq.current ??= fetch("/api/history/search-index")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { images?: string[]; tracks?: [string, string, string, number][] }) => {
        // A 200 does NOT mean a payload this build can read. A cache one layer up — the
        // browser's, or Vercel's Data Cache, which outlives a deployment — can hand back a body
        // written by an older shape of this route; that is what broke production on
        // 2026-08-05. Both tokens now make that a miss rather than a hit, and this check is the
        // last line: an unreadable payload counts as NO INDEX (the search falls back to the
        // server), never as an empty or half-built one.
        const tracks = d?.tracks;
        const ok =
          Array.isArray(tracks) &&
          (tracks.length === 0 || (Array.isArray(tracks[0]) && tracks[0].length >= 4));
        if (!ok) throw new Error("search index: unrecognised payload shape");
        setIndex(
          tracks.map(([id, name, artist, img]) => ({
            id,
            name,
            artist,
            image: img >= 0 ? (d.images?.[img] ?? null) : null,
            ln: name.toLowerCase(),
            la: artist.toLowerCase(),
          })),
        );
      })
      .catch(() => {
        // Nothing to retry: without an index every keystroke goes to the server instead, which
        // is exactly what this page did before the index existed.
      });
  };

  // Fetched on IDLE after Home has painted, not on focus. Focus was too late in the one case
  // that matters: on a cold data cache the server has to build the index (~2.7s against the
  // primary), so the first person to search after a deploy waited that out with the box already
  // in front of them — the "still ~2s" report this whole change was meant to fix. Starting it
  // during the idle gap between the page landing and a hand reaching the search box hides the
  // build entirely. requestIdleCallback so it can never compete with hydration or the first
  // paint; a plain timeout where that doesn't exist (Safari). Focus and the first keystroke
  // stay wired to loadIndex() as backstops — it is idempotent, so whichever fires first wins.
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(() => loadIndex(), { timeout: 2000 });
      return () => w.cancelIdleCallback?.(h);
    }
    const t = setTimeout(loadIndex, 800);
    return () => clearTimeout(t);
  }, []);

  // The matched tracks, newest play first (the index arrives in that order, so the result
  // order is the one the SQL search produced). `null` means "no index answer" — still loading
  // or failed — which is what routes the query to the server fallback below.
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !index) return null;
    const out: IndexEntry[] = [];
    for (const e of index) {
      if ((mode === "songs" ? e.ln : e.la).includes(q)) {
        out.push(e);
        if (out.length >= MAX_MATCHES) break;
      }
    }
    return out;
  }, [index, query, mode]);

  // Plays behind the current results — from the hydration call on the index path, from the old
  // search action on the fallback path. Both return one row per play, so the grouping below
  // doesn't care which ran.
  const [plays, setPlays] = useState<SearchPlays>(NO_PLAYS);
  // The mode+query in the box right now, checked when a response lands so a slow answer to an
  // old query can never overwrite a newer one. Updated in the effect (which runs on every
  // change), not during render.
  const liveKey = useRef("");

  useEffect(() => {
    const q = query.trim();
    const k = `${mode}:${q}`;
    liveKey.current = k;
    if (!q) return;
    loadIndex();
    // This effect re-runs when `plays` lands (it reads it, below), so without this the answer
    // to a query would schedule the next request for the SAME query — a self-feeding loop.
    // `key` is set to the query a response was fetched for, on both paths.
    if (plays.key === k) return;

    if (!matched) {
      // Fallback: the index is in flight or failed. This is the old path, unchanged — the box
      // is never dead, it just goes back to costing a round trip per query.
      const id = setTimeout(() => {
        searchPlaysAction(q)
          .then((rows) => {
            if (liveKey.current === k) setPlays({ rows, ids: new Set(), key: k, complete: true, failed: false });
          })
          // Without this the page hangs on "Searching…" for as long as it is open — a rejected
          // action left `plays` untouched, so the pending flag below never cleared. That is the
          // regression Rem hit: the index was unreadable (stale-shaped cache entry), every
          // query fell through to here, and one failed action was terminal. Record the failure
          // under the same key a success would use, so the view resolves and the effect stops.
          .catch(() => {
            if (liveKey.current === k) setPlays({ rows: [], ids: new Set(), key: k, complete: true, failed: true });
          });
      }, SEARCH_DEBOUNCE_MS);
      return () => clearTimeout(id);
    }
    if (matched.length === 0) return;
    // Typing narrows: every match for "abc" is also a match for "ab". So once a complete set of
    // plays is in hand, extending the query needs no request at all — the test is simply
    // whether the ids now wanted are already covered, which also catches going back to a
    // shorter query or flipping modes.
    if (plays.complete && matched.every((m) => plays.ids.has(m.id))) return;
    const ids = matched.map((m) => m.id);
    const id = setTimeout(() => {
      playsForTracksAction(ids)
        .then((rows) => {
          if (liveKey.current !== k) return;
          setPlays({ rows, ids: new Set(ids), key: k, complete: rows.length < HYDRATE_ROW_CAP, failed: false });
        })
        // The rows are already on screen here, so a failure costs counts and times, not the
        // result. Recording it under `key` is what stops the effect retrying on every render.
        .catch(() => {
          if (liveKey.current === k) {
            setPlays({ rows: [], ids: new Set(), key: k, complete: true, failed: true });
          }
        });
      // 120ms: this no longer guards a slow query (the rows are already on screen), it just
      // stops a burst of typing firing a call per character.
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, mode, matched, plays]);

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
      // New plays landed. If one of them was a song never played before, the search index we
      // are holding doesn't have it — drop our copy so the next keystroke re-asks. Usually a
      // 304 with no body: the ETag only moves when `tracks` actually gained a row.
      if (r.added > 0) indexReq.current = null;
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

  // Whether the plays in hand answer what is on screen. On the index path that's id coverage;
  // on the fallback path it's the query they were fetched for.
  const statsReady = matched
    ? matched.every((m) => plays.ids.has(m.id))
    : plays.key === `${mode}:${query.trim()}`;
  // Only the fallback path has nothing to show while it waits — the index path already has the
  // rows and is only missing their numbers.
  const searchPending = searching && !matched && !statsReady;
  // Answered, but with a failure rather than results. Kept distinct from "no results": telling
  // someone their song isn't in their history when the request simply failed is a lie.
  const searchFailed = searching && plays.failed && plays.key === `${mode}:${query.trim()}`;

  const groups = useMemo<(SongGroup | ArtistGroup)[]>(() => {
    if (!searching) return [];
    const q = query.trim().toLowerCase();
    const rows = statsReady ? plays.rows : [];
    const byId = new Map<string, TrackStats[]>();
    for (const r of rows) {
      const list = byId.get(r.id);
      if (list) list.push(r);
      else byId.set(r.id, [r]);
    }
    // The matched tracks: the client index when it's loaded, otherwise reconstructed from the
    // server's rows — those come newest-first too, so first appearance gives the same order.
    // Songs mode matches the TITLE only; artist matches belong to the other tab.
    let entries: { id: string; name: string; artist: string; image: string | null }[];
    if (matched) {
      entries = matched;
    } else {
      entries = [];
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.id) || !(mode === "songs" ? r.name : r.artist).toLowerCase().includes(q)) {
          continue;
        }
        seen.add(r.id);
        entries.push({ id: r.id, name: r.name, artist: r.artist, image: r.albumImage });
      }
    }

    if (mode === "songs") {
      return entries.map((e) => {
        const p = byId.get(e.id) ?? [];
        const newest = p[0]; // rows come newest-first
        return {
          kind: "song",
          id: e.id,
          name: e.name,
          artist: e.artist,
          album: newest?.album ?? null,
          // From the index, so the art is in the first paint — the row reads as finished
          // before the counts arrive rather than as a grey square that might still be loading.
          image: e.image ?? newest?.albumImage ?? null,
          count: p.length || null,
          lastPlayed: newest?.lastPlayed ?? null,
          plays: p,
        };
      });
    }
    // Artists: the matched tracks folded per artist, so an artist's total is the sum over
    // their matched songs.
    const byArtist = new Map<string, ArtistGroup>();
    for (const e of entries) {
      let g = byArtist.get(e.artist);
      if (!g) {
        g = { kind: "artist", artist: e.artist, count: null, lastPlayed: null, image: null };
        byArtist.set(e.artist, g);
      }
      g.image ??= e.image; // index-supplied: art paints with the row, not after it
      const p = byId.get(e.id) ?? [];
      if (p.length === 0) continue;
      g.count = (g.count ?? 0) + p.length;
      if (!g.lastPlayed || p[0].lastPlayed > g.lastPlayed) g.lastPlayed = p[0].lastPlayed;
    }
    return [...byArtist.values()];
  }, [matched, plays, statsReady, searching, mode, query]);

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
                  : searchFailed
                    ? "Couldn’t reach the server. Edit the search to try again."
                    : `No ${mode === "songs" ? "songs" : "artists"} match “${query.trim()}”.`}
              </p>
            ) : (
              <ul className="divide-y divide-border/50">
                {groups.map((g) =>
                  g.kind === "song" ? (
                    <SongResult
                      key={g.id}
                      group={g}
                      expanded={expanded === g.id}
                      onToggle={() => setExpanded((e) => (e === g.id ? null : g.id))}
                    />
                  ) : (
                    <li key={g.artist}>
                      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2 sm:gap-4">
                        <Art image={g.image} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium select-text">{g.artist}</p>
                          {/* The play total arrives after the row does; the non-breaking space
                              holds the line so nothing reflows when it lands. */}
                          <p className="text-[13px] text-muted-foreground">
                            {g.count == null
                              ? " "
                              : `${g.count} ${g.count === 1 ? "play" : "plays"}`}
                          </p>
                        </div>
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {g.lastPlayed ? timeAgo(g.lastPlayed) : ""}
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
                  // pr keeps the right-aligned FROM/PLAYED text off the scrollbar.
                  className="thin-scroll h-full overflow-y-auto pl-[var(--day-text-inset)] pr-2"
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
                    "pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent transition-opacity duration-200",
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
        // Start pulling the index the moment the box is focused, so it is usually already in
        // hand by the first character. Idempotent — the first call is the only one that fetches.
        onFocus={loadIndex}
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
// on the right and the row expands to the exact listen times, each with where it was played
// from. Both come from the hydrated play rows, so the expansion needs no request of its own.
//
// Title, artist and art render immediately (they come from the client index); album, count and
// time appear when the stats land. The row's height is set by the 44px thumbnail, so nothing
// reflows as they fill in.
function SongResult({
  group,
  expanded,
  onToggle,
}: {
  group: SongGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { name, artist, album, image, count, lastPlayed, plays } = group;
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
        <Art image={image} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium select-text">{name}</p>
          <p className="truncate text-[13px] text-muted-foreground select-text">{artist}</p>
        </div>
        <p className="hidden truncate text-[13px] text-muted-foreground md:block">{album}</p>
        <div className="text-right">
          {count != null && count > 1 ? (
            <p className="text-sm font-medium tabular-nums">×{count}</p>
          ) : null}
          <p className="text-xs tabular-nums text-muted-foreground">
            {lastPlayed ? timeAgo(lastPlayed) : ""}
          </p>
        </div>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground/60 transition-transform",
            expanded && "rotate-180",
            // Nothing to expand until the plays are in.
            plays.length === 0 && "opacity-0",
          )}
        />
      </button>
      {expanded && plays.length > 0 ? (
        <ul className="mb-2 ml-[3.75rem] space-y-1 border-l border-border/60 pl-4">
          {listed.map((p, i) => (
            <li key={i} className="flex items-baseline gap-3 text-[13px] text-muted-foreground">
              {/* Fixed width from sm up so the sources line up into a column rather than
                  ragging off each timestamp. */}
              <span className="shrink-0 tabular-nums sm:min-w-[8.5rem]">
                {exactTimeShort(p.lastPlayed)}
              </span>
              {/* Where THAT play was listened from — the same per-play value the day table
                  shows in its From column, carried on the row by db.ts's sourceExpr: the
                  resolved playlist/album name, the bare context type when the name never
                  resolved, and NULL when the song is no longer in the playlist it was
                  credited to (ctx_orphan). Nothing is rendered for a null, same as a play
                  with no context at all. */}
              {p.source ? <span className="truncate">{p.source}</span> : null}
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
