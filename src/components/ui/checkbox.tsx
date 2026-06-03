"use client"

import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"

// Visual checkbox indicator only — intentionally not an interactive control.
// The surrounding row owns a single onClick so a click toggles exactly once.
// (The Base UI primitive never fired onChange, and a native <input> nested in a
// <label> double-fired it. A presentational box driven by `checked` avoids both.)
function Checkbox({
  checked = false,
  disabled = false,
  className,
}: {
  checked?: boolean
  disabled?: boolean
  className?: string
}) {
  return (
    <span
      data-slot="checkbox"
      aria-hidden
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-input/30",
        disabled && "opacity-50",
        className
      )}
    >
      <CheckIcon
        className={cn("size-3 transition-opacity", checked ? "opacity-100" : "opacity-0")}
      />
    </span>
  )
}

export { Checkbox }
