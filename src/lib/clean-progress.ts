// Shared glue for surfacing a running "clean playlist" job across the app. The job
// itself lives in the server task registry; here we just remember which task is
// active (in localStorage, so it survives reloads) and define the progress event
// the app-wide watcher emits for any interested UI (the CleanMenu button).

export const CLEAN_LS_KEY = "clean:active";
export const CLEAN_TOAST_ID = "clean-progress";

export type CleanActive = { taskId: string; playlistId: string };

export type CleanProgressDetail = {
  playlistId: string;
  taskId: string;
  processed: number;
  total: number;
  // "gone" = the server no longer knows this task (e.g. it restarted).
  status: "queued" | "running" | "done" | "error" | "gone";
};

export function readCleanActive(): CleanActive | null {
  try {
    const raw = localStorage.getItem(CLEAN_LS_KEY);
    return raw ? (JSON.parse(raw) as CleanActive) : null;
  } catch {
    return null;
  }
}

export function writeCleanActive(active: CleanActive): void {
  localStorage.setItem(CLEAN_LS_KEY, JSON.stringify(active));
  // Nudge the watcher to start polling immediately (same-tab; cross-tab uses the
  // native `storage` event).
  window.dispatchEvent(new CustomEvent("clean:active"));
}

export function clearCleanActive(): void {
  localStorage.removeItem(CLEAN_LS_KEY);
}
