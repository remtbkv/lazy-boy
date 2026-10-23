// One user's step of the cron tick (docs/multi-user/PLAN.md §7.2 step 3, §6.2 layer 4): probe,
// harvest if the policy says so, record into the user's own store. It receives everything it may
// touch as arguments: its Uid, its UserStore, a token getter bound to that uid, its deadline, and
// its own row of the due queue (read by the claim, its counter bound to its uid). It holds no
// other user's store, token or row, and it never writes the queue's schedule: the tick releases
// the lease from the outcome this returns (tick.ts), so a step abandoned at its deadline cannot.
import { brakeMode, quotaDay, nextQuotaReset, type BrakeMode } from "@/lib/brake";
import {
  afterHarvest,
  decideHarvest,
  observe,
  type HarvestTrigger,
  type PlayerObservation,
  type ProbeState,
} from "@/lib/harvest-policy";
import type { Uid } from "@/lib/identity";
import { spotifyClient, SpotifyError, type OwnedToken } from "@/lib/spotify";
import { TokenKeyError } from "@/lib/token-keys";
import { DecryptError } from "@/lib/token-crypto";
import { RefreshError } from "@/lib/token-core";

export type Spotify = ReturnType<typeof spotifyClient>;
export type RecentPlay = Awaited<ReturnType<Spotify["recentlyPlayed"]>>[number];

/** The part of a user's store (Phase 1's `UserStore`, `forUser(uid)`) a step uses. */
export interface StepStore {
  /** `meta.probe` (§4.3): what the probe last saw. */
  readProbe(): Promise<ProbeState | null>;
  writeProbe(p: ProbeState): Promise<void>;
  /** One harvest's plays into the user's store (natural keys, safe to repeat), their contexts
   *  resolved with the user's own client; today's syncRecentPlays after its Spotify call. */
  recordHarvest(plays: RecentPlay[], sp: Spotify): Promise<{ added: number }>;
  /** One resumable library rescan (§7.7), committing per playlist; today's syncLibrary. */
  rescanLibrary(sp: Spotify, deadline: number): Promise<void>;
}

/** The step's own row of the due queue: what the claim read, and the brake's counter bound to
 *  this uid (awaited before each recently-played call, §7.5). */
export type StepQueue = {
  lastHarvestAt: number | null;
  quotaDay: string | null;
  rpCalls: number;
  countRpCall(day: string): Promise<number>;
};

export type StepContext = {
  uid: Uid;
  store: StepStore;
  /** A currently valid access token for this uid, naming it (the client checks); throws
   *  NoTokenError, RefreshError, DecryptError… */
  token: () => Promise<OwnedToken>;
  /** Epoch ms: no Spotify call starts after it. */
  deadline: number;
  queue: StepQueue;
};

/** The tick's view, the same for every step: app-wide scalars, no user's data. */
export type StepView = {
  now: number;
  /** The brake's inputs: the app's total this quota day and N (§7.5). */
  rpTotal: number;
  users: number;
  brakeOn: boolean;
  backstopMs: number;
  /** `cooldown:<bucket>` → until. */
  cooldowns: Record<string, number>;
  /** A load or a return to the tab (§7.6). */
  openApp: boolean;
};

export class NoTokenError extends Error {
  constructor() {
    super("no token row");
    this.name = "NoTokenError";
  }
}

export type StepCode =
  | "ok"
  /** The app-wide rate limit (seconds; the client's cooldown): nobody's failure. */
  | "rate-limited"
  /** A bucket's QUOTA_EXCEEDED: the bucket cools down, the user is not backed off. */
  | "quota"
  | "no-token"
  | "invalid-grant"
  /** The blob or the keys: the deployment's fault, nothing written (§5.3). */
  | "decrypt"
  | "token-error"
  | "not-registered"
  | "spotify-error"
  | "store-error"
  | "timeout";

export type StepOutcome = {
  code: StepCode;
  trigger: HarvestTrigger | null;
  added: number;
  /** Set when a harvest landed. */
  harvestedAt: number | null;
  /** The probe state after the step, for the queue's `state`. */
  probe: ProbeState | null;
  cooldown: { bucket: string; until: number } | null;
};

const outcome = (code: StepCode, o: Partial<StepOutcome> = {}): StepOutcome => ({
  code,
  trigger: null,
  added: 0,
  harvestedAt: null,
  probe: null,
  cooldown: null,
  ...o,
});

// A bucket's QUOTA_EXCEEDED cools it until the observed reset (14:51 UTC), but never longer than
// the client's persisted cap for a long ban (client.ts PERSIST_COOLDOWN_CAP_MS): one re-probe per
// half hour cannot sustain a ban, and the reset drifts.
const QUOTA_COOLDOWN_MAX_MS = 30 * 60_000;
const quotaCooldownUntil = (now: number) => Math.min(now + QUOTA_COOLDOWN_MAX_MS, nextQuotaReset(now));

/** Why a Spotify call failed, as a step code; null when it is not Spotify's answer. */
function spotifyFailure(e: unknown): StepCode | null {
  if (e instanceof SpotifyError) {
    if (e.status === 429) return /QUOTA_EXCEEDED/.test(e.message) ? "quota" : "rate-limited";
    // Spotify's two wordings: "The user is not registered for this application" (GOTCHAS) and
    // "Check settings on developer.spotify.com/dashboard, the user may not be registered."
    if (e.status === 403 && /not (be )?registered/i.test(e.message)) return "not-registered";
    return "spotify-error";
  }
  // Network errors and timeouts (fetch's TypeError, AbortSignal.timeout's TimeoutError).
  if (e instanceof Error && (e.name === "TypeError" || e.name === "TimeoutError" || e.name === "AbortError")) {
    return "spotify-error";
  }
  return null;
}

function tokenFailure(e: unknown): StepCode {
  if (e instanceof NoTokenError) return "no-token";
  if (e instanceof RefreshError && e.terminal) return "invalid-grant";
  if (e instanceof DecryptError || e instanceof TokenKeyError) return "decrypt";
  return "token-error";
}

export async function runStep(ctx: StepContext, view: StepView): Promise<StepOutcome> {
  const { now } = view;
  try {
    await ctx.token();
  } catch (e) {
    return outcome(tokenFailure(e));
  }

  let prev: ProbeState | null;
  try {
    prev = await ctx.store.readProbe();
  } catch {
    return outcome("store-error");
  }

  // The probe, unless the player bucket is cooling down. A player refusal leaves the policy blind
  // to track changes, and its 30-minute rule takes over (§7.8). So does a probe that fails on its
  // own (a 5xx, a timeout): the user backs off, but the backstop still harvests, as the
  // single-user route did when its player check failed, so a failing probe never stops capture.
  let probeOk = false;
  let probeFailed: StepCode | null = null;
  let obs: PlayerObservation = null;
  let cooldown: StepOutcome["cooldown"] = null;
  if (now >= (view.cooldowns.player ?? 0)) {
    try {
      obs = await spotifyClient(ctx.uid, ctx.token, false, "cron-probe").resources.playerState();
      probeOk = true;
    } catch (e) {
      const code = spotifyFailure(e) ?? tokenFailure(e);
      if (code === "quota") cooldown = { bucket: "player", until: quotaCooldownUntil(now) };
      else if (code === "spotify-error") probeFailed = code;
      else return outcome(code, { probe: prev });
    }
  }
  const settled = (): StepCode => probeFailed ?? (cooldown ? "quota" : "ok");

  let probe = prev;
  if (probeOk) {
    const o = observe(prev, obs, now);
    probe = o.next;
    if (o.write) {
      try {
        await ctx.store.writeProbe(probe);
      } catch {
        return outcome("store-error", { probe: prev, cooldown });
      }
    }
  }

  const day = quotaDay(now);
  const mine = ctx.queue.quotaDay === day ? ctx.queue.rpCalls : 0;
  const brake: BrakeMode = brakeMode({ mine, total: view.rpTotal, users: view.users, on: view.brakeOn });
  const trigger = decideHarvest({
    now,
    probe,
    probeOk,
    lastHarvestAt: ctx.queue.lastHarvestAt,
    brake,
    backstopMs: view.backstopMs,
    cooldownUntil: view.cooldowns["recently-played"] ?? 0,
    openApp: view.openApp,
  });
  if (!trigger || Date.now() >= ctx.deadline) return outcome(settled(), { probe, cooldown });

  // The count first, awaited, so a lost write cannot undercount (§7.5 item 1).
  try {
    await ctx.queue.countRpCall(day);
  } catch {
    return outcome("store-error", { probe, cooldown });
  }
  const sp = spotifyClient(ctx.uid, ctx.token, false, `harvest:${trigger}`);
  let plays: RecentPlay[];
  try {
    plays = await sp.recentlyPlayed(50);
  } catch (e) {
    const code = spotifyFailure(e) ?? tokenFailure(e);
    if (code === "quota") {
      return outcome("quota", { probe, trigger, cooldown: { bucket: "recently-played", until: quotaCooldownUntil(now) } });
    }
    return outcome(code, { probe, trigger, cooldown });
  }
  let added: number;
  try {
    ({ added } = await ctx.store.recordHarvest(plays, sp));
    if (probe) {
      const after = afterHarvest(probe, trigger, now);
      if (JSON.stringify(after) !== JSON.stringify(probe)) await ctx.store.writeProbe(after);
      probe = after;
    }
  } catch {
    return outcome("store-error", { probe, trigger, cooldown });
  }
  return outcome(settled(), { trigger, added, harvestedAt: now, probe, cooldown });
}
