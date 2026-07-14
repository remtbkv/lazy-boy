import { Skeleton } from "@/components/ui/skeleton";

// Friends' own loading UI — otherwise it inherits the parent skeleton, which is the Home shape
// (day strip, song rows) and looks like the wrong page. Mirrors the real layout: a display
// heading, a lead line, then ruled rows.
export default function FriendsLoading() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-7 sm:px-6 sm:pb-20 sm:pt-6">
      <Skeleton className="h-11 w-64 max-w-full rounded-lg" />
      <Skeleton className="mt-4 h-4 w-72 max-w-full rounded" />

      <ul className="mt-8 max-w-2xl border-t border-border/60">
        {Array.from({ length: 3 }).map((_, i) => (
          <li key={i} className="border-b border-border/60 py-5">
            <Skeleton className="h-4 w-56 rounded" />
            <Skeleton className="mt-2.5 h-3.5 w-full max-w-lg rounded opacity-60" />
          </li>
        ))}
      </ul>
    </main>
  );
}
