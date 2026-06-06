"use client";

import { useState } from "react";
import { Brush, GitMerge, ListPlus, Play, Search } from "lucide-react";
import { saveQueueAction } from "@/app/(app)/actions";
import { ActionButton } from "@/components/action-button";
import { CleanPanel } from "@/components/clean-panel";
import { FindPanel } from "@/components/find-panel";
import { HoverTip } from "@/components/hover-tip";
import { MergePanel } from "@/components/merge-panel";
import { ResumePanel } from "@/components/resume-panel";
import { PlaylistGrid } from "@/components/playlist-grid";
import { PlaylistsSync } from "@/components/playlists-sync";
import { Button } from "@/components/ui/button";

export type PlaylistItem = {
  id: string;
  name: string;
  image: string | null;
  trackCount: number;
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

// Renders the persisted library instantly. A background sync (PlaylistsSync)
// refreshes the store when it's stale, then the server data is revalidated —
// no per-load pagination waterfall against Spotify.
export function PlaylistsClient({
  initialItems,
  syncedAt,
  backupPref,
}: {
  initialItems: PlaylistItem[];
  syncedAt: string | null;
  backupPref: boolean;
}) {
  const items = initialItems;
  const total = items.length;
  // Only one quick-action panel open at a time — opening one replaces the other.
  const [openPanel, setOpenPanel] = useState<null | "resume" | "clean" | "find" | "merge">(null);
  const toggle = (p: "resume" | "clean" | "find" | "merge") =>
    setOpenPanel((o) => (o === p ? null : p));

  return (
    <div className="space-y-6">
      {/* Compact, extensible action toolbar. Each action is a pill — add more by
          dropping another button in. Full explanations live on the Home page. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <HoverTip
          label={RESUME_HINT}
          delay={500}
          placement="bottom"
          tipClassName={TIP}
          className="inline-flex"
        >
          <Button
            variant="outline"
            className={
              CHIP + (openPanel === "resume" ? " border-white/50 bg-accent text-foreground" : "")
            }
            aria-expanded={openPanel === "resume"}
            onClick={() => toggle("resume")}
          >
            <Play className="size-4 text-foreground" />
            Resume
          </Button>
        </HoverTip>
        <HoverTip
          label={CLEAN_HINT}
          delay={500}
          placement="bottom"
          tipClassName={TIP}
          className="inline-flex"
        >
          <Button
            variant="outline"
            className={
              CHIP + (openPanel === "clean" ? " border-white/50 bg-accent text-foreground" : "")
            }
            aria-expanded={openPanel === "clean"}
            onClick={() => toggle("clean")}
          >
            <Brush className="size-4 text-foreground" />
            Clean playlist
          </Button>
        </HoverTip>
        <HoverTip
          label={FIND_HINT}
          delay={500}
          placement="bottom"
          tipClassName={TIP}
          className="inline-flex"
        >
          <Button
            variant="outline"
            className={
              CHIP + (openPanel === "find" ? " border-white/50 bg-accent text-foreground" : "")
            }
            aria-expanded={openPanel === "find"}
            onClick={() => toggle("find")}
          >
            <Search className="size-4 text-foreground" />
            Find
          </Button>
        </HoverTip>
        <HoverTip
          label={SAVE_QUEUE_HINT}
          delay={500}
          placement="bottom"
          tipClassName={TIP}
          className="inline-flex"
        >
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
        <HoverTip
          label={MERGE_HINT}
          delay={500}
          placement="bottom"
          tipClassName={TIP}
          className="inline-flex"
        >
          <Button
            variant="outline"
            className={
              CHIP +
              (openPanel === "merge" ? " border-white/50 bg-accent text-foreground" : "")
            }
            aria-expanded={openPanel === "merge"}
            onClick={() => toggle("merge")}
          >
            <GitMerge className="size-4 text-foreground" />
            Merge
          </Button>
        </HoverTip>
        <PlaylistsSync syncedAt={syncedAt} />
      </div>

      {openPanel === "resume" ? (
        <div className="max-w-lg">
          <ResumePanel
            playlists={items.map((p) => ({
              id: p.id,
              name: p.name,
              trackCount: p.trackCount,
            }))}
          />
        </div>
      ) : null}

      {openPanel === "clean" ? (
        <div className="max-w-lg">
          <CleanPanel
            playlists={items.map((p) => ({
              id: p.id,
              name: p.name,
              trackCount: p.trackCount,
            }))}
            initialBackup={backupPref}
          />
        </div>
      ) : null}

      {openPanel === "find" ? (
        <div className="max-w-lg">
          <FindPanel />
        </div>
      ) : null}

      {openPanel === "merge" ? (
        <div className="max-w-lg">
          <MergePanel
            playlists={items.map((p) => ({
              id: p.id,
              name: p.name,
              trackCount: p.trackCount,
            }))}
            total={total}
            loadingMore={false}
          />
        </div>
      ) : null}

      <PlaylistGrid playlists={items} total={total} loadingMore={false} />
    </div>
  );
}
