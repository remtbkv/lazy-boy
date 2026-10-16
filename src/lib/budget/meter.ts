// The meter's in-process aggregate (docs/multi-user/CAPACITY.md §6): what each function
// invocation cost, summed by (UTC day, route, user) until a flush writes it to the telemetry
// store as one batch of upserts. request-meter.ts feeds it from the request path; nothing here
// knows about Next or the store, so the flush rules are known-answer tested on their own.
//
// A flush that fails keeps every count it took and merges them back for the next one; a
// flush that succeeded on the store but whose answer was lost counts them twice, which errs
// high, the safe side for a budget. Attempts are at most a minute apart, so a dead telemetry
// store costs one 4-second attempt a minute, not one per request.

export type MeterSample = {
  day: string;
  route: string;
  /** The gated user, or "-" (a cron tick, a signed-out caller, the cold start). */
  uid: string;
  invocations: number;
  /** Process CPU, user + system, in microseconds (process.cpuUsage()'s unit). */
  cpuUs: number;
  wallMs: number;
  /** Response body bytes, where the route reported them (request-meter.ts meteredBody). */
  bytes: number;
};

export const FLUSH_EVERY_MS = 60_000;
export const FLUSH_EVERY_INVOCATIONS = 200;

const keyOf = (s: MeterSample) => `${s.day}\u0000${s.route}\u0000${s.uid}`;

export class MeterAggregate {
  private pending = new Map<string, MeterSample>();
  private invocationsSinceFlush = 0;
  private lastAttemptAt = 0;
  private flushing = false;

  record(s: MeterSample): void {
    const k = keyOf(s);
    const cur = this.pending.get(k);
    this.pending.set(
      k,
      cur
        ? {
            ...cur,
            invocations: cur.invocations + s.invocations,
            cpuUs: cur.cpuUs + s.cpuUs,
            wallMs: cur.wallMs + s.wallMs,
            bytes: cur.bytes + s.bytes,
          }
        : { ...s },
    );
    this.invocationsSinceFlush += s.invocations;
  }

  /** Something to write, no flush running, and a minute since the last attempt or 200
   *  invocations since the last flush. */
  due(now: number): boolean {
    if (this.flushing || this.pending.size === 0) return false;
    return this.invocationsSinceFlush >= FLUSH_EVERY_INVOCATIONS || now - this.lastAttemptAt >= FLUSH_EVERY_MS;
  }

  /** Write everything pending as one batch. False (and the counts kept) if `write` rejects. */
  async flush(write: (rows: MeterSample[]) => Promise<void>, now: number): Promise<boolean> {
    if (this.flushing) return false;
    this.flushing = true;
    this.lastAttemptAt = now;
    const taken = [...this.pending.values()];
    this.pending = new Map();
    this.invocationsSinceFlush = 0;
    try {
      if (taken.length) await write(taken);
      return true;
    } catch {
      // Merged with whatever was recorded while the write was out.
      for (const s of taken) this.record(s);
      return false;
    } finally {
      this.flushing = false;
    }
  }

  rows(): MeterSample[] {
    return [...this.pending.values()].map((s) => ({ ...s }));
  }

  /** Drop everything pending and set the last attempt (tests). */
  reset(lastAttemptAt = 0): void {
    this.pending = new Map();
    this.invocationsSinceFlush = 0;
    this.lastAttemptAt = lastAttemptAt;
  }
}
