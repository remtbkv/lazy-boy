"use client";

import { useMemo, useState, useTransition } from "react";
import { Brush } from "lucide-react";
import { toast } from "sonner";
import { setCleanBackupAction, startCleanAction } from "@/app/(app)/actions";
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
import { writeCleanActive } from "@/lib/clean-progress";
import { fuzzyFilter } from "@/lib/filter";

type Item = { id: string; name: string; trackCount: number };

// Fuzzy-find a playlist and clean it. Phase 1 runs against the library index and
// returns at once (toasted here); the background reconcile is handed to
// CleanProgressWatcher. The backup choice is the global, DB-backed preference.
export function CleanPanel({
  playlists,
  initialBackup,
}: {
  playlists: Item[];
  initialBackup: boolean;
}) {
  const [query, setQuery] = useState("");
  const [backup, setBackup] = useState(initialBackup);
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(
    () => fuzzyFilter(playlists, query, (p) => p.name),
    [playlists, query],
  );

  function toggleBackup() {
    setBackup((b) => {
      const next = !b;
      void setCleanBackupAction(next); // persist the global preference
      return next;
    });
  }

  function clean(p: Item) {
    setBusyId(p.id);
    start(async () => {
      const r = await startCleanAction(p.id, backup);
      setBusyId(null);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`Created "${r.name}" — kept ${r.kept}, removed ${r.removed}`);
      writeCleanActive({ taskId: r.taskId, playlistId: p.id });
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Clean a playlist</CardTitle>
        <CardDescription>
          Find a playlist and remove songs you&apos;ve already saved elsewhere into a new
          &quot;Cleaned: …&quot; playlist. The original is left untouched.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search playlists…"
          className="h-9"
        />

        <div
          role="checkbox"
          aria-checked={backup}
          tabIndex={0}
          onClick={toggleBackup}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleBackup();
            }
          }}
          className="flex cursor-pointer select-none items-center gap-2 text-sm outline-none"
        >
          <Checkbox checked={backup} />
          Back up removed songs to a separate playlist
        </div>

        <ScrollArea className="h-64 rounded-md border border-border">
          <ul className="divide-y divide-border">
            {filtered.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => clean(p)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 disabled:opacity-50"
                >
                  <Brush className="size-4 shrink-0 text-muted-foreground" />
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
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
