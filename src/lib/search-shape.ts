// The search payloads' format tokens (db.ts, "The payload FORMATS"). Their own module because the
// browser needs them too: the IndexedDB copy is keyed by the shape this build reads
// (search-cache.ts), and db.ts is server-only.
export const LIBRARY_INDEX_SHAPE = "v1";
// v2 added the per-song durationMs slot (Home derives its day lists from this payload).
export const HISTORY_INDEX_SHAPE = "v2";
