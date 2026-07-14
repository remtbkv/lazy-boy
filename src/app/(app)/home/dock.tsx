"use client";

import { useEffect, useState } from "react";
import { Diff, Eraser, GitMerge, ListPlus, Play, Search, X } from "lucide-react";
import { saveQueueAction } from "@/app/(app)/actions";
import { ActionButton } from "@/components/action-button";
import { CleanPanel } from "@/components/clean-panel";
import { FindPanel } from "@/components/find-panel";
import { MergePanel } from "@/components/merge-panel";
import { PlaylistsSync } from "@/components/playlists-sync";
import { ResumePanel } from "@/components/resume-panel";
import { SubtractPanel } from "@/components/subtract-panel";
import type { DockData } from "../history-actions";
import { cn } from "@/lib/utils";

type PanelKey = "resume" | "clean" | "find" | "merge" | "subtract";

// The dock is the design; the PANELS are the app. Each button opens the same panel the old
// toolbar did — these are the real Spotify flows (progress, confirmation, backups), not a
// picker. Save queue has no panel: it's one action, so the button just runs it.
//
// Subtract renders a result card beside its picker, so it needs a much wider shell than the
// others — hence the per-action width.
const ACTIONS: {
  key: PanelKey | "queue";
  label: string;
  icon: typeof Play;
  width?: string;
}[] = [
  { key: "resume", label: "Resume", icon: Play, width: "max-w-lg" },
  { key: "clean", label: "Clean", icon: Eraser, width: "max-w-lg" },
  { key: "find", label: "Find", icon: Search, width: "max-w-lg" },
  { key: "queue", label: "Save queue", icon: ListPlus },
  { key: "merge", label: "Merge", icon: GitMerge, width: "max-w-lg" },
  { key: "subtract", label: "Subtract", icon: Diff, width: "max-w-4xl" },
];

// gap-2 (in the parents below) mirrors the spacing between the day-by-day cards.
const PILL =
  "flex h-10 items-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-medium text-foreground/90 transition-colors hover:border-[color-mix(in_srgb,var(--border)_55%,var(--muted-foreground))] hover:bg-accent";
const TILE =
  "flex h-[64px] flex-col items-center justify-center gap-1.5 rounded-xl border border-border/70 bg-card text-[12px] font-medium text-foreground/90 transition-colors active:bg-accent";

// The action dock. Desktop: a quiet row of pills. Mobile: a grid of tiles sized for thumbs.
export function ActionDock({ playlists, backupPref, syncedAt }: DockData) {
  const [open, setOpen] = useState<PanelKey | null>(null);
  const action = ACTIONS.find((a) => a.key === open) ?? null;

  return (
    <>
      <div className="grid grid-cols-3 gap-2 sm:hidden">
        {ACTIONS.map((a) =>
          a.key === "queue" ? (
            <ActionButton
              key={a.key}
              action={saveQueueAction}
              pendingText="Saving…"
              success={(r) => `Saved to "${r.name}"`}
              variant="outline"
              className={TILE}
            >
              <a.icon className="size-[18px] text-muted-foreground" strokeWidth={1.9} />
              {a.label}
            </ActionButton>
          ) : (
            <button key={a.key} type="button" onClick={() => setOpen(a.key as PanelKey)} className={TILE}>
              <a.icon className="size-[18px] text-muted-foreground" strokeWidth={1.9} />
              {a.label}
            </button>
          ),
        )}
      </div>

      <div className="hidden flex-wrap items-center gap-2 sm:flex">
        {ACTIONS.map((a) =>
          a.key === "queue" ? (
            <ActionButton
              key={a.key}
              action={saveQueueAction}
              pendingText="Saving…"
              success={(r) => `Saved to "${r.name}"`}
              variant="outline"
              className={PILL}
            >
              <a.icon className="size-4" strokeWidth={1.9} />
              {a.label}
            </ActionButton>
          ) : (
            <button key={a.key} type="button" onClick={() => setOpen(a.key as PanelKey)} className={PILL}>
              <a.icon className="size-4" strokeWidth={1.9} />
              {a.label}
            </button>
          ),
        )}
      </div>

      {/* Headless: kicks the background library scan when the cache is stale, renders nothing. */}
      <PlaylistsSync syncedAt={syncedAt} />

      {action && open ? (
        <PanelShell width={action.width ?? "max-w-lg"} onClose={() => setOpen(null)}>
          {open === "resume" ? <ResumePanel playlists={playlists} /> : null}
          {open === "clean" ? <CleanPanel playlists={playlists} initialBackup={backupPref} /> : null}
          {open === "find" ? <FindPanel /> : null}
          {open === "merge" ? (
            <MergePanel playlists={playlists} total={playlists.length} loadingMore={false} />
          ) : null}
          {open === "subtract" ? <SubtractPanel playlists={playlists} /> : null}
        </PanelShell>
      ) : null}
    </>
  );
}

// Home is a locked viewport (the song list scrolls inside it), so a panel can't open inline
// the way it used to — it would have nowhere to grow. It opens over the page instead: a
// bottom sheet on mobile, a centered dialog on desktop. The panels bring their own titles,
// so this adds only a scrim and a way out.
function PanelShell({
  width,
  onClose,
  children,
}: {
  width: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="den-scrim absolute inset-0 bg-black/55"
      />
      <div role="dialog" aria-modal className={cn("relative w-full", width)}>
        {/* Sits ABOVE the card, on the scrim. The panels put their own controls in the
            top-right corner (Clean's "Sync backend"), so a close button inside the card
            would land on top of them — and it can't live inside the scrolling box anyway,
            which would clip it. */}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute -top-11 right-0 flex size-9 items-center justify-center rounded-full bg-white/10 text-white/80 backdrop-blur transition-colors hover:bg-white/20 hover:text-white"
        >
          <X className="size-4" />
        </button>
        <div className="den-sheet max-h-[85dvh] overflow-y-auto pb-[env(safe-area-inset-bottom)] sm:max-h-[85vh]">
          {children}
        </div>
      </div>
    </div>
  );
}
