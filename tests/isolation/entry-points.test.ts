// T3's census (PLAN.md §6.4): every page, layout, route handler and "use server" module under
// src/app, found by globbing, must be in this registry: gated by requireUser (checked here by
// its source calling one of the require*User functions), exempt by name, or PENDING with the
// reason it is not gated yet. A new entry point with no entry fails the suite. The behavioural
// half of T3 (no session, as B, as B with A's ids) runs per gated entry point in
// process-state.test.ts and now-playing-route.test.ts; for the rest it waits for their gates.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const ENTRY = walk(path.join(ROOT, "src/app"))
  .map((p) => path.relative(ROOT, p))
  .filter((rel) => {
    const base = path.basename(rel);
    if (["page.tsx", "layout.tsx", "route.ts"].includes(base)) return true;
    return /\.(ts|tsx)$/.test(base) && /^\s*["']use server["']/.test(readFileSync(path.join(ROOT, rel), "utf8"));
  })
  .sort();

type Status = { gated: true } | { exempt: string } | { pending: string };
const QUEUED = "in a file queued lanes edit (STORE_MIGRATION, P2-P4); gated in Phase 1's turn";

const REGISTRY: Record<string, Status> = {
  "src/app/api/tasks/[id]/route.ts": { gated: true },
  "src/app/api/playlists/sync/route.ts": { gated: true },
  "src/app/api/playlists/[id]/tracks/route.ts": { gated: true },
  "src/app/api/now-playing/route.ts": { gated: true },
  "src/app/(app)/playlists/page.tsx": { gated: true },
  "src/app/(app)/playlists/[id]/page.tsx": { gated: true },

  "src/app/layout.tsx": { exempt: "the root layout: no user data" },
  "src/app/page.tsx": { exempt: "/: redirects to /home, reads nothing" },
  "src/app/(auth)/login/page.tsx": { exempt: "/login" },
  "src/app/kbtest/page.tsx": { exempt: "dev-only keyboard test page; notFound() in production" },
  "src/app/api/build/route.ts": { exempt: "build id, no auth and no store by design (GOTCHAS)" },
  "src/app/api/auth/[...nextauth]/route.ts": { exempt: "Auth.js" },
  "src/app/api/cron/health/route.ts": { exempt: "cron secret (T13 in health.test.ts)" },
  "src/app/api/cron/sync/route.ts": { exempt: "cron secret" },
  "src/app/api/cron/usage-check/route.ts": { exempt: "cron secret" },

  "src/app/(app)/layout.tsx": { pending: `${QUEUED}; a layout is not a gate anyway (SECURITY.md)` },
  "src/app/(app)/home/page.tsx": { pending: `${QUEUED}; its first wave also moves behind the gate (01b E5)` },
  "src/app/(app)/usage/page.tsx": { pending: `${QUEUED}; admin-only in Phase 1's turn` },
  "src/app/(app)/history-actions.ts": { pending: QUEUED },
  "src/app/api/search/history/route.ts": { pending: `${QUEUED}; uid in its ETag and body too` },
  "src/app/api/search/library/route.ts": { pending: `${QUEUED}; uid in its ETag and body too` },
  "src/app/api/metrics/route.ts": { pending: `${QUEUED}; uid from the session, reserved event names refused (T15)` },
  "src/app/api/sync/route.ts": { pending: "the on-load harvest; moves with Phase 3's open-app rules" },
  "src/app/(app)/actions.ts": { pending: "the Phase 0 lane edits logout here; each action moves to requireActionUser in Phase 1's turn" },
  "src/app/(app)/friends/page.tsx": { pending: "prerendered placeholder with no user data; gate it when it gains any" },
};

const GATE_CALL = /\brequire(Page|Route|Action)?User\(/;

describe("T3 census: every entry point is accounted for", () => {
  it("each entry point found in src/app has a registry entry, and each entry still exists", () => {
    expect(ENTRY.filter((f) => !(f in REGISTRY))).toEqual([]);
    expect(Object.keys(REGISTRY).filter((f) => !ENTRY.includes(f))).toEqual([]);
  });

  it("every entry marked gated calls requireUser", () => {
    const notGated = Object.entries(REGISTRY)
      .filter(([, s]) => "gated" in s)
      .map(([f]) => f)
      .filter((f) => !GATE_CALL.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(notGated).toEqual([]);
  });
});
