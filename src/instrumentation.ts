// Next runs register() once per server process, before it handles any request. The only thing
// it does here: start building the read replica (src/lib/db.ts) at instance start instead of
// on the first scanning read.
//
// Why it matters — the product's cold path is "open the app, look at the stats, search within
// 10-15s". getReader() serves from the primary until the replica has synced, and the primary's
// scan latency has a seconds-long tail, so every read that happens during the boot pays it.
// Kicking the boot off here overlaps it with process start and the first render instead of
// starting the clock when the first read arrives.
export async function register(): Promise<void> {
  // Edge and the client bundle also run this file; the replica is a native SQLite file and
  // only exists on the Node runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Dynamic import so db.ts (and the native libsql binding) is only loaded on that runtime.
  const { warmReplica } = await import("@/lib/db");
  // Deliberately NOT awaited: the sync is fire-and-forget, and a slow or failing one must
  // never delay or break server start. Reads fall back to the primary until it lands.
  warmReplica();
}
