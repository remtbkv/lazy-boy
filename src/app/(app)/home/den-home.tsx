"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown } from "lucide-react";
import type { DayStats, TrackStats } from "@/lib/db";
import { exactTimeShort, formatDuration, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { searchPerfEnabled, startSearchProbe, type IndexStatus } from "@/lib/search-perf";
import { patchHistoryPayload } from "@/lib/history-patch";
import { addPlay, reconcilePlays, type Provisional } from "@/lib/optimistic-play";
import { recordAppEvent } from "@/lib/metrics-client";
import { IdentityTrackMenu } from "@/components/identity-track-menu";
import { useNowPlaying } from "@/components/now-playing-context";
import { usePhone, useSearchMode } from "../use-search-mode";
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
      // Unattributed rows ("(queued)") sort together at the end rather than under "".
      return (a.source ?? "￿").localeCompare(b.source ?? "￿");
  }
}

// A day row's "From" is the play CONTEXT — where the listen actually started (playlist,
// album, "(queued)") — NOT the playlists the song happens to live in. Rem, 2026-08-12:
// membership answers a different question, and the place that asks it is search (an
// expanded result's "In …" line, off entry.playlists). A membership list here also made
// every row read as a wall of playlist names.

// ---- The searchable set ------------------------------------------------------------------
// One song, merged from the two search payloads (db.ts, "The client-side search payloads").
// A song is in here if it sits in a playlist, in Liked Songs, or in the listen history — so
// the box searches the LIBRARY, and `plays` being empty is a fact about the song ("never
// played"), not a loading state. Everything a result row renders is on this object before the
// first keystroke: nothing is fetched per query, and nothing fills in late.
//
// `key` is the song's IDENTITY — lower(artist) + "\n" + lower(name) — which is how the two
// payloads are joined. Not the track id: Spotify hands the same song a different id in a
// playlist than in recently-played, so an id join marks songs you play constantly as never
// played (db.ts has the count). `ln`/`la` are the lower-cased name/artist, folded once at load
// so a keystroke is one String.includes per song (13,464 in playlists or Liked Songs, plus
// the 496 played ones that are in neither) over strings already in the right case.
type Play = { minute: number; source: string | null };
type Entry = {
  key: string;
  name: string;
  artist: string;
  image: string | null;
  album: string | null;
  /** Playlists the song is in, by name. Empty for a song known only from the history. */
  playlists: string[];
  /** Newest first. Empty = never played. */
  plays: Play[];
  ln: string;
  la: string;
};

// One search result: a song with all its plays collapsed behind it (expandable), or an artist
// with their totals.
type SongGroup = { kind: "song"; entry: Entry };
type ArtistGroup = {
  kind: "artist";
  artist: string;
  image: string | null;
  songs: number;
  plays: number;
  last: number | null;
};

/** The wire shapes. Kept as tuples for size — see db.ts for what each slot means. */
type LibraryPayload = {
  images: string[];
  albums: string[];
  playlists: string[];
  tracks: [string, string, number, number, number[]][];
};
type HistoryPayload = {
  images: string[];
  albums: string[];
  sources: string[];
  /** [name, artist, image, album, durationMs] — durationMs is 0 when unknown. */
  tracks: [string, string, number, number, number][];
  plays: [number, number, number][];
};

// How many results a query may show. A one-letter query matches thousands of songs and the
// only cost left is DOM: every one of them is already in memory, matched and ranked. What is
// dropped is reported under the list rather than silently truncated.
const MAX_RESULTS = 400;
const SEARCH_DEBOUNCE_MS = 120;
const NO_FALLBACK = { key: "", rows: [] as TrackStats[], failed: false };

/** "12 songs" / "1 song". */
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** Epoch minutes (what the payloads carry) → the ISO string the formatters take. */
function iso(minute: number): string {
  return new Date(minute * 60000).toISOString();
}

// A 200 does NOT mean a payload this build can read. A cache one layer up — the browser's, or
// Vercel's Data Cache, which outlives a deployment — can hand back a body written by an older
// shape of the route; that is what broke production on 2026-08-05. The shape tokens make that
// a miss rather than a hit, and this is the last line: an unreadable payload counts as NO
// payload (the other half, or the server, answers), never as an empty or half-built one.
const fetchPayload = <T,>(url: string, ok: (d: T) => boolean): Promise<T | null> =>
  fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d: T) => {
      if (!ok(d)) throw new Error(`${url}: unrecognised payload shape`);
      return d;
    })
    .catch(() => null);

/** Merge the two payloads into the searchable set. Either may be missing — each payload is
 *  self-contained, so the library alone gives songs with no play data and the history alone
 *  gives exactly what this box used to search. */
function buildEntries(lib: LibraryPayload | null, hist: HistoryPayload | null): Entry[] {
  const entries: Entry[] = [];
  const at = new Map<string, number>();
  const add = (name: string, artist: string, image: string | null, album: string | null) => {
    const key = `${artist.toLowerCase()}\n${name.toLowerCase()}`;
    const hit = at.get(key);
    if (hit !== undefined) return entries[hit];
    at.set(key, entries.length);
    const e: Entry = {
      key,
      name,
      artist,
      image,
      album,
      playlists: [],
      plays: [],
      ln: name.toLowerCase(),
      la: artist.toLowerCase(),
    };
    entries.push(e);
    return e;
  };
  const pick = (table: string[], i: number) => (i >= 0 ? (table[i] ?? null) : null);

  if (lib) {
    for (const [name, artist, img, alb, pls] of lib.tracks) {
      const e = add(name, artist, pick(lib.images, img), pick(lib.albums, alb));
      for (const p of pls) {
        const n = lib.playlists[p];
        if (n) e.playlists.push(n);
      }
    }
  }
  if (hist) {
    // The history's own art/album only lands on songs the library didn't already describe —
    // for anything in a playlist the library's copy is the one already on screen elsewhere.
    const byIndex = hist.tracks.map(([name, artist, img, alb]) =>
      add(name, artist, pick(hist.images, img), pick(hist.albums, alb)),
    );
    // Plays arrive newest-first and are pushed in order, so each song's list stays that way.
    for (const [track, minute, source] of hist.plays) {
      byIndex[track]?.plays.push({ minute, source: pick(hist.sources, source) });
    }
  }
  return entries;
}

// ---- Days from memory --------------------------------------------------------------------
// Every day slide used to be a server action (dayTracksAction → getPlaysByDay), cached per day
// on the client. The read itself is small and indexed; what it costs is the trip. The store is
// a self-hosted sqld reached over a Tailscale Funnel, so a query is ~70ms+ before it starts
// running — paid AFTER the click, which is what made walking the strip feel like waiting.
// The neighbour prefetch below hid that for the two adjacent days and nothing else.
//
// The history payload already holds the answer: every play, with the minute it happened, the
// song it belongs to and where it was played from. Grouping those minutes into local days is
// getPlaysByDay's whole job, and doing it here makes EVERY day — not just the two next to you —
// switch inside one frame, with no request at all. The server path stays exactly as it was for
// the seconds before the payload lands (and for the day the payload can't be complete for).
//
// Two things this has to reproduce, or the two paths would disagree on screen:
//   • the DAY BUCKET. The server buckets with a fixed offset — the `tzoffset` cookie the
//     browser publishes, applied to every historical play (db.ts localDay). So this uses the
//     same fixed offset rather than per-instant local time: across a DST change the two agree
//     with EACH OTHER, which is the only thing a user comparing a day card's count against its
//     rows can see. (Per-instant local time would be the more "correct" bucket and would put a
//     handful of plays on a different day than the strip counted them under.)
//   • the ROW SHAPE and the initial ORDER: plays DESC then lastPlayed DESC, the order
//     getPlaysByDay returns, so the list's default sort lands on the same sequence whichever
//     path produced it.
//
// It groups by song IDENTITY (lower(artist)+lower(name)), where the server groups by track id.
// That is the payload's join and it is the better answer — a song Spotify re-issued under a
// second id is one row here and two there — but it IS a difference, and it is the one place a
// derived day can legitimately not match the server's. Checked, not assumed: replaying this
// against getPlaysByDay for all 69 days in data/replica.db (2026-08-11) agreed on every row's
// play count, last-played minute, source, album and duration, except for the 18 of 3,025
// played identities that exist under two track ids — and the first version of the source rule
// disagreed on 66 of the 69 days, so the comparison can fail.
type MemoryDays = {
  rows: Map<string, TrackStats[]>;
  /** One row PER PLAY, newest first, per-play source — the phone's day list shows a song
   *  again for each play instead of a count (Rem, 2026-08-13). Includes the newest day:
   *  the refresh patches new plays into the payload, so it stays current. */
  playRows: Map<string, TrackStats[]>;
  /** The local day of the newest play in the payload. Days strictly older than this are fully
   *  covered; that day itself may be missing the last few minutes (the payload rebuilds at
   *  most every 10 min — db.ts's slow marker), so it is left to the server path. */
  newest: string | null;
};
function buildDays(hist: HistoryPayload): MemoryDays {
  // Minutes to ADD to UTC, i.e. the same number TimezoneCookie writes for the server to use.
  const offMs = -new Date().getTimezoneOffset() * 60000;
  const localDay = (minute: number) => new Date(minute * 60000 + offMs).toISOString().slice(0, 10);
  // The "From" a day row shows is the song's most recent play OVERALL, not its last play that
  // day: SELECT_TRACK's source subquery (db.ts) is not filtered to the day, and TrackStats
  // says so in as many words. Reproduced rather than corrected, because the alternative is the
  // same day reading differently depending on which path produced its rows — and the first
  // seconds of every visit are still the server's. Plays arrive newest-first, so the first one
  // seen for a song is its latest. (Checked against getPlaysByDay over all 69 days in the
  // store, 2026-08-11: per-day source instead of this disagreed on 66 of them.)
  const latestSource = new Map<number, number>();
  for (const [t, , src] of hist.plays) if (!latestSource.has(t)) latestSource.set(t, src);
  const days = new Map<string, Map<string, TrackStats>>();
  const playRows = new Map<string, TrackStats[]>();
  for (const [t, minute, playSrc] of hist.plays) {
    const track = hist.tracks[t];
    if (!track) continue;
    const [name, artist, img, alb, durationMs] = track;
    const day = localDay(minute);
    {
      // The per-play row: this play's own time and its own context.
      let list = playRows.get(day);
      if (!list) playRows.set(day, (list = []));
      const played = iso(minute);
      list.push({
        id: `${artist.toLowerCase()}\n${name.toLowerCase()}@${minute}`,
        name,
        artist,
        uri: "",
        album: alb >= 0 ? (hist.albums[alb] ?? null) : null,
        albumImage: img >= 0 ? (hist.images[img] ?? null) : null,
        durationMs: durationMs || null,
        plays: 1,
        lastPlayed: played,
        firstPlayed: played,
        source: playSrc >= 0 ? (hist.sources[playSrc] ?? null) : null,
      });
    }
    let rows = days.get(day);
    if (!rows) days.set(day, (rows = new Map()));
    const key = `${artist.toLowerCase()}\n${name.toLowerCase()}`;
    const played = iso(minute);
    const hit = rows.get(key);
    if (hit) {
      // Plays arrive newest-first, so the row was created from the day's LAST play — its time
      // is already right, and every later play can only push firstPlayed back.
      hit.plays += 1;
      hit.firstPlayed = played;
      continue;
    }
    const src = latestSource.get(t) ?? -1;
    rows.set(key, {
      // The identity IS the id here: the payload carries no track ids (it is joined on
      // identity — db.ts), and the only thing the day list uses `id` for is the React key.
      id: key,
      name,
      artist,
      uri: "",
      album: alb >= 0 ? (hist.albums[alb] ?? null) : null,
      albumImage: img >= 0 ? (hist.images[img] ?? null) : null,
      durationMs: durationMs || null,
      plays: 1,
      lastPlayed: played,
      firstPlayed: played,
      source: src >= 0 ? (hist.sources[src] ?? null) : null,
    });
  }
  const rows = new Map<string, TrackStats[]>();
  for (const [day, byKey] of days) {
    rows.set(
      day,
      [...byKey.values()].sort(
        (a, b) => b.plays - a.plays || b.lastPlayed.localeCompare(a.lastPlayed),
      ),
    );
  }
  // Plays arrive newest-first, so each day's per-play list is already newest-first.
  return { rows, playRows, newest: hist.plays.length ? localDay(hist.plays[0][1]) : null };
}

/** Match rank: an exact title beats a title that starts with the query, which beats one that
 *  merely contains it. The library is 5x the size of the history, so without this a typed-out
 *  title can sit below a hundred incidental substring hits — the old index was small enough
 *  for plain recency order to pass for relevance. */
function tier(hay: string, q: string): number {
  return hay === q ? 0 : hay.startsWith(q) ? 1 : 2;
}

// The history half of Home: day strip → list → search island. The greeting and the action
// dock render in the page shell instead, OUTSIDE this component's Suspense boundary, so they
// paint immediately while these (heavier) reads stream in behind a skeleton.
//
// First paint comes from the server's materialized payload; then the full history payload
// loads in the background, and from that moment BOTH halves of this page are answered out of
// memory — a day slide is a regroup of plays already in the browser ("Days from memory"), and
// a query is a substring match over the merged search set. The server action per day survives
// as the fallback for the seconds before the payload lands, with its per-day cache.
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
  // Same cue for the search-results box (phone) — its bottom edge sliced rows without it.
  const resScrollRef = useRef<HTMLDivElement>(null);
  const [resMoreBelow, setResMoreBelow] = useState(false);
  const cache = useRef(new Map<string, TrackStats[]>([[initialDay, initialTracks]]));
  const dayReq = useRef(0);

  // The history payload once it has landed, and every local day derived from it (buildDays
  // above). One fetch answers both halves of this page: the search box matches against it and
  // the day list is grouped out of it, so after the first second on the page neither one is
  // waiting on the store.
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const memoryDays = useMemo(() => (history ? buildDays(history) : null), [history]);
  /** A day's rows out of memory, or null when the payload cannot answer for that day — it
   *  hasn't loaded, it's the all-time view, or it's the payload's own newest day (which can be
   *  short the last few minutes; that day is the one `cache` always holds anyway, because the
   *  server rendered it and the refresh keeps it current). */
  const fromMemory = (day: string): TrackStats[] | null => {
    if (!memoryDays?.newest || day === "all" || day >= memoryDays.newest) return null;
    return memoryDays.rows.get(day) ?? [];
  };

  // Two performance marks, and nothing else: when this component is on screen with the server's
  // data, and when day slides + search stopped needing the server at all. They are read by a
  // separate collector (anything marked "lb:"); nothing in here reads them back.
  useEffect(() => {
    performance.mark("lb:data-rendered");
  }, []);
  const markedReady = useRef(false);
  useEffect(() => {
    if (!memoryDays || markedReady.current) return;
    markedReady.current = true;
    performance.mark("lb:history-ready");
  }, [memoryDays]);

  // A past day's plays can never change — once fetched it's frozen history. So persist those
  // to sessionStorage and they survive navigation entirely (no server round-trip on return).
  // Today is deliberately NOT persisted (it grows as you listen), and the store is capped so
  // it can't balloon: this is text only, a few KB a day.
  const DAY_STORE = "lb-days";
  const DAY_STORE_MAX = 20;
  // The store is BUILD-STAMPED: sessionStorage survives reloads — including the build-skew
  // reload — so a deploy that changes TrackStats used to hand the new bundle old-shaped rows
  // with no runtime detection (the exact hazard the server's shape tokens exist to close;
  // audit 2026-08-19, T1.7). A build mismatch discards the whole store.
  const DAY_STORE_BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DAY_STORE);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { build?: string; days?: Record<string, TrackStats[]> };
      if (parsed.build !== DAY_STORE_BUILD || !parsed.days) {
        sessionStorage.removeItem(DAY_STORE);
        return;
      }
      for (const [day, rows] of Object.entries(parsed.days)) {
        if (!cache.current.has(day)) cache.current.set(day, rows);
      }
    } catch {
      /* storage unavailable / corrupt — just fetch as usual */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const persistDay = (day: string, rows: TrackStats[]) => {
    // `initialDay` is the most recent day with plays — treat it as live, everything older is frozen.
    if (day === "all" || day >= initialDay) return;
    try {
      const raw = sessionStorage.getItem(DAY_STORE);
      const parsed = raw
        ? (JSON.parse(raw) as { build?: string; days?: Record<string, TrackStats[]> })
        : null;
      const saved = parsed?.build === DAY_STORE_BUILD && parsed.days ? parsed.days : {};
      saved[day] = rows;
      const keys = Object.keys(saved).sort();
      while (keys.length > DAY_STORE_MAX) delete saved[keys.shift() as string];
      sessionStorage.setItem(DAY_STORE, JSON.stringify({ build: DAY_STORE_BUILD, days: saved }));
    } catch {
      /* quota / unavailable — the in-memory cache still works */
    }
  };

  // Extend the day strip further back (2wk → 4wk → all). The whole daily set is one fast
  // query, so we fetch it ONCE and reveal more by slicing on the client — the chevron and
  // "See all" are then instant instead of paying a server round-trip each press. Prefetched
  // on mount so the full set is usually already in hand before the first click.
  const allDailyPromise = useRef<{ p: ReturnType<typeof dailyStatsAction>; at: number } | null>(
    null,
  );
  const loadAllDaily = () => {
    // Memoized for a minute, not for the component's life: the old forever-memo meant
    // pressing "See all" after an hour of listening replaced the live strip with the
    // mount-time snapshot (audit 2026-08-19, T2.7).
    if (!allDailyPromise.current || Date.now() - allDailyPromise.current.at > 60_000) {
      allDailyPromise.current = { p: dailyStatsAction(100000), at: Date.now() };
    }
    return allDailyPromise.current.p;
  };
  useEffect(() => {
    void loadAllDaily();
  }, []);
  const extendDays = async (days: number): Promise<boolean> => {
    const all = await loadAllDaily();
    if (!all.length) return false;
    // Keep the LIVE head: the snapshot can be up to 60s old, and replacing today's card
    // with it discarded a handoff bump or a just-landed play (wave-2 audit, A18).
    setDaily((cur) => {
      const next = all.slice(0, days);
      if (next[0] && cur[0] && next[0].day === cur[0].day && cur[0].plays > next[0].plays) {
        next[0] = cur[0];
      }
      return next;
    });
    return true;
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
      // Advance the counter here too: without it, a slower server fetch already in flight
      // for the PREVIOUS selection still passed its own guard and overwrote these rows
      // (wave-2 audit, A1 — click All-time, then a cached day: the all-time response
      // landed on the day view).
      dayReq.current++;
      setDayPending(false);
      setTracks(hit);
      return;
    }
    // Grouped out of the payload in memory: no request, no pending state, this frame. It is
    // deliberately NOT written into `cache` — the payload is the source of truth for these
    // days, and a copy taken now would not see the plays a refresh patches into it later.
    // The counter still moves, so a slower server day already in flight can't land on top.
    const mem = fromMemory(day);
    if (mem) {
      dayReq.current++;
      setDayPending(false);
      setTracks(mem);
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
      // Once the payload is in, every day is already answered from memory — warming one would
      // be a read of the store for rows nothing will ever look at. So this window closes on
      // its own, and what survives is the fallback for the first seconds of a visit.
      if (fromMemory(day)) continue;
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

  // ---- Search (the whole answer is matched in the browser) -------------------------------
  // Every keystroke used to be a debounced server action running `LIKE '%q%'` over the whole
  // history — unindexable by construction (GOTCHAS: count the rows a query SCANS), so each
  // character paid a round trip plus a full `tracks` scan against remote Turso: 1,904.5ms
  // median (1,382.8-3,132.7), n=7, 2026-08-05, `bench-reads.mjs search`. Matching now runs in
  // this browser, over two payloads fetched once per visit (db.ts, "The client-side search
  // payloads"), so typing costs no network at all.
  //
  // Two things that used to be true are not any more:
  //   • It searched your HISTORY. A song sitting in a playlist you had never played was not in
  //     the index and came back "No songs match" — which is what it was designed to do (the
  //     results were plays) and reads as a bug once you know the song is right there. The
  //     library payload is the fix, and it is why a row now has to say whether it was played.
  //   • Rows appeared first and their numbers arrived a beat later, from one debounced
  //     hydration call per query. Counts, times, the per-play list and the playlists a song
  //     lives in are all in the payloads now, so a row is complete in the frame it appears.
  //
  // What it costs: 43.8ms median (15.8-130.2, n=25, five queries x five reps, in-browser rAF,
  // dev) from the keystroke to the painted frame, against 12.2ms for the old index. The extra
  // is the work that used to happen 900ms later in a second update — matching 13,960 songs
  // instead of 2,959, and painting up to 400 COMPLETE rows instead of 400 stubs. Slower per
  // keystroke, one paint instead of two, and nothing on screen is provisional.
  //
  // The match is a plain case-insensitive substring, per mode: the title in Songs, the artist
  // in Artists — unchanged. What is new is the ORDER: exact, then prefix, then substring, and
  // played before never-played inside each. lib/filter.ts's fuzzyFilter is the other shared
  // matcher and is deliberately not used here: it splits the query into order-independent
  // tokens, which is a wider answer than this box has ever given.
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"songs" | "artists">("songs");
  const [expanded, setExpanded] = useState<string | null>(null);
  const searching = query.trim().length > 0;

  // ---- Phone search MODE (Rem's spec, 2026-08-13) ----------------------------------------
  // While the search input is focused OR a query stands, on a phone, search owns the
  // screen: the greeting/dock bands and the app header fold away (den.css) and <main> is
  // pinned to the live visual-viewport height so the results box bottom rides the
  // keyboard's top edge. The day strip STAYS — in this mode it is the scope filter: the
  // strip flips to All-time on entry (a search is global by default), tapping a day
  // narrows the results to songs played that day (answered from the in-memory payload,
  // instantly), and leaving search restores whatever day was selected before.
  const phone = usePhone();
  const [searchFocused, setSearchFocused] = useState(false);
  // The immediate twin of searchFocused: flips false the instant the input blurs, while
  // searchFocused waits out the island's 180ms tap grace — the height driver must move
  // with the keyboard, not with the grace (the checkmark pause, Rem 2026-08-13).
  const [searchKbUp, setSearchKbUp] = useState(false);
  const searchMode = phone && (searchFocused || searching);
  useSearchMode(searchMode, searchKbUp);
  const prevSel = useRef<string | null>(null);
  useEffect(() => {
    if (searchMode) {
      if (prevSel.current === null) {
        prevSel.current = selected;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one transition, one flip
        if (selected !== "all") select("all");
      }
    } else if (prevSel.current !== null) {
      const prev = prevSel.current;
      prevSel.current = null;
      // Only restore if the user didn't pick a different scope while searching — a day
      // chosen in search mode is a deliberate place to land.
      if (selected === "all" && prev !== "all") select(prev);
    }
    // select/selected are read at transition time only; re-running on their changes
    // would re-trigger the entry branch mid-mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMode]);

  // The payloads are fetched off the render path and then held in memory for the rest of the
  // visit. Persistence across visits is the browser's HTTP cache plus each route's ETag: the
  // library half revalidates in one 304 with no body unless a playlist changed.
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const libReq = useRef<Promise<LibraryPayload | null> | null>(null);
  const histReq = useRef<Promise<HistoryPayload | null> | null>(null);
  // Where a query would be answered from right now. Only the perf readout reads it.
  const indexStatus = useRef<IndexStatus>("fallback");

  const loadIndex = () => {
    // Idempotent, and it HAS to be: this is called from an effect that also reads `entries`, so
    // a call that re-attached a handler to the already-resolved requests would rebuild the set,
    // hand back a new array identity, re-run the effect and call this again — a render loop
    // that pins the tab. One handler per pair of requests; a re-fetch only happens after a
    // ref is cleared (new plays landed).
    if (libReq.current && histReq.current) return;
    if (!libReq.current) indexStatus.current = "fetching";
    libReq.current ??= fetchPayload<LibraryPayload>(
      "/api/search/library",
      (d) => Array.isArray(d?.tracks) && (!d.tracks.length || d.tracks[0]?.length >= 5),
    );
    histReq.current ??= fetchPayload<HistoryPayload>(
      "/api/search/history",
      (d) =>
        Array.isArray(d?.tracks) &&
        Array.isArray(d?.plays) &&
        // 5, not 4: a v1 body (no durationMs) would derive days with an empty Length column.
        (!d.tracks.length || d.tracks[0]?.length >= 5),
    );
    const [lib, hist] = [libReq.current, histReq.current];
    void Promise.all([lib, hist]).then(([l, h]) => {
      // A refresh that found new plays drops the history request to force a re-fetch; ignore a
      // pair that was superseded while in flight.
      if (libReq.current !== lib || histReq.current !== hist) return;
      // Both halves failed: nothing to match against, so queries go to the server. An earlier
      // successful build is kept — a failed refresh should not empty the box.
      if (!l && !h) {
        indexStatus.current = "fallback";
        return;
      }
      // Both EMPTY is not an index either: a cold/half-built store answering 200 with
      // `{tracks: []}` used to mint `entries = []`, which is truthy — every search then
      // rendered "No songs match" for the visit with no fallback scheduled
      // (audit 2026-08-19, T2.6). Empty payloads → server fallback, same as failure.
      if (!l?.tracks.length && !h?.tracks.length) {
        indexStatus.current = "fallback";
        return;
      }
      indexStatus.current = "memory";
      setEntries(buildEntries(l, h));
      // The history half also feeds the day list (buildDays). Only set on success: a failed
      // history fetch must leave an earlier payload — and the days derived from it — standing.
      if (h) setHistory(h);
    });
  };

  // Opt-in timing readout (lib/search-perf.ts): one console line per query, off unless the
  // `lb-perf` flag is set. Keyed on the query alone — the search effect below also re-runs when
  // its data lands, and restarting the probe there would mean it never finished. Each keystroke
  // supersedes the previous probe, so what gets logged is the wait after the last one.
  useEffect(() => {
    if (!searchPerfEnabled() || !query.trim()) return;
    return startSearchProbe(query.trim(), indexStatus.current);
  }, [query, mode]);

  // Fetched on IDLE after Home has painted, not on focus. Focus was too late in the one case
  // that matters: on a cold data cache the server has to build the index (~2.7s against the
  // primary), so the first person to search after a deploy waited that out with the box already
  // in front of them — the "still ~2s" report this whole change was meant to fix. Starting it
  // during the idle gap between the page landing and a hand reaching the search box hides the
  // build entirely. requestIdleCallback so it can never compete with hydration or the first
  // paint; a plain timeout where that doesn't exist (Safari). Focus and the first keystroke
  // stay wired to loadIndex() as backstops — it is idempotent, so whichever fires first wins.
  //
  // It is no longer only the search box that waits on this: the day list derives from the
  // history half too, so this fetch is what ends the page's dependence on the store, whether or
  // not anyone types. Both halves start here — the day list needs one of them, and splitting
  // the start would just move the library's build cost onto the first keystroke again.
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

  // The server fallback, for the window before the payloads land (and the case where both
  // failed). Same action the box used before any of this existed, so it is never dead — but it
  // only knows the history, so its answer is the narrower one.
  const [fallback, setFallback] = useState<{ key: string; rows: TrackStats[]; failed: boolean }>(
    NO_FALLBACK,
  );
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
    // Matched in the browser: no request at all, for any query.
    if (entries) return;
    // This effect re-runs when the answer lands (it reads `fallback`), so without this the
    // answer to a query would schedule the next request for the SAME query — a self-feeding
    // loop. `key` is set on failure too: without it a rejected action left the view on
    // "Searching…" for as long as the page stayed open, which is the regression Rem hit when a
    // stale-shaped cache entry sent every query down this path.
    if (fallback.key === k) return;
    const id = setTimeout(() => {
      searchPlaysAction(q)
        .then((rows) => {
          if (liveKey.current === k) setFallback({ key: k, rows, failed: false });
        })
        .catch(() => {
          if (liveKey.current === k) setFallback({ key: k, rows: [], failed: true });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, mode, entries, fallback]);

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

  const doRefresh = useRef<(force?: boolean) => Promise<void>>(async () => {});
  // Ordering guard: three independent triggers (track change + its 4s echo, the 120s
  // interval, visibilitychange) used to run doRefresh concurrently with no sequencing —
  // the slower run could land LAST with staler rows, resurrecting provisionals the faster
  // one had already confirmed (double-count; audit 2026-08-19, T1.9). Last-started wins.
  const refreshRun = useRef(0);
  // Sync throttle: a Spotify recently-played harvest rides every refresh, and the pile of
  // triggers meant ~2 calls per track change plus one per tab-switch — real pressure on the
  // one endpoint with a daily quota (audit 2026-08-19, T2.1). Track changes force through;
  // ambient triggers (interval, visibility) skip if a refresh ran in the last 45s.
  const lastRefreshAt = useRef(0);
  useEffect(() => {
    doRefresh.current = async (force = false) => {
      if (!force && Date.now() - lastRefreshAt.current < 45_000) return;
      lastRefreshAt.current = Date.now();
      const run = ++refreshRun.current;
      const at = selected;
      // A pinned past day is frozen history, and a search owns its own result set: in both
      // cases refresh the stats but skip rows we'd only overwrite with identical ones.
      const followingLatest = selected === (daily[0]?.day ?? null);
      const want = searching ? null : selected === "all" ? "all" : followingLatest ? "latest" : null;
      // Tell the server the newest play minute the in-memory index holds, so it can hand
      // back exactly the plays the index is missing — including ones the cron tick synced
      // (those return added=0 here and would otherwise slip through until the next payload).
      const held = histReq.current ? await histReq.current : null;
      const r = await refreshHistoryAction(want, daily.length, held?.plays[0]?.[1] ?? null);
      // New plays the index is missing. The server payload only rebuilds every 10 min (the
      // slow marker), so a refetch would come back without them — instead PATCH the copy in
      // memory with the delta, and search knows the play instantly. The next cold load
      // reconciles from the server. Only the history half — the library payload does not
      // move when you listen, which is the whole reason the two are separate.
      if (r.newPlays?.length) {
        const hist = histReq.current ? await histReq.current : null;
        if (hist) {
          const patched = patchHistoryPayload(hist, r.newPlays);
          // The delta can re-deliver the boundary minute (the server filters `>=` now);
          // when everything deduped away, `plays` is the same reference — skip the
          // re-render entirely.
          if (patched.plays !== hist.plays) {
            histReq.current = Promise.resolve(patched);
            const lib = libReq.current ? await libReq.current : null;
            setEntries(buildEntries(lib, patched));
            // Same delta, same object: the derived days re-group off the patched payload, so a
            // play that just landed is in yesterday's rows too if that is where it belongs.
            setHistory(patched);
          }
        } else {
          // No payload in memory yet (still fetching or failed) — the old drop-and-refetch
          // is the right fallback; the ≤10-min-stale copy beats none.
          histReq.current = null;
          loadIndex();
        }
      }
      if (!r.ok || selRef.current !== at || refreshRun.current !== run) return;
      // Fold the still-unconfirmed optimistic plays into the server truth before it hits
      // the screen — otherwise a sync that hasn't caught a play yet would make the row the
      // handoff just added flicker out (optimistic-play.ts owns the confirm/expire rules).
      //
      // ONLY when the response actually carries today's rows (`want === "latest"`).
      // Reconciling against `null` (searching / a pinned past day) meant NOTHING could
      // confirm, so the card rendered server-count + N provisionals — over-counting for
      // the whole TTL; the "all" rows are all-time aggregates, the wrong universe in both
      // directions (audit 2026-08-19, T1.9). Wrong universe → leave the provisionals and
      // the server's own card alone; the next latest-mode refresh reconciles properly.
      // Day-scoped: a provisional minted before local midnight must never be bumped onto
      // the NEW day's card (wave-2 audit, A3). Ones whose day has rolled off the newest
      // server day can no longer confirm in this universe — drop them (the sync recorded
      // the real play on the right day long since).
      const provs = provisionalsRef.current.filter((p) => p.day === r.daily[0]?.day);
      const canReconcile = want === "latest" && !!r.tracks;
      const bump =
        canReconcile && provs.length
          ? reconcilePlays(r.tracks ?? [], provs, Date.now())
          : { rows: r.tracks ?? [], remaining: canReconcile ? [] : provs };
      provisionalsRef.current = bump.remaining;
      setDaily(
        canReconcile && bump.remaining.length && r.daily.length
          ? [
              { ...r.daily[0], plays: r.daily[0].plays + bump.remaining.length },
              ...r.daily.slice(1),
            ]
          : r.daily,
      );
      setAllTime(r.allTime);
      if (!r.day || !r.tracks) return;
      const rows = r.day === r.daily[0]?.day ? bump.rows : r.tracks;
      cache.current.set(r.day, rows);
      // The local day rolled over while the tab sat open — follow it onto the new day instead
      // of leaving you parked on what used to be "today".
      if (r.day !== at) setSelected(r.day);
      setTracks(rows);
    };
  });

  // Visible tabs only: the now-playing state is broadcast to every tab (one leader polls,
  // the rest listen), so without this gate N open Home tabs would each run the sync round
  // trip on every track change and every interval tick. A hidden tab does nothing; the
  // visibilitychange handler below catches it up the moment it's looked at again.
  useEffect(() => {
    if (document.visibilityState !== "visible") return;
    // Track changes force through the sync throttle (this is the just-finished play the
    // shortcut exists for); the 4s echo covers Spotify's recently-played lag.
    void doRefresh.current(true);
    const t = setTimeout(() => void doRefresh.current(true), 4000);
    return () => clearTimeout(t);
  }, [nowPlayingId]);

  // ---- The play handoff: bar → today's list, same update ----
  // The client watched the song play; when it leaves the bar (track change or stop) it can
  // appear in today's list immediately — no waiting for the sync round trip. Gated on ≥30s
  // of observed progress, because that is what Spotify itself records as a play: an early
  // skip never gets a row, so nothing has to be retracted later. The refresh that follows
  // (the nowPlayingId effect above) confirms it against the store within seconds.
  const provisionalsRef = useRef<Provisional[]>([]);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (freshTimer.current) clearTimeout(freshTimer.current);
  }, []);
  const lastPlayingRef = useRef<{
    id: string;
    title: string;
    artist: string;
    // The album NAME, not just its art. /api/now-playing passes normTrack's track through
    // whole (spotify/resources.ts sets `album`), so the bar has always had it — the row built
    // below just wasn't capturing it, and a song landed in today's list with a blank Album
    // column until the next sync replaced the row with the server's.
    album: string | null;
    albumImage: string | null;
    durationMs: number;
    source: string | null;
    maxProgress: number;
    /** When a poll last SAW this song ACTUALLY PLAYING (isPlaying true). A finish() long
     *  after that means the tab was suspended or the song sat paused — see the staleness
     *  guard below. Paused polls must NOT refresh this: a song paused at 9 PM and swapped
     *  at 12:30 AM used to read as "seen 6s ago" and mint a 3.5-hour-late play
     *  (audit 2026-08-19, T1.2). */
    seenAt: number;
    /** Whether this tab ever observed the song PLAYING. A track first seen paused (a
     *  reopened tab, a device left loaded) carries progress it earned long ago — crediting
     *  it on the next song change is the paused-seed phantom. */
    sawPlaying: boolean;
  } | null>(null);
  useEffect(() => {
    const prev = lastPlayingRef.current;
    const finish = (p: NonNullable<typeof prev>) => {
      // Every verdict this shortcut reaches is beaconed to client_metrics ("handoff"): the
      // mint happens purely in the browser, so a wrong row on screen is undiagnosable from
      // the store alone — the 2026-08-19 phantom took store archaeology to rule paths out.
      // One event per song change while the tab is open; meta carries the inputs the
      // guards judged.
      const verdict = (v: string) =>
        recordAppEvent(
          "handoff",
          `${v}|${p.artist} — ${p.title}|gap=${Math.round((Date.now() - p.seenAt) / 1000)}s|prog=${
            p.durationMs > 0 ? `${Math.round((p.maxProgress / p.durationMs) * 100)}%` : "?"
          }|from=${p.source ?? ""}`,
        );
      // STALE finish = the tab slept holding this song and woke to a different one. The
      // handoff stamps the play as "now", so a suspended tab minted a play an hour after
      // the song actually ended (Abracadabra, 10:46 PM, Rem 2026-08-16) — a song that old
      // is the SYNC's business (it recorded the real play with its real time long ago),
      // never this shortcut's. The poll runs every ~6s; a 60s gap only happens suspended.
      if (Date.now() - p.seenAt > 60_000) return verdict("stale");
      // Never observed playing in this tab = nothing to credit: its progress predates us.
      if (!p.sawPlaying) return verdict("never-played");
      // Same bar the store applies (plays.skipped): under 35% of the song listened is a
      // skip, not a play — don't hand it to the list (Rem, 2026-08-16). 30s floor stands
      // in when the duration is unknown.
      const need = p.durationMs > 0 ? p.durationMs * 0.35 : 30_000;
      if (p.maxProgress < need) return verdict("skip");
      const nowIso = new Date().toISOString();
      const row = {
        id: p.id,
        name: p.title,
        artist: p.artist,
        uri: `spotify:track:${p.id}`,
        album: p.album,
        albumImage: p.albumImage,
        durationMs: p.durationMs || null,
        plays: 1,
        lastPlayed: nowIso,
        firstPlayed: nowIso,
        source: p.source,
      };
      // daily[0] is only "today" when today already has plays. On the FIRST play of a
      // new local day the strip still leads with yesterday, and crediting that card put
      // a 10:15 AM play inside "Yesterday" (Rem, 2026-08-17). No card for today yet →
      // leave the play entirely to the sync, which creates the day properly.
      const localToday = new Date(
        Date.now() - new Date().getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 10);
      if (daily[0]?.day !== localToday) return verdict("no-today");
      verdict("commit");
      provisionalsRef.current.push({ row, at: Date.now(), day: localToday });
      const today = daily[0]?.day;
      setDaily((d) =>
        d.length
          ? [
              {
                ...d[0],
                plays: d[0].plays + 1,
                durationMs: d[0].durationMs + Math.min(p.maxProgress, p.durationMs || p.maxProgress),
              },
              ...d.slice(1),
            ]
          : d,
      );
      if (today && selRef.current === today) {
        setTracks((ts) => {
          const next = addPlay(ts, row);
          cache.current.set(today, next);
          return next;
        });
        setFreshKey(`${row.artist.toLowerCase()}\n${row.name.toLowerCase()}`);
        // Re-armed, not stacked: two commits inside 1.6s used to let the first timer clear
        // the second's highlight early.
        if (freshTimer.current) clearTimeout(freshTimer.current);
        freshTimer.current = setTimeout(() => setFreshKey(null), 1600);
      }
    };
    if (playing?.track) {
      if (prev && prev.id === playing.track.id) {
        prev.source = playing.context?.name ?? prev.source;
        // Only a PLAYING observation refreshes the liveness stamp and earns progress —
        // a paused chip re-observed every 6s must not keep a dead song "fresh".
        if (playing.isPlaying) {
          prev.maxProgress = Math.max(prev.maxProgress, playing.progressMs);
          prev.seenAt = Date.now();
          prev.sawPlaying = true;
        }
      } else {
        if (prev) finish(prev);
        lastPlayingRef.current = {
          id: playing.track.id,
          title: playing.track.title,
          artist: playing.track.artist,
          album: playing.track.album ?? null,
          albumImage: playing.track.albumImage,
          durationMs: playing.durationMs,
          source: playing.context?.name ?? null,
          // A track first seen PAUSED starts with no credit: whatever progress it shows
          // was earned before this tab was watching.
          maxProgress: playing.isPlaying ? playing.progressMs : 0,
          seenAt: Date.now(),
          sawPlaying: !!playing.isPlaying,
        };
      }
    } else if (prev) {
      finish(prev);
      lastPlayingRef.current = null;
    }
    // `daily` is deliberately not a dep: the effect must fire exactly on player movement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void doRefresh.current();
    }, 120_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void doRefresh.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Nothing to wait for once the payloads are in: a query is answered by the memo below in the
  // frame it is typed. These two flags describe the fallback path only.
  const answered = fallback.key === `${mode}:${query.trim()}`;
  const searchPending = searching && !entries && !answered;
  // Answered, but with a failure rather than results. Kept distinct from "no results": telling
  // someone their song isn't in their library when the request simply failed is a lie.
  const searchFailed = searching && !entries && answered && fallback.failed;

  // The fallback's play rows folded into the same Entry shape the payloads produce, so the
  // grouping below has one input and the rows render through one code path. Its songs are
  // always played ones (they came out of the history) and it knows no playlists.
  const fallbackEntries = useMemo<Entry[] | null>(() => {
    if (entries || !answered || fallback.rows.length === 0) return null;
    const by = new Map<string, Entry>();
    for (const r of fallback.rows) {
      const key = `${r.artist.toLowerCase()}\n${r.name.toLowerCase()}`;
      let e = by.get(key);
      if (!e) {
        e = {
          key,
          name: r.name,
          artist: r.artist,
          image: r.albumImage,
          album: r.album,
          playlists: [],
          plays: [],
          ln: r.name.toLowerCase(),
          la: r.artist.toLowerCase(),
        };
        by.set(key, e);
      }
      // One row per play, newest first — the same order the payload's plays arrive in.
      e.plays.push({ minute: Math.floor(Date.parse(r.lastPlayed) / 60000), source: r.source });
    }
    return [...by.values()];
  }, [entries, fallback, answered]);

  // The search-mode day scope: when a day is picked on the strip while searching, results
  // narrow to plays from that LOCAL day. Same fixed-offset day bucket as buildDays, so the
  // scoped counts agree with the day cards.
  const scopeDay = searchMode && selected !== "all" ? selected : null;

  // Matching, ranking and grouping, all in memory. `total` is what matched before the display
  // cap, so the list can say what it dropped instead of silently truncating.
  const { groups, total } = useMemo<{ groups: (SongGroup | ArtistGroup)[]; total: number }>(() => {
    const none = { groups: [], total: 0 };
    const q = query.trim().toLowerCase();
    const source = entries ?? fallbackEntries;
    if (!q || !source) return none;

    // Scope an entry's plays to the picked day; an entry with none left drops out. The
    // copy keeps `entries` itself untouched — the scope is a view, not a mutation.
    let scope: ((e: Entry) => Entry | null) | null = null;
    if (scopeDay) {
      const offMin = -new Date().getTimezoneOffset();
      const m0 = Date.parse(`${scopeDay}T00:00:00Z`) / 60000 - offMin;
      const m1 = m0 + 1440;
      scope = (e) => {
        const plays = e.plays.filter((p) => p.minute >= m0 && p.minute < m1);
        return plays.length ? { ...e, plays } : null;
      };
    }

    if (mode === "songs") {
      let hits = source.filter((e) => e.ln.includes(q));
      if (scope) hits = hits.map(scope).filter((e): e is Entry => e !== null);
      hits.sort(
        (a, b) =>
          tier(a.ln, q) - tier(b.ln, q) ||
          // Played first, most recent first. A song you listen to is the one you meant.
          (b.plays[0]?.minute ?? -1) - (a.plays[0]?.minute ?? -1) ||
          a.name.localeCompare(b.name),
      );
      return {
        groups: hits.slice(0, MAX_RESULTS).map((entry): SongGroup => ({ kind: "song", entry })),
        total: hits.length,
      };
    }

    // Artists: every song by a matching artist folded into one row, so the totals are over the
    // whole artist, not over the songs whose titles happened to match.
    const byArtist = new Map<string, ArtistGroup>();
    for (const raw of source) {
      if (!raw.la.includes(q)) continue;
      const e = scope ? scope(raw) : raw;
      if (!e) continue; // nothing played that day — out of a day-scoped answer
      let g = byArtist.get(e.la);
      if (!g) {
        g = { kind: "artist", artist: e.artist, image: null, songs: 0, plays: 0, last: null };
        byArtist.set(e.la, g);
      }
      g.image ??= e.image;
      g.songs += 1;
      g.plays += e.plays.length;
      const last = e.plays[0]?.minute ?? null;
      if (last != null && (g.last == null || last > g.last)) g.last = last;
    }
    const artists = [...byArtist.values()];
    artists.sort(
      (a, b) =>
        tier(a.artist.toLowerCase(), q) - tier(b.artist.toLowerCase(), q) ||
        (b.last ?? -1) - (a.last ?? -1) ||
        a.artist.localeCompare(b.artist),
    );
    return { groups: artists.slice(0, MAX_RESULTS), total: artists.length };
  }, [entries, fallbackEntries, mode, query, scopeDay]);

  // ---- Right-click menu (search rows + day rows — identity-resolved) ----
  const [ctxMenu, setCtxMenu] = useState<{
    name: string;
    artist: string;
    x: number;
    y: number;
    /** The row's played-from context, when the menu came from a DAY row: "Play from"
     *  offers only that playlist (Rem, 2026-08-16 — not every playlist the song lives
     *  in; that broader list belongs to search rows, which leave this undefined). */
    from?: string | null;
  } | null>(null);
  const openMenu =
    (name: string, artist: string, from?: string | null) => (e: React.MouseEvent) => {
      e.preventDefault();
      // Without this, right-clicking a second row while a menu is open let the open
      // menu's window-level contextmenu closer fire on the SAME event — the menu closed
      // instead of moving (wave-2 audit, A12).
      e.stopPropagation();
      setCtxMenu({ name, artist, x: e.clientX, y: e.clientY, from });
    };

  // ---- Row selection (Spotify-ported): click or right-click holds a wash on the row so
  // the context menu's target is visible; moves with the next selection, clears on an
  // outside click. Pointer devices only — a phone tap shouldn't flash a selection.
  const [selRow, setSelRow] = useState<string | null>(null);
  const selectRow = (key: string) => {
    if (window.matchMedia("(hover: hover)").matches) setSelRow(key);
  };
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = e.target;
      if (el instanceof Element && el.closest(".den-rowstate, [data-den-menu], [role='menu'], [role='dialog']"))
        return;
      setSelRow(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

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

  // Phone day view: one row PER PLAY (newest first), not per song with a count — a song
  // played twice appears twice, in its actual slots (Rem, 2026-08-13). Desktop (sortable
  // aggregated table) and the all-time view keep the counted rows; before the payload
  // lands the aggregated server rows stand in.
  const displayRows = useMemo(() => {
    if (!phone || selected === "all") return dayRows;
    // Known, accepted gap: these payload-derived rows don't contain the handoff's
    // provisional (it lives in `tracks`), so on phone a just-finished play appears only
    // when the ~4s refresh patches the payload — a few seconds later than desktop. The
    // per-play-per-row view is worth those seconds (Rem, 2026-08-13).
    return memoryDays?.playRows.get(selected) ?? dayRows;
  }, [phone, selected, memoryDays, dayRows]);

  // Recompute the bottom cues whenever the visible rows change (new day / re-sort /
  // new query) — and, for the results box, when the mode's height animation lands.
  useEffect(() => {
    const el = dayScrollRef.current;
    setDayMoreBelow(!!el && el.scrollHeight - el.clientHeight - el.scrollTop > 2);
    // displayRows, not dayRows: on phone the rendered set is the per-play list, and the
    // scroll cue was derived from the other one.
  }, [displayRows]);
  useEffect(() => {
    const check = () => {
      const el = resScrollRef.current;
      setResMoreBelow(!!el && el.scrollHeight - el.clientHeight - el.scrollTop > 2);
    };
    const raf = requestAnimationFrame(check);
    // The box height glides for ~450ms after keyboard moves; re-check once it settles.
    const t = setTimeout(check, 500);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [groups, searchKbUp]);

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
          // Same boxed shell as the day list below: clipping wrapper + inner scroller +
          // a modest bottom fade, so the box's bottom edge never SLICES through a row
          // with the keyboard up (Rem's screenshot, 2026-08-13) — the fade says
          // "continues" the same way the day view's does.
          <div
            className={cn(
              "relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60 sm:overflow-visible sm:rounded-none sm:border-0",
              searchPending && "opacity-60 transition-opacity",
            )}
          >
            <div
              // Read by the opt-in perf probe (lib/search-perf.ts) and by nothing else. `query`
              // is what makes a mark attributable: without it a probe cannot tell its own rows
              // from the ones still on screen from the previous keystroke.
              data-search-results=""
              data-query={query.trim()}
              data-rows={groups.length}
              // "1" the rows are complete · "x" the attempt failed, nothing is coming · "0"
              // waiting on the server fallback. On the payload path a row is never partial, so
              // this is "1" from the first frame.
              data-hydrated={searchPending ? "0" : searchFailed ? "x" : "1"}
              // Scrolling the results with the keyboard up dismisses it (the iOS-native
              // gesture); the viewport-tracking mode then grows the box into the freed
              // space. Blur only the search input — not, say, a focused button.
              onTouchMove={() => {
                const el = document.activeElement;
                if (searchMode && el instanceof HTMLInputElement) el.blur();
              }}
              onScroll={(e) => {
                const el = e.currentTarget;
                setResMoreBelow(el.scrollHeight - el.clientHeight - el.scrollTop > 2);
              }}
              ref={resScrollRef}
              className="thin-scroll h-full overflow-y-auto px-2.5 sm:px-0"
            >
              {groups.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {searchPending
                    ? "Searching…"
                    : searchFailed
                      ? "Couldn’t reach the server. Edit the search to try again."
                      : `No ${mode === "songs" ? "songs" : "artists"} match “${query.trim()}”${scopeDay ? " that day" : ""}.`}
                </p>
              ) : (
                <>
                  <ul className="divide-y divide-border/50">
                    {groups.map((g, i) =>
                      g.kind === "song" ? (
                        <SongResult
                          key={g.entry.key}
                          entry={g.entry}
                          index={i}
                          expanded={expanded === g.entry.key}
                          onToggle={() =>
                            setExpanded((e) => (e === g.entry.key ? null : g.entry.key))
                          }
                          onMenu={openMenu(g.entry.name, g.entry.artist)}
                        />
                      ) : (
                        <li
                          key={g.artist}
                          className="den-row"
                          style={{ "--i": i } as React.CSSProperties}
                        >
                          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2 sm:gap-4">
                            <Art image={g.image} />
                            <div className="min-w-0">
                              {/* Same 15px as the day table's titles — the results rows
                                  read as one system with the browsing view (Rem). */}
                              <p className="truncate text-[15px] font-medium select-text">
                                {g.artist}
                              </p>
                              {/* Library first, listening second: how much of them you HAVE is
                                  the fact that survives an artist you've never got to. */}
                              <p className="text-[13px] text-muted-foreground">
                                {plural(g.songs, "song")}
                                {g.plays > 0 ? ` · ${plural(g.plays, "play")}` : ""}
                              </p>
                            </div>
                            <PlayedAt last={g.last} />
                          </div>
                        </li>
                      ),
                    )}
                  </ul>
                  {total > groups.length ? (
                    // Never truncate silently: a capped list that says nothing reads as the whole
                    // answer. Typing one more character is the fix, and the count says so.
                    <p className="py-3 text-center text-xs text-muted-foreground/70">
                      Showing the first {groups.length.toLocaleString()} of{" "}
                      {total.toLocaleString()} matches.
                    </p>
                  ) : null}
                </>
              )}
            </div>
            {/* Kept small — real estate matters here — and phone-only: desktop results
                never sat under a keyboard. */}
            <div
              className={cn(
                "pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent transition-opacity duration-200 sm:hidden",
                resMoreBelow ? "opacity-100" : "opacity-0",
              )}
            />
          </div>
        ) : (
          // Phone: the song list is BOUNDED — a framed box that scrolls inside itself,
          // with the search pill always visible under it (Rem's iMessage reference,
          // 2026-08-12). The box CLIPS its content (overflow-hidden) so the row divider
          // hairlines and the bottom fade end exactly at the rounded corner instead of
          // peeking past the curve; no surface tint of its own, so the fade (which goes
          // to the page background) can't leave an off-colour patch in the corners.
          // Desktop keeps the open, borderless list.
          <div
            className={cn(
              "min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60 sm:overflow-visible sm:rounded-none sm:border-0",
              dayPending && "opacity-60 transition-opacity",
            )}
          >
            {displayRows.length === 0 ? (
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
                  // Phone: the gutters live here (the box clips, it doesn't pad).
                  className="thin-scroll h-full overflow-y-auto pl-2.5 pr-2.5 sm:pl-[var(--day-text-inset)] sm:pr-2"
                >
                <table className="w-full table-fixed text-[15px]">
                  {/* Phone: no header row at all — column-header sorting is a pointer
                      affordance, and a caps SONG·ARTIST/PLAYS line over a two-column list
                      was desktop furniture adding noise. The default order stands there. */}
                  <thead className="sticky top-0 z-10 hidden bg-background sm:table-header-group">
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
                    {displayRows.map((t, i) => {
                      const from = t.source;
                      const rowKey = `${t.id}-${t.lastPlayed}-${i}`;
                      return (
                        <tr
                          key={rowKey}
                          onClick={() => selectRow(rowKey)}
                          onContextMenu={(e) => {
                            selectRow(rowKey);
                            openMenu(t.name, t.artist, from)(e);
                          }}
                          style={{ "--i": i } as React.CSSProperties}
                          className={cn(
                            "den-row den-rowstate",
                            selRow === rowKey && "den-rowsel",
                            freshKey === `${t.artist.toLowerCase()}\n${t.name.toLowerCase()}` &&
                              "row-fresh",
                          )}
                        >
                          {/* touch-callout off + phone select-none: a long-press READS
                              the clipped title (HoldTitle) instead of raising the iOS
                              selection callout over the row (Rem, 2026-08-13). */}
                          <td className="py-2 pr-3 [-webkit-touch-callout:none]">
                            <div className="flex min-w-0 items-center gap-3">
                              {/* Phone: art fills the row's actual height (the three text
                                  lines) instead of floating small inside it — same row
                                  height, text shifted right (Rem). */}
                              <Art image={t.albumImage} sizeCls="size-12 sm:size-10" />
                              <div className="min-w-0 flex-1">
                                <HoldTitle text={t.name} />
                                {/* Phone line 2: artist left; playlist · time right-flush
                                    where the plays count used to sit (the count is gone —
                                    a repeat play is its own row). suppressHydrationWarning
                                    on the time: same clock/zone mechanisms as the cells
                                    below. */}
                                <div className="flex min-w-0 items-baseline gap-2">
                                  <p className="truncate text-[13px] text-muted-foreground select-none sm:select-text">
                                    {t.artist}
                                  </p>
                                  <p
                                    suppressHydrationWarning
                                    className="ml-auto flex min-w-0 max-w-[55%] shrink-0 items-baseline text-[12px] tabular-nums text-muted-foreground/70 sm:hidden"
                                  >
                                    {from ? (
                                      <span className="truncate">{from}&nbsp;·&nbsp;</span>
                                    ) : null}
                                    <span className="whitespace-nowrap">
                                      {selected === "all" ? timeAgo(t.lastPlayed) : clockTime(t.lastPlayed)}
                                    </span>
                                  </p>
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="hidden truncate py-2 pr-4 text-muted-foreground md:table-cell">
                            {t.album ?? "—"}
                          </td>
                          <td className="hidden py-2 pr-6 text-right tabular-nums text-muted-foreground sm:table-cell">
                            {formatDuration(t.durationMs)}
                          </td>
                          {/* Explicit width on the phone: table-fixed takes its column
                              widths from the FIRST rendered row, and with the header row
                              display:none under sm that first row is this one — no width
                              hint meant a 50/50 split with the Song column, truncating
                              titles at half the screen. Desktop still sizes off the th. */}
                          <td className="hidden py-2 text-right tabular-nums text-muted-foreground sm:table-cell sm:w-14 sm:pr-6">
                            {t.plays}
                          </td>
                          {/* suppressHydrationWarning: same two mechanisms as the phone fold
                              above — timeAgo()'s clock boundary, clockTime()'s server-UTC vs
                              browser-local zone. */}
                          <td
                            suppressHydrationWarning
                            className="hidden py-2 pr-6 text-right tabular-nums text-muted-foreground sm:table-cell"
                          >
                            {selected === "all" ? timeAgo(t.lastPlayed) : clockTime(t.lastPlayed)}
                          </td>
                          <td className="hidden py-2 text-right text-muted-foreground lg:table-cell">
                            <FromCell text={from ?? "(queued)"} />
                          </td>
                        </tr>
                      );
                    })}
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
        onFocusChange={setSearchFocused}
        onKeyboardChange={setSearchKbUp}
        stayDocked={searchMode}
        placeholder={mode === "songs" ? "Search your songs…" : "Search artists…"}
      >
        <div className="flex h-9 shrink-0 items-center gap-0.5 rounded-full bg-muted/60 p-0.5 sm:h-8">
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
                "h-8 rounded-full px-3.5 text-[13px] font-medium capitalize transition-colors sm:h-7 sm:px-3 sm:text-[12px]",
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
      {ctxMenu ? (
        <IdentityTrackMenu
          // Keyed on the identity: the component resolves ONCE per instance, so reusing
          // one instance across a second right-click showed song B's menu acting on song
          // A's resolved track (wave-2 audit, A11).
          key={`${ctxMenu.artist}\n${ctxMenu.name}`}
          name={ctxMenu.name}
          artist={ctxMenu.artist}
          playedFrom={ctxMenu.from}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
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

// A day row's "From" text, in a column that must not grow: the playlists a song lives in are
// routinely wider than it. At rest the cell clips to an ellipsis like every other column; while
// the cursor is on THIS cell the string scrolls past and back so the rest of it can be read.
//
// The overflow is measured here, on enter — one layout read, on the one cell being looked at —
// and handed to the animation as a distance and a duration (the keyframes live in den.css). It
// has to be measured: an animation that can't know how far the text hides either stops short or
// runs the text off the edge. Speed is constant, so a long list takes longer rather than moving
// faster, and a cell whose text fits does nothing at all.
const MARQUEE_PX_PER_S = 34;
/** The share of the keyframes that moves; the rest is the pause at each end. */
const MARQUEE_MOVING = 0.7;

function FromCell({ text }: { text: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const start = () => {
    const el = box.current;
    if (!el) return;
    const over = el.scrollWidth - el.clientWidth;
    if (over <= 1) return;
    el.style.setProperty("--den-marquee-x", `${-over}px`);
    el.style.setProperty(
      "--den-marquee-dur",
      `${(over / MARQUEE_PX_PER_S / MARQUEE_MOVING).toFixed(2)}s`,
    );
    el.dataset.run = "";
  };
  const stop = () => {
    const el = box.current;
    if (el) delete el.dataset.run;
  };
  return (
    <span
      ref={box}
      onMouseEnter={start}
      onMouseLeave={stop}
      className="den-marquee inline-block max-w-full truncate align-middle text-left"
    >
      <span>{text}</span>
    </span>
  );
}

function Art({
  image,
  size = 11,
  sizeCls,
}: {
  image: string | null;
  size?: 9 | 10 | 11;
  /** Responsive size classes that replace the `size` mapping (e.g. "size-14 sm:size-10"). */
  sizeCls?: string;
}) {
  const cls = sizeCls ?? (size === 9 ? "size-9" : size === 10 ? "size-10" : "size-11");
  return image ? (
    <img src={image} alt="" loading="lazy" className={`${cls} shrink-0 rounded-md object-cover`} />
  ) : (
    <span className={`${cls} shrink-0 rounded-md bg-secondary`} />
  );
}

// A day row's title. Desktop: a plain selectable truncated line. Phone: press-and-hold
// walks the clipped remainder into view (same measured marquee as the From cell — the
// distance and speed come from the real overflow) and releases back; selection is off
// there so the hold reads the title instead of raising the text-selection callout.
function HoldTitle({ text }: { text: string }) {
  const box = useRef<HTMLParagraphElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = box.current;
      if (!el) return;
      const over = el.scrollWidth - el.clientWidth;
      if (over <= 1) return;
      el.style.setProperty("--den-marquee-x", `${-over}px`);
      el.style.setProperty(
        "--den-marquee-dur",
        `${(over / MARQUEE_PX_PER_S / MARQUEE_MOVING).toFixed(2)}s`,
      );
      el.dataset.run = "";
    }, 350);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    const el = box.current;
    if (el) delete el.dataset.run;
  };
  return (
    <p
      ref={box}
      onTouchStart={start}
      onTouchEnd={stop}
      onTouchCancel={stop}
      // A moving finger is a scroll, not a hold.
      onTouchMove={stop}
      className="den-marquee truncate select-none sm:select-text"
    >
      <span>{text}</span>
    </p>
  );
}

/** The right-hand slot of a result row: when the song was last played, or that it never was.
 *
 *  A never-played song is a normal result now that the box searches the library, so the row has
 *  to SAY that rather than leave the slot empty — an empty slot reads as a number still
 *  loading, which is the thing this whole change removed. It sits at half ink and in the same
 *  place a timestamp would, so a run of them settles into a column instead of shouting once per
 *  line, and ranking puts played songs first within each match tier, so they cluster. */
function PlayedAt({ last }: { last: number | null }) {
  return last == null ? (
    <p className="text-xs text-muted-foreground/50">Never played</p>
  ) : (
    // suppressHydrationWarning: timeAgo() reads the clock (see the song-table cells).
    <p suppressHydrationWarning className="text-xs tabular-nums text-muted-foreground">
      {timeAgo(iso(last))}
    </p>
  );
}

// A matched song: one row no matter how many times it was played; the play count sits on the
// right and the row expands to where the song lives and the exact times it ran. Everything
// here is already in memory when the row mounts — art, album, counts, times, playlists — so
// the row is complete in its first frame and nothing reflows behind it.
function SongResult({
  entry,
  index,
  expanded,
  onToggle,
  onMenu,
}: {
  entry: Entry;
  /** Position in the result list — drives the staggered reveal's per-row delay. */
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onMenu?: (e: React.MouseEvent) => void;
}) {
  const { name, artist, album, image, playlists, plays } = entry;
  const SHOW = 12;
  const IN_SHOW = 4;
  const [showAllPlays, setShowAllPlays] = useState(false);
  const listed = showAllPlays ? plays : plays.slice(0, SHOW);
  // A never-played song still expands — to the playlists it sits in, which is the answer to
  // the question that put it on screen.
  const detail = plays.length > 0 || playlists.length > 0;
  return (
    <li className="den-row" style={{ "--i": index } as React.CSSProperties}>
      <button
        type="button"
        onClick={onToggle}
        onContextMenu={onMenu}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 py-2 text-left sm:gap-4 md:grid-cols-[auto_minmax(0,5fr)_minmax(0,4fr)_auto_auto]"
      >
        <Art image={image} />
        <div className="min-w-0">
          {/* 15px, matching the day table's titles — results were a step smaller than the
              browsing view and read as a different, cramped surface (Rem, 2026-08-13). */}
          <p className="truncate text-[15px] font-medium select-text">{name}</p>
          <p className="truncate text-[13px] text-muted-foreground select-text">{artist}</p>
        </div>
        <p className="hidden truncate text-[13px] text-muted-foreground md:block">{album}</p>
        <div className="text-right">
          {plays.length > 1 ? (
            <p className="text-sm font-medium tabular-nums">×{plays.length}</p>
          ) : null}
          <PlayedAt last={plays[0]?.minute ?? null} />
        </div>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground/60 transition-transform",
            expanded && "rotate-180",
            !detail && "opacity-0",
          )}
        />
      </button>
      {expanded && detail ? (
        <ul className="mb-2 ml-[3.75rem] space-y-1 border-l border-border/60 pl-4">
          {playlists.length > 0 ? (
            <li className="text-[13px] text-muted-foreground/80">
              In {playlists.slice(0, IN_SHOW).join(", ")}
              {playlists.length > IN_SHOW ? ` +${playlists.length - IN_SHOW} more` : ""}
            </li>
          ) : null}
          {listed.map((p, i) => (
            <li key={i} className="flex items-baseline gap-3 text-[13px] text-muted-foreground">
              {/* Fixed width from sm up so the sources line up into a column rather than
                  ragging off each timestamp. */}
              <span className="shrink-0 tabular-nums sm:min-w-[8.5rem]">
                {exactTimeShort(iso(p.minute))}
              </span>
              {/* Where THAT play was listened from — the resolved playlist/album name, the bare
                  context type when the name never resolved, and nothing at all when the song is
                  no longer in the playlist it was credited to (db.ts's ctx_orphan). */}
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
