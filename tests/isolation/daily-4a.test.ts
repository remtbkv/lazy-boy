// The daily chores Phase 4a adds (PLAN.md §7.11 as RULINGS Oct 15 change it): which users each
// chore hands to the deletion job, the hold while an app-wide invalid_grant event stands, the
// sweeps, and the two cron-job.org jobs re-enabled. No dormant or twelve-month trigger exists.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppMeta } from "@/lib/app-db";
import { ensureCronJobsEnabled } from "@/lib/cronjob-jobs";
import { runPhase4aChores, type DailyDeps } from "@/lib/daily-4a";
import { freshAppDb, seedUser } from "./harness";

const NOW = Date.UTC(2026, 9, 20, 9, 0);
const DAY = 86_400_000;
let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number | null> = {}) => (await db.raw().execute({ sql, args })).rows;

function deps(): DailyDeps & { deleted: string[]; withdrawn: string[] } {
  const deleted: string[] = [];
  const withdrawn: string[] = [];
  return {
    deleted,
    withdrawn,
    now: () => NOW,
    deleteAccount: async (uid) => (deleted.push(uid), { kind: "done" }),
    withdrawInvite: async (uid) => (withdrawn.push(uid), { kind: "done" }),
    reenableJobs: async () => "skipped",
  };
}

beforeEach(async () => {
  db = freshAppDb();
  await getAppMeta("schema_version");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the deletion chores", () => {
  beforeEach(async () => {
    const rows: [string, string, number, boolean?][] = [
      ["aaaaaaaaaaaa", "revoked", NOW - 10 * DAY, true], // the admin, revoked long ago: never
      ["bbbbbbbbbbbb", "revoked", NOW - 3 * DAY], // day 4
      ["cccccccccccc", "revoked", NOW - 2 * DAY], // not yet
      ["dddddddddddd", "deleting", NOW - 1 * DAY], // a deletion to retry
      ["eeeeeeeeeeee", "needs_reconnect", NOW - 30 * DAY], // kept while it waits for its owner
      ["ffffffffffff", "active", NOW - 400 * DAY], // no twelve-month rule
      ["gggggggggggg", "disabled", NOW - 400 * DAY],
    ];
    for (const [uid, status, at, admin] of rows) await seedUser(db.raw(), { uid, status, statusAt: at, admin });
    // An unclaimed invite past 14 days, one inside it, and a claimed one.
    for (const [uid, at, aid] of [["hhhhhhhhhhhh", NOW - 15 * DAY, null], ["iiiiiiiiiiii", NOW - 13 * DAY, null], ["jjjjjjjjjjjj", NOW - 20 * DAY, "acct-j"]] as const) {
      await q("INSERT INTO users (uid, account_id, spotify_id, db_name, status, status_at, invited_at) VALUES (:u, :a, 'sp-' || :u, :d, :s, :t, :t)", {
        u: uid,
        a: aid,
        d: `lb-u-${uid}`,
        s: aid ? "active" : "invited",
        t: at,
      });
    }
  });

  it("retries deletions, deletes day-4 revocations, expires 14-day invites, and nothing else", async () => {
    const d = deps();
    const out = await runPhase4aChores(d);
    expect(d.deleted.sort()).toEqual(["bbbbbbbbbbbb", "dddddddddddd"]);
    expect(d.withdrawn).toEqual(["hhhhhhhhhhhh"]);
    expect(out.deletions).toBe("retried done; day4 done; invites done");
    expect(JSON.stringify(out)).not.toMatch(/[a-z2-7]{12}/);
  });

  it("holds every day-4 deletion while an app-wide invalid_grant event stands", async () => {
    await q("INSERT INTO events (at, uid, code) VALUES (:t, NULL, 'grant-wide')", { t: NOW - 3 * DAY });
    const d = deps();
    const out = await runPhase4aChores(d);
    expect(d.deleted).toEqual(["dddddddddddd"]);
    expect(out.deletions).toContain("day4 held:grant-wide");
  });
});

describe("the sweeps", () => {
  it("removes old deleted rows, orphan token, queue and lock rows, stale pending requests and old health records; keeps the rest", async () => {
    await seedUser(db.raw(), { uid: "aaaaaaaaaaaa", status: "active", admin: true });
    await seedUser(db.raw(), { uid: "bbbbbbbbbbbb", status: "deleted", statusAt: NOW - 6 * DAY });
    await seedUser(db.raw(), { uid: "cccccccccccc", status: "deleted", statusAt: NOW - 4 * DAY });
    for (const u of ["aaaaaaaaaaaa", "zzzzzzzzzzzz"]) {
      await q("INSERT INTO user_tokens (uid, blob, expires_at, granted_at) VALUES (:u, 'b', 0, 0)", { u });
      await q("INSERT INTO sync_state (uid, state, next_probe_at) VALUES (:u, 'idle', 0)", { u });
      await q("INSERT INTO app_meta (key, value) VALUES (:k, '1')", { k: `lock:spotify_refresh:${u}` });
    }
    await q("INSERT INTO requests (id, email, name, status, created_at, status_at, terms_version) VALUES ('rrrrrrrrrrr1', 'old@x.io', 'n', 'pending', :t, :t, 'v')", { t: NOW - 15 * DAY });
    await q("INSERT INTO requests (id, email, name, status, created_at, status_at, terms_version) VALUES ('rrrrrrrrrrr2', 'new@x.io', 'n', 'pending', :t, :t, 'v')", { t: NOW - 1 * DAY });
    await q("INSERT INTO app_meta (key, value) VALUES (:a, 'isolation'), (:b, 'daily')", { a: `health_red:${NOW - 31 * DAY}`, b: `health_red:${NOW - 1 * DAY}` });

    const out = await runPhase4aChores(deps());
    expect(JSON.parse(out.sweeps)).toEqual({ deletedRows: 1, orphanTokens: 1, orphanQueue: 1, orphanLocks: 1, pendingRequests: 1, healthRecords: 1 });
    expect((await q("SELECT uid FROM users ORDER BY uid")).map((r) => r.uid)).toEqual(["aaaaaaaaaaaa", "cccccccccccc"]);
    expect((await q("SELECT uid FROM user_tokens")).map((r) => r.uid)).toEqual(["aaaaaaaaaaaa"]);
    expect((await q("SELECT key FROM app_meta WHERE key LIKE 'lock:%'")).map((r) => r.key)).toEqual(["lock:spotify_refresh:aaaaaaaaaaaa"]);
    expect((await q("SELECT id FROM requests")).map((r) => r.id)).toEqual(["rrrrrrrrrrr2"]);
    expect((await q("SELECT key FROM app_meta WHERE key LIKE 'health_red:%'")).map((r) => r.key)).toEqual([`health_red:${NOW - DAY}`]);
  });
});

describe("re-enabling the two cron-job.org jobs", () => {
  it("enables a disabled job, leaves an enabled one, and does nothing without its settings", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (init?.method === "PATCH") return new Response("{}");
        return Response.json({ jobDetails: { enabled: url.endsWith("/111") } });
      }),
    );
    expect(await ensureCronJobsEnabled({ CRONJOB_API_KEY: "k", CRONJOB_JOB_IDS: "111, 222" })).toEqual({ "111": "already-on", "222": "enabled" });
    expect(calls).toEqual(["GET https://api.cron-job.org/jobs/111", "GET https://api.cron-job.org/jobs/222", "PATCH https://api.cron-job.org/jobs/222"]);
    expect(await ensureCronJobsEnabled({ CRONJOB_JOB_IDS: "111" })).toBe("skipped");
    expect(await ensureCronJobsEnabled({ CRONJOB_API_KEY: "k" })).toBe("skipped");
  });
});
