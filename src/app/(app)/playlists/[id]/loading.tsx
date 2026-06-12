import { ArrowLeft } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

// Shown the instant a playlist link is clicked, so navigation feels immediate instead of
// frozen while the server renders from the cache. Mirrors the detail page's layout (back
// link, cover + title, track rows) so the swap to real content doesn't jump.
export default function Loading() {
  return (
    <div className="space-y-6">
      <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground">
        <ArrowLeft className="size-4" />
        All playlists
      </span>

      <div className="flex flex-col gap-6 sm:flex-row sm:items-end">
        <Skeleton className="size-40 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-9 w-1/2" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>

      <div className="space-y-2 rounded-lg border border-border p-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-10 rounded" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
