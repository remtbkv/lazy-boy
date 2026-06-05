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
import { toast } from "sonner";
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
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  function play() {
    onClose();
    start(async () => {
      const r = await playPlaylistAction(playlist.id);
      if (r.ok) toast.success(`Playing "${playlist.name}"`);
      else toast.error(r.error);
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
      toast.success(`Created "${r.name}" — kept ${r.kept}, removed ${r.removed}`);
      writeCleanActive({ taskId: r.taskId, playlistId: playlist.id });
    });
  }

  function del() {
    onClose();
    start(async () => {
      const r = await deletePlaylistAction(playlist.id);
      if (r.ok) {
        toast.success(`Deleted "${playlist.name}"`);
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
  }, [x, y, confirmDelete]);

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
      {confirmDelete ? (
        <div className="w-56 p-2">
          <p className="px-1 pb-2 text-sm">
            Delete <span className="font-medium">{playlist.name}</span>?
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={del}
              className="flex-1 rounded-md bg-red-600/90 px-2.5 py-1.5 text-center font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="flex-1 rounded-md border border-border px-2.5 py-1.5 text-center transition-colors hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <Item icon={<Play className="size-4" />} label="Play" disabled={pending} onClick={play} />
          <Item icon={<Brush className="size-4" />} label="Clean" disabled={pending} onClick={clean} />
          <Item
            icon={<Trash2 className="size-4" />}
            label="Delete"
            disabled={pending}
            onClick={() => setConfirmDelete(true)}
          />
        </>
      )}
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
      className="flex w-full items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-left text-foreground transition-colors hover:bg-accent disabled:opacity-50"
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
    </button>
  );
}
