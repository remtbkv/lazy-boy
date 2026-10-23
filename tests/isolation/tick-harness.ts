// The tick's simulated world (PLAN.md §6.4, T4, T13): a Spotify scripted per bearer that logs which
// bearer each call carried, a store per user in memory that records whose plays it was handed, and
// deps for src/lib/sync/tick.ts over the real app database (freshAppDb).
import { expect, vi } from "vitest";
import { appQueue, PHASE3_TICK, type TickConfig, type TickDeps } from "@/lib/sync/tick";
import type { RecentPlay, StepStore } from "@/lib/sync/step";
import type { ProbeState } from "@/lib/harvest-policy";
import type { Uid } from "@/lib/identity";
import type { UserTokens } from "@/lib/token-core";
import { cronCaller } from "@/lib/cron-auth";

export const FAR = 4_000_000_000;

type Player = { trackId: string; isPlaying: boolean; progressMs: number } | null;
/** What Spotify does for one bearer: its player, its recent plays, or a failure per endpoint. */
export type Script = {
  player?: Player | "hang" | number;
  recent?: { trackId: string; playedAt: string }[] | "hang" | number | { status: number; body: string };
};

export type Call = { path: string; bearer: string | null };

const rawTrack = (id: string) => ({
  id,
  name: `name ${id}`,
  uri: `spotify:track:${id}`,
  type: "track",
  artists: [{ name: `artist ${id}` }],
  album: { name: `album ${id}`, images: [] },
  duration_ms: 180_000,
});

function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const s = init?.signal;
    s?.addEventListener("abort", () => reject(s.reason ?? new Error("aborted")));
  });
}

/** A Spotify answering per bearer. Install with `vi.stubGlobal("fetch", spotify.fetch)`. */
export function tickSpotify(scripts: Record<string, Script>) {
  const calls: Call[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const auth = new Headers(init?.headers).get("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    calls.push({ path: url.pathname, bearer });
    const s = bearer ? scripts[bearer] : undefined;
    if (!s) return new Response("no such token", { status: 401 });
    if (url.pathname === "/v1/me/player") {
      const p = s.player ?? null;
      if (p === "hang") return hang(init);
      if (typeof p === "number") return new Response("player failed", { status: p });
      if (p === null) return new Response(null, { status: 204 });
      return Response.json({ is_playing: p.isPlaying, progress_ms: p.progressMs, item: rawTrack(p.trackId) });
    }
    if (url.pathname === "/v1/me/player/recently-played") {
      const r = s.recent ?? [];
      if (r === "hang") return hang(init);
      if (typeof r === "number") return new Response("recent failed", { status: r });
      if (!Array.isArray(r)) return new Response(r.body, { status: r.status, headers: { "Retry-After": "3600" } });
      return Response.json({ items: r.map((x) => ({ track: rawTrack(x.trackId), played_at: x.playedAt, context: null })) });
    }
    return new Response("not scripted", { status: 404 });
  };
  return { calls, fetch: vi.fn(fetchImpl) };
}

/** One user's store in memory: their probe, their plays, and every play it was ever handed. */
export function memoryStepStore(owner: string) {
  let probe: ProbeState | null = null;
  const plays = new Map<string, RecentPlay>();
  const handed: string[] = [];
  let rescans = 0;
  const store: StepStore = {
    async readProbe() {
      return probe;
    },
    async writeProbe(p) {
      probe = p;
    },
    async recordHarvest(items) {
      let added = 0;
      for (const p of items) {
        handed.push(p.track.id);
        const k = `${p.track.id}\n${p.playedAt}`;
        if (!plays.has(k)) {
          plays.set(k, p);
          added++;
        }
      }
      return { added };
    },
    async rescanLibrary() {
      rescans++;
    },
  };
  return {
    owner,
    store,
    plays,
    handed,
    get probe() {
      return probe;
    },
    set probe(p: ProbeState | null) {
      probe = p;
    },
    get rescans() {
      return rescans;
    },
  };
}

/** Each user's access token is `at-<uid>`; `tokens[uid]` may instead be a function that throws. */
export function tokenSource(tokens: Record<string, (() => UserTokens | null) | undefined>) {
  return async (uid: Uid): Promise<UserTokens | null> => {
    const t = tokens[uid];
    if (t) return t();
    return { uid, accessToken: `at-${uid}`, refreshToken: `rt-${uid}`, expiresAt: FAR };
  };
}

export function tickDeps(o: {
  now: () => number;
  stores: Record<string, ReturnType<typeof memoryStepStore>>;
  tokenFor?: TickDeps["tokenFor"];
  config?: Partial<TickConfig>;
  storeFor?: TickDeps["storeFor"];
  queue?: TickDeps["queue"];
  budgetMode?: TickDeps["budgetMode"];
}) {
  const afters: Promise<unknown>[] = [];
  const daily = vi.fn(async () => {});
  const deps: TickDeps = {
    now: o.now,
    caller: cronCaller,
    queue: o.queue ?? appQueue,
    storeFor: o.storeFor ?? ((u) => o.stores[u.uid].store),
    tokenFor: o.tokenFor ?? tokenSource({}),
    after: (w) => {
      afters.push(w);
    },
    dailyChores: daily,
    budgetMode: o.budgetMode ?? (async () => "normal"),
    config: { ...PHASE3_TICK, signups: "invite", ...o.config },
  };
  return { deps, afters, daily };
}

export const ZEN = "Bearer zen-secret";
export const EXT = "Bearer ext-secret";
export function stubCronSecrets() {
  vi.stubEnv("CRON_SECRET", "zen-secret");
  vi.stubEnv("CRON_SECRET_EXT", "ext-secret");
}

// ── Checks the planted-bug self-test runs (tests/isolation/planted-bugs.test.ts) ─────────────

const CHECK_NOW = Date.UTC(2026, 9, 16, 18, 0);

/** §6.2 layer 4: each step gets its own user's store. Two live users with token rows (the second
 *  the admin) and one tick: every play a store was handed is its owner's. `storeFor` builds the
 *  tick's store lookup over the two memory stores. */
export async function expectStepsKeepToTheirStore(
  a: Uid,
  b: Uid,
  storeFor: (stores: Record<string, ReturnType<typeof memoryStepStore>>) => TickDeps["storeFor"],
): Promise<void> {
  const stores = { [a]: memoryStepStore(a), [b]: memoryStepStore(b) };
  const play = (uid: string): Script => ({
    player: { trackId: `${uid}-now`, isPlaying: true, progressMs: 1_000 },
    recent: [{ trackId: `${uid}-t1`, playedAt: "2026-10-16T17:55:00.000Z" }],
  });
  vi.stubGlobal("fetch", tickSpotify({ [`at-${a}`]: play(a), [`at-${b}`]: play(b) }).fetch);
  stubCronSecrets();
  const { deps } = tickDeps({ now: () => CHECK_NOW, stores, storeFor: storeFor(stores) });
  const { runTick } = await import("@/lib/sync/tick");
  await runTick(deps, ZEN);
  for (const uid of [a, b]) {
    expect(stores[uid].handed.length, `${uid} was harvested`).toBeGreaterThan(0);
    expect(stores[uid].handed.filter((id) => !id.startsWith(`${uid}-`)), `${uid}'s store holds only ${uid}'s plays`).toEqual([]);
  }
}

/** §7.2 step 3: a release lands only for the tick that holds the lease. `a` is a live user with
 *  no queue row yet; tick t1 leases it, the lease runs out, tick t2 takes it, then t1's late
 *  release must write nothing and t2 must still hold it. */
export async function expectReleaseNeedsItsLease(
  a: Uid,
  release: (uid: Uid, tick: string, now: number, w: import("@/lib/app-db").Release) => Promise<boolean>,
): Promise<void> {
  const { claimDueUsers } = await import("@/lib/app-db");
  await claimDueUsers({ tick: "t1", now: CHECK_NOW, signups: "invite" });
  expect((await claimDueUsers({ tick: "t2", now: CHECK_NOW + 51_000, signups: "invite" })).users.map((u) => u.uid)).toContain(a);
  const late = { state: "idle" as const, nextProbeAt: CHECK_NOW + 999_000, failures: 0, lastError: null, lastOkAt: null, lastHarvestAt: null };
  expect(await release(a, "t1", CHECK_NOW + 52_000, late)).toBe(false);
  expect((await claimDueUsers({ tick: "t3", now: CHECK_NOW + 53_000, signups: "invite" })).users.map((u) => u.uid)).not.toContain(a);
}
