"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Clock3, Pause, Play } from "lucide-react";
import { toast } from "@/lib/toast";
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
  const { playing, toggle, playOptimistic } = useNowPlaying();
  const currentId = playing?.track.id;
  const isPlayingNow = playing?.isPlaying ?? false;
  const dupes = useMemo(() => new Set(duplicateIds), [duplicateIds]);
  const [sort, setSort] = useState<Sort>("original");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [menu, setMenu] = useState<{ x: number; y: number; track: Track } | null>(null);
  // URIs removed this session — filtered out immediately so the row disappears
  // without waiting on the server revalidation.
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  // Once the server list changes it's authoritative — drop the optimistic set, or a
  // track later re-added to the playlist would stay hidden until a full remount.
  // (Adjust-state-during-render, per React's "you might not need an effect".)
  const [prevTracks, setPrevTracks] = useState(tracks);
  if (prevTracks !== tracks) {
    setPrevTracks(tracks);
    if (removed.size) setRemoved(new Set());
  }

  // Deep-link from Find: `?t=<trackId>` scrolls that row into view and flashes it. The
  // flash is a soft wash that fades out on its own, so it's a brief "here it is" cue
  // rather than a persistent selection.
  const targetTrackId = useSearchParams().get("t");
  const scrolledFor = useRef<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

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
      // Show the now-playing highlight on this row right away; the poll confirms.
      playOptimistic(
        { id: t.id, title: t.title, artist: t.artist, albumImage: t.albumImage ?? null },
        t.durationMs ?? 0,
      );
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

  // Once the rows are in the DOM, scroll the deep-linked track into view and flash it.
  useEffect(() => {
    if (!targetTrackId || scrolledFor.current === targetTrackId) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`t-${targetTrackId}`);
      if (!el) return;
      scrolledFor.current = targetTrackId;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setFlashId(targetTrackId);
    });
    return () => cancelAnimationFrame(raf);
  }, [targetTrackId, sorted]);

  // Clear the flash after it has played, on its own timer keyed to flashId — so a
  // background refresh (which re-renders `sorted`) can't cancel the cleanup and leave the
  // highlight stuck on. The CSS animation ends at opacity 0 regardless; this just resets
  // the marker so the same row can flash again later.
  useEffect(() => {
    if (!flashId) return;
    const timeout = setTimeout(() => setFlashId(null), 1900);
    return () => clearTimeout(timeout);
  }, [flashId]);

  return (
    <div className="space-y-2">
      {/* Track count + length live in the playlist header (next to the cover); don't
          repeat the count here. Keep only the duplicates note (shown nowhere else) and
          the sort control. */}
      <div className="flex items-center justify-end gap-2">
        {dupes.size > 0 ? (
          <p className="mr-auto text-sm text-muted-foreground">
            {dupes.size} duplicate{dupes.size === 1 ? "" : "s"}
          </p>
        ) : null}
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
      <div className="thin-scroll rounded-lg border border-border sm:max-h-[calc(100vh-25rem)] sm:overflow-y-auto">
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
            <li key={`${t.id}-${i}`} id={`t-${t.id}`} className="scroll-mt-24">
              <div
                className={
                  "relative grid cursor-default grid-cols-[1.5rem_1fr_auto] items-center gap-3 px-3 py-2 transition-colors hover:bg-accent/30 md:grid-cols-[1.5rem_2fr_1.4fr_auto]" +
                  (isCurrent ? " bg-white/5" : "")
                }
                onDoubleClick={() => play(t)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation(); // don't let the menu's own outside-click closer fire
                  setMenu({ x: e.clientX, y: e.clientY, track: t });
                }}
              >
                {/* Deep-link flash — a soft, rounded wash that pops in and fades on its
                    own (CSS flash-pulse; rests at opacity 0 so it's never a stuck box). */}
                <div
                  aria-hidden
                  className={
                    "pointer-events-none absolute inset-y-1 inset-x-2 rounded-xl bg-white/[0.07] opacity-0 " +
                    (flashId === t.id ? "flash-pulse" : "")
                  }
                />
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
