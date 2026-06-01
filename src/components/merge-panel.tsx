"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { mergeAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";

type Item = { id: string; name: string; trackCount: number };

export function MergePanel({ playlists }: { playlists: Item[] }) {
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

  const chosen = playlists.filter((p) => selected.has(p.id));
  const previewName = chosen.map((p) => p.name).join(" + ");

  function merge() {
    const ids = chosen.map((p) => p.id);
    startTransition(async () => {
      const res = await mergeAction(ids);
      if (res.ok) {
        toast.success(`Created "${res.name}" with ${res.count} tracks`);
        setSelected(new Set());
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Merge playlists</CardTitle>
        <CardDescription>
          Pick two or more. We create a new playlist combining them, in order, with
          duplicate songs removed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ScrollArea className="h-56 rounded-md border border-border">
          <ul className="divide-y divide-border">
            {playlists.map((p) => (
              <li key={p.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-secondary/50">
                  <Checkbox
                    checked={selected.has(p.id)}
                    onCheckedChange={() => toggle(p.id)}
                  />
                  <span className="flex-1 truncate text-sm">{p.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {p.trackCount}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </ScrollArea>

        {chosen.length > 0 ? (
          <p className="truncate text-xs text-muted-foreground">
            New playlist: <span className="text-foreground">{previewName}</span>
          </p>
        ) : null}

        <Button
          onClick={merge}
          disabled={pending || chosen.length < 2}
          className="w-full"
        >
          {pending
            ? "Merging…"
            : `Merge ${chosen.length || ""} playlist${chosen.length === 1 ? "" : "s"}`.trim()}
        </Button>
      </CardContent>
    </Card>
  );
}
