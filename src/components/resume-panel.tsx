"use client";

import { useMemo, useState, useTransition } from "react";
import { Play } from "lucide-react";
import { toast } from "@/lib/toast";
import { resumePlaylistAction } from "@/app/(app)/actions";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fuzzyFilter } from "@/lib/filter";

type Item = { id: string; name: string; trackCount: number };

// Pick a playlist → playback resumes on the active device from the song after the
// last one you played from it (server figures that out from listen history).
export function ResumePanel({ playlists }: { playlists: Item[] }) {
  const [query, setQuery] = useState("");
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(
    () => fuzzyFilter(playlists, query, (p) => p.name),
    [playlists, query],
  );

  function resume(p: Item) {
    setBusyId(p.id);
    start(async () => {
      const r = await resumePlaylistAction(p.id);
      setBusyId(null);
      // No success toast — you'll hear the music start. Only surface failures
      // (e.g. no active device), which otherwise look like nothing happened.
      if (!r.ok) toast.error(r.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pick up where you left off</CardTitle>
        <CardDescription>
          Pick a playlist — playback resumes on your active device from the song after the
          last one you played from it (or the top if it&apos;s new to you).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search playlists…"
          className="h-9"
        />
        <div className="thin-scroll max-h-64 overflow-y-auto rounded-md border border-border">
          <ul className="divide-y divide-border">
            {filtered.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => resume(p)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 disabled:opacity-50"
                >
                  <Play className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-sm">{p.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {busyId === p.id ? "…" : p.trackCount}
                  </span>
                </button>
              </li>
            ))}
            {filtered.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                No playlists match “{query}”.
              </li>
            ) : null}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
