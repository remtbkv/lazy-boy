import { Skeleton } from "@/components/ui/skeleton";

// Placeholder for the streamed history boundary (day strip + song table). It mirrors the real
// thing's footprint — same flex slot, same card height, same row rhythm — so the shell doesn't
// jump when the data lands, and you see the page's shape instantly instead of a blank gap.
export function HistorySkeleton() {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Day strip: just a merged row of blocks. A skeleton is an estimate of the layout, not a
          replica — reproducing the tray border and the separate All-time card made it read as
          real chrome rather than a placeholder. */}
      <div className="flex shrink-0 gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[6.5rem] flex-1 rounded-xl" />
        ))}
      </div>

      {/* Song table: header rule, then rows at the real row height. */}
      <div className="min-h-0 flex-1">
        <Skeleton className="h-5 w-full rounded-md opacity-40" />
        <div className="mt-3 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-10 shrink-0 rounded-md" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-1/3 rounded" />
                <Skeleton className="h-3 w-1/5 rounded opacity-60" />
              </div>
              <Skeleton className="h-3.5 w-40 rounded opacity-40" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
