"use client";

import { useMemo, useState, useTransition } from "react";
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
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fuzzyFilter } from "@/lib/filter";

type Item = { id: string; name: string; trackCount: number };

export function MergePanel({
  playlists,
  total,
  loadingMore = false,
}: {
  playlists: Item[];
  total?: number;
  loadingMore?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtered = useMemo(
    () => fuzzyFilter(playlists, query, (p) => p.name),
    [playlists, query],
  );

  // Combine in the order the user picked them, not list order — a Set preserves
  // insertion order, so iterate it rather than filtering the original list.
  const byId = new Map(playlists.map((p) => [p.id, p]));
  const chosen = [...selected]
    .map((id) => byId.get(id))
    .filter((p): p is Item => Boolean(p));
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
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search playlists…"
            className="h-9"
          />
          <span className="shrink-0 text-xs text-muted-foreground">
            {selected.size} selected
          </span>
        </div>

        {loadingMore && total ? (
          <p className="text-xs text-muted-foreground">
            Loaded {playlists.length} of {total} playlists — searching the rest as
            they load…
          </p>
        ) : null}

        <ScrollArea className="h-64 rounded-md border border-border">
          <ul className="divide-y divide-border">
            {filtered.map((p) => {
              const isChecked = selected.has(p.id);
              return (
                <li key={p.id}>
                  <div
                    role="checkbox"
                    aria-checked={isChecked}
                    tabIndex={0}
                    onClick={() => toggle(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle(p.id);
                      }
                    }}
                    className={
                      "flex cursor-pointer select-none items-center gap-3 px-3 py-2 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40" +
                      (isChecked ? " bg-accent/30" : "")
                    }
                  >
                    <Checkbox checked={isChecked} />
                    <span className="flex-1 truncate text-sm">{p.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {p.trackCount}
                    </span>
                  </div>
                </li>
              );
            })}
            {filtered.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                No playlists match “{query}”.
              </li>
            ) : null}
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
