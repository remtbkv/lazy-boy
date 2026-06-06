"use client";

import { useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { CircleMinus, CirclePlus, ListPlus } from "lucide-react";
import { toast } from "@/lib/toast";
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

  // Keep the menu fully on-screen by measuring its real size (it sizes to its content,
  // so this stays correct no matter what the labels are) and nudging it inward from the
  // cursor if it would overflow. useLayoutEffect runs before paint, so there's no flash.
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      left: Math.max(pad, Math.min(x, window.innerWidth - r.width - pad)),
      top: Math.max(pad, Math.min(y, window.innerHeight - r.height - pad)),
    });
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="fixed z-50 w-max max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border bg-popover p-1 text-sm shadow-2xl shadow-black/50 ring-1 ring-white/5"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Item
        icon={<ListPlus className="size-4" />}
        label="Add to queue"
        disabled={pending}
        onClick={() => run(() => addToQueueAction(track.uri), "Added to queue")}
      />
      <Item
        icon={<CirclePlus className="size-4" />}
        label="Save to Liked Songs"
        disabled={pending}
        onClick={() => run(() => saveToLikedAction(track.id), "Saved to Liked Songs")}
      />
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
      <Item icon={<ShareIcon />} label="Share" onClick={share} />
    </div>
  );
}

// lucide's `Share` with a shorter arrow — its shaft (v13) pokes too far down vs
// Spotify's; trimmed to v9 so the arrow sits cleanly above the box. Same 24×24 grid and
// stroke conventions as the other lucide icons here.
function ShareIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden
    >
      <path d="M8 9H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-2" />
      <path d="m8 6 4-4 4 4" />
      <path d="M12 2v11" />
    </svg>
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
      className="flex w-full items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-left text-foreground transition-colors hover:bg-accent disabled:opacity-50"
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
    </button>
  );
}
