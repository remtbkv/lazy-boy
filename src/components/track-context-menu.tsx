"use client";

import { useEffect, useTransition, type ReactNode } from "react";
import { CircleMinus, Heart, ListPlus, Share2 } from "lucide-react";
import { toast } from "sonner";
import {
  addToQueueAction,
  removeFromPlaylistAction,
  saveToLikedAction,
} from "@/app/(app)/actions";
import type { Track } from "@/lib/spotify";

// A lightweight right-click menu for a track — custom (not Base UI) so it's
// reliable. Positioned at the cursor and clamped to the viewport. Mirrors the
// useful slice of Spotify's own track menu.
export function TrackContextMenu({
  track,
  x,
  y,
  onClose,
  playlistId,
  onRemoved,
}: {
  track: Track;
  x: number;
  y: number;
  onClose: () => void;
  // When set (the track lives in one of the user's own playlists), the menu
  // offers "Remove from this playlist".
  playlistId?: string;
  onRemoved?: (track: Track) => void;
}) {
  const [pending, start] = useTransition();

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    okMessage: string,
    onOk?: () => void,
  ) {
    onClose();
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(okMessage);
        onOk?.();
      } else {
        toast.error(r.error ?? "Something went wrong");
      }
    });
  }

  function share() {
    const url = `https://open.spotify.com/track/${track.id}`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success("Link copied"))
      .catch(() => toast.error("Couldn't copy link"));
    onClose();
  }

  const left = Math.min(x, window.innerWidth - 234);
  const top = Math.min(y, window.innerHeight - 180);

  return (
    <div
      className="fixed z-50 w-56 overflow-hidden rounded-lg border border-border bg-popover p-1 text-sm shadow-2xl shadow-black/50 ring-1 ring-white/5"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {playlistId ? (
        <Item
          icon={<CircleMinus className="size-4" />}
          label="Remove from playlist"
          disabled={pending}
          onClick={() =>
            run(
              () => removeFromPlaylistAction(playlistId, track.uri),
              "Removed from playlist",
              () => onRemoved?.(track),
            )
          }
        />
      ) : null}
      <Item
        icon={<Heart className="size-4" />}
        label="Save to Liked Songs"
        disabled={pending}
        onClick={() => run(() => saveToLikedAction(track.id), "Saved to Liked Songs")}
      />
      <Item
        icon={<ListPlus className="size-4" />}
        label="Add to queue"
        disabled={pending}
        onClick={() => run(() => addToQueueAction(track.uri), "Added to queue")}
      />
      <Item icon={<Share2 className="size-4" />} label="Share" onClick={share} />
    </div>
  );
}

function Item({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-foreground transition-colors hover:bg-accent disabled:opacity-50"
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
    </button>
  );
}
