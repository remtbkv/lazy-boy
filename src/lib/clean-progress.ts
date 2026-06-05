// Shared glue for surfacing a clean's background reconcile across the app. The job
// itself lives in the server task registry; here we just remember which task is
// active (in localStorage, so it survives reloads) for CleanProgressWatcher to poll.

export const CLEAN_LS_KEY = "clean:active";

export type CleanActive = { taskId: string; playlistId: string };

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
