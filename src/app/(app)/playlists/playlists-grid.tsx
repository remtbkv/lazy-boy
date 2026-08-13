"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { SortMenu } from "@/components/sort-menu";
import { PlaylistThumb } from "@/components/playlist-thumb";
import { SearchIsland } from "../search-island";
import type { StoredPlaylist } from "@/lib/db";
import { fuzzyFilter } from "@/lib/filter";

type Sort = "recents" | "name" | "songs";
const SORTS: { key: Sort; label: string }[] = [
  { key: "recents", label: "Recents" },
  { key: "name", label: "Name" },
  { key: "songs", label: "Songs" },
];
// Direction each sort opens in; clicking the active one flips it.
const DEFAULT_DIR: Record<Sort, "asc" | "desc"> = {
  recents: "asc", // native library order; desc reverses it
  name: "asc",
  songs: "desc", // most songs first
};

// The library under the new skin: a stats heading that shares its row with the sort
// control (numbers in foreground, labels muted — same emphasis as the live app), an
// in-flow search, and a responsive art-first grid. Art is never overlaid.
export function PlaylistsGrid({
  playlists,
  owned,
  uniqueSongs,
}: {
  playlists: StoredPlaylist[];
  owned: number;
  uniqueSongs: number;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recents");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  // Picking a key only picks the key — direction is its own control now (no hidden
  // re-click-to-flip). A new key still opens in its natural direction.
  const selectSort = (k: Sort) => {
    if (k === sort) return;
    setSort(k);
    setDir(DEFAULT_DIR[k]);
  };
  const toggleDir = () => setDir((d) => (d === "asc" ? "desc" : "asc"));

  const filtered = query.trim() ? fuzzyFilter(playlists, query, (p) => p.name) : playlists;
  const shown = useMemo(() => {
    // "Recents" is native library order (asc); desc reverses it. Name/Songs sort explicitly.
    if (sort === "recents") return dir === "asc" ? filtered : [...filtered].reverse();
    const f = dir === "asc" ? 1 : -1;
    const arr = [...filtered];
    if (sort === "name") arr.sort((a, b) => f * a.name.localeCompare(b.name));
    else arr.sort((a, b) => f * (a.trackCount - b.trackCount));
    return arr;
  }, [filtered, sort, dir]);

  // One songs number, not two: the app's computed unique-song count (dedupes the same song
  // across playlists), falling back to the raw track-count sum until it's first computed.
  const totalSongs = playlists.reduce((n, p) => n + p.trackCount, 0);
  const songCount = uniqueSongs || totalSongs;

  // One mark, matching Home's: the grid is on screen with the server's library. The whole page
  // arrives in that one payload (tiles, counts, sort), so this is the page's load story — read
  // by the collector in src/lib/metrics-client.ts, shown on /usage. Nothing here reads it back.
  useEffect(() => {
    performance.mark("lb:playlists-rendered");
  }, []);

  return (
    <div className="space-y-6">
      {/* No "Playlists" title — the active nav tab already names the page. The stats line is
          the header (numbers foreground, labels muted); the sort sits inline at its right.
          Search moved to the bottom island. */}
      {/* items-end on the phone: the stats wrap to two lines there, and a top-hung sort
          control next to a two-line block read as floating (Rem, 2026-08-13). */}
      <div className="flex items-end justify-between gap-3 sm:items-center">
        {/* Locale pinned, not the runtime default: this line is server-rendered and then
            hydrated, and a bare toLocaleString() groups by whatever locale the runtime is in
            (en-US "13,464" on Vercel's Node vs de-DE "13.464" in the browser) — a hydration
            mismatch for anyone outside en-US. */}
        {/* Phone: the line breaks BEFORE "unique songs" (block span) — deliberate split, no
            separator dot left hanging at the end of the first line — and at 17px: the page
            header can carry more size than desktop's inline 15px. */}
        <h1 className="text-[17px] text-muted-foreground sm:text-[15px]">
          <span className="whitespace-nowrap">
            <span className="font-medium text-foreground">
              {playlists.length.toLocaleString("en-US")}
            </span>{" "}
            playlists
          </span>
          {" · "}
          <span className="whitespace-nowrap">
            <span className="font-medium text-foreground">{owned.toLocaleString("en-US")}</span>{" "}
            created by you
          </span>
          <span className="hidden sm:inline">{" · "}</span>
          <span className="block whitespace-nowrap sm:inline">
            <span className="font-medium text-foreground">
              {songCount.toLocaleString("en-US")}
            </span>{" "}
            unique songs
          </span>
        </h1>
        <div className="shrink-0">
          <SortMenu
            value={sort}
            direction={dir}
            options={SORTS}
            onSelect={selectSort}
            onToggleDirection={toggleDir}
          />
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Nothing matches “{query.trim()}”.
        </p>
      ) : (
        // Same grid + boxed card as the live library: 4 columns on desktop, art in a
        // bordered box. Copied wholesale so the squares match the original view.
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((p, i) => (
            <li key={p.id}>
              <Link
                href={`/playlists/${p.id}`}
                className="group block rounded-lg border border-border bg-card p-3 transition-colors hover:border-white/25 hover:bg-accent/40"
              >
                <PlaylistThumb src={p.image} name={p.name} priority={i < 8} />
                <p className="mt-3 truncate text-sm font-medium select-text">{p.name}</p>
                <p className="truncate text-xs tabular-nums text-muted-foreground">
                  {p.trackCount} songs
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Bottom-centered search island (search moved out of the header row). Under 20
          playlists the page is too short to need searching — the island just covers tiles. */}
      {playlists.length >= 20 && (
        <SearchIsland query={query} onQuery={setQuery} placeholder="Search your playlists…" />
      )}
    </div>
  );
}
