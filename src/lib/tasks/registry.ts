// In-memory background-task registry. Long-running work (clean playlist) reports
// progress here; the client polls /api/tasks/[id].
//
// EXTENSION SEAM (ROADMAP Phase 3): replace the Map with Redis/DB so tasks survive a
// refresh and work across server instances. Keep this interface stable.
//
// Every task records the user it runs for, and only that user can read it back
// (getTaskFor): a task's result can name playlists, so another user polling its id gets
// nothing (multi-user PLAN.md §6.2 layer 4, 01b S7).
import type { Uid } from "@/lib/identity";

export type TaskStatus = "queued" | "running" | "done" | "error";

export type Task<R = unknown> = {
  id: string;
  owner: Uid;
  label: string;
  status: TaskStatus;
  processed: number;
  total: number;
  result?: R;
  error?: string;
  updatedAt: number;
};

// Persist across hot reloads in dev and across requests in a single instance.
const store: Map<string, Task> =
  (globalThis as { __taskStore?: Map<string, Task> }).__taskStore ??
  ((globalThis as { __taskStore?: Map<string, Task> }).__taskStore = new Map());

export function createTask(label: string, owner: Uid): Task {
  const task: Task = {
    id: crypto.randomUUID(),
    owner,
    label,
    status: "queued",
    processed: 0,
    total: 0,
    updatedAt: Date.now(),
  };
  store.set(task.id, task);
  sweepFinished();
  return task;
}

// Evict long-finished tasks so the store doesn't grow without bound in a persistent
// process. Only touches done/error tasks past the TTL — running ones are never dropped,
// and the window is long enough that a client polling its result still finds it.
const FINISHED_TTL_MS = 10 * 60 * 1000;
function sweepFinished(): void {
  const cutoff = Date.now() - FINISHED_TTL_MS;
  for (const [id, t] of store) {
    if ((t.status === "done" || t.status === "error") && t.updatedAt < cutoff) {
      store.delete(id);
    }
  }
}

/** The task, if it exists and belongs to `uid`; undefined otherwise, alike, so a caller
 *  cannot tell another user's task from a missing one. */
export function getTaskFor(id: string, uid: Uid): Task | undefined {
  const t = store.get(id);
  return t && t.owner === uid ? t : undefined;
}

export function updateTask(id: string, patch: Partial<Omit<Task, "id" | "owner">>): void {
  const t = store.get(id);
  if (!t) return;
  store.set(id, { ...t, ...patch, updatedAt: Date.now() });
}

/**
 * Run `work` in the background, wiring its progress callback into the task. Returns
 * immediately; callers hand the task id to the client for polling.
 */
// The detached work promise, per task — so a serverless caller can hand it to
// `after(...)` and keep the invocation alive until the work finishes. Without that, the
// platform may freeze the invocation as soon as the response returns, mid-scan
// (audit 2026-08-19, T2.10). Same lifetime caveats as `store` above.
const running = new Map<string, Promise<void>>();

/** The task's completion promise (never rejects), or resolved if unknown/finished. */
export function taskDone(id: string): Promise<void> {
  return running.get(id) ?? Promise.resolve();
}

export function runTask<R>(
  label: string,
  work: (onProgress: (processed: number, total: number) => void) => Promise<R>,
  owner: Uid,
): Task {
  const task = createTask(label, owner);
  updateTask(task.id, { status: "running" });
  const done = (async () => {
    try {
      const result = await work((processed, total) =>
        updateTask(task.id, { processed, total }),
      );
      updateTask(task.id, { status: "done", result });
    } catch (e) {
      updateTask(task.id, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      running.delete(task.id);
    }
  })();
  running.set(task.id, done);
  return task;
}
