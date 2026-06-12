"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { Brush, Play, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  deletePlaylistAction,
  playPlaylistAction,
  startCleanAction,
} from "@/app/(app)/actions";
import { writeCleanActive } from "@/lib/clean-progress";

// Right-click menu for a playlist tile. Custom (not Base UI) so it's reliable, mirroring
// TrackContextMenu's positioning. Order: Play, Clean, Delete. Delete asks for an in-menu
// confirm before it fires.
export function PlaylistContextMenu({
  playlist,
  x,
  y,
  onClose,
  onDeleted,
}: {
  playlist: { id: string; name: string };
  x: number;
  y: number;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [pending, start] = useTransition();

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Arm the dismiss listeners on the next frame so the trailing events of the
    // right-click that opened the menu (mouseup/contextmenu) don't instantly close it.
    const raf = requestAnimationFrame(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
      window.addEventListener("keydown", onKey);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function play() {
    onClose();
    start(async () => {
      // No success toast — the music starting on the device is obvious enough.
      const r = await playPlaylistAction(playlist.id);
      if (!r.ok) toast.error(r.error);
    });
  }

  function clean() {
    onClose();
    start(async () => {
      const r = await startCleanAction(playlist.id); // backup uses the global preference
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.unique) {
        toast.success("This playlist is unique");
        return;
      }
      toast.success(`Created "${r.name}" — kept ${r.kept}, removed ${r.removed}`);
      if (r.taskId) writeCleanActive({ taskId: r.taskId, playlistId: playlist.id });
    });
  }

  // Delete is destructive and sits one row under Clean — require a second click.
  // First click arms the row ("Delete?"); the second actually fires.
  const [confirming, setConfirming] = useState(false);

  function del() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    onClose();
    start(async () => {
      const r = await deletePlaylistAction(playlist.id);
      if (r.ok) {
        // If it was already gone (stale index), remove it silently — no toast.
        // Otherwise a plain "Deleted"; the tile vanishing makes it clear which one.
        if (!r.alreadyGone) toast.success("Deleted");
        onDeleted(playlist.id);
      } else {
        toast.error(r.error);
      }
    });
  }

  // Keep the menu fully on-screen (measure real size, nudge inward before paint).
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
      className="fixed z-50 w-max min-w-44 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border bg-popover p-1 text-sm shadow-2xl shadow-black/50 ring-1 ring-white/5"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Item icon={<Play className="size-4" />} label="Play" disabled={pending} onClick={play} />
      <Item icon={<Brush className="size-4" />} label="Clean" disabled={pending} onClick={clean} />
      <Item
        icon={<Trash2 className="size-4" />}
        label={confirming ? "Delete? Click again" : "Delete"}
        danger={confirming}
        disabled={pending}
        onClick={del}
      />
    </div>
  );
}

function Item({
  icon,
  label,
  onClick,
  disabled,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        "flex w-full items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent disabled:opacity-50" +
        (danger ? " text-red-400" : " text-foreground")
      }
    >
      <span className={danger ? "text-red-400" : "text-muted-foreground"}>{icon}</span>
      {label}
    </button>
  );
}
