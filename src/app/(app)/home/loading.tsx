import { Skeleton } from "@/components/ui/skeleton";

// Route-level loading UI: Next shows this instantly on navigation to /home (and as the
// first streamed chunk on a cold load) while the server component awaits auth + the DB
// reads. It mirrors the real shell — greeting, quick-action pills, then the history strip
// + table — so the page doesn't jump when the content lands, and the user sees immediate
// feedback instead of a blank screen on a slow/cold start.
export default function HomeLoading() {
  return (
    <div>
      <header>
        <Skeleton className="h-12 w-80 max-w-full rounded-lg" />
      </header>

      <div className="mt-7 flex flex-wrap gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28 rounded-full" />
        ))}
      </div>

      <section className="mt-5 space-y-6 border-t border-border/60 pt-5">
        <div className="flex w-full gap-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-[7.5rem] flex-1 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-[calc(100vh-36.25rem)] min-h-40 w-full rounded-lg" />
      </section>
    </div>
  );
}
