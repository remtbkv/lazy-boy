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
    blurb: "Pick a base playlist, then the playlists to subtract from it — see which songs are unique vs. shared." },
];

// The action dock. Desktop: a quiet row of text buttons — hover reveals the surface
// (no standing chips). Mobile: a 3-wide grid of tiles sized for thumbs; tapping opens
// a bottom sheet with the action's description readable on touch.
export function ActionDock({ playlists, backupPref, syncedAt }: DockData) {
  const [open, setOpen] = useState<ActionKey | null>(null);
  // Once the pill row is scrolled, the LEFT edge also clips a pill mid-letter — without a
  // fade there it read as the page itself being chopped (Rem, 2026-08-13). The left fade
  // appears only when there is actually content hidden behind that edge.
  const [rowScrolled, setRowScrolled] = useState(false);
  // Save queue never opens a sheet: it has nothing to pick, so a full-height panel was
  // three restatements of "Save queue" over empty space (Rem, 2026-08-13). It gets a
  // small confirm bubble anchored to the button that was just tapped instead.
  const [queueAnchor, setQueueAnchor] = useState<{ left: number; top: number } | null>(null);
  const action = ACTIONS.find((a) => a.key === open) ?? null;

  const activate = (key: ActionKey, e: React.MouseEvent) => {
    if (key === "queue") {
      const r = e.currentTarget.getBoundingClientRect();
      setQueueAnchor({
        left: Math.max(8, Math.min(r.left, window.innerWidth - 218)),
        top: r.bottom + 8,
      });
      return;
    }
    setOpen(key);
  };

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
          onScroll={(e) => setRowScrolled(e.currentTarget.scrollLeft > 4)}
          className={cn(
            "thin-scroll flex snap-x gap-2 overflow-x-auto",
            rowScrolled
              ? "[-webkit-mask-image:linear-gradient(to_right,transparent,#000_1.5rem,#000_calc(100%-1.5rem),transparent)] [mask-image:linear-gradient(to_right,transparent,#000_1.5rem,#000_calc(100%-1.5rem),transparent)]"
              : "[-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)]",
          )}
        >
          {ACTIONS.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={(e) => activate(a.key, e)}
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
            onClick={(e) => activate(a.key, e)}
            className="flex h-10 items-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-medium text-foreground/90 transition-colors hover:border-[color-mix(in_srgb,var(--border)_55%,var(--muted-foreground))] hover:bg-accent"
          >
            <a.icon className="size-4" strokeWidth={1.9} />
            {a.label}
          </button>
        ))}
      </div>

      {/* Headless: kicks the background library scan when the cache is stale, renders nothing. */}
      <PlaylistsSync syncedAt={syncedAt} />

      {queueAnchor ? (
        <QueuePopover anchor={queueAnchor} onClose={() => setQueueAnchor(null)} />
      ) : null}

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

// Save queue's confirm: a compact bubble AT the button (no sheet, no scrim, no repeated
// copy — the pill already said what it does). One tap to run, X or outside tap to leave.
// Enters with a quick pop, leaves with the same fade-down the sheet uses.
function QueuePopover({
  anchor,
  onClose,
}: {
  anchor: { left: number; top: number };
  onClose: () => void;
}) {
  const [pending, start] = useTransition();
  const [closing, setClosing] = useState(false);
  const dismiss = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 180);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const save = () => {
    start(async () => {
      const r = await saveQueueAction();
      if (r.ok) toast.success(`Saved to "${r.name}"`);
      else toast.error(r.error);
      dismiss();
    });
  };
  return (
    <>
      {/* Transparent outside-tap catcher — a toast-like bubble earns no dimmed scrim. */}
      <button type="button" aria-label="Close" onClick={dismiss} className="fixed inset-0 z-50" />
      <div
        className={cn("den-pop fixed z-50 flex items-center gap-1 rounded-2xl border border-border bg-popover p-1.5 shadow-xl shadow-black/40", closing && "den-closing")}
        style={{ left: anchor.left, top: anchor.top }}
      >
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="h-[44px] rounded-xl bg-foreground px-4 text-[15px] font-semibold text-background transition-opacity disabled:opacity-50 sm:h-9 sm:text-sm"
        >
          {pending ? "Saving…" : "Save queue"}
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={dismiss}
          className="flex size-[44px] shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:size-9"
        >
          <X className="size-6 sm:size-4" />
        </button>
      </div>
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

  // Animated exit: every close path plays the roll-down (transform+opacity only, so it
  // runs on the compositor — no layout per frame) and unmounts when it lands. Rem,
  // 2026-08-13: closing must glide down like the search reveal, never blink out.
  const [closing, setClosing] = useState(false);
  const requestClose = () => {
    setClosing((already) => {
      if (!already) setTimeout(onClose, 230);
      return true;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
    // requestClose closes over setState + onClose only; re-binding per render is noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // other group it moves over instead of being in both. The BASE group holds exactly
    // ONE playlist: the action only ever diffs picked[0], and the old multi-select UI
    // numbered B1/B2/B3 while silently ignoring everything after B1 (wave-2 audit, D1/C4).
    if (group === "base") {
      if (others.includes(id)) setOthers(others.filter((x) => x !== id));
      setPicked((cur) => (cur[0] === id ? [] : [id]));
      return;
    }
    if (others.includes(id)) {
      setOthers(others.filter((x) => x !== id));
    } else {
      if (picked.includes(id)) setPicked(picked.filter((x) => x !== id));
      setOthers([...others, id]);
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
      requestClose();
    });
  };

  const saveDiff = () => {
    if (!preview) return;
    const name = `${nameOf(picked[0])} minus ${others.map(nameOf).join(" + ")}`.slice(0, 100);
    start(async () => {
      const r = await saveCompareDiffAction(name, preview.kept.map((t) => t.uri));
      if (r.ok) toast.success(`Saved ${r.count} songs to "${name}"`);
      else toast.error(r.error);
      requestClose();
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <button
        type="button"
        aria-label="Close"
        onClick={requestClose}
        className={cn("den-scrim absolute inset-0 bg-black/55", closing && "den-closing")}
      />
      <div
        role="dialog"
        aria-modal
        aria-label={action.label}
        className={cn(
          "den-sheet relative flex max-h-[78dvh] w-full flex-col rounded-t-2xl border border-border bg-popover pb-[env(safe-area-inset-bottom)] sm:max-h-[70vh] sm:max-w-md sm:rounded-2xl",
          closing && "den-closing",
        )}
      >
        {/* No title row — the button just tapped already named the action, so the
            description IS the header. No grab handle either: it read as draggable (it
            wasn't) and echoed the iOS home indicator. The X spans the description's two
            lines at finger size (Rem, 2026-08-13). */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5 sm:pt-4">
          <p className="text-[16px] leading-snug text-muted-foreground sm:text-[13px]">
            {preview
              ? `${preview.kept.length} only in "${nameOf(picked[0])}" · ${preview.overlap.length} shared`
              : action.blurb}
          </p>
          <button
            type="button"
            aria-label="Close"
            onClick={requestClose}
            className="-mr-2 -mt-1 flex size-[44px] shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:mt-0.5 sm:size-8"
          >
            <X className="size-6 sm:size-4" />
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
                  "h-10 rounded-lg px-4 text-[15px] font-medium transition-colors sm:h-8 sm:px-3 sm:text-[13px]",
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
              <div key={t.id} className="flex w-full items-center gap-3 px-5 py-3 text-left sm:py-2.5">
                {t.albumImage ? (
                  <img src={t.albumImage} alt="" className="size-12 shrink-0 rounded-md object-cover sm:size-10" />
                ) : (
                  <span className="size-12 shrink-0 rounded-md bg-secondary sm:size-10" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16px] font-medium sm:text-sm">{t.title}</span>
                  <span className="block truncate text-[13px] text-muted-foreground sm:text-xs">{t.artist}</span>
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
                    "flex w-full items-center gap-3 px-5 py-3 text-left transition-colors sm:py-2.5",
                    on ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
                  )}
                >
                  {p.image ? (
                    <img src={p.image} alt="" className="size-12 shrink-0 rounded-md object-cover sm:size-10" />
                  ) : (
                    <span className="size-12 shrink-0 rounded-md bg-secondary sm:size-10" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[16px] font-medium sm:text-sm">{p.name}</span>
                    <span className="block text-[13px] tabular-nums text-muted-foreground sm:text-xs">
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
              className="text-[15px] font-medium text-muted-foreground transition-colors hover:text-foreground sm:text-sm"
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
            className="h-12 rounded-xl bg-foreground px-6 text-[16px] font-semibold text-background transition-opacity disabled:opacity-40 sm:h-10 sm:rounded-lg sm:px-5 sm:text-sm"
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
      {action === "subtract" ? (isBase ? "B" : `S${n}`) : n}
    </span>
  );
}
