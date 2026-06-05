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
  total,
  loadingMore = false,
}: {
  playlists: Item[];
  total?: number;
  loadingMore?: boolean;
}) {
  const count = Math.max(total ?? playlists.length, playlists.length);
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
  const moreCount = searching ? 0 : Math.max(count, sorted.length) - visible.length;

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
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Your playlists · {count}
          {loadingMore ? (
            <span className="ml-2 normal-case text-muted-foreground/70">loading…</span>
          ) : null}
        </h2>
        <SortMenu value={sort} direction={dir} options={SORTS} onSelect={selectSort} />
      </div>

      {searching && filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No playlists match “{query.trim()}”.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((p) => (
            <li key={p.id}>
              <Link
                href={`/playlists/${p.id}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, p });
                }}
                className="group block rounded-lg border border-border bg-card p-3 transition-colors hover:border-white/25 hover:bg-accent/40"
              >
                <PlaylistThumb src={p.image} name={p.name} />
                <p className="mt-3 truncate text-sm font-medium select-text">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.trackCount} tracks</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

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

      <FloatingBar
        query={query}
        onQuery={setQuery}
        placeholder="Search playlists…"
        action={action}
      />

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
