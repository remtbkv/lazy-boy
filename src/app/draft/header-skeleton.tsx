import { Skeleton } from "@/components/ui/skeleton";

// The header's placeholder, shared by every draft route's loading.tsx so the top bar doesn't
// reshuffle between routes.
//
// It includes the now-playing chip. That chip renders only when something is actually playing,
// so once the page lands it may well not be there — but reserving it while loading is still the
// right call: the alternative (skip it, then have a chip pop in on the right) shifts the header
// the moment data arrives. Estimating its presence costs nothing; guessing it away costs a jump.
export function HeaderSkeleton() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-6 px-4 sm:px-6">
        <Skeleton className="size-9 rounded-full" />
        <Skeleton className="h-4 w-40 rounded" />

        <div className="ml-auto flex items-center gap-4">
          {/* Now-playing chip: album art + title/artist + the progress rule. */}
          <div className="hidden items-center gap-3 sm:flex">
            <Skeleton className="size-9 shrink-0 rounded-md" />
            <div className="w-[158px] space-y-1.5">
              <Skeleton className="h-3 w-2/3 rounded" />
              <Skeleton className="h-2.5 w-1/3 rounded opacity-60" />
              <Skeleton className="h-0.5 w-full rounded-full opacity-40" />
            </div>
          </div>
          <Skeleton className="size-8 shrink-0 rounded-full" />
        </div>
      </div>
    </header>
  );
}
