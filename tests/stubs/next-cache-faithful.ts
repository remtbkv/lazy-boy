// A next/cache stub that keys the way Next 16.2.6's unstable_cache does
// (next/dist/server/web/spec-extension/unstable-cache.js:55, :82): the callback's SOURCE TEXT,
// the key parts joined by commas, and JSON.stringify(args); and stores the value as JSON, as
// the incremental cache does. Variables the callback captures from its closure are not in the
// key. The default stub (next-cache.ts) is a pass-through, which can see no collision at all;
// the isolation suite mocks next/cache with this one (PLAN.md §6.4). An entry keeps the tags its
// call passed (`options.tags`, which Next keeps beside the entry and leaves out of the key), and
// revalidateTag drops every entry carrying the tag, as an expired tag makes the entry a miss.
type Entry = { body: string; tags: string[] };
const entries = new Map<string, Entry>();

export function unstable_cache<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  keyParts?: string[],
  opts?: { tags?: string[] },
): (...args: A) => Promise<R> {
  const fixedKey = `${fn.toString()}-${Array.isArray(keyParts) && keyParts.join(",")}`;
  return async (...args: A) => {
    const key = `${fixedKey}-${JSON.stringify(args)}`;
    const hit = entries.get(key);
    if (hit) return JSON.parse(hit.body) as R;
    const value = await fn(...args);
    entries.set(key, { body: JSON.stringify(value), tags: [...(opts?.tags ?? [])] });
    return value;
  };
}

/** Test hooks: the stored keys, an entry's tags, a forged entry under any key, and a reset. */
export const __cache = {
  keys: () => [...entries.keys()],
  tagsOf: (key: string) => entries.get(key)?.tags ?? null,
  forge: (key: string, value: unknown) => entries.set(key, { body: JSON.stringify(value), tags: entries.get(key)?.tags ?? [] }),
  clear: () => entries.clear(),
};

export function revalidatePath(): void {}
export function revalidateTag(tag: string): void {
  for (const [key, e] of entries) if (e.tags.includes(tag)) entries.delete(key);
}
