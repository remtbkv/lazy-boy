// Static checks over src/ (PLAN.md §6.4: S1, S2, S4, S5, S6, S8), run on every `npm test`. They
// parse the source with the TypeScript compiler API, so a comment or a string that merely
// mentions a pattern does not count. Each allowlist entry says why it is there; an entry marked
// PENDING is single-user code that Phase 1's turn moves (it sits in a file queued lanes edit),
// and the check fails if a PENDING entry disappears without its line being deleted, so the
// lists only shrink on purpose.
//
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n) && !n.endsWith(".d.ts") ? [p] : [];
  });
}
const FILES = walk(SRC).map((abs) => {
  const rel = path.relative(ROOT, abs);
  const text = readFileSync(abs, "utf8");
  return { rel, text, sf: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true) };
});

function visit(node: ts.Node, f: (n: ts.Node) => void): void {
  f(node);
  node.forEachChild((c) => visit(c, f));
}
const calleeText = (c: ts.CallExpression | ts.NewExpression, sf: ts.SourceFile) =>
  c.expression.getText(sf).replace(/\s+/g, "");

/** Every call (or `new`) whose callee text matches, as `file: callee(firstArg)`. */
function calls(match: (callee: string) => boolean): string[] {
  const out: string[] = [];
  for (const { rel, sf } of FILES) {
    visit(sf, (n) => {
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && match(calleeText(n, sf))) {
        const arg = n.arguments?.[0]?.getText(sf) ?? "";
        out.push(`${rel}: ${calleeText(n, sf)}(${arg})`);
      }
    });
  }
  return out;
}

describe("S1: unstable_cache only inside userCache", () => {
  const ALLOWED = new Set(["src/lib/user-cache.ts"]);
  const PENDING = new Set<string>([]);

  it("no other file calls it", () => {
    const files = new Set(calls((c) => c === "unstable_cache").map((s) => s.split(":")[0]));
    const stray = [...files].filter((f) => !ALLOWED.has(f) && !PENDING.has(f));
    expect(stray).toEqual([]);
    for (const p of PENDING) expect(files.has(p), `${p} no longer calls unstable_cache: drop it from PENDING`).toBe(true);
  });
});

describe("S2: a Uid is minted in one place", () => {
  // The gate mints from the session; auth.ts mints Rem's uid in the sign-in branch and in the
  // two owner-bound Phase 1 shims. Phase 2 adds the cron's claim; the scripts' --user helper
  // comes with forUser.
  const MINTERS = new Set(["src/lib/session-gate.ts", "src/lib/auth.ts"]);

  it("no `as Uid` outside identity.ts", () => {
    const casts: string[] = [];
    for (const { rel, sf } of FILES) {
      visit(sf, (n) => {
        if (ts.isAsExpression(n) && n.type.getText(sf) === "Uid" && rel !== "src/lib/identity.ts") {
          casts.push(`${rel}: ${n.getText(sf)}`);
        }
      });
    }
    expect(casts).toEqual([]);
  });

  it("mintUid is imported only by the minters", () => {
    expect(importersOf("mintUid").filter((f) => !MINTERS.has(f))).toEqual([]);
  });

  // phase1Owner() mints Rem's uid from OWNER_UID for the paths that act for him with no
  // session: the cron and the daily chores until Phase 3's claim, the health check, the
  // sign-in's owner guard, and db.ts's app-wide rows (the cooldown) until Phase 2's app database.
  const OWNER_PATHS = new Set([
    "src/lib/db.ts",
    "src/lib/owner.ts",
    "src/app/api/cron/sync/route.ts",
    "src/app/api/cron/daily/route.ts",
    "src/app/api/cron/health/route.ts",
    "src/app/api/cron/store-bench/route.ts",
  ]);
  it("phase1Owner is imported only by the paths that act for the owner without a session", () => {
    expect(importersOf("phase1Owner").filter((f) => !OWNER_PATHS.has(f))).toEqual([]);
  });

  // forUserAt names the database as well as the user: only Phase 2's identity read (with the
  // db_name it returns) may call it. Nothing in src does in Phase 1; the tests do.
  it("forUserAt is imported by nothing in src", () => {
    expect(importersOf("forUserAt")).toEqual([]);
  });
});

function importersOf(name: string): string[] {
  const out: string[] = [];
  for (const { rel, sf } of FILES) {
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st)) continue;
      const named = st.importClause?.namedBindings;
      if (named && ts.isNamedImports(named) && named.elements.some((e) => (e.propertyName ?? e.name).text === name)) {
        out.push(rel);
      }
    }
  }
  return out;
}

describe("S3: db.ts exports no per-user function", () => {
  // Every value db.ts exports, as a snapshot a reviewer sees change: forUser and forUserAt (the
  // only way to a user's data), the telemetry store's functions (no user's database), the
  // app-wide cooldown (the admin's database until Phase 2's app_meta), and pure helpers and
  // constants. A per-user function exported here could run against a database without naming
  // its user (PLAN.md §6.2 layer 3).
  const EXPORTS = [
    "HISTORY_INDEX_SHAPE",
    "HOME_PAYLOAD_SHAPE",
    "LIBRARY_INDEX_SHAPE",
    "SUMMARY_EVENTS",
    "StoreRefusedError",
    "USER_SCHEMA_VERSION",
    "forUser",
    "forUserAt",
    "getApiLogSummary",
    "getClientLoadSpeed",
    "getRecentlyPlayedQuotaWindows",
    "getSpotifyCallBreakdown",
    "getSpotifyCooldownUntil",
    "isolationEventsAfter",
    "ledgerAdd",
    "ledgerDayModeledTotal",
    "ledgerSet",
    "logSpotifyRequest",
    "mayApplySchema",
    "openVerdict",
    "payloadTzOffset",
    "pruneApiLog",
    "pruneClientMetrics",
    "readLedger",
    "recordClientMetrics",
    "setSpotifyCooldownUntil",
  ];

  it("its value exports match the snapshot", () => {
    const db = FILES.find((f) => f.rel === "src/lib/db.ts")!;
    const names: string[] = [];
    for (const st of db.sf.statements) {
      const exported = (ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : []).some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!exported) continue;
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) names.push(st.name.text);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
      }
      if (ts.isExportDeclaration(st)) names.push(st.getText(db.sf));
    }
    expect(names.sort()).toEqual([...EXPORTS].sort());
  });
});

describe("S4: module-scope state is on a reviewed list", () => {
  // Every module-scope binding that is ever mutated: a top-level `let` that is assigned, a
  // top-level const container (Map, Set, array, object, a globalThis-backed store) that has a
  // mutating method called on it or an element assigned, and every non-readonly static class
  // field. Each says how it is keyed, or why one value for every user is right.
  const BROWSER = "browser module: one tab, one signed-in user";
  const REVIEWED: Record<string, string> = {
    "src/lib/user-cache.ts: names": "wrapper names, process-wide on purpose: no user data",
    "src/lib/playlists-sync.ts: currentSync": "Map<Uid, task id>",
    "src/lib/tasks/registry.ts: store": "tasks carry their owner; getTaskFor checks it",
    "src/lib/tasks/registry.ts: running": "completion promises by task id; holds no result",
    "src/lib/han-fold.ts: TABLE": "a fixed folding table filled at module load; no user data",
    "src/lib/spotify/client.ts: cooldownUntil": "app-wide on purpose: Spotify's rate limit is per app (PLAN.md §4.3)",
    "src/app/(app)/use-search-mode.ts: lastKbHeight": BROWSER,
    "src/components/now-playing-context.tsx: markedNowPlayingReady": BROWSER,
    "src/components/playlist-tracks-sync.tsx: lastAttempt": BROWSER,
    "src/components/playlists-sync.tsx: inFlight": BROWSER,
    "src/components/playlists-sync.tsx: lastAttempt": BROWSER,
    "src/components/playlists-sync.tsx: watching": BROWSER,
    "src/lib/metrics-client.ts: buffer": BROWSER,
    "src/lib/metrics-client.ts: errorsRecorded": BROWSER,
    "src/lib/metrics-client.ts: loadPage": BROWSER,
    "src/lib/metrics-client.ts: loadPv": BROWSER,
    "src/lib/metrics-client.ts: page": BROWSER,
    "src/lib/metrics-client.ts: pendingNav": BROWSER,
    "src/lib/metrics-client.ts: pv": BROWSER,
    "src/lib/metrics-client.ts: sessionMemo": BROWSER,
    "src/lib/metrics-client.ts: started": BROWSER,
    "src/lib/metrics-client.ts: viewStart": BROWSER,
    "src/lib/metrics-client.ts: visibleMs": BROWSER,
    "src/lib/metrics-client.ts: visibleSince": BROWSER,
    "src/lib/search-perf.ts: enabled": BROWSER,
    "src/lib/db.ts: g": "clients by db_name, owner verdicts and schema runs by (uid, db_name), the telemetry client",
    "src/lib/db.ts: storeSizeMemo": "Map keyed by (uid, db_name)",
    "src/lib/db.ts: uniqueRecomputeKickedAt": "Map keyed by (uid, db_name)",
    "src/lib/db.ts: apiLogWrites": "the telemetry store's prune counter: one log for the app, no user data",
    "src/app/api/cron/store-bench/route.ts: warm": "whether this instance served a request yet; no user data",
  };
  // PENDING: none left; an entry here is single-user state still waiting for its key.
  const PENDING: Record<string, string> = {};

  const MUTATORS = new Set(["set", "add", "delete", "clear", "push", "pop", "splice", "shift", "unshift", "sort", "reverse", "fill"]);

  function mutated(sf: ts.SourceFile, name: string, isLet: boolean): boolean {
    let hit = false;
    visit(sf, (n) => {
      if (hit) return;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const left = n.left;
        const root = ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left) ? left.expression : left;
        if (ts.isIdentifier(root) && root.text === name && (isLet || root !== left)) hit = true;
      }
      // ++ and -- only: `!x` and `-x` read a binding, they do not change it.
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(n.operand) &&
        n.operand.text === name
      ) {
        hit = true;
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const obj = n.expression.expression;
        if (ts.isIdentifier(obj) && obj.text === name && MUTATORS.has(n.expression.name.text)) hit = true;
      }
    });
    return hit;
  }

  function found(): string[] {
    const out: string[] = [];
    for (const { rel, sf } of FILES) {
      for (const st of sf.statements) {
        if (ts.isVariableStatement(st)) {
          const isLet = (st.declarationList.flags & ts.NodeFlags.Let) !== 0;
          for (const d of st.declarationList.declarations) {
            if (!ts.isIdentifier(d.name)) continue;
            if (mutated(sf, d.name.text, isLet)) out.push(`${rel}: ${d.name.text}`);
          }
        }
        if (ts.isClassDeclaration(st)) {
          for (const m of st.members) {
            const mods = ts.canHaveModifiers(m) ? (ts.getModifiers(m) ?? []) : [];
            const isStatic = mods.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
            const ro = mods.some((x) => x.kind === ts.SyntaxKind.ReadonlyKeyword);
            if (ts.isPropertyDeclaration(m) && isStatic && !ro) out.push(`${rel}: ${st.name?.text}.${m.name.getText(sf)}`);
          }
        }
      }
    }
    return out.sort();
  }

  it("every finding is reviewed or pending, and every pending entry still exists", () => {
    const f = found();
    const unreviewed = f.filter((x) => !(x in REVIEWED) && !(x in PENDING));
    expect(unreviewed).toEqual([]);
    for (const p of Object.keys(PENDING)) expect(f, `${p} is gone: drop it from PENDING`).toContain(p);
  });
});

describe("S5: Spotify is fetched with no-store or through the client", () => {
  // Auth.js's own token exchange goes through this customFetch with Auth.js's init: a POST,
  // which no cache stores.
  const EXEMPT = new Set(["src/lib/auth.ts: fetch(input)"]);

  it("every direct fetch in a file that names a Spotify host sets cache: no-store", () => {
    const bad: string[] = [];
    for (const { rel, sf, text } of FILES) {
      if (rel === "src/lib/spotify/client.ts") continue;
      if (!/https:\/\/(api|accounts)\.spotify\.com/.test(text)) continue;
      visit(sf, (n) => {
        if (!ts.isCallExpression(n) || n.expression.getText(sf) !== "fetch") return;
        const id = `${rel}: fetch(${n.arguments[0]?.getText(sf) ?? ""})`;
        const opts = n.arguments[1];
        const noStore =
          opts !== undefined &&
          ts.isObjectLiteralExpression(opts) &&
          opts.properties.some(
            (p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "cache" && p.initializer.getText(sf) === '"no-store"',
          );
        if (!noStore && !EXEMPT.has(id)) bad.push(id);
      });
    }
    expect(bad).toEqual([]);
  });
});

describe("S6: browser storage names", () => {
  const STORAGE = /^(window\.)?(localStorage|sessionStorage)\.(getItem|setItem|removeItem)$|^navigator\.locks\.request$|^BroadcastChannel$/;
  // Device-level names: not user data, kept across users on purpose.
  const DEVICE = new Set([
    "src/components/now-playing-context.tsx: localStorage.getItem(RELOAD_STAMP_KEY)",
    "src/components/now-playing-context.tsx: localStorage.setItem(RELOAD_STAMP_KEY)",
    "src/lib/metrics-client.ts: sessionStorage.getItem(SESSION_KEY)",
    "src/lib/metrics-client.ts: sessionStorage.setItem(SESSION_KEY)",
    "src/lib/search-perf.ts: window.localStorage.setItem(FLAG)",
    "src/lib/search-perf.ts: window.localStorage.removeItem(FLAG)",
    "src/lib/search-perf.ts: window.localStorage.getItem(FLAG)",
    "src/app/(app)/error.tsx: sessionStorage.getItem(KEY)",
    "src/app/(app)/error.tsx: sessionStorage.setItem(KEY)",
  ]);
  // PENDING: user data under a bare name. Each moves to userStorageName(uid, …) once the (app)
  // layout renders the uid for the browser (a queued file); until then sign-out clears them by
  // their bare names (user-storage.ts).
  const PENDING = new Set([
    "src/components/now-playing-context.tsx: localStorage.setItem(CACHE_KEY)",
    "src/components/now-playing-context.tsx: localStorage.getItem(CACHE_KEY)",
    "src/components/now-playing-context.tsx: BroadcastChannel(CHANNEL)",
    "src/components/now-playing-context.tsx: navigator.locks.request(LEADER_LOCK)",
    "src/lib/clean-progress.ts: localStorage.getItem(CLEAN_LS_KEY)",
    "src/lib/clean-progress.ts: localStorage.setItem(CLEAN_LS_KEY)",
    "src/lib/clean-progress.ts: localStorage.removeItem(CLEAN_LS_KEY)",
    "src/app/(app)/home/den-home.tsx: sessionStorage.getItem(DAY_STORE)",
    "src/app/(app)/home/den-home.tsx: sessionStorage.removeItem(DAY_STORE)",
    "src/app/(app)/home/den-home.tsx: sessionStorage.setItem(DAY_STORE)",
    "src/app/(app)/chrome.tsx: sessionStorage.getItem(RING_CACHE + image)",
    "src/app/(app)/chrome.tsx: sessionStorage.setItem(RING_CACHE + image)",
  ]);

  it("every storage name is built by userStorageName, device-level, or pending", () => {
    const all = [...new Set(calls((c) => STORAGE.test(c)))];
    const bad = all.filter((s) => !/\(userStorageName\(/.test(s) && !DEVICE.has(s) && !PENDING.has(s));
    expect(bad).toEqual([]);
    for (const p of PENDING) expect(all, `${p} is gone: drop it from PENDING`).toContain(p);
  });
});

describe("S7: no user path awaits the telemetry store", () => {
  // The telemetry store is the Zenbook (STORE_MIGRATION §5): a user path that awaits it waits
  // on it. Its calls are fired with `void` or in after(); these files await on purpose.
  const TELEMETRY = new Set([
    "logSpotifyRequest",
    "getSpotifyCallBreakdown",
    "getRecentlyPlayedQuotaWindows",
    "pruneApiLog",
    "pruneClientMetrics",
    "getApiLogSummary",
    "ledgerAdd",
    "ledgerSet",
    "readLedger",
    "ledgerDayModeledTotal",
    "recordClientMetrics",
    "getClientLoadSpeed",
    "isolationEventsAfter",
  ]);
  const ALLOWED: Record<string, string> = {
    "src/app/api/cron/daily/route.ts": "the daily chores",
    "src/lib/usage-check.ts": "run by the daily chores and the usage-check cron route",
    "src/app/(app)/usage/telemetry.ts": "/usage, settled one section at a time",
    "src/app/api/cron/health/route.ts": "the health check reads isolation events where Phase 1 records them",
    "src/lib/isolation.ts": "an isolation event's only record in Phase 1; a rare path, 4 s cap",
    "src/instrumentation.ts": "server errors only, after the response (STORE_MIGRATION §6 item 4)",
  };

  it("awaits a telemetry function only in the allowed files", () => {
    const bad: string[] = [];
    for (const { rel, sf } of FILES) {
      if (rel === "src/lib/db.ts" || rel in ALLOWED) continue;
      visit(sf, (n) => {
        if (!ts.isAwaitExpression(n)) return;
        let e: ts.Expression = n.expression;
        while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && /^(catch|then|finally)$/.test(e.expression.name.text)) {
          e = e.expression.expression;
        }
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && TELEMETRY.has(e.expression.text)) {
          bad.push(`${rel}: await ${e.expression.text}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });
});

describe("S8: no nested async server component reads user data or calls Spotify", () => {
  // A component nested in a page renders after, and apart from, the page body's gate; T3 can
  // only reach what the page body does. In each page.tsx, an async function component other
  // than the default export may not call anything imported from the store, the session or the
  // Spotify client (it may await a promise the gated body started).
  const SOURCES = new Set(["@/lib/db", "@/lib/session", "@/lib/spotify", "@/lib/auth"]);
  const PENDING = new Set<string>([]);

  it("finds none outside the pending list", () => {
    const bad: string[] = [];
    for (const { rel, sf } of FILES) {
      if (!rel.endsWith("page.tsx")) continue;
      const imported = new Set<string>();
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !SOURCES.has((st.moduleSpecifier as ts.StringLiteral).text)) continue;
        const nb = st.importClause?.namedBindings;
        if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) imported.add(e.name.text);
      }
      for (const st of sf.statements) {
        if (!ts.isFunctionDeclaration(st) || !st.name || !/^[A-Z]/.test(st.name.text)) continue;
        const mods = ts.getModifiers(st) ?? [];
        if (mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) continue;
        if (!mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) continue;
        visit(st, (n) => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && imported.has(n.expression.text)) {
            bad.push(`${rel}: ${st.name!.text} calls ${n.expression.text}`);
          }
        });
      }
    }
    expect(bad.filter((b) => !PENDING.has(b))).toEqual([]);
  });
});
