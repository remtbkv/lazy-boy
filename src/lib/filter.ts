// Forgiving name search shared by the playlist grid and merge panel: a
// case-insensitive substring match, with names that *start* with the query
// ranked ahead of ones that merely contain it.
export function fuzzyFilter<T>(items: T[], query: string, name: (t: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items
    .filter((it) => name(it).toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = name(a).toLowerCase().startsWith(q) ? 0 : 1;
      const bp = name(b).toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp;
    });
}
