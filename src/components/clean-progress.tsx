"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { cleanActiveKey, clearCleanActive, readCleanActive } from "@/lib/clean-progress";
import { exitDone, originFrom, type Point } from "@/lib/dock-motion";
import type { Task } from "@/lib/tasks/registry";
import { clearIfSignedOut } from "@/lib/user-storage";
import { useUid } from "@/components/user-context";
import { cn } from "@/lib/utils";

type ReconcileResult = { changed: boolean; name: string; added: number; removed: number };

// Mounted once in the (app) layout so it survives navigation. After a clean, Phase 1
// has already created the cleaned playlist (the user got a toast for it); this watches
// the background Phase-2 reconcile and only speaks up if the refresh actually adjusted
// the result. A small "Tidying up…" pill shows while it runs: it grows out of the dock pill the
// clean was started from and fades back out when the reconcile ends (den.css, "The dock's
// motion"), where it used to appear and vanish in one frame.
export function CleanProgressWatcher() {
  const uid = useUid();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const misses = useRef(0);
  const [active, setActive] = useState(false);
  // Mounted while active and through its exit after; `from` is the dock pill (clean:active's detail).
  const [shown, setShown] = useState(false);
  const from = useRef<Point | null>(null);
  const pill = useRef<HTMLDivElement>(null);
  if (active && !shown) setShown(true);

  useEffect(() => {
    // One tick at a time: a response slower than the 1s interval would otherwise
    // overlap the next tick and both could see "done" → duplicate success toasts.
    let inFlight = false;

    function stop() {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
      // Fresh miss budget for the NEXT clean: the component never unmounts, so a counter
      // left at 3 made the next clean's first cross-instance 404 clear it instantly —
      // reintroducing the bug the counter fixed (wave-3 adversarial review, H1).
      misses.current = 0;
      setActive(false);
    }

    async function tick() {
      if (inFlight) return;
      inFlight = true;
      try {
        await poll();
      } finally {
        inFlight = false;
      }
    }

    async function poll() {
      const a = readCleanActive(uid);
      if (!a) {
        stop();
        return;
      }
      const res = await fetch(`/api/tasks/${a.taskId}`).catch(() => null);
      if (!res) return; // transient blip — keep polling
      clearIfSignedOut(res, uid);
      if (res.status === 404) {
        // The task registry is per-instance on serverless: a poll routed to another
        // instance 404s while the reconcile is running fine, and clearing on the first
        // miss dropped the pill and the completion toast (audit 2026-08-19 wave 2, E1).
        // Only three consecutive misses (≈ the task genuinely gone or swept) clear it.
        misses.current += 1;
        if (misses.current >= 3) {
          clearCleanActive(uid);
          stop();
        }
        return;
      }
      misses.current = 0;
      if (!res.ok) return;

      const task = (await res.json()) as Task<ReconcileResult>;
      if (task.status === "done") {
        const r = task.result;
        if (r?.changed) {
          toast.success(`Tidied "${r.name}" after refresh — added ${r.added}, removed ${r.removed}`);
        }
        clearCleanActive(uid);
        stop();
      } else if (task.status === "error") {
        // Phase 1 already succeeded, but a failed reconcile can leave the cleaned playlist
        // stale or its backup half-rewritten (replaceItems clears before it refills), so
        // say so instead of failing silently (burn lazyboy-review, L1).
        toast.error(
          `Couldn't finish tidying the cleaned playlist after refresh${task.error ? ` (${task.error})` : ""} — check it and its backup.`,
        );
        clearCleanActive(uid);
        stop();
      }
    }

    function ensureRunning() {
      if (readCleanActive(uid) && !timer.current) {
        setActive(true);
        tick();
        timer.current = setInterval(tick, 1000);
      }
    }

    ensureRunning();
    const onActive = (e: Event) => {
      from.current = (e as CustomEvent<Point | null>).detail ?? null;
      ensureRunning();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === cleanActiveKey(uid)) ensureRunning();
    };
    window.addEventListener("clean:active", onActive);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("clean:active", onActive);
      window.removeEventListener("storage", onStorage);
      stop();
    };
  }, [uid]);

  useLayoutEffect(() => {
    const el = pill.current;
    if (shown && el) el.style.transformOrigin = originFrom(from.current, el);
  }, [shown]);
  useEffect(() => {
    if (active || !shown) return;
    let live = true;
    exitDone(pill.current).then(() => live && setShown(false));
    return () => {
      live = false;
    };
  }, [active, shown]);

  if (!shown) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[4.5rem] z-30 mx-auto flex max-w-5xl justify-end px-4 sm:px-6">
      <div
        ref={pill}
        className={cn(
          "dock-surface pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow-lg ring-1 ring-white/5 backdrop-blur",
          !active && "dock-leaving",
        )}
      >
        <Loader2 className="size-3.5 animate-spin" />
        Tidying up…
      </div>
    </div>
  );
}
