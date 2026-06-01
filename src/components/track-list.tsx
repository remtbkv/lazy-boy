"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { removeTracksAction } from "@/app/(app)/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { Track } from "@/lib/spotify";

export function TrackList({
  playlistId,
  tracks,
  duplicateIds,
}: {
  playlistId: string;
  tracks: Track[];
  duplicateIds: string[];
}) {
  const dupes = new Set(duplicateIds);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectDuplicates() {
    setSelected(new Set(dupes));
  }

  function remove() {
    const ids = [...selected];
    startTransition(async () => {
      const res = await removeTracksAction(playlistId, ids);
      if (res.ok) {
        toast.success(`Created "${res.name}" without ${res.removed} tracks`);
        setSelected(new Set());
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          {tracks.length} tracks
          {dupes.size > 0 ? ` · ${dupes.size} duplicate${dupes.size === 1 ? "" : "s"}` : ""}
        </p>
        <div className="ml-auto flex gap-2">
          {dupes.size > 0 ? (
            <Button variant="ghost" size="sm" onClick={selectDuplicates}>
              Select duplicates
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={remove}
            disabled={pending || selected.size === 0}
          >
            {pending ? "Removing…" : `Remove ${selected.size || ""}`.trim()} → new playlist
          </Button>
        </div>
      </div>

      <ul className="divide-y divide-border rounded-lg border border-border">
        {tracks.map((t, i) => (
          <li key={`${t.id}-${i}`}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-secondary/40">
              <Checkbox
                checked={selected.has(t.id)}
                onCheckedChange={() => toggle(t.id)}
              />
              <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{t.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {t.artist}
                </span>
              </span>
              {dupes.has(t.id) ? (
                <Badge variant="secondary" className="text-[10px]">
                  duplicate
                </Badge>
              ) : null}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
