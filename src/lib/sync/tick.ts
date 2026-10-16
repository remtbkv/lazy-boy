// The cron tick (docs/multi-user/PLAN.md §7.2), with every dependency injected so the simulated
// environment runs it whole (tests/isolation/t4-tick.test.ts, t13-tick-callers.test.ts). The route
// (`/api/cron/sync`, Phase 3's turn) passes the real ones: cron-auth.ts's caller, app-db.ts's
// queue, forUser's stores, auth.ts's tokenForTick, next/server's after(), the daily route's chores.
//
//   0. The caller is named by its secret. Only the Zenbook's can get a non-200: 503 when the admin
//      has no token row or is not active, or when two or more users, or the admin, failed to
//      decrypt in the last tick, read from the app database before anything else. cron-job.org
//      always gets a bare {"ok":true}: it disables a job after a run of failures, and it keeps
//      response bodies, where per-user outcomes would record when each friend listens.
//   1. The stamp: one tick per window (45 s in Phase 3, 90 s for the interim pinger, §7.9).
//   2. The claim, one attempt and 5 s: every due active user leased, joined to their token row and
//      database name. If it fails the tick ends.
//   3. Steps under Promise.allSettled, 15 s each (step.ts), each released from its outcome.
//   4. At most one library rescan, after the harvests, with at least 10 s of the 20 left.
//   5. The reply within 20 s; whatever has not finished goes to after().
//   6. The daily chores in after() when `daily_at` is over 26 hours old, under `lock:daily`.
// Then the bookkeeping only the tick can do: a 403 "not registered" marks a friend `removed` only
// while someone else's calls still work; invalid_grant's confirmation (§5.4 step 2) for at most one
// user, one token-endpoint call; two or more users, or the admin, hit within 24 h is an app-wide
// event (step 3).
import { randomUUID } from "node:crypto";
import * as appDb from "@/lib/app-db";
import type { Claim, ClaimedUser, OwnerAlarmRow, Release } from "@/lib/app-db";
import type { CronCaller } from "@/lib/cron-auth";
import { DAILY_STALE_MS } from "@/lib/health";
import { EARLY_MS, backoffMs, nextDue, syncStateFor, type HarvestTrigger } from "@/lib/harvest-policy";
import type { Uid } from "@/lib/identity";
import { spotifyClient, type OwnedToken } from "@/lib/spotify";
import { NoTokenError, runStep, type StepCode, type StepOutcome, type StepStore, type StepView } from "@/lib/sync/step";
import { RefreshError, type UserTokens } from "@/lib/token-core";

/** The app-database statements the tick runs (app-db.ts in production). */
export type TickQueue = Pick<
  typeof appDb,
  | "readOwnerAlarm"
  | "stampTick"
  | "claimDueUsers"
  | "claimUser"
  | "releaseLease"
  | "countRpCall"
  | "extendCooldown"
  | "moveStatus"
  | "recordAppEvent"
  | "grantFailuresSince"
  | "startGrantConfirm"
  | "finishGrantConfirm"
  | "claimRescan"
  | "scheduleRescan"
  | "acquireAppLock"
  | "releaseAppLock"
  | "setAppMeta"
  | "getAppMeta"
>;
export const appQueue: TickQueue = appDb;

export type TickConfig = {
  /** 45 s from Phase 3's turn; 90 s while the interim pinger runs alone (§7.9). */
  stampWindowMs: number;
  signups: "owner" | "invite";
  /** Hourly until the first friend; 2 hours from Phase 4a (§7.4). */
  backstopMs: number;
  /** brake.ts BRAKE_ON: off in Phase 3. */
  brakeOn: boolean;
  stepMs: number;
  replyMs: number;
  rescanMinLeftMs: number;
};

/** Phase 3's numbers (§7.2): 15 s a step, a reply within 20 s, a rescan only with 10 s left. */
export const PHASE3_TICK = {
  stampWindowMs: 45_000,
  backstopMs: 3_600_000,
  brakeOn: false,
  stepMs: 15_000,
  replyMs: 20_000,
  rescanMinLeftMs: 10_000,
} as const;

export type TickDeps = {
  /** The tick's clock: every due time and policy decision reads it. */
  now: () => number;
  caller: (authorization: string | null) => CronCaller | null;
  queue: TickQueue;
  /** The user's store, from the claimed row's uid and db_name (forUser checks the pair). */
  storeFor: (user: ClaimedUser) => StepStore;
  /** auth.ts tokenForTick: throws every failure, never clears (token-core.ts). */
  tokenFor: (uid: Uid) => Promise<UserTokens | null>;
  after: (work: Promise<unknown>) => void;
  /** The daily route's chores (§7.11), idempotent and resumable. */
  dailyChores: () => Promise<void>;
  config: TickConfig;
};

export type TickReply = { status: number; body: Record<string, unknown> };

export type OwnerAlarm = "no-admin" | "admin-status" | "no-token" | "decrypt";

/** The owner alarm's verdict (§7.2 step 0, §5.3). */
export function ownerAlarm(a: OwnerAlarmRow): OwnerAlarm | null {
  if (a.adminStatus === null) return "no-admin";
  if (a.adminStatus !== "active") return "admin-status";
  if (!a.adminHasToken) return "no-token";
  if (a.adminDecrypt || a.decryptUsers >= 2) return "decrypt";
  return null;
}

const TAB_TAKES_OVER_MS = 5 * 60_000;
const DAILY_LOCK_MS = 15 * 60_000;
const RESCAN_RETRY_MS = 10 * 60_000;
const RESCAN_ACTIVE_MS = 30 * 60_000;
const RESCAN_IDLE_MS = 150 * 60_000;
const GRANT_WINDOW_MS = 24 * 3_600_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

function withDeadline<T>(p: Promise<T>, at: number, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<T>((r) => {
    timer = setTimeout(() => r(late()), Math.max(0, at - Date.now()));
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

const failed = (code: StepCode): StepOutcome => ({
  code,
  trigger: null,
  added: 0,
  harvestedAt: null,
  probe: null,
  cooldown: null,
});

/** A getter bound to one uid: one token read per step, reused while it has a minute left. */
function boundToken(uid: Uid, read: TickDeps["tokenFor"]): () => Promise<OwnedToken> {
  let held: UserTokens | null = null;
  return async () => {
    if (held && Date.now() / 1000 < held.expiresAt - 60) return { uid: held.uid, accessToken: held.accessToken };
    const t = await read(uid);
    if (!t) throw new NoTokenError();
    if (t.uid !== uid) throw new Error("token owner mismatch");
    held = t;
    return { uid: t.uid, accessToken: t.accessToken };
  };
}

/** What the queue keeps after a step. A user claimed early (an open tab's load) keeps their due
 *  time; a due one moves two minutes on, or into backoff. */
function releaseFor(u: ClaimedUser, o: StepOutcome, now: number): Release {
  const keepsDue = u.nextProbeAt > now + EARLY_MS;
  switch (o.code) {
    case "ok":
    case "quota":
    case "rate-limited":
      return {
        state: syncStateFor(o.probe, now),
        nextProbeAt: keepsDue ? u.nextProbeAt : nextDue(u.uid, u.nextProbeAt, now),
        failures: 0,
        lastError: o.code === "ok" ? null : o.code,
        lastOkAt: o.code === "ok" ? now : null,
        lastHarvestAt: o.harvestedAt,
      };
    case "invalid-grant":
      // Not leasable once needs_reconnect; the error is what the confirmation looks for.
      return { state: "idle", nextProbeAt: u.nextProbeAt, failures: u.failures, lastError: "invalid_grant", lastOkAt: null, lastHarvestAt: null };
    default:
      return {
        state: "backoff",
        nextProbeAt: now + backoffMs(u.failures + 1),
        failures: u.failures + 1,
        lastError: o.code,
        lastOkAt: null,
        lastHarvestAt: o.harvestedAt,
      };
  }
}

type Served = { user: ClaimedUser; store: StepStore | null; token: () => Promise<OwnedToken>; outcome: StepOutcome | null };

const toServe = (deps: TickDeps, claim: Claim): Served[] =>
  claim.users.map((user) => ({ user, store: null, token: boundToken(user.uid, deps.tokenFor), outcome: null }));

/** Run the claimed users' steps, filling in each outcome as it lands (so a reply sent before the
 *  last one shows the rest as pending), and release each from its outcome. `clock` is the tick's
 *  time now. */
async function serve(
  deps: TickDeps,
  claim: Claim,
  served: Served[],
  tick: string,
  now: number,
  clock: () => number,
  openApp: boolean,
): Promise<void> {
  const { config, queue } = deps;
  const view: StepView = {
    now,
    rpTotal: claim.rpTotal,
    users: claim.activeUsers,
    brakeOn: config.brakeOn,
    backstopMs: config.backstopMs,
    cooldowns: claim.cooldowns,
    openApp,
  };

  const settle = async (s: Served, o: StepOutcome) => {
    if (o.cooldown) await queue.extendCooldown(o.cooldown.bucket, o.cooldown.until);
    // A blob or key the deployment cannot read: nothing about the user is written (§5.3), and
    // the lease lapses on its own.
    if (o.code === "decrypt") return;
    if (o.code === "invalid-grant") {
      // §5.4 step 1: stop at once, keep the data and the blob.
      await queue.moveStatus(s.user.uid, "active", "needs_reconnect", now);
      await queue.recordAppEvent("invalid-grant", s.user.uid, now);
    }
    await queue.releaseLease(s.user.uid, tick, clock(), releaseFor(s.user, o, now));
  };

  await Promise.allSettled(
    served.map(async (s) => {
      const deadline = Date.now() + config.stepMs;
      let o: StepOutcome;
      try {
        s.store = deps.storeFor(s.user);
        const u = s.user;
        o = await withDeadline(
          runStep(
            {
              uid: u.uid,
              store: s.store,
              token: s.token,
              deadline,
              queue: { lastHarvestAt: u.lastHarvestAt, quotaDay: u.quotaDay, rpCalls: u.rpCalls, countRpCall: (day) => queue.countRpCall(u.uid, day) },
            },
            view,
          ),
          deadline,
          () => failed("timeout"),
        );
      } catch {
        // A user database refused (a wrong owner, behind on schema): that user's step skips.
        o = failed("store-error");
      }
      s.outcome = o;
      if (o.code !== "not-registered") await settle(s, o).catch((e) => console.error(`[tick] release ${s.user.uid}: ${String(e)}`));
    }),
  );

  // §7.8: a 403 "not registered" removes a friend only while someone else's calls still work, in
  // this tick or within 10 minutes; when every user fails that way (the owner's Premium lapsing
  // looks like this) everyone backs off. Never the admin.
  const notRegistered = served.filter((s) => s.outcome?.code === "not-registered");
  if (notRegistered.length > 0) {
    const working = new Set<string>([...claim.okRecent, ...served.filter((s) => s.outcome?.code === "ok").map((s) => s.user.uid)]);
    for (const s of notRegistered) {
      const someoneElse = [...working].some((uid) => uid !== s.user.uid);
      if (someoneElse && !s.user.isAdmin && (await queue.moveStatus(s.user.uid, "active", "removed", now).catch(() => false))) {
        await queue.releaseLease(s.user.uid, tick, clock(), { ...releaseFor(s.user, s.outcome!, now), state: "idle" }).catch(() => {});
      } else {
        await settle(s, s.outcome!).catch(() => {});
      }
    }
  }

  // §5.4 step 3: two or more users, or the admin, hit within 24 hours is Spotify's event, not
  // theirs; the health check reports it, and nothing moves toward deletion.
  if (served.some((s) => s.outcome?.code === "invalid-grant")) {
    const hit = await queue.grantFailuresSince(now - GRANT_WINDOW_MS).catch(() => null);
    if (hit && (hit.users >= 2 || hit.admin)) await queue.recordAppEvent("grant-wide", null, now).catch(() => {});
  }
}

/** §5.4 step 2: one more refresh, at least 10 minutes on, for at most one user; no data calls. */
async function confirmGrant(deps: TickDeps, uid: Uid, now: number): Promise<void> {
  if (!(await deps.queue.startGrantConfirm(uid))) return;
  let result: "ok" | "dead" | "unknown";
  try {
    result = (await deps.tokenFor(uid)) ? "ok" : "dead";
  } catch (e) {
    result = e instanceof RefreshError && e.terminal ? "dead" : "unknown";
  }
  if (result === "ok") await deps.queue.moveStatus(uid, "needs_reconnect", "active", now);
  await deps.queue.finishGrantConfirm(uid, result, now);
}

/** At most one library rescan (§7.7), for the most overdue user whose step succeeded. */
async function maybeRescan(deps: TickDeps, served: Served[], now: number, deadline: number): Promise<string | null> {
  const due = served
    .filter((s) => s.outcome?.code === "ok" && s.store && (s.user.nextRescanAt === null || s.user.nextRescanAt <= now))
    .sort((a, b) => (a.user.nextRescanAt ?? 0) - (b.user.nextRescanAt ?? 0));
  const s = due[0];
  if (!s || !(await deps.queue.claimRescan(s.user.uid, now, now + RESCAN_RETRY_MS))) return null;
  await s.store!.rescanLibrary(spotifyClient(s.user.uid, s.token, true, "cron-library-scan"), deadline);
  const every = syncStateFor(s.outcome!.probe, now) === "active" ? RESCAN_ACTIVE_MS : RESCAN_IDLE_MS;
  await deps.queue.scheduleRescan(s.user.uid, now + every);
  return s.user.uid;
}

/** §7.11: the daily chores, when the last run is over 26 hours old, in after(). */
function maybeDaily(deps: TickDeps, dailyAt: number | null, now: number): "started" | null {
  if (dailyAt !== null && now - dailyAt <= DAILY_STALE_MS) return null;
  const run = (async () => {
    const owner = await deps.queue.acquireAppLock("lock:daily", DAILY_LOCK_MS);
    if (!owner) return;
    await deps.dailyChores();
    await deps.queue.setAppMeta("daily_at", String(deps.now()));
    await deps.queue.releaseAppLock("lock:daily", owner);
  })().catch((e) => console.error(`[tick] daily chores: ${String(e)}`));
  deps.after(run);
  return "started";
}

const stepsBody = (served: Served[]) =>
  served.map((s) => ({
    uid: s.user.uid,
    outcome: s.outcome?.code ?? "pending",
    ...(s.outcome?.trigger ? { trigger: s.outcome.trigger } : {}),
    ...(s.outcome?.harvestedAt ? { added: s.outcome.added } : {}),
  }));

/** `GET /api/cron/sync`. */
export async function runTick(deps: TickDeps, authorization: string | null): Promise<TickReply> {
  const caller = deps.caller(authorization);
  if (!caller) return { status: 401, body: { ok: false, error: "forbidden" } };
  const zenbook = caller === "zenbook";
  const started = Date.now();
  const now = deps.now();
  const clock = () => now + (Date.now() - started);

  let alarm: OwnerAlarm | null = null;
  if (zenbook) {
    try {
      alarm = ownerAlarm(await deps.queue.readOwnerAlarm(now));
    } catch {
      // The store did not answer; the stamp below meets the same and ends the tick.
    }
  }
  const answer = (body: Record<string, unknown>): TickReply => {
    if (!zenbook) return { status: 200, body: { ok: true } };
    return alarm ? { status: 503, body: { ok: false, error: alarm } } : { status: 200, body: { ok: true, ...body } };
  };

  try {
    if (!(await deps.queue.stampTick(now, deps.config.stampWindowMs))) return answer({ skipped: "recent tick" });
  } catch {
    return answer({ skipped: "store" });
  }
  const tick = randomUUID();
  let claim: Claim;
  try {
    claim = await deps.queue.claimDueUsers({ tick, now, signups: deps.config.signups });
  } catch {
    return answer({ skipped: "store" });
  }
  const daily = maybeDaily(deps, claim.dailyAt, now);

  const replyAt = started + deps.config.replyMs;
  const served = toServe(deps, claim);
  const extra: { rescan?: string } = {};
  const work = (async () => {
    await serve(deps, claim, served, tick, now, clock, false);
    if (claim.confirmUid) await confirmGrant(deps, claim.confirmUid, now).catch((e) => console.error(`[tick] confirm: ${String(e)}`));
    if (replyAt - Date.now() >= deps.config.rescanMinLeftMs) {
      const uid = await maybeRescan(deps, served, now, replyAt).catch((e) => {
        console.error(`[tick] rescan: ${String(e)}`);
        return null;
      });
      if (uid) extra.rescan = uid;
    }
  })();
  const done = await Promise.race([work.then(() => true), sleep(replyAt - Date.now()).then(() => false)]);
  if (!done) deps.after(work);

  // §5.3: two or more users, or the admin, failing to decrypt in this tick, too.
  const decrypts = served.filter((s) => s.outcome?.code === "decrypt");
  if (decrypts.length >= 2 || decrypts.some((s) => s.user.isAdmin)) alarm ??= "decrypt";
  return answer({ steps: stepsBody(served), ...extra, ...(daily ? { daily } : {}), ...(done ? {} : { after: true }) });
}

/** `/api/sync` (§7.6): the same step under the same lease, for the signed-in user only. A load or a
 *  return to the tab (`load`) harvests a change the brake held back, at least 60 s after the last
 *  harvest; the tab's own 2-minute timer runs a step only when no tick has stamped in 5 minutes, so
 *  an open app keeps capturing when both pingers are down. */
export async function runOpenApp(
  deps: TickDeps,
  o: { uid: Uid; load: boolean },
): Promise<{ ran: boolean; outcome?: StepCode; trigger?: HarvestTrigger | null; reason?: string }> {
  const started = Date.now();
  const now = deps.now();
  if (!o.load) {
    const at = Number(await deps.queue.getAppMeta("tick_at")) || 0;
    if (now - at < TAB_TAKES_OVER_MS) return { ran: false, reason: "cron" };
  }
  const tick = `tab:${randomUUID()}`;
  const claim = await deps.queue.claimUser({ uid: o.uid, tick, now, dueOnly: !o.load, signups: deps.config.signups });
  if (claim.users.length !== 1 || claim.users[0].uid !== o.uid) return { ran: false, reason: "busy" };
  const served = toServe(deps, claim);
  await serve(deps, claim, served, tick, now, () => now + (Date.now() - started), o.load);
  return { ran: true, outcome: served[0].outcome?.code, trigger: served[0].outcome?.trigger ?? null };
}
