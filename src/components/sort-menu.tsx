"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Reusable sort control, used by the track list, playlist grid, and history.
//
// Two modes:
//  • Legacy (no `onToggleDirection`): the active row carries an ↑/↓ and re-selecting it
//    flips direction. Kept so existing call sites behave exactly as before.
//  • Split (`onToggleDirection` given): sorting is what it actually is — two variables.
//    The menu owns the KEY only (plain ink rows, no accent, active = foreground), and
//    direction becomes its own always-visible ↑/↓ button beside the trigger. Every glyph
//    then has one job: the arrow IS direction, the chevron IS the menu. No hidden
//    re-click-to-flip gesture, and no lone green accent in an ink-only skin.
export function SortMenu<K extends string>({
  value,
  direction,
  options,
  onSelect,
  onToggleDirection,
  fallbackLabel = "Sort",
}: {
  value: K;
  direction?: "asc" | "desc";
  options: readonly { key: K; label: string }[];
  onSelect: (key: K) => void;
  /** Opt into split mode (see above). */
  onToggleDirection?: () => void;
  fallbackLabel?: string;
}) {
  const label = options.find((o) => o.key === value)?.label ?? fallbackLabel;
  const DirArrow = direction === "asc" ? ArrowUp : ArrowDown;
  const split = !!onToggleDirection && !!direction;

  // Hover to open (Base UI's Menu has no openOnHover), with an intent delay so merely
  // sweeping the cursor past the trigger doesn't pop the menu — it only opens if you
  // linger. A short close delay bridges trigger → panel so it doesn't snap shut in
  // transit. Clicking still works, and touch (no hover) falls back to it.
  const OPEN_DELAY = 220;
  const CLOSE_DELAY = 150;
  // A hover-opened menu ignores a *trigger* click for this long: the user who reached for
  // the trigger was going to click it, and their click lands just as the hover opens it —
  // toggling it straight back shut. Clicks after this window close it as normal.
  const CLICK_GRACE = 450;
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedAt = useRef(0);
  const openedByHover = useRef(false);
  const selecting = useRef(false); // an item was picked → that close must always go through

  const openMenu = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      openedByHover.current = true;
      openedAt.current = Date.now();
      setOpen(true);
    }, OPEN_DELAY);
  };
  const scheduleClose = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => {
      openedByHover.current = false;
      setOpen(false);
    }, CLOSE_DELAY);
  };
  // The grace guard. A press on the trigger within CLICK_GRACE of a hover-open means the
  // user was reaching for the trigger and the menu opened under their cursor — toggling it
  // straight back shut is never what they meant.
  //
  // It has to be a DOCUMENT capture listener, not a React handler on the trigger: Base UI
  // dismisses the popup from its own document-level listener, which would fire before
  // anything bound further down the tree. Registering ours at mount (before the popup adds
  // its own on open) puts us first in the capture queue, so stopImmediatePropagation here
  // actually prevents the dismissal. Past the grace, presses fall through and toggle as normal.
  const triggerWrapRef = useRef<HTMLSpanElement>(null);
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    const swallow = (e: Event) => {
      const target = e.target as Node | null;
      if (!target || !triggerWrapRef.current?.contains(target)) return;
      const inGrace =
        openRef.current &&
        openedByHover.current &&
        Date.now() - openedAt.current < CLICK_GRACE;
      if (!inGrace) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    document.addEventListener("pointerdown", swallow, true);
    document.addEventListener("mousedown", swallow, true);
    document.addEventListener("click", swallow, true);
    return () => {
      document.removeEventListener("pointerdown", swallow, true);
      document.removeEventListener("mousedown", swallow, true);
      document.removeEventListener("click", swallow, true);
    };
  }, []);
  useEffect(
    () => () => {
      if (openTimer.current) clearTimeout(openTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  return (
    <div className="flex items-center gap-0.5">
      <DropdownMenu
        open={open}
        onOpenChange={(o) => {
          if (o) {
            if (openTimer.current) clearTimeout(openTimer.current);
            // Do NOT clear openedByHover here: Base UI also notifies on the open we just
            // made ourselves from the hover timer, and clobbering the flag there would
            // disable the grace entirely. Only a *click*-open (flag already false) stamps
            // a fresh time, so a click-opened menu toggles shut on the next click as normal.
            if (!openedByHover.current) openedAt.current = Date.now();
            setOpen(true);
            return;
          }
          if (openTimer.current) clearTimeout(openTimer.current);
          // Picking an option always closes.
          if (selecting.current) {
            selecting.current = false;
            openedByHover.current = false;
            setOpen(false);
            return;
          }
          // Swallow the click that lands right as the hover-open fires (see CLICK_GRACE).
          if (openedByHover.current && Date.now() - openedAt.current < CLICK_GRACE) return;
          openedByHover.current = false;
          setOpen(false);
        }}
      >
        {/* The grace guard: a press landing right after the hover-open is swallowed here, in
            the CAPTURE phase, rather than by refusing the close in onOpenChange — Base UI
            tears the popup down on a trigger press regardless of the controlled `open`.
            React binds at the root, so stopping propagation on the way DOWN means the
            trigger never sees the event at all. Past the grace, presses pass through and
            toggle normally. */}
        <span ref={triggerWrapRef} className="inline-flex">
          {/* Hover emphasis is the text brightening (muted → foreground) and the chevron
              coming to full — no background chip, which read as a heavy box. */}
          <DropdownMenuTrigger
            onMouseEnter={openMenu}
            onMouseLeave={scheduleClose}
            render={
              <Button
                variant="ghost"
                size="sm"
                className="group gap-1.5 px-1.5 text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground active:bg-transparent dark:hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-foreground"
              />
            }
          >
            {label}
            {/* In split mode the direction lives in its own button, so the trigger carries a
                single glyph (the chevron) instead of an arrow + chevron pair. */}
            {!split && direction ? <DirArrow className="size-3.5" /> : null}
            <ChevronDownIcon className="size-3.5 opacity-60 transition-opacity group-hover:opacity-100" />
          </DropdownMenuTrigger>
        </span>

        <DropdownMenuContent
          align="end"
          onMouseEnter={openMenu}
          onMouseLeave={scheduleClose}
          className={cn(
            // Hug the content instead of a fixed width (which left dead space beside short
            // labels); hairline border + a real shadow rather than the default fat ring.
            split
              ? "min-w-44 rounded-xl border border-border p-1 shadow-2xl shadow-black/50 ring-0"
              : "w-48",
          )}
        >
          {/* "Sort by" is redundant — the trigger already names the control. */}
          {!split ? <DropdownMenuLabel>Sort by</DropdownMenuLabel> : null}
          {options.map((o) => {
            const active = value === o.key;
            return (
              <DropdownMenuItem
                key={o.key}
                onClick={() => {
                  selecting.current = true;
                  onSelect(o.key);
                }}
                className={cn(
                  "justify-between gap-6",
                  split &&
                    cn(
                      "h-8 rounded-lg px-2.5 text-[13px]",
                      // Hover/keyboard highlight is the SAME mechanism as everywhere else in
                      // this skin — the text brightens. No background chip (Base UI's default
                      // is focus:bg-accent, overridden here).
                      "focus:bg-transparent focus:text-foreground",
                      // Selection reads as ink brightness, not a colored tick.
                      active ? "text-foreground" : "text-muted-foreground",
                    ),
                )}
              >
                {o.label}
                {split ? null : active && direction ? (
                  direction === "asc" ? (
                    <ArrowUp className="size-4 text-primary" />
                  ) : (
                    <ArrowDown className="size-4 text-primary" />
                  )
                ) : active ? (
                  <CheckIcon className="size-4 text-primary" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Direction: one click, always visible, nothing hidden behind a re-click. */}
      {split ? (
        <button
          type="button"
          onClick={onToggleDirection}
          aria-label={
            direction === "asc" ? "Ascending — switch to descending" : "Descending — switch to ascending"
          }
          title={direction === "asc" ? "Ascending" : "Descending"}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        >
          <DirArrow className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
