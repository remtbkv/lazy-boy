// The open tab's sync cadence, as /api/sync last said it (docs/multi-user/CAPACITY.md §6):
// 2 minutes normally, 5 in economy and freeze. SyncOnLoad's loop (below) is the one caller of
// /api/sync and records each reply's interval here; Home's open-tab refresh (den-home.tsx) reads
// it for its own timer and focus throttle. Browser module: one tab, one value. Framework-free
// so the timing is known-answer tested with fake timers (tests/budget-modes.test.ts).
import { SYNC_INTERVAL_MS } from "@/lib/budget/modes";

export const DEFAULT_SYNC_INTERVAL_MS = SYNC_INTERVAL_MS.normal;
let current = DEFAULT_SYNC_INTERVAL_MS;

export function syncIntervalMs(): number {
  return current;
}

/** Take the interval from a /api/sync reply; anything else (an error, an older deployment's
 *  reply) keeps the last one. */
export function noteSyncReply(body: unknown): void {
  const v = (body as { intervalMs?: unknown } | null)?.intervalMs;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) current = v;
}

/** How long an ambient trigger (a return to the tab, a timer) waits after the last run: the
 *  caller's own gap normally; under a longer server interval, that interval less 30 s, so a
 *  timer firing on the interval is never the one skipped. */
export function ambientGapMs(normalGapMs: number): number {
  return current > DEFAULT_SYNC_INTERVAL_MS ? current - 30_000 : normalGapMs;
}

/** Which trigger a sync is, as /api/sync's `x-sync` header names it (multi-user PLAN §7.6): the
 *  load and a return to the tab (`load`) run the open app's step at once; the timer (`timer`)
 *  only when no cron tick has run in 5 minutes. */
export type SyncKind = "load" | "timer";

/** SyncOnLoad's loop: sync on start, then one interval after each sync, and on a return to
 *  the tab once the ambient gap has passed. A hidden tab never syncs. */
export class SyncLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;
  private stopped = true;

  constructor(
    private readonly post: (kind: SyncKind) => Promise<unknown>,
    private readonly visible: () => boolean,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.run("load");
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  focus(): void {
    if (!this.stopped && Date.now() - this.lastAt >= ambientGapMs(0)) void this.run("load");
  }

  private async run(kind: SyncKind): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.visible()) {
      this.lastAt = Date.now();
      noteSyncReply(await this.post(kind).catch(() => null));
    }
    if (this.stopped) return;
    // Two runs can overlap (a return to the tab while a sync is out): one timer, the later.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run("timer"), current);
  }
}
