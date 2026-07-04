"use client";

import { useState } from "react";
import Link from "next/link";
import { SearchIcon, X } from "lucide-react";
import type { StoredPlaylist } from "@/lib/db";
import { fuzzyFilter } from "@/lib/filter";

// The library under the new skin: heading with the real counts, an in-flow search
// (no floating pill), and a responsive art-first grid — 2-up on phones, up to 5-up
// on desktop. Art is never overlaid; the name sits below it.
export function PlaylistsGrid({ playlists }: { playlists: StoredPlaylist[] }) {
  const [query, setQuery] = useState("");
  const shown = query.trim() ? fuzzyFilter(playlists, query, (p) => p.name) : playlists;
  const songs = playlists.reduce((n, p) => n + p.trackCount, 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="den-display text-[27px] leading-tight sm:text-4xl">Playlists</h1>
        <p className="mt-1.5 text-sm tabular-nums text-muted-foreground">
          {playlists.length} playlists · {songs.toLocaleString()} songs
        </p>
      </header>

      <div className="flex h-11 items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 focus-within:border-[color-mix(in_srgb,var(--border)_30%,var(--muted-foreground))]">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your playlists…"
          aria-label="Search playlists"
          className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
        />
        {query ? (
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

      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Nothing matches “{query.trim()}”.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {shown.map((p) => (
            <li key={p.id}>
              <Link href={`/playlists/${p.id}`} className="group block">
                {p.image ? (
                  <img
                    src={p.image}
                    alt=""
                    loading="lazy"
                    className="aspect-square w-full rounded-lg object-cover transition-opacity group-hover:opacity-90"
                  />
                ) : (
                  <span className="block aspect-square w-full rounded-lg bg-secondary" />
                )}
                <p className="mt-2 truncate text-sm font-medium select-text">{p.name}</p>
                <p className="truncate text-xs tabular-nums text-muted-foreground">
                  {p.trackCount} songs
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
