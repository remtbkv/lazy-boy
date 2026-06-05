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
  const [mergeOpen, setMergeOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);

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
              CHIP + (resumeOpen ? " border-white/50 bg-accent text-foreground" : "")
            }
            aria-expanded={resumeOpen}
            onClick={() => setResumeOpen((o) => !o)}
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
              CHIP + (cleanOpen ? " border-white/50 bg-accent text-foreground" : "")
            }
            aria-expanded={cleanOpen}
            onClick={() => setCleanOpen((o) => !o)}
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
              CHIP + (findOpen ? " border-white/50 bg-accent text-foreground" : "")
            }
            aria-expanded={findOpen}
            onClick={() => setFindOpen((o) => !o)}
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
            success={(r) => `Saved ${r.count} to "${r.name}"`}
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
              (mergeOpen ? " border-white/50 bg-accent text-foreground" : "")
            }
            aria-expanded={mergeOpen}
            onClick={() => setMergeOpen((o) => !o)}
          >
            <GitMerge className="size-4 text-foreground" />
            Merge
          </Button>
        </HoverTip>
        <PlaylistsSync syncedAt={syncedAt} />
      </div>

      {resumeOpen ? (
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

      {cleanOpen ? (
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

      {findOpen ? (
        <div className="max-w-lg">
          <FindPanel />
        </div>
      ) : null}

      {mergeOpen ? (
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
