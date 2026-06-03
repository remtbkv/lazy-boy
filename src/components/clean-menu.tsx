"use client";

import { useEffect, useRef, useState } from "react";
import { Brush } from "lucide-react";
import { toast } from "sonner";
import { startCleanAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  readCleanActive,
  writeCleanActive,
  type CleanProgressDetail,
} from "@/lib/clean-progress";

type Progress = { processed: number; total: number; status: CleanProgressDetail["status"] };

// "Clean playlist" as a header button + popover, so the controls don't sit in a
// permanent side column. Live progress shows on the button itself. The actual job
// is tracked app-wide by CleanProgressWatcher; this component just kicks it off and
// mirrors the progress it broadcasts, so navigating away and back (or reloading)
// still shows the running clean.
export function CleanMenu({ playlistId }: { playlistId: string }) {
  const [open, setOpen] = useState(false);
  const [backup, setBackup] = useState(true);
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const running = progress?.status === "queued" || progress?.status === "running";

  // Pick up an in-flight clean for THIS playlist on mount, then mirror progress
  // from the watcher's events.
  useEffect(() => {
    // Deferred to a frame so it isn't a synchronous setState in the effect body
    // (and so localStorage is only read client-side).
    const raf = requestAnimationFrame(() => {
      const active = readCleanActive();
      if (active?.playlistId === playlistId) {
        setProgress((p) => p ?? { processed: 0, total: 0, status: "running" });
      }
    });
    const onProgress = (e: Event) => {
      const d = (e as CustomEvent<CleanProgressDetail>).detail;
      if (d.playlistId !== playlistId) return;
      if (d.status === "done" || d.status === "error" || d.status === "gone") {
        setProgress(null);
      } else {
        setProgress({ processed: d.processed, total: d.total, status: d.status });
      }
    };
    window.addEventListener("clean:progress", onProgress);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("clean:progress", onProgress);
    };
  }, [playlistId]);

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  async function start() {
    setStarting(true);
    const res = await startCleanAction(playlistId, backup);
    setStarting(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setProgress({ processed: 0, total: 0, status: "running" });
    writeCleanActive({ taskId: res.taskId, playlistId });
  }

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : 0;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <Button
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="gap-2 border-white/25 hover:border-white/50"
      >
        <Brush className="size-4" />
        Clean playlist
        {running && progress!.total > 0 ? (
          <span className="ml-1 tabular-nums text-xs text-muted-foreground">{pct}%</span>
        ) : null}
      </Button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 space-y-3 rounded-xl border border-border bg-popover/95 p-4 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur">
          <p className="text-xs text-muted-foreground">
            Creates &quot;Cleaned: …&quot; with songs you&apos;ve already saved elsewhere
            removed.
          </p>

          <div
            role="checkbox"
            aria-checked={backup}
            aria-disabled={running}
            tabIndex={running ? -1 : 0}
            onClick={() => !running && setBackup((b) => !b)}
            onKeyDown={(e) => {
              if (!running && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                setBackup((b) => !b);
              }
            }}
            className="flex cursor-pointer select-none items-center gap-2 text-sm outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            <Checkbox checked={backup} disabled={running} />
            Back up removed songs to a separate playlist
          </div>

          {running ? (
            <div className="space-y-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Scanning your library… {progress!.processed}
                {progress!.total ? ` / ${progress!.total}` : ""} ({pct}%)
              </p>
            </div>
          ) : (
            <Button onClick={start} disabled={starting} className="w-full">
              {starting ? "Starting…" : "Clean playlist"}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
