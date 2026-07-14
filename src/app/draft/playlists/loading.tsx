import { Skeleton } from "@/components/ui/skeleton";
import { HeaderSkeleton } from "../header-skeleton";

// Playlists' own loading UI. Without this, the parent /draft loading.tsx (the Home shape —
// greeting, action pills, day strip, song rows) would be shown here, which is the wrong page.
// This mirrors the real Playlists layout: stats line + sort, then the 4-up grid of boxed cards.
export default function PlaylistsLoading() {
  return (
    <>
      <HeaderSkeleton />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-7 sm:px-6 sm:pb-24 sm:pt-9">
        <div className="space-y-6">
          {/* Stats line with the sort control inline at its right. */}
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-80 max-w-full rounded" />
            <Skeleton className="h-7 w-28 shrink-0 rounded" />
          </div>

          {/* 4-up grid. Plain blocks, no card borders — an estimate of the layout, not a
              replica of its chrome. */}
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <li key={i}>
                <Skeleton className="aspect-square w-full rounded-xl" />
                <Skeleton className="mt-3 h-4 w-2/3 rounded" />
                <Skeleton className="mt-2 h-3 w-1/3 rounded opacity-60" />
              </li>
            ))}
          </ul>
        </div>
      </main>
    </>
  );
}
