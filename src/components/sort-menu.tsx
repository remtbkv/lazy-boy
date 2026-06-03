"use client";

import { ArrowDown, ArrowUp, CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Reusable "Sort by ▾" menu, used by the track list, playlist grid, and history.
// When `direction` is supplied, the active option shows an up/down arrow and
// re-selecting it is expected to flip direction (the parent handles the toggle in
// `onSelect`); without it, the menu just marks the active option with a check.
export function SortMenu<K extends string>({
  value,
  direction,
  options,
  onSelect,
  fallbackLabel = "Sort",
}: {
  value: K;
  direction?: "asc" | "desc";
  options: readonly { key: K; label: string }[];
  onSelect: (key: K) => void;
  fallbackLabel?: string;
}) {
  const label = options.find((o) => o.key === value)?.label ?? fallbackLabel;
  const DirArrow = direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" />
        }
      >
        {label}
        {direction ? <DirArrow className="size-3.5" /> : null}
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        {options.map((o) => {
          const active = value === o.key;
          return (
            <DropdownMenuItem
              key={o.key}
              onClick={() => onSelect(o.key)}
              className="justify-between gap-4"
            >
              {o.label}
              {active && direction ? (
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
  );
}
