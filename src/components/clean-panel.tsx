"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Brush, RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  setCleanBackupAction,
  startCleanAction,
  startSyncAction,
} from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { HoverTip } from "@/components/hover-tip";
import { writeCleanActive } from "@/lib/clean-progress";
import { fuzzyFilter } from "@/lib/filter";

type Item = { id: string; name: string; trackCount: number };

// localStorage key for the in-flight backend sync, so its progress survives a reload
// and reappears when you reopen this panel.
const SYNC_LS_KEY = "sync:active";

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

  // Backend sync (background task) — id persisted in localStorage so a refresh or a
  // panel close/reopen keeps showing live progress.
  const [syncTaskId, setSyncTaskId] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ processed: number; total: number } | null>(null);

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
      if (r.unique) {
        toast.success("This playlist is unique");
        return;
      }
      toast.success(`Created "${r.name}" — kept ${r.kept}, removed ${r.removed}`);
      if (r.taskId) writeCleanActive({ taskId: r.taskId, playlistId: p.id });
    });
  }

  // Pick up an in-flight sync on mount (survives reload). Deferred so it isn't a
  // synchronous setState in the effect body, and so localStorage is only read client-side.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const id = localStorage.getItem(SYNC_LS_KEY);
      if (id) setSyncTaskId(id);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Poll the sync task while one is active.
  useEffect(() => {
    if (!syncTaskId) return;
    let stopped = false;
    const finish = (msg?: () => void) => {
      localStorage.removeItem(SYNC_LS_KEY);
      setSyncTaskId(null);
      setSyncProgress(null);
      msg?.();
    };
    const tick = async () => {
      const res = await fetch(`/api/tasks/${syncTaskId}`).catch(() => null);
      if (!res || stopped) return;
      if (res.status === 404) return finish();
      if (!res.ok) return;
      const task = (await res.json()) as {
        status: string;
        processed: number;
        total: number;
        error?: string;
      };
      setSyncProgress({ processed: task.processed ?? 0, total: task.total ?? 0 });
      if (task.status === "done") finish(() => toast.success("Synced"));
      else if (task.status === "error") finish(() => toast.error(task.error ?? "Sync failed"));
    };
    void tick();
    const iv = setInterval(tick, 1000);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [syncTaskId]);

  async function startSync() {
    const r = await startSyncAction();
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    localStorage.setItem(SYNC_LS_KEY, r.taskId);
    setSyncProgress({ processed: 0, total: 0 });
    setSyncTaskId(r.taskId);
  }

  const syncing = !!syncTaskId;
  const syncLabel =
    syncing && syncProgress && syncProgress.total > 0
      ? `${syncProgress.processed.toLocaleString()} / ${syncProgress.total.toLocaleString()}`
      : syncing
        ? "Syncing…"
        : "Sync backend";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Clean a playlist</CardTitle>
        <CardDescription>
          Find a playlist and remove songs you&apos;ve already saved elsewhere into a new
          &quot;Cleaned: …&quot; playlist. The original is left untouched.
        </CardDescription>
        <CardAction>
          <HoverTip
            label="Re-scans your entire library to update the backend so playlist cleans can be done quickly. Syncs every hour but if you recently altered playlists, run this sync again."
            delay={500}
            placement="bottom"
            tipClassName="max-w-[15rem] rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-xs leading-snug text-muted-foreground shadow-lg ring-1 ring-white/5"
            className="inline-flex"
          >
            <Button
              variant="outline"
              onClick={startSync}
              disabled={syncing}
              className="h-7 gap-1.5 rounded-md border-white/15 px-2.5 text-xs font-normal text-muted-foreground hover:border-white/30 hover:text-foreground"
            >
              <RefreshCw className={"size-3.5" + (syncing ? " animate-spin" : "")} />
              {syncLabel}
            </Button>
          </HoverTip>
        </CardAction>
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

        {/* Sizes to its content — a couple of matches stays small — and caps at ~4 rows,
            scrolling (thin bar) for the rest so the card stays compact. */}
        <div className="thin-scroll max-h-40 overflow-y-auto rounded-md border border-border">
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
        </div>
      </CardContent>
    </Card>
  );
}
