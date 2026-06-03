"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  CLEAN_LS_KEY,
  clearCleanActive,
  readCleanActive,
  type CleanProgressDetail,
} from "@/lib/clean-progress";
import type { Task } from "@/lib/tasks/registry";

type CleanResult = { id: string; name: string; kept: number; removed: number };

// Mounted once in the (app) layout, so it keeps running across page navigation.
// A clean started on any playlist page reports here, which lets its progress
// survive leaving the page and reloading the site. It shows a small, unobtrusive
// pill pinned under the header (not a big toast), and broadcasts "clean:progress"
// events so the CleanMenu button can mirror the same percentage.
export function CleanProgressWatcher() {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // null = not running (hidden). Otherwise the label to show — "Cleaning…" until
  // we have a real total, then "Cleaning… N%". Avoids a 0% flash on resume.
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    function broadcast(detail: CleanProgressDetail) {
      window.dispatchEvent(new CustomEvent("clean:progress", { detail }));
    }
    function stop() {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    }

    async function tick() {
      const active = readCleanActive();
      if (!active) {
        stop();
        return;
      }
      const res = await fetch(`/api/tasks/${active.taskId}`).catch(() => null);
      if (!res) return; // transient network blip — keep polling
      if (res.status === 404) {
        // The server forgot this task (likely a restart). Drop it quietly.
        clearCleanActive();
        broadcast({ ...active, processed: 0, total: 0, status: "gone" });
        setLabel(null);
        stop();
        return;
      }
      if (!res.ok) return;

      const task = (await res.json()) as Task<CleanResult>;
      const next =
        task.total > 0 ? Math.min(100, Math.round((task.processed / task.total) * 100)) : 0;
      broadcast({
        playlistId: active.playlistId,
        taskId: active.taskId,
        processed: task.processed,
        total: task.total,
        status: task.status,
      });

      if (task.status === "done") {
        toast.success(
          `Created "${task.result?.name}" — kept ${task.result?.kept}, removed ${task.result?.removed}`,
        );
        clearCleanActive();
        setLabel(null);
        stop();
      } else if (task.status === "error") {
        toast.error(task.error ?? "Clean failed");
        clearCleanActive();
        setLabel(null);
        stop();
      } else {
        setLabel(task.total > 0 ? `Cleaning… ${next}%` : "Cleaning…");
      }
    }

    function ensureRunning() {
      if (readCleanActive() && !timer.current) {
        tick();
        timer.current = setInterval(tick, 800);
      }
    }

    ensureRunning();
    const onActive = () => ensureRunning();
    const onStorage = (e: StorageEvent) => {
      if (e.key === CLEAN_LS_KEY) ensureRunning();
    };
    window.addEventListener("clean:active", onActive);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("clean:active", onActive);
      window.removeEventListener("storage", onStorage);
      stop();
    };
  }, []);

  if (label === null) return null;

  // Pinned just under the header, right-aligned to the same centered container so it
  // sits under the avatar. z-30 keeps it below the sticky header (z-40).
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[4.5rem] z-30 mx-auto flex max-w-5xl justify-end px-4 sm:px-6">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow-lg ring-1 ring-white/5 backdrop-blur">
        <Loader2 className="size-3.5 animate-spin" />
        {label}
      </div>
    </div>
  );
}
