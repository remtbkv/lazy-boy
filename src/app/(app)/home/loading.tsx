import { Skeleton } from "@/components/ui/skeleton";

// Route-level loading UI: Next shows this instantly on navigation (and as the first streamed
// chunk on a cold load) while the server component awaits auth + the DB reads. It mirrors only
// the PAGE BODY — greeting, action pills, day strip, list — NOT the header: the header lives in
// the layout, so the real one is already on screen during loading. Painting a header skeleton
// here stacked a second faded bar under the real header.
export default function HomeLoading() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-24 pt-7 sm:px-6 sm:pb-20 sm:pt-6">
      <div className="flex flex-col gap-6">
        <Skeleton className="h-11 w-96 max-w-full rounded-lg" />

        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-28 rounded-full" />
          ))}
        </div>

        {/* Day strip: just a merged row of blocks. A skeleton is an estimate of the layout,
              not a replica — reproducing the tray border and the separate All-time card made it
              read as real chrome. */}
        <div className="flex gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[6.5rem] flex-1 rounded-xl" />
          ))}
        </div>

        <div className="space-y-3">
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
    </main>
  );
}
