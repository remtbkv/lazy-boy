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
import { exactTime, timeAgo } from "@/lib/format";

type Mode = "song" | "artist";
type FoundSong = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  albumImage: string | null;
  playlistCount: number;
};
type FoundArtist = { artist: string; songCount: number; albumImage: string | null };
type Listens = { total: number; recent: string[] };
type Selected =
  | { kind: "song"; item: FoundSong }
  | { kind: "artist"; item: FoundArtist };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Quick lookup of a song OR an artist in your playlists (toggle between the two so the
// results stay clean), then see when you last listened to it. All from the local store.
export function FindPanel() {
  const [mode, setMode] = useState<Mode>("song");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<(FoundSong | FoundArtist)[]>([]);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [listens, setListens] = useState<Listens | null>(null);
  const [loading, setLoading] = useState(false);
  const searchReq = useRef(0);
  const listenReq = useRef(0);

  async function select(sel: Selected) {
    setSelected(sel);
    setListens(null);
    setLoading(true);
    const id = ++listenReq.current;
    const url =
      sel.kind === "song"
        ? `/api/find/listens?id=${encodeURIComponent(sel.item.id)}`
        : `/api/find/listens?artist=${encodeURIComponent(sel.item.artist)}`;
    const res = await fetch(url);
    if (id !== listenReq.current) return;
    setLoading(false);
    if (res.ok) setListens((await res.json()) as Listens);
  }

  useEffect(() => {
    const q = query.trim();
    const id = ++searchReq.current;
    const t = setTimeout(async () => {
      if (id !== searchReq.current) return;
      if (!q) {
        setResults([]);
        setSelected(null);
        setListens(null);
        return;
      }
      const res = await fetch(`/api/find?q=${encodeURIComponent(q)}&mode=${mode}`);
      if (!res.ok || id !== searchReq.current) return;
      const { results: found } = (await res.json()) as {
        results: (FoundSong | FoundArtist)[];
      };
      if (id !== searchReq.current) return;
      setResults(found);
      if (found.length === 1) {
        void select(
          mode === "song"
            ? { kind: "song", item: found[0] as FoundSong }
            : { kind: "artist", item: found[0] as FoundArtist },
        );
      } else {
        setSelected(null);
        setListens(null);
      }
    }, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [query, mode]);

  function switchMode(m: Mode) {
    if (m === mode) return;
    setMode(m);
    setQuery("");
    setResults([]);
    setSelected(null);
    setListens(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Find {mode === "song" ? "a song" : "an artist"}</CardTitle>
        <CardDescription>
          Look up a {mode} in your playlists and see when you last listened — no trip to
          History needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Toggle which kind of thing you're searching, so songs and artists never mix. */}
        <div className="inline-flex rounded-full border border-border bg-card/60 p-0.5 text-sm">
          {(["song", "artist"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              aria-pressed={mode === m}
              className={
                "rounded-full px-3.5 py-1 capitalize transition-colors " +
                (mode === m
                  ? "bg-white/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {m}
            </button>
          ))}
        </div>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === "song" ? "Enter a song name…" : "Enter an artist name…"}
          className="h-9"
          autoFocus
        />

        {selected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <AlbumThumb src={selected.item.albumImage} />
              <div className="min-w-0">
                {selected.kind === "song" ? (
                  <>
                    <p className="truncate font-medium">{selected.item.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {selected.item.artist}
                      {selected.item.album ? ` · ${selected.item.album}` : ""}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="truncate font-medium">{selected.item.artist}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {plural(selected.item.songCount, "song")} in your playlists
                    </p>
                  </>
                )}
              </div>
            </div>

            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : listens ? (
              listens.total === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No listens recorded yet
                  {selected.kind === "song"
                    ? ` — it's in ${plural(selected.item.playlistCount, "playlist")}.`
                    : "."}
                </p>
              ) : (
                <div className="space-y-1.5">
                  <p className="text-sm">
                    Played{" "}
                    <span className="font-medium tabular-nums">{listens.total}</span>{" "}
                    {listens.total === 1 ? "time" : "times"}
                    {selected.kind === "song"
                      ? ` · in ${plural(selected.item.playlistCount, "playlist")}`
                      : ""}
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
                    .filter((r) =>
                      mode === "song"
                        ? (r as FoundSong).id !== (selected.item as FoundSong).id
                        : (r as FoundArtist).artist !== (selected.item as FoundArtist).artist,
                    )
                    .map((r) => {
                      const label =
                        mode === "song"
                          ? `${(r as FoundSong).title} — ${(r as FoundSong).artist}`
                          : (r as FoundArtist).artist;
                      const key = mode === "song" ? (r as FoundSong).id : (r as FoundArtist).artist;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() =>
                            select(
                              mode === "song"
                                ? { kind: "song", item: r as FoundSong }
                                : { kind: "artist", item: r as FoundArtist },
                            )
                          }
                          className="max-w-full truncate rounded-full border border-border px-2.5 py-1 text-xs transition-colors hover:bg-accent"
                        >
                          {label}
                        </button>
                      );
                    })}
                </div>
              </div>
            ) : null}
          </div>
        ) : query.trim() && results.length > 1 ? (
          <div className="thin-scroll max-h-40 overflow-y-auto rounded-md border border-border">
            <ul className="divide-y divide-border">
              {results.map((r) => {
                const isSong = mode === "song";
                const song = r as FoundSong;
                const artist = r as FoundArtist;
                return (
                  <li key={isSong ? song.id : artist.artist}>
                    <button
                      type="button"
                      onClick={() =>
                        select(
                          isSong
                            ? { kind: "song", item: song }
                            : { kind: "artist", item: artist },
                        )
                      }
                      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent/40"
                    >
                      <AlbumThumb src={r.albumImage} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">
                          {isSong ? song.title : artist.artist}
                        </span>
                        {isSong ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {song.artist}
                            {song.album ? ` · ${song.album}` : ""}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {isSong
                          ? plural(song.playlistCount, "playlist")
                          : plural(artist.songCount, "song")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : query.trim() ? (
          <p className="px-1 py-4 text-center text-sm text-muted-foreground">
            No {mode === "song" ? "songs" : "artists"} in your playlists match “{query.trim()}”.
          </p>
        ) : (
          <p className="px-1 py-2 text-sm text-muted-foreground">
            Type {mode === "song" ? "a song" : "an artist"} name to look it up.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
