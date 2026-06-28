"use client";

import { useState } from "react";
import { Diff, Eraser, GitMerge, ListPlus, Play, Search } from "lucide-react";
import { saveQueueAction } from "@/app/(app)/actions";
import { ActionButton } from "@/components/action-button";
import { CleanPanel } from "@/components/clean-panel";
import { FindPanel } from "@/components/find-panel";
import { HoverTip } from "@/components/hover-tip";
import { MergePanel } from "@/components/merge-panel";
import { ResumePanel } from "@/components/resume-panel";
import { SubtractPanel } from "@/components/subtract-panel";
import { PlaylistsSync } from "@/components/playlists-sync";
import { Button } from "@/components/ui/button";

type Playlist = {
  id: string;
  name: string;
  trackCount: number;
  image: string | null;
  mine?: boolean;
};

// Action-pill style: roomy, with a clear hover lift + accent so it reads as a
// real button, not a faint chip.
const CHIP =
  "h-10 gap-2 rounded-full border-border bg-card px-4 text-sm font-medium transition-all hover:-translate-y-0.5 hover:border-white/40 hover:bg-accent hover:text-foreground hover:shadow-md hover:shadow-black/20";

// Muted, subdued hover hint for the action pills — appears after a beat so it only
// shows up while you're weighing what to do. Copy is intentionally short; tweak freely.
const TIP =
  "max-w-[15rem] rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-xs leading-snug text-muted-foreground shadow-lg ring-1 ring-white/5";

const SAVE_QUEUE_HINT =
  "Skips through your queue to log each track, saves them to a new playlist, then drops you back where you were.";
const MERGE_HINT =
  "Combines the playlists you pick into one new playlist, kept in the order you choose them.";
const RESUME_HINT =
  "Resumes a playlist on your active device from the song right after the last one you played from it.";
const CLEAN_HINT =
  "Find a playlist and strip out songs already in your library. The original stays put; a new “Cleaned: …” playlist holds the rest.";
const FIND_HINT =
  "Look up any song that's in one of your playlists and see when you last listened to it — a quick reference without digging through History.";
const SUBTRACT_HINT =
  "Set difference between playlists: pick a base and subtract others to see which of its songs are unique vs. shared — then save the difference or strip the shared songs out.";

// The quick-action toolbar + the panel each one opens. Lives on Home so the actions are
// reachable the moment the app opens. Only one panel is open at a time — opening one
// replaces whatever was open.
export function QuickActions({
  playlists,
  backupPref,
  syncedAt,
}: {
  playlists: Playlist[];
  backupPref: boolean;
  syncedAt: string | null;
}) {
  const [openPanel, setOpenPanel] = useState<
    null | "resume" | "clean" | "find" | "merge" | "subtract"
  >(null);
  const toggle = (p: "resume" | "clean" | "find" | "merge" | "subtract") =>
    setOpenPanel((o) => (o === p ? null : p));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2.5">
        <HoverTip label={RESUME_HINT} delay={500} placement="bottom" tipClassName={TIP} className="inline-flex">
          <Button
            variant="outline"
            className={CHIP + (openPanel === "resume" ? " border-white/70 bg-white/15 text-foreground ring-1 ring-inset ring-white/20" : "")}
            aria-expanded={openPanel === "resume"}
            onClick={() => toggle("resume")}
          >
            <Play className="size-4 text-foreground" />
            Resume
          </Button>
        </HoverTip>
        <HoverTip label={CLEAN_HINT} delay={500} placement="bottom" tipClassName={TIP} className="inline-flex">
          <Button
            variant="outline"
            className={CHIP + (openPanel === "clean" ? " border-white/70 bg-white/15 text-foreground ring-1 ring-inset ring-white/20" : "")}
            aria-expanded={openPanel === "clean"}
            onClick={() => toggle("clean")}
          >
            <Eraser className="size-4 text-foreground" />
            Clean playlist
          </Button>
        </HoverTip>
        <HoverTip label={FIND_HINT} delay={500} placement="bottom" tipClassName={TIP} className="inline-flex">
          <Button
            variant="outline"
            className={CHIP + (openPanel === "find" ? " border-white/70 bg-white/15 text-foreground ring-1 ring-inset ring-white/20" : "")}
            aria-expanded={openPanel === "find"}
            onClick={() => toggle("find")}
          >
            <Search className="size-4 text-foreground" />
            Find
          </Button>
        </HoverTip>
        <HoverTip label={SAVE_QUEUE_HINT} delay={500} placement="bottom" tipClassName={TIP} className="inline-flex">
          <ActionButton
            action={saveQueueAction}
            pendingText="Saving…"
            success={(r) => `Saved to "${r.name}"`}
            variant="outline"
            className={CHIP}
          >
            <ListPlus className="size-4 text-foreground" />
            Save queue
          </ActionButton>
        </HoverTip>
        <HoverTip label={MERGE_HINT} delay={500} placement="bottom" tipClassName={TIP} className="inline-flex">
          <Button
            variant="outline"
            className={CHIP + (openPanel === "merge" ? " border-white/70 bg-white/15 text-foreground ring-1 ring-inset ring-white/20" : "")}
            aria-expanded={openPanel === "merge"}
            onClick={() => toggle("merge")}
          >
            <GitMerge className="size-4 text-foreground" />
            Merge
          </Button>
        </HoverTip>
        <HoverTip label={SUBTRACT_HINT} delay={500} placement="bottom" tipClassName={TIP} className="inline-flex">
          <Button
            variant="outline"
            className={CHIP + (openPanel === "subtract" ? " border-white/70 bg-white/15 text-foreground ring-1 ring-inset ring-white/20" : "")}
            aria-expanded={openPanel === "subtract"}
            onClick={() => toggle("subtract")}
          >
            <Diff className="size-4 text-foreground" />
            Subtract
          </Button>
        </HoverTip>

        {/* Headless: kicks the background library scan when stale, renders nothing. */}
        <PlaylistsSync syncedAt={syncedAt} />
      </div>

      {openPanel === "resume" ? (
        <div className="max-w-lg">
          <ResumePanel playlists={playlists} />
        </div>
      ) : null}

      {openPanel === "clean" ? (
        <div className="max-w-lg">
          <CleanPanel playlists={playlists} initialBackup={backupPref} />
        </div>
      ) : null}

      {openPanel === "find" ? (
        <div className="max-w-lg">
          <FindPanel />
        </div>
      ) : null}

      {openPanel === "merge" ? (
        <div className="max-w-lg">
          <MergePanel playlists={playlists} total={playlists.length} loadingMore={false} />
        </div>
      ) : null}

      {openPanel === "subtract" ? (
        // Wider than the other panels: the result renders in a second card beside the
        // picker (the panel lays the two out as an equal two-column grid).
        <div className="max-w-4xl">
          <SubtractPanel playlists={playlists} />
        </div>
      ) : null}
    </div>
  );
}
