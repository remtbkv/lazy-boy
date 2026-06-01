"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { startCleanAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { Task } from "@/lib/tasks/registry";

type CleanResult = { id: string; name: string; kept: number; removed: number };

export function CleanPanel({ playlistId }: { playlistId: string }) {
  const [backup, setBackup] = useState(true);
  const [task, setTask] = useState<Task<CleanResult> | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const running = task?.status === "queued" || task?.status === "running";

  // Poll the task endpoint while the job is active.
  useEffect(() => {
    if (!task || !running) return;
    timer.current = setInterval(async () => {
      const res = await fetch(`/api/tasks/${task.id}`);
      if (!res.ok) return;
      const next: Task<CleanResult> = await res.json();
      setTask(next);
      if (next.status === "done") {
        toast.success(
          `Created "${next.result?.name}" — kept ${next.result?.kept}, removed ${next.result?.removed}`,
        );
      } else if (next.status === "error") {
        toast.error(next.error ?? "Clean failed");
      }
    }, 700);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [task, running]);

  async function start() {
    setStarting(true);
    const res = await startCleanAction(playlistId, backup);
    setStarting(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setTask({
      id: res.taskId,
      label: "clean-playlist",
      status: "running",
      processed: 0,
      total: 0,
      updatedAt: Date.now(),
    });
  }

  const pct =
    task && task.total > 0
      ? Math.min(100, Math.round((task.processed / task.total) * 100))
      : 0;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div>
        <p className="text-sm font-medium">Clean this playlist</p>
        <p className="text-xs text-muted-foreground">
          Creates &quot;Cleaned: …&quot; with songs you&apos;ve already saved elsewhere
          removed.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={backup}
          onCheckedChange={(v) => setBackup(Boolean(v))}
          disabled={running}
        />
        Back up removed songs to a separate playlist
      </label>

      {running ? (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Scanning your library… {task!.processed}
            {task!.total ? ` / ${task!.total}` : ""} ({pct}%)
          </p>
        </div>
      ) : (
        <Button onClick={start} disabled={starting} className="w-full">
          {starting ? "Starting…" : "Clean playlist"}
        </Button>
      )}
    </div>
  );
}
