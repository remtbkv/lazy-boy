"use client";

import { useMemo, useState } from "react";
import { Clock3, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { playPlaylistTrackAction } from "@/app/(app)/actions";
import { AlbumThumb } from "@/components/album-thumb";
import { HoverTip } from "@/components/hover-tip";
import { useNowPlaying } from "@/components/now-playing-context";
import { SortMenu } from "@/components/sort-menu";
import { TrackContextMenu } from "@/components/track-context-menu";
import { Badge } from "@/components/ui/badge";
import { formatDuration } from "@/lib/format";
import type { Track } from "@/lib/spotify";

type Sort = "original" | "title" | "artist" | "album" | "recent";

// "Custom" is the playlist's native order (default). The rest sort, and clicking the
// active one flips direction.
const SORTS: { key: Sort; label: string }[] = [
  { key: "original", label: "Custom" },
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "recent", label: "Recently added" },
];
const DEFAULT_DIR: Record<Exclude<Sort, "original">, "asc" | "desc"> = {
  title: "asc",
  artist: "asc",
  album: "asc",
  recent: "desc", // newest-added first
};

export function TrackList({
  tracks,
  duplicateIds,
  playlistId,
  canRemove = false,
}: {
  tracks: Track[];
  duplicateIds: string[];
  // The playlist these tracks belong to; only passed to the menu (for "Remove
  // from this playlist") when it's one the user owns.
  playlistId?: string;
  canRemove?: boolean;
}) {
  const { playing, toggle, refresh, setPlaying } = useNowPlaying();
  const currentId = playing?.track.id;
  const isPlayingNow = playing?.isPlaying ?? false;
  const dupes = new Set(duplicateIds);
  const [sort, setSort] = useState<Sort>("original");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [menu, setMenu] = useState<{ x: number; y: number; track: Track } | null>(null);
  // URIs removed this session — filtered out immediately so the row disappears
  // without waiting on the server revalidation.
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  // Double-click a row → play that track within the playlist context, so playback
  // continues through the rest of the playlist (like Spotify). Clears the accidental
  // word-selection a double-click makes on the title text.
  function play(t: Track) {
    if (!playlistId) return;
    window.getSelection?.()?.removeAllRanges();
    playPlaylistTrackAction(playlistId, t.uri).then((r) => {
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      // Show the now-playing highlight on this row right away, then reconcile.
      setPlaying({
        track: { id: t.id, title: t.title, artist: t.artist, albumImage: t.albumImage ?? null },
        isPlaying: true,
        progressMs: 0,
        durationMs: t.durationMs ?? 0,
        context: null,
      });
      setTimeout(refresh, 700);
    });
  }

  function selectSort(k: Sort) {
    if (k === "original") {
      setSort("original");
    } else if (k === sort) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(k);
      setDir(DEFAULT_DIR[k]);
    }
  }

  const sorted = useMemo(() => {
    const base = removed.size ? tracks.filter((t) => !removed.has(t.uri)) : tracks;
    if (sort === "original") return base;
    const f = dir === "asc" ? 1 : -1;
    const arr = [...base];
    switch (sort) {
      case "title":
        arr.sort((a, b) => f * a.title.localeCompare(b.title));
        break;
      case "artist":
        arr.sort((a, b) => f * a.artist.localeCompare(b.artist));
        break;
      case "album":
        arr.sort((a, b) => f * (a.album ?? "").localeCompare(b.album ?? ""));
        break;
      case "recent":
        arr.sort((a, b) => f * (a.addedAt ?? "").localeCompare(b.addedAt ?? ""));
        break;
    }
    return arr;
  }, [tracks, sort, dir, removed]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {tracks.length} tracks
          {dupes.size > 0
            ? ` · ${dupes.size} duplicate${dupes.size === 1 ? "" : "s"}`
            : ""}
        </p>
        <SortMenu
          value={sort}
          direction={sort === "original" ? undefined : dir}
          options={SORTS}
          onSelect={selectSort}
        />
      </div>

      {/* On desktop, cap the list to the space under the playlist header so the
          page itself doesn't scroll — you scroll within this box. On phones the
          header stacks taller and a boxed scroll-within-scroll feels wrong, so the
          list just flows and the page scrolls normally. */}
      {/* Sizes to its content — one song shows just one row — and only scrolls once
          it would exceed the cap. */}
      <div className="rounded-lg border border-border sm:max-h-[calc(100vh-27rem)] sm:overflow-y-auto">
        {/* column header — sticks while the list scrolls inside the box (desktop) */}
        <div className="z-10 grid grid-cols-[1.5rem_1fr_auto] items-center gap-3 border-b border-border bg-background px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:sticky sm:top-0 md:grid-cols-[1.5rem_2fr_1.4fr_auto]">
          <span className="text-right">#</span>
          <span>Title</span>
          <span className="hidden md:block">Album</span>
          <span className="pr-1">
            <Clock3 className="size-3.5" />
          </span>
        </div>

        <ul>
          {sorted.map((t, i) => {
            const isCurrent = !!currentId && currentId === t.id;
            return (
            <li key={`${t.id}-${i}`}>
              <div
                className={
                  "grid cursor-default grid-cols-[1.5rem_1fr_auto] items-center gap-3 px-3 py-2 hover:bg-accent/30 md:grid-cols-[1.5rem_2fr_1.4fr_auto]" +
                  (isCurrent ? " bg-white/5" : "")
                }
                onDoubleClick={() => play(t)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation(); // don't let the menu's own outside-click closer fire
                  setMenu({ x: e.clientX, y: e.clientY, track: t });
                }}
              >
                <span className="flex items-center justify-end text-right text-xs tabular-nums text-muted-foreground">
                  {isCurrent ? (
                    <HoverTip label={isPlayingNow ? "Pause" : "Play"} placement="top">
                      <button
                        type="button"
                        aria-label={isPlayingNow ? "Pause" : "Play"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle();
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                        className="flex size-5 items-center justify-center text-[#1db954]"
                      >
                        {isPlayingNow ? (
                          <Pause className="size-3.5" fill="currentColor" />
                        ) : (
                          <Play className="size-3.5 translate-x-px" fill="currentColor" />
                        )}
                      </button>
                    </HoverTip>
                  ) : (
                    i + 1
                  )}
                </span>
                <div className="flex min-w-0 items-center gap-3">
                  <AlbumThumb src={t.albumImage} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          "truncate text-sm select-text" +
                          (isCurrent ? " text-[#1db954]" : "")
                        }
                      >
                        {t.title}
                      </span>
                      {dupes.has(t.id) ? (
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          duplicate
                        </Badge>
                      ) : null}
                    </div>
                    <span className="block truncate text-xs text-muted-foreground select-text">
                      {t.artist}
                    </span>
                  </div>
                </div>
                <span className="hidden truncate text-sm text-muted-foreground select-text md:block">
                  {t.album ?? "—"}
                </span>
                <span className="pr-1 text-right text-sm tabular-nums text-muted-foreground">
                  {formatDuration(t.durationMs)}
                </span>
              </div>
            </li>
            );
          })}
        </ul>
      </div>

      {menu ? (
        <TrackContextMenu
          track={menu.track}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          playlistId={canRemove ? playlistId : undefined}
          onRemoved={(t) => setRemoved((prev) => new Set(prev).add(t.uri))}
        />
      ) : null}
    </div>
  );
}
