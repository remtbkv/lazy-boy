// Next.js startup hook (runs once when the server process boots). Used to arm the
// background listen-history sync. Node runtime only — it touches the SQLite store
// and uses setInterval, neither of which belong in the edge runtime.
export async function register() {
  // Skip during `next build` (register also runs at build time) so we don't fire a
  // network sync while collecting page data — only arm it for the running server.
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { ensureSyncScheduler } = await import("@/lib/sync/scheduler");
    ensureSyncScheduler();
  }
}
