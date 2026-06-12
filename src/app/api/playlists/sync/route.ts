import { startLibrarySync } from "@/lib/playlists-sync";

// Triggered by the client when the stored library is empty or stale. Kicks the full
// library scan as a background task and returns its id immediately — the scan runs off the
// request, paced and committing per playlist, while the client polls progress.
export async function POST() {
  try {
    const { taskId } = await startLibrarySync();
    return Response.json({ ok: true, taskId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: msg === "unauthorized" ? 401 : 500 });
  }
}
