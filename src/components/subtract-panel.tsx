"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { ArrowLeftRight, Pause, Play } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  playPlaylistTrackAction,
  removeTracksAction,
  saveCompareDiffAction,
  subtractPreviewAction,
  type SubtractTrack,
} from "@/app/(app)/actions";
import { AlbumThumb } from "@/components/album-thumb";
import { HoverTip } from "@/components/hover-tip";
import { PlaylistThumb } from "@/components/playlist-thumb";
import { useNowPlaying } from "@/components/now-playing-context";
import { TrackContextMenu } from "@/components/track-context-menu";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { fuzzyFilter } from "@/lib/filter";
import type { Track } from "@/lib/spotify";

type Item = {
  id: string;
  name: string;
  trackCount: number;
  image: string | null;
  mine?: boolean;
};
type Preview = { kept: SubtractTrack[]; overlap: SubtractTrack[] };

// Set-difference tool: pick a base playlist, subtract one or more others from it, and
// see the split — songs unique to the base vs. songs that also live in the subtracted
// playlists. The result renders in a second card to the right, styled like the playlist
// detail view (art, title/artist, now-playing column, right-click menu, double-click
// play) minus the album/length columns so it fits the card. From there, save the
// difference as a new playlist or remove the overlap from the base in place.
export function SubtractPanel({ playlists }: { playlists: Item[] }) {
  const [baseId, setBaseId] = useState<string | null>(null);
  const [others, setOthers] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [computing, setComputing] = useState(false);
  const [tab, setTab] = useState<"kept" | "overlap">("kept");
  const [pending, start] = useTransition();
  const [menu, setMenu] = useState<{ x: number; y: number; track: SubtractTrack } | null>(null);
  const { playing, toggle: npToggle, playOptimistic } = useNowPlaying();

  const byId = useMemo(() => new Map(playlists.map((p) => [p.id, p])), [playlists]);
  const base = baseId ? byId.get(baseId) : undefined;
  // Picked in click order — a Set preserves insertion order (same as MergePanel).
  const chosen = [...others]
    .map((id) => byId.get(id))
    .filter((p): p is Item => Boolean(p));

  const filtered = useMemo(
    () => fuzzyFilter(playlists, query, (p) => p.name).filter((p) => p.id !== baseId),
    [playlists, query, baseId],
  );

  function pickBase(id: string) {
    setBaseId(id);
    setQuery("");
    setOthers((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function clearBase() {
    setBaseId(null);
    setOthers(new Set());
    setPreview(null);
    setQuery("");
  }

  function toggleOther(id: string) {
    setOthers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Deselecting the last one ends the comparison — clear in the handler (not the
    // effect) so the effect never sets state synchronously.
    if (others.has(id) && others.size === 1) {
      setPreview(null);
      setComputing(false);
    }
  }

  // Recompute the difference whenever the selection changes — debounced so toggling a
  // few playlists in a row fires one request; the cleanup's cancelled flag drops an
  // in-flight reply for a stale selection.
  useEffect(() => {
    if (!baseId || others.size === 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setComputing(true);
      const args = [...others]
        .map((id) => byId.get(id))
        .filter((p): p is Item => Boolean(p))
        .map((p) => ({ id: p.id, name: p.name }));
      const r = await subtractPreviewAction(baseId, args);
      if (cancelled) return;
      setComputing(false);
      if (r.ok) setPreview({ kept: r.kept, overlap: r.overlap });
      else {
        setPreview(null);
        toast.error(r.error);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [baseId, others, byId]);

  const diffName = base ? [base.name, ...chosen.map((p) => p.name)].join(" − ") : "";

  function saveDiff() {
    if (!preview || preview.kept.length === 0) return;
    const uris = preview.kept.map((t) => t.uri);
    start(async () => {
      const r = await saveCompareDiffAction(diffName, uris);
      if (r.ok) toast.success(`Saved ${r.count} songs to "${diffName}"`);
      else toast.error(r.error);
    });
  }

  function removeOverlap() {
    if (!base || !preview || preview.overlap.length === 0) return;
    const uris = preview.overlap.map((t) => t.uri);
    start(async () => {
      const r = await removeTracksAction(base.id, uris);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`Removed ${r.removed} songs from "${base.name}"`);
      // The overlap is gone from the base — what's kept is now the whole playlist.
      setPreview((p) => (p ? { kept: p.kept, overlap: [] } : p));
      setTab("kept");
    });
  }

  // A context-menu remove took one track out of the base — mirror it in the preview.
  function dropFromPreview(uri: string) {
    setPreview((p) =>
      p
        ? {
            kept: p.kept.filter((t) => t.uri !== uri),
            overlap: p.overlap.filter((t) => t.uri !== uri),
          }
        : p,
    );
  }

  // Double-click a result row → play it within the base playlist (these are all the
  // base's tracks), exactly like the playlist detail view.
  function play(t: SubtractTrack) {
    if (!base) return;
    window.getSelection?.()?.removeAllRanges();
    playPlaylistTrackAction(base.id, t.uri).then((r) => {
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      playOptimistic(
        { id: t.id, title: t.title, artist: t.artist, albumImage: t.albumImage },
        t.durationMs ?? 0,
      );
    });
  }

  const list = preview ? (tab === "kept" ? preview.kept : preview.overlap) : [];
  const showResult = Boolean(base && others.size > 0);
  const currentId = playing?.track.id;
  const isPlayingNow = playing?.isPlaying ?? false;

  // Quick-action chip styling (same family as the toolbar): neutral white accents,
  // no green fills.
  const chip = (active: boolean) =>
    "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
    (active
      ? "border-white/70 bg-white/15 text-foreground ring-1 ring-inset ring-white/20"
      : "border-transparent bg-secondary text-muted-foreground hover:text-foreground");

  return (
    // Two shared rows (subgrid on lg): row 1 = each card's main content, row 2 = the
    // left card's subtractor summary AND the right card's action buttons — so those two
    // start at the same y no matter how the text above them changes. No fixed heights.
    <div className="grid items-stretch gap-4 lg:grid-cols-2 lg:grid-rows-[auto_auto]">
      <Card className="lg:row-span-2 lg:grid lg:grid-rows-subgrid">
        <div className="flex min-h-0 flex-col gap-4">
        <CardHeader>
          <CardTitle className="text-base">Subtract playlists</CardTitle>
          <CardDescription>
            Pick a base playlist, then one or more to subtract.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {base ? (
            <div className="flex items-center gap-3 text-sm">
              <span className="size-11 shrink-0">
                <PlaylistThumb src={base.image} name="" />
              </span>
              <span className="min-w-0 truncate">
                {base.name}
                <span className="ml-1.5 text-xs text-muted-foreground">{base.trackCount}</span>
              </span>
              <Button
                variant="outline"
                onClick={clearBase}
                className="ml-auto h-7 gap-1.5 rounded-md border-white/15 px-2.5 text-xs font-normal text-muted-foreground hover:border-white/30 hover:text-foreground"
              >
                <ArrowLeftRight className="size-3.5" />
                Change base
              </Button>
            </div>
          ) : null}

          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={base ? "Search playlists to subtract…" : "Search for the base playlist…"}
            aria-label={base ? "Search playlists to subtract" : "Search for the base playlist"}
            className="h-9"
          />

          {/* Taller rows with real playlist art; the cap shows ~4 rows before scrolling. */}
          <div className="thin-scroll max-h-[15.25rem] overflow-y-auto rounded-md border border-border">
            <ul className="divide-y divide-border">
              {filtered.map((p) =>
                base ? (
                  <li key={p.id}>
                    <div
                      role="checkbox"
                      aria-checked={others.has(p.id)}
                      aria-label={p.name}
                      tabIndex={0}
                      onClick={() => toggleOther(p.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleOther(p.id);
                        }
                      }}
                      className={
                        "flex cursor-pointer select-none items-center gap-3 px-3 py-2 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40" +
                        (others.has(p.id) ? " bg-accent/30" : "")
                      }
                    >
                      <Checkbox checked={others.has(p.id)} />
                      <span className="size-11 shrink-0">
                        <PlaylistThumb src={p.image} name="" />
                      </span>
                      <span className="flex-1 truncate text-sm">{p.name}</span>
                      <span className="text-xs text-muted-foreground">{p.trackCount}</span>
                    </div>
                  </li>
                ) : (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => pickBase(p.id)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40"
                    >
                      <span className="size-11 shrink-0">
                        <PlaylistThumb src={p.image} name="" />
                      </span>
                      <span className="flex-1 truncate text-sm">{p.name}</span>
                      <span className="text-xs text-muted-foreground">{p.trackCount}</span>
                    </button>
                  </li>
                ),
              )}
              {filtered.length === 0 ? (
                <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No playlists match “{query}”.
                </li>
              ) : null}
            </ul>
          </div>

        </CardContent>
        </div>

        {/* Row 2 (aligned with the result card's buttons): the subtracted playlists,
            one truncating line each so nothing can run off the card. The base already
            shows above; the created playlist still gets the full "A − B − C" name. */}
        <CardContent>
          {chosen.length > 0 ? (
            <div className="space-y-1 rounded-md border border-border/60 px-3 py-2 text-xs">
              {chosen.map((p) => (
                <div key={p.id} className="flex items-baseline gap-1.5 text-muted-foreground">
                  <span className="shrink-0">−</span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {base
                ? "Pick at least one playlist to subtract from the base."
                : "Songs match by artist + title, like everywhere else in the app."}
            </p>
          )}
        </CardContent>
      </Card>

      {showResult ? (
        <Card className="flex min-h-0 flex-col lg:row-span-2 lg:grid lg:grid-rows-subgrid">
          <div className="flex min-h-0 flex-col gap-4">
          <CardHeader>
            <div className="flex gap-2">
              <button onClick={() => setTab("kept")} className={chip(tab === "kept")}>
                Unique {preview ? preview.kept.length : "…"}
              </button>
              <button onClick={() => setTab("overlap")} className={chip(tab === "overlap")}>
                Shared {preview ? preview.overlap.length : "…"}
              </button>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
            {computing && !preview ? (
              <p className="text-sm text-muted-foreground">Computing difference…</p>
            ) : preview ? (
              <>
                {/* Same box as the playlist view: thin scrollbar, sticky column header,
                    scrolls within the card. Album + length columns are dropped so it
                    fits this card's width. */}
                <div className="thin-scroll min-h-0 max-h-[26rem] flex-1 overflow-y-auto rounded-lg border border-border">
                  <div className="sticky top-0 z-10 grid grid-cols-[1.5rem_1fr_auto] items-center gap-3 border-b border-border bg-background px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <span className="text-right">#</span>
                    <span>Title</span>
                    <span />
                  </div>
                  {list.length === 0 ? (
                    <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                      {tab === "kept"
                        ? "Nothing left — every song is in a subtracted playlist."
                        : "No shared songs."}
                    </p>
                  ) : (
                    <ul>
                      {list.map((t, i) => {
                        const isCurrent = !!currentId && currentId === t.id;
                        return (
                          <li key={`${t.id}-${i}`}>
                            <div
                              className={
                                "grid cursor-default grid-cols-[1.5rem_1fr_auto] items-center gap-3 px-3 py-2 transition-colors hover:bg-accent/30" +
                                (isCurrent ? " bg-white/5" : "")
                              }
                              onDoubleClick={() => play(t)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
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
                                        npToggle();
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
                                  <span
                                    className={
                                      "block truncate text-sm select-text" +
                                      (isCurrent ? " text-[#1db954]" : "")
                                    }
                                  >
                                    {t.title}
                                  </span>
                                  <span className="block truncate text-xs text-muted-foreground select-text">
                                    {t.artist}
                                  </span>
                                </div>
                              </div>
                              {tab === "overlap" && t.in ? (
                                <span className="max-w-32 truncate pr-1 text-right text-xs text-muted-foreground">
                                  in {t.in}
                                </span>
                              ) : (
                                <span />
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            ) : null}
          </CardContent>
          </div>

          {/* Row 2 — starts at the same y as the left card's subtractor list. */}
          <CardContent className="flex gap-2">
            <Button
              onClick={saveDiff}
              disabled={pending || !preview || preview.kept.length === 0}
              className="flex-1 bg-foreground text-background hover:bg-foreground/90"
            >
              {pending ? "Working…" : "Save unique"}
            </Button>
            {base?.mine ? (
              <Button
                variant="outline"
                onClick={removeOverlap}
                disabled={pending || !preview || preview.overlap.length === 0}
                className="flex-1"
              >
                Remove shared
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {menu && base ? (
        <TrackContextMenu
          track={
            {
              id: menu.track.id,
              uri: menu.track.uri,
              title: menu.track.title,
              artist: menu.track.artist,
              albumImage: menu.track.albumImage,
              durationMs: menu.track.durationMs ?? undefined,
            } as Track
          }
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          playlistId={base.mine ? base.id : undefined}
          onRemoved={(t) => dropFromPreview(t.uri)}
        />
      ) : null}
    </div>
  );
}
