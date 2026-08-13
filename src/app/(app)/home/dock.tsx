"use client";

import { useEffect, useState, useTransition } from "react";
import { Diff, Eraser, GitMerge, ListPlus, Play, X } from "lucide-react";
import {
  mergeAction,
  resumePlaylistAction,
  saveCompareDiffAction,
  saveQueueAction,
  startCleanAction,
  subtractPreviewAction,
  type SubtractTrack,
} from "@/app/(app)/actions";
import { PlaylistsSync } from "@/components/playlists-sync";
import { writeCleanActive } from "@/lib/clean-progress";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { DockData } from "../history-actions";

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

// The action dock. Desktop: a quiet row of text buttons — hover reveals the surface
// (no standing chips). Mobile: a 3-wide grid of tiles sized for thumbs; tapping opens
// a bottom sheet with the action's description readable on touch.
export function ActionDock({ playlists, backupPref, syncedAt }: DockData) {
  const [open, setOpen] = useState<ActionKey | null>(null);
  const action = ACTIONS.find((a) => a.key === open) ?? null;

  const activate = (key: ActionKey) => setOpen(key);

  return (
    <>
      {/* Mobile: ONE swipeable row of content-width pills (Rem, 2026-08-12 — equal-width
          thirds made them "way too wide" with tiny text; each pill hugs its label at a
          readable size instead). thin-scroll so den.css kills the native bar under 640px.
          No standing scrollbar here (Rem, 2026-08-13): the cut-off pill dissolving into
          the edge fade IS the "it scrolls" signal — a bar under a five-item row was
          furniture. (The day tray keeps its grabbable hairline; that strip is long.)
          No edge bleed: the row lives inside the page gutters like every other band. */}
      <div className="sm:hidden">
        <div
          className="thin-scroll flex snap-x gap-2 overflow-x-auto [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)]"
        >
          {ACTIONS.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => activate(a.key)}
              className="flex h-11 shrink-0 snap-start items-center gap-1.5 rounded-full border border-border bg-card px-4 text-[13px] font-medium text-foreground/90 transition-colors active:bg-accent"
            >
              <a.icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.9} />
              {a.label}
            </button>
          ))}
        </div>
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

      {/* Headless: kicks the background library scan when the cache is stale, renders nothing. */}
      <PlaylistsSync syncedAt={syncedAt} />

      {action ? (
        <ActionSheet
          action={action}
          playlists={playlists}
          backupPref={backupPref}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

function ActionSheet({
  action,
  playlists,
  backupPref,
  onClose,
}: {
  action: (typeof ACTIONS)[number];
  playlists: Playlist[];
  backupPref: boolean;
  onClose: () => void;
}) {
  // Ordered selections. For "subtract" both lists are live and the toggle decides
  // which one a tap adds to; for everything else only `picked` is used.
  const [picked, setPicked] = useState<string[]>([]);
  const [others, setOthers] = useState<string[]>([]);
  const [group, setGroup] = useState<"base" | "subtract">("base");
  const [pending, start] = useTransition();
  // Subtract answers a question before it does anything, so it gets a second step in the
  // same sheet: the picker becomes the result (unique vs. shared), with the save as the
  // follow-up. Every other action commits straight from the picker.
  const [preview, setPreview] = useState<{ kept: SubtractTrack[]; overlap: SubtractTrack[] } | null>(
    null,
  );

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

  const nameOf = (id: string) => playlists.find((p) => p.id === id)?.name ?? "playlist";

  // The real Spotify flows. Merge names itself, and Clean reports progress through the
  // app-wide CleanProgressWatcher (see the layout) — so neither needs a step of its own.
  const confirm = () => {
    start(async () => {
      switch (action.key) {
        case "resume": {
          const r = await resumePlaylistAction(picked[0]);
          if (r.ok) toast.success(`Resuming "${nameOf(picked[0])}"`);
          else toast.error(r.error);
          break;
        }
        case "clean": {
          const r = await startCleanAction(picked[0], backupPref);
          if (!r.ok) {
            toast.error(r.error);
            break;
          }
          // Hand the task to the global watcher so progress keeps showing after this closes.
          if (r.taskId) writeCleanActive({ taskId: r.taskId, playlistId: picked[0] });
          toast.success(
            r.unique
              ? `"${r.name}" — nothing to strip, every song is new`
              : `Cleaning "${r.name}" — ${r.removed} already-saved removed, ${r.kept} kept`,
          );
          break;
        }
        case "queue": {
          const r = await saveQueueAction();
          if (r.ok) toast.success(`Saved to "${r.name}"`);
          else toast.error(r.error);
          break;
        }
        case "merge": {
          const r = await mergeAction(picked); // click order is the merge order
          if (r.ok) toast.success(`Merged ${r.count} songs into "${r.name}"`);
          else toast.error(r.error);
          break;
        }
        case "subtract": {
          // Step one: answer the question. Nothing is written until you save below.
          const r = await subtractPreviewAction(
            picked[0],
            others.map((id) => ({ id, name: nameOf(id) })),
          );
          if (r.ok) {
            setPreview({ kept: r.kept, overlap: r.overlap });
            return; // stay open — the result IS the point
          }
          toast.error(r.error);
          break;
        }
      }
      onClose();
    });
  };

  const saveDiff = () => {
    if (!preview) return;
    const name = `${nameOf(picked[0])} minus ${others.map(nameOf).join(" + ")}`.slice(0, 100);
    start(async () => {
      const r = await saveCompareDiffAction(name, preview.kept.map((t) => t.uri));
      if (r.ok) toast.success(`Saved ${r.count} songs to "${name}"`);
      else toast.error(r.error);
      onClose();
    });
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
            <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
              {preview
                ? `${preview.kept.length} only in "${nameOf(picked[0])}" · ${preview.overlap.length} shared`
                : action.blurb}
            </p>
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
        {action.select === "subtract" && !preview ? (
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

        {preview ? (
          // The result. Same row rhythm as the picker, so the sheet doesn't lurch.
          <div className="thin-scroll mt-4 min-h-0 flex-1 overflow-y-auto border-t border-border/60">
            {preview.kept.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted-foreground">
                Every song is already in the playlists you subtracted.
              </p>
            ) : null}
            {preview.kept.map((t) => (
              <div key={t.id} className="flex w-full items-center gap-3 px-5 py-2.5 text-left">
                {t.albumImage ? (
                  <img src={t.albumImage} alt="" className="size-10 shrink-0 rounded-md object-cover" />
                ) : (
                  <span className="size-10 shrink-0 rounded-md bg-secondary" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{t.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{t.artist}</span>
                </span>
              </div>
            ))}
          </div>
        ) : action.select ? (
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
          {(picked.length || others.length) && !preview ? (
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
            onClick={preview ? saveDiff : confirm}
            disabled={pending || (!preview && !ready) || (!!preview && preview.kept.length === 0)}
            className="h-10 rounded-lg bg-foreground px-5 text-sm font-semibold text-background transition-opacity disabled:opacity-40"
          >
            {pending
              ? "Working…"
              : preview
                ? `Save ${preview.kept.length} songs`
                : action.label}
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
