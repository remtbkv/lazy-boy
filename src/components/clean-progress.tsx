"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  CLEAN_LS_KEY,
  clearCleanActive,
  readCleanActive,
} from "@/lib/clean-progress";
import type { Task } from "@/lib/tasks/registry";

type ReconcileResult = { changed: boolean; name: string; added: number; removed: number };

// Mounted once in the (app) layout so it survives navigation. After a clean, Phase 1
// has already created the cleaned playlist (the user got a toast for it); this watches
// the background Phase-2 reconcile and only speaks up if the refresh actually adjusted
// the result. A small "Tidying up…" pill shows while it runs.
export function CleanProgressWatcher() {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    function stop() {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
      setActive(false);
    }

    async function tick() {
      const a = readCleanActive();
      if (!a) {
        stop();
        return;
      }
      const res = await fetch(`/api/tasks/${a.taskId}`).catch(() => null);
      if (!res) return; // transient blip — keep polling
      if (res.status === 404) {
        clearCleanActive();
        stop();
        return;
      }
      if (!res.ok) return;

      const task = (await res.json()) as Task<ReconcileResult>;
      if (task.status === "done") {
        const r = task.result;
        if (r?.changed) {
          toast.success(`Tidied "${r.name}" after refresh — added ${r.added}, removed ${r.removed}`);
        }
        clearCleanActive();
        stop();
      } else if (task.status === "error") {
        // Phase 1 already succeeded; a failed background reconcile just means the
        // cleaned playlist may be a touch stale. Don't alarm the user.
        clearCleanActive();
        stop();
      }
    }

    function ensureRunning() {
      if (readCleanActive() && !timer.current) {
        setActive(true);
        tick();
        timer.current = setInterval(tick, 1000);
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

  if (!active) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[4.5rem] z-30 mx-auto flex max-w-5xl justify-end px-4 sm:px-6">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow-lg ring-1 ring-white/5 backdrop-blur">
        <Loader2 className="size-3.5 animate-spin" />
        Tidying up…
      </div>
    </div>
  );
}
