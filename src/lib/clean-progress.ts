// Shared glue for surfacing a clean's background reconcile across the app. The job
// itself lives in the server task registry; here we just remember which task is
// active (in localStorage, so it survives reloads) for CleanProgressWatcher to poll.
// The key is the user's (userStorageName(uid, "clean:active")): another user signing in on
// this browser neither sees nor polls this one's clean (multi-user PLAN §6.2 layer 6).
import { userStorageName } from "@/lib/user-storage";

export const cleanActiveKey = (uid: string) => userStorageName(uid, "clean:active");

export type CleanActive = { taskId: string; playlistId: string };

export function readCleanActive(uid: string): CleanActive | null {
  try {
    const raw = localStorage.getItem(userStorageName(uid, "clean:active"));
    return raw ? (JSON.parse(raw) as CleanActive) : null;
  } catch {
    return null;
  }
}

export function writeCleanActive(uid: string, active: CleanActive): void {
  localStorage.setItem(userStorageName(uid, "clean:active"), JSON.stringify(active));
  // Nudge the watcher to start polling immediately (same-tab; cross-tab uses the
  // native `storage` event).
  window.dispatchEvent(new CustomEvent("clean:active"));
}

export function clearCleanActive(uid: string): void {
  localStorage.removeItem(userStorageName(uid, "clean:active"));
}
