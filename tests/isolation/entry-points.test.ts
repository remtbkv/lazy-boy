// T3's census (PLAN.md §6.4): every page, layout, route handler and "use server" module under
// src/app, found by globbing, must be in this registry: gated by requireUser (checked here by
// its source calling one of the require*User functions) or exempt by name; PENDING (not gated
// yet, with the reason) is empty since Phase 1's turn. A new entry point with no entry fails
// the suite. The behavioural half of T3 (every principal against every entry point) is the
// authorization map, tests/isolation/authz-*.
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

const REGISTRY: Record<string, Status> = {
  "src/app/api/tasks/[id]/route.ts": { gated: true },
  "src/app/api/playlists/sync/route.ts": { gated: true },
  "src/app/api/playlists/[id]/tracks/route.ts": { gated: true },
  "src/app/api/now-playing/route.ts": { gated: true },
  "src/app/api/search/history/route.ts": { gated: true },
  "src/app/api/search/library/route.ts": { gated: true },
  "src/app/api/metrics/route.ts": { gated: true },
  "src/app/api/sync/route.ts": { gated: true },
  "src/app/(app)/layout.tsx": { gated: true },
  "src/app/(app)/home/page.tsx": { gated: true },
  "src/app/(app)/usage/page.tsx": { gated: true },
  "src/app/(app)/playlists/page.tsx": { gated: true },
  "src/app/(app)/playlists/[id]/page.tsx": { gated: true },
  "src/app/(app)/history-actions.ts": { gated: true },
  "src/app/(app)/actions.ts": { gated: true },
  "src/app/(app)/disconnect/page.tsx": { gated: true },

  "src/app/layout.tsx": { exempt: "the root layout: no user data" },
  "src/app/page.tsx": { exempt: "/: redirects to /home, reads nothing" },
  "src/app/(auth)/login/page.tsx": { exempt: "/login" },
  "src/app/(legal)/layout.tsx": { exempt: "the legal pages' layout: static text" },
  "src/app/(legal)/privacy/page.tsx": { exempt: "/privacy: static text" },
  "src/app/(legal)/terms/page.tsx": { exempt: "/terms: static text" },
  "src/app/(app)/friends/page.tsx": { exempt: "prerendered placeholder with no user data; gate it when it gains any" },
  "src/app/(auth)/join/page.tsx": { exempt: "/join: a friend's first visit, no session; shows only the cookie's own request (join-routes.test.ts)" },
  "src/app/api/join/route.ts": { exempt: "the request form's POST: public, bounded in SQL, shut under SIGNUPS=owner (join-request.test.ts)" },
  "src/app/api/join/link/route.ts": { exempt: "the join link: a token whose hash opens one approved invite; reads no user data (join-routes.test.ts)" },
  "src/app/(auth)/signed-out/page.tsx": { exempt: "the page after Log out: static text, no session or reads (logout-disconnect.test.ts)" },
  "src/app/(auth)/disconnected/page.tsx": { exempt: "the page after Disconnect: static text, no session or reads" },
  "src/app/(auth)/reconnect/page.tsx": { exempt: "decision 20's page for a dead grant: static text and the sign-in, no session or reads" },
  "src/app/kbtest/page.tsx": { exempt: "dev-only keyboard test page; notFound() in production" },
  "src/app/api/build/route.ts": { exempt: "build id, no auth and no store by design (GOTCHAS)" },
  "src/app/api/auth/[...nextauth]/route.ts": { exempt: "Auth.js" },
  "src/app/api/cron/health/route.ts": { exempt: "cron secret (T13 in health.test.ts)" },
  "src/app/api/cron/sync/route.ts": { exempt: "cron secret" },
  "src/app/api/cron/daily/route.ts": { exempt: "cron secret" },
  "src/app/api/cron/store-bench/route.ts": { exempt: "cron secret" },
  "src/app/api/cron/usage-check/route.ts": { exempt: "cron secret" },
  "src/app/api/cron/probe/route.ts": { exempt: "the planted probe: CRON_SECRET only, never CRON_SECRET_EXT (planted-probe.test.ts)" },

};

const GATE_CALL = /\brequire(Page|Route|Action)?User\(/;

describe("T3 census: every entry point is accounted for", () => {
  it("each entry point found in src/app has a registry entry, and each entry still exists", () => {
    expect(ENTRY.filter((f) => !(f in REGISTRY))).toEqual([]);
    expect(Object.keys(REGISTRY).filter((f) => !ENTRY.includes(f))).toEqual([]);
  });

  it("nothing is pending", () => {
    expect(Object.entries(REGISTRY).filter(([, s]) => "pending" in s)).toEqual([]);
  });

  it("every entry marked gated calls requireUser", () => {
    const notGated = Object.entries(REGISTRY)
      .filter(([, s]) => "gated" in s)
      .map(([f]) => f)
      .filter((f) => !GATE_CALL.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(notGated).toEqual([]);
  });
});
