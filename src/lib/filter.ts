// Forgiving name search shared by the playlist grid and merge panel. Each
// whitespace-separated token must appear somewhere in the name (order-independent),
// so "old chinese" still matches "older chinese parse" even though the words aren't
// contiguous. Ranking: a contiguous match of the whole query first, then names that
// start with the first token, then the rest.
export function fuzzyFilter<T>(items: T[], query: string, name: (t: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const tokens = q.split(/\s+/).filter(Boolean);
  const first = tokens[0];
  const rank = (it: T) => {
    const n = name(it).toLowerCase();
    if (n.includes(q)) return 0;
    if (n.startsWith(first)) return 1;
    return 2;
  };
  return items
    .filter((it) => {
      const n = name(it).toLowerCase();
      return tokens.every((t) => n.includes(t));
    })
    .sort((a, b) => rank(a) - rank(b));
}
