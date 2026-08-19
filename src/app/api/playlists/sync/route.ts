import { after } from "next/server";
import { startLibrarySync } from "@/lib/playlists-sync";
import { taskDone } from "@/lib/tasks/registry";

// Triggered by the client when the stored library is empty or stale. Kicks the full
// library scan as a background task and returns its id immediately — the scan runs off the
// request, paced and committing per playlist, while the client polls progress.
export async function POST() {
  try {
    const { taskId } = await startLibrarySync();
    // Keep the invocation alive until the detached scan finishes — without this, Vercel may
    // freeze the function the moment the response returns, mid-scan (audit 2026-08-19, T2.10).
    after(taskDone(taskId));
    return Response.json({ ok: true, taskId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: msg === "unauthorized" ? 401 : 500 });
  }
}
