"use client";

import { useEffect, useState } from "react";
import { Diff, Eraser, GitMerge, ListPlus, Play, X } from "lucide-react";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Playlist = { id: string; name: string; trackCount: number; image: string | null };

type ActionKey = "resume" | "clean" | "queue" | "merge" | "subtract";

// How each action picks playlists:
//   single  — exactly one (Resume, Clean)
//   ordered — several, and the CLICK ORDER matters (Merge) → numbered badges
//   subtract — two ordered groups (base + subtract), switched by a mode toggle
const ACTIONS: {
  key: ActionKey;
  label: string;
  icon: typeof Play;
  blurb: string;
  select: "single" | "ordered" | "subtract" | null;
}[] = [
  { key: "resume", label: "Resume", icon: Play, select: "single",
    blurb: "Pick a playlist and it starts from the song right after the last one you played from it." },
  { key: "clean", label: "Clean", icon: Eraser, select: "single",
    blurb: "Strips out songs already in your library. The original stays put; a new “Cleaned” playlist holds the rest." },
  { key: "queue", label: "Save queue", icon: ListPlus, select: null,
    blurb: "Logs your current queue into a new playlist, then drops you back where you were." },
  { key: "merge", label: "Merge", icon: GitMerge, select: "ordered",
    blurb: "Combines the playlists you pick into one, kept in the order you pick them." },
  { key: "subtract", label: "Subtract", icon: Diff, select: "subtract",
    blurb: "Pick base playlists, then the playlists to subtract from them — see which songs are unique vs. shared." },
];

const DRAFT_NOTE = "Draft preview — this action gets wired up when the design ships.";

// The action dock. Desktop: a quiet row of text buttons — hover reveals the surface
// (no standing chips). Mobile: a 3-wide grid of tiles sized for thumbs; tapping opens
// a bottom sheet with the action's description readable on touch.
export function ActionDock({ playlists }: { playlists: Playlist[] }) {
  const [open, setOpen] = useState<ActionKey | null>(null);
  const action = ACTIONS.find((a) => a.key === open) ?? null;

  const activate = (key: ActionKey) => setOpen(key);

  return (
    <>
      {/* Mobile tiles */}
      <div className="grid grid-cols-3 gap-2 sm:hidden">
        {ACTIONS.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={() => activate(a.key)}
            className="flex h-[64px] flex-col items-center justify-center gap-1.5 rounded-xl border border-border/70 bg-card text-[12px] font-medium text-foreground/90 transition-colors active:bg-accent"
          >
            <a.icon className="size-[18px] text-muted-foreground" strokeWidth={1.9} />
            {a.label}
          </button>
        ))}
      </div>

      {/* Desktop row */}
      {/* gap-2 mirrors the spacing between the day-by-day cards below. */}
      <div className="hidden flex-wrap items-center gap-2 sm:flex">
        {ACTIONS.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={() => activate(a.key)}
            className="flex h-10 items-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-medium text-foreground/90 transition-colors hover:border-[color-mix(in_srgb,var(--border)_55%,var(--muted-foreground))] hover:bg-accent"
          >
            <a.icon className="size-4" strokeWidth={1.9} />
            {a.label}
          </button>
        ))}
      </div>

      {action ? <ActionSheet action={action} playlists={playlists} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function ActionSheet({
  action,
  playlists,
  onClose,
}: {
  action: (typeof ACTIONS)[number];
  playlists: Playlist[];
  onClose: () => void;
}) {
  // Ordered selections. For "subtract" both lists are live and the toggle decides
  // which one a tap adds to; for everything else only `picked` is used.
  const [picked, setPicked] = useState<string[]>([]);
  const [others, setOthers] = useState<string[]>([]);
  const [group, setGroup] = useState<"base" | "subtract">("base");

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

  const tap = (id: string) => {
    if (action.select === "single") {
      setPicked((cur) => (cur[0] === id ? [] : [id]));
      return;
    }
    if (action.select === "ordered") {
      setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
      return;
    }
    // subtract: a tap toggles the playlist in the ACTIVE group; if it sits in the
    // other group it moves over instead of being in both.
    const [active, setActive, passive, setPassive] =
      group === "base"
        ? ([picked, setPicked, others, setOthers] as const)
        : ([others, setOthers, picked, setPicked] as const);
    if (active.includes(id)) {
      setActive(active.filter((x) => x !== id));
    } else {
      if (passive.includes(id)) setPassive(passive.filter((x) => x !== id));
      setActive([...active, id]);
    }
  };

  const ready =
    action.select === "single"
      ? picked.length === 1
      : action.select === "ordered"
        ? picked.length >= 2
        : action.select === "subtract"
          ? picked.length >= 1 && others.length >= 1
          : true;

  const confirm = () => {
    toast.success(DRAFT_NOTE);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="den-scrim absolute inset-0 bg-black/55"
      />
      <div
        role="dialog"
        aria-modal
        aria-label={action.label}
        className="den-sheet relative flex max-h-[78dvh] w-full flex-col rounded-t-2xl border border-border bg-popover pb-[env(safe-area-inset-bottom)] sm:max-h-[70vh] sm:max-w-md sm:rounded-2xl"
      >
        {/* Grab handle (mobile affordance) */}
        <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-border sm:hidden" />
        <div className="flex items-start justify-between gap-4 px-5 pt-4">
          <div>
            <h2 className="den-display text-lg">{action.label}</h2>
            <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{action.blurb}</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Subtract: which group the next tap goes to. */}
        {action.select === "subtract" ? (
          <div className="mx-5 mt-3 flex items-center gap-0.5 self-start rounded-xl border border-border bg-card p-1">
            {(
              [
                ["base", `Base${picked.length ? ` · ${picked.length}` : ""}`],
                ["subtract", `Subtract${others.length ? ` · ${others.length}` : ""}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setGroup(key)}
                aria-pressed={group === key}
                className={cn(
                  "h-8 rounded-lg px-3 text-[13px] font-medium transition-colors",
                  group === key ? "bg-secondary text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {action.select ? (
          <div className="thin-scroll mt-4 min-h-0 flex-1 overflow-y-auto border-t border-border/60">
            {/* The library streams in just after mount (see DockLoader), so on a very fast
                click it may not have landed yet. */}
            {playlists.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted-foreground">Loading your playlists…</p>
            ) : null}
            {playlists.map((p) => {
              const sel = action.select!; // narrowed by the outer conditional
              const baseIdx = picked.indexOf(p.id);
              const otherIdx = others.indexOf(p.id);
              const on = baseIdx >= 0 || otherIdx >= 0;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => tap(p.id)}
                  aria-pressed={on}
                  className={cn(
                    "flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors",
                    on ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
                  )}
                >
                  {p.image ? (
                    <img src={p.image} alt="" className="size-10 shrink-0 rounded-md object-cover" />
                  ) : (
                    <span className="size-10 shrink-0 rounded-md bg-secondary" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{p.name}</span>
                    <span className="block text-xs tabular-nums text-muted-foreground">
                      {p.trackCount} songs
                    </span>
                  </span>
                  <SelectionBadge action={sel} baseIdx={baseIdx} otherIdx={otherIdx} />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 border-t border-border/60" />
        )}

        <div className="flex items-center justify-between gap-2 px-5 py-4">
          {/* "Never mind, redo" — wipes the picks without closing. Only rendered once
              there's something to wipe. */}
          {picked.length || others.length ? (
            <button
              type="button"
              onClick={() => {
                setPicked([]);
                setOthers([]);
                setGroup("base");
              }}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Clear
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={confirm}
            disabled={!ready}
            className="h-10 rounded-lg bg-foreground px-5 text-sm font-semibold text-background transition-opacity disabled:opacity-40"
          >
            {action.label}
          </button>
        </div>
      </div>
    </div>
  );
}

// The right-edge selection marker per row:
//   single   — a filled dot (radio)
//   ordered  — the pick's ORDER NUMBER (1, 2, 3…)
//   subtract — the order number, tagged B (base) or S (subtract) by fill
function SelectionBadge({
  action,
  baseIdx,
  otherIdx,
}: {
  action: "single" | "ordered" | "subtract";
  baseIdx: number;
  otherIdx: number;
}) {
  const on = baseIdx >= 0 || otherIdx >= 0;
  if (action === "single") {
    return (
      <span
        className={cn(
          "size-[18px] shrink-0 rounded-full border transition-colors",
          on ? "border-[var(--bamboo)] bg-[var(--bamboo)]" : "border-border",
        )}
      />
    );
  }
  if (!on) {
    return <span className="size-[22px] shrink-0 rounded-full border border-border" />;
  }
  const isBase = baseIdx >= 0;
  const n = (isBase ? baseIdx : otherIdx) + 1;
  return (
    <span
      className={cn(
        "flex size-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums",
        isBase
          ? "bg-[var(--bamboo)] text-[#1c1a18]"
          : "border border-[var(--muted-foreground)] text-foreground",
      )}
    >
      {action === "subtract" ? (isBase ? `B${n}` : `S${n}`) : n}
    </span>
  );
}
