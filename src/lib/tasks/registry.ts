// In-memory background-task registry. Long-running work (clean playlist) reports
// progress here; the client polls /api/tasks/[id].
//
// EXTENSION SEAM (ROADMAP Phase 3): replace the Map with Redis/DB so tasks survive a
// refresh and work across server instances. Keep this interface stable.

export type TaskStatus = "queued" | "running" | "done" | "error";

export type Task<R = unknown> = {
  id: string;
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

export function createTask(label: string): Task {
  const task: Task = {
    id: crypto.randomUUID(),
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

export function getTask(id: string): Task | undefined {
  return store.get(id);
}

export function updateTask(id: string, patch: Partial<Omit<Task, "id">>): void {
  const t = store.get(id);
  if (!t) return;
  store.set(id, { ...t, ...patch, updatedAt: Date.now() });
}

/**
 * Run `work` in the background, wiring its progress callback into the task. Returns
 * immediately; callers hand the task id to the client for polling.
 */
export function runTask<R>(
  label: string,
  work: (onProgress: (processed: number, total: number) => void) => Promise<R>,
): Task {
  const task = createTask(label);
  updateTask(task.id, { status: "running" });
  void (async () => {
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
    }
  })();
  return task;
}
