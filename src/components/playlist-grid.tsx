"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUp } from "lucide-react";
import { PlaylistThumb } from "@/components/playlist-thumb";
import { FloatingBar } from "@/components/floating-bar";
import { PlaylistContextMenu } from "@/components/playlist-context-menu";
import { SortMenu } from "@/components/sort-menu";
import { fuzzyFilter } from "@/lib/filter";

type Item = { id: string; name: string; image: string | null; trackCount: number };

type Sort = "recents" | "name" | "songs";
const SORTS: { key: Sort; label: string }[] = [
  { key: "recents", label: "Recents" },
  { key: "name", label: "Name" },
  { key: "songs", label: "Songs" },
];
// Direction each sort opens in; clicking the active one flips it.
const DEFAULT_DIR: Record<Sort, "asc" | "desc"> = {
  recents: "asc", // native library order; desc reverses it
  name: "asc",
  songs: "desc", // most songs first
};

const COLLAPSED = 12; // ~3 rows on desktop

export function PlaylistGrid({
  playlists,
  loadingMore = false,
  stats,
}: {
  playlists: Item[];
  // Accepted for call-site compatibility; the count now lives in the page heading.
  total?: number;
  loadingMore?: boolean;
  // Library stats, rendered as the heading on the left of the sort row so it shares a line
  // with the sort control instead of sitting on its own (which left an awkward gap above the
  // grid). Passed as data, not JSX, so it renders client-side without serialized-children warnings.
  stats?: { playlists: number; owned: number; songs: number; unique: boolean };
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recents");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  function selectSort(k: Sort) {
    if (k === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(k);
      setDir(DEFAULT_DIR[k]);
    }
  }
  const sectionRef = useRef<HTMLElement | null>(null);

  // Right-click menu + optimistic hide of just-deleted playlists (the server
  // revalidation catches up a moment later).
  const [menu, setMenu] = useState<{ x: number; y: number; p: Item } | null>(null);
  const [deleted, setDeleted] = useState<Set<string>>(new Set());

  const filtered = useMemo(
    () => fuzzyFilter(
      playlists.filter((p) => !deleted.has(p.id)),
      query,
      (p) => p.name,
    ),
    [playlists, query, deleted],
  );

  // All client-side over the loaded list, so it's instant. "Recents" keeps
  // Spotify's native library order (asc); flipping it reverses to oldest-first.
  const sorted = useMemo(() => {
    const f = dir === "asc" ? 1 : -1;
    if (sort === "recents") return dir === "asc" ? filtered : [...filtered].reverse();
    const arr = [...filtered];
    if (sort === "name") arr.sort((a, b) => f * a.name.localeCompare(b.name));
    if (sort === "songs") arr.sort((a, b) => f * (a.trackCount - b.trackCount));
    return arr;
  }, [filtered, sort, dir]);

  const searching = query.trim().length > 0;
  const showingAll = searching || expanded;
  const visible = showingAll ? sorted : sorted.slice(0, COLLAPSED);
  const moreCount = searching ? 0 : sorted.length - visible.length;

  // Searching while scrolled deep brings the (now shorter) list up into view.
  useEffect(() => {
    if (!searching) return;
    const el = sectionRef.current;
    if (el && el.getBoundingClientRect().top < 72) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [searching]);

  // With a big library expanded, the grid runs many rows deep. Once you're a
  // couple of pages down, offer a jump back to the top.
  const [showTop, setShowTop] = useState(false);
  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > window.innerHeight * 1.5);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const action = searching
    ? null
    : expanded
      ? { label: "See less", onClick: () => setExpanded(false) }
      : moreCount > 0
        ? { label: `See ${moreCount} more`, onClick: () => setExpanded(true) }
        : null;

  return (
    <section
      ref={sectionRef}
      className="scroll-mt-24 space-y-4"
    >
      {/* Stats heading shares this row with the sort control, so it flows straight into the
          grid below instead of leaving a gap. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          {/* Quiet caption — normal case, muted labels, numbers in foreground so they pop.
              Matches the app's secondary text (no all-caps, which read out of place). */}
          {stats ? (
            <h1 className="truncate text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{stats.playlists.toLocaleString()}</span> playlists
              {" · "}
              <span className="font-medium text-foreground">{stats.owned.toLocaleString()}</span> created by you
              {" · "}
              <span className="font-medium text-foreground">{stats.songs.toLocaleString()}</span>{" "}
              {stats.unique ? "unique songs" : "total songs"}
            </h1>
          ) : null}
          {loadingMore ? (
            <span className="text-sm text-muted-foreground/70">loading…</span>
          ) : null}
        </div>
        <SortMenu value={sort} direction={dir} options={SORTS} onSelect={selectSort} />
      </div>

      {searching && filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No playlists match “{query.trim()}”.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((p, i) => (
            <li key={p.id}>
              <Link
                href={`/playlists/${p.id}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({ x: e.clientX, y: e.clientY, p });
                }}
                className="group block rounded-lg border border-border bg-card p-3 transition-colors hover:border-white/25 hover:bg-accent/40"
              >
                {/* Eager-load the first ~viewport of covers (≈ mobile's first rows + a bit) so
                    what you see fills in immediately; the rest lazy-load on scroll, which keeps
                    cellular from fetching all of them up front. */}
                <PlaylistThumb src={p.image} name={p.name} priority={i < 8} />
                <p className="mt-3 truncate text-sm font-medium select-text">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.trackCount} tracks</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <FloatingBar
        query={query}
        onQuery={setQuery}
        placeholder="Search playlists…"
        action={action}
      />

      {/* After FloatingBar on purpose: the pill measures its PREVIOUS sibling as "the
          last content" for bottom clearance — this fixed button would make that
          measurement garbage and zero out the padding. Both are fixed, so DOM order
          doesn't change what you see. */}
      {showingAll && showTop ? (
        <button
          type="button"
          aria-label="Back to top"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed left-1/2 top-[68px] z-30 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-white/20 bg-popover text-foreground shadow-xl shadow-black/50 ring-1 ring-black/30 backdrop-blur transition-colors hover:bg-accent"
        >
          <ArrowUp className="size-4" />
        </button>
      ) : null}

      {menu ? (
        <PlaylistContextMenu
          playlist={{ id: menu.p.id, name: menu.p.name }}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onDeleted={(id) => setDeleted((s) => new Set(s).add(id))}
        />
      ) : null}
    </section>
  );
}
