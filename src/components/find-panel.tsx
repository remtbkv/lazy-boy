"use client";

import { useEffect, useRef, useState } from "react";
import { AlbumThumb } from "@/components/album-thumb";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { exactTime, timeAgo } from "@/lib/format";

type FoundSong = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  albumImage: string | null;
  playlistCount: number;
};
type Listens = { total: number; recent: string[] };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Quick song lookup: type a name → fuzzy-match songs that are in any of your playlists →
// (auto-pick if there's only one, otherwise choose) → see when you last listened to it,
// all in this dropdown. Everything reads the local store, so it's instant.
export function FindPanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundSong[]>([]);
  const [selected, setSelected] = useState<FoundSong | null>(null);
  const [listens, setListens] = useState<Listens | null>(null);
  const [loading, setLoading] = useState(false);
  // Guards against out-of-order responses when typing fast.
  const searchReq = useRef(0);
  const listenReq = useRef(0);

  async function selectSong(song: FoundSong) {
    setSelected(song);
    setListens(null);
    setLoading(true);
    const id = ++listenReq.current;
    const res = await fetch(`/api/find/listens?id=${encodeURIComponent(song.id)}`);
    if (id !== listenReq.current) return;
    setLoading(false);
    if (res.ok) setListens((await res.json()) as Listens);
  }

  useEffect(() => {
    const q = query.trim();
    const id = ++searchReq.current;
    // All state changes happen inside the timeout (async), never synchronously in the
    // effect body, so a fast typist doesn't trigger a render cascade.
    const t = setTimeout(async () => {
      if (id !== searchReq.current) return;
      if (!q) {
        setResults([]);
        setSelected(null);
        setListens(null);
        return;
      }
      const res = await fetch(`/api/find?q=${encodeURIComponent(q)}`);
      if (!res.ok || id !== searchReq.current) return;
      const { results: found } = (await res.json()) as { results: FoundSong[] };
      if (id !== searchReq.current) return;
      setResults(found);
      // Exactly one match → skip the choose step and show it straight away.
      if (found.length === 1) {
        void selectSong(found[0]);
      } else {
        setSelected(null);
        setListens(null);
      }
    }, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Find a song</CardTitle>
        <CardDescription>
          Look up any song that&apos;s in one of your playlists and see when you last listened
          to it — no trip to History needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter song name…"
          className="h-9"
          autoFocus
        />

        {selected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <AlbumThumb src={selected.albumImage} />
              <div className="min-w-0">
                <p className="truncate font-medium">{selected.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {selected.artist}
                  {selected.album ? ` · ${selected.album}` : ""}
                </p>
              </div>
            </div>

            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : listens ? (
              listens.total === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No listens recorded yet — it&apos;s in {plural(selected.playlistCount, "playlist")}.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <p className="text-sm">
                    Played{" "}
                    <span className="font-medium tabular-nums">{listens.total}</span>{" "}
                    {listens.total === 1 ? "time" : "times"} · in{" "}
                    {plural(selected.playlistCount, "playlist")}
                  </p>
                  <ul className="space-y-1 text-sm">
                    {listens.recent.map((iso, i) => (
                      <li key={i} className="flex items-baseline justify-between gap-3">
                        <span>{timeAgo(iso)}</span>
                        <span className="text-xs text-muted-foreground">{exactTime(iso)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            ) : null}

            {results.length > 1 ? (
              <div className="border-t border-border pt-2">
                <p className="mb-1.5 text-xs text-muted-foreground">Other matches</p>
                <div className="flex flex-wrap gap-1.5">
                  {results
                    .filter((r) => r.id !== selected.id)
                    .map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => selectSong(r)}
                        className="max-w-full truncate rounded-full border border-border px-2.5 py-1 text-xs transition-colors hover:bg-accent"
                      >
                        {r.title} — {r.artist}
                      </button>
                    ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : query.trim() && results.length > 1 ? (
          <ScrollArea className="max-h-64 rounded-md border border-border">
            <ul className="divide-y divide-border">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => selectSong(r)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent/40"
                  >
                    <AlbumThumb src={r.albumImage} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{r.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {r.artist}
                        {r.album ? ` · ${r.album}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {plural(r.playlistCount, "playlist")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        ) : query.trim() ? (
          <p className="px-1 py-4 text-center text-sm text-muted-foreground">
            No songs in your playlists match “{query.trim()}”.
          </p>
        ) : (
          <p className="px-1 py-2 text-sm text-muted-foreground">
            Type a song name to look it up.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
