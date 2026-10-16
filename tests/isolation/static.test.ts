// Static checks over src/ (PLAN.md §6.4: S1-S8), run on every `npm test`. They
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
  // two owner-bound Phase 1 shims. Phase 3 adds the cron's claim (app-db.ts, from the rows it
  // just leased); the scripts' --user helper comes with forUser.
  // user-cache.ts: the planted probe names a cache key from the Zenbook's request, behind
  // CRON_SECRET, and reads nothing with it (planted-probe.test.ts).
  const MINTERS = new Set(["src/lib/session-gate.ts", "src/lib/auth.ts", "src/lib/app-db.ts", "src/lib/user-cache.ts"]);

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
  // session: identity-read.ts's adminStore (the cron, the daily chores, the health check, the
  // store bench, the sign-in's owner guard and token-move.ts's plaintext row, until Phase 3's
  // claim), which reads his users row for his database. db.ts no longer does: its app-wide rows
  // (the cooldown, the budget mode) are app_meta's from Phase 3's turn.
  const OWNER_PATHS = new Set(["src/lib/identity-read.ts"]);
  it("phase1Owner is imported only by the paths that act for the owner without a session", () => {
    expect(importersOf("phase1Owner").filter((f) => !OWNER_PATHS.has(f))).toEqual([]);
  });

  // forUserAt names the database as well as the user: only what read the users row may call it,
  // with the db_name it read: Phase 2's identity read and adminStore (identity-read.ts), and
  // Phase 3's tick, which opens each claimed user's store at the db_name the claim read from the
  // users row that leased them (src/lib/sync/tick-deps.ts). The tests do too.
  it("forUserAt is imported only by the identity read and the tick's store lookup", () => {
    expect(importersOf("forUserAt").sort()).toEqual(["src/lib/identity-read.ts", "src/lib/sync/tick-deps.ts"]);
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
  // app-wide budget mode (app_meta's `budget_mode`), and pure helpers and constants. (The app-wide
  // cooldown left for app_meta's `cooldown:<bucket>` at Phase 3's turn.) A per-user function
  // exported here could run against a database without naming its user (PLAN.md §6.2 layer 3).
  const EXPORTS = [
    "HISTORY_INDEX_SHAPE",
    "HOME_PAYLOAD_SHAPE",
    "LIBRARY_INDEX_SHAPE",
    "ORPHAN_PREDICATE",
    "SUMMARY_EVENTS",
    "StoreRefusedError",
    "USER_SCHEMA_VERSION",
    "forUser",
    "forUserAt",
    "getApiLogSummary",
    "getBudgetMode",
    "getClientLoadSpeed",
    "getRecentlyPlayedQuotaWindows",
    "getSpotifyCallBreakdown",
    "ledgerAdd",
    "ledgerDayModeledTotal",
    "ledgerSet",
    "logSpotifyRequest",
    "mayApplySchema",
    "meterFlush",
    "openVerdict",
    "payloadTzOffset",
    "pruneApiLog",
    "pruneClientMetrics",
    "readBudgetDay",
    "readLedger",
    "readMeter",
    "recordBudgetDay",
    "recordClientMetrics",
    "setBudgetMode",
  ];

  it("its value exports match the snapshot", () => {
    const db = FILES.find((f) => f.rel === "src/lib/db.ts")!;
    const names: string[] = [];
    for (const st of db.sf.statements) {
      // `export { a, b }` and `export … from` carry no export modifier: read their names, or a
      // re-exported per-user function would pass unseen (the shape tokens moved to one in 1905).
      if (ts.isExportDeclaration(st)) {
        const clause = st.exportClause;
        if (clause && ts.isNamedExports(clause)) names.push(...clause.elements.map((e) => e.name.text));
        else names.push(st.getText(db.sf));
        continue;
      }
      const exported = (ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : []).some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!exported) continue;
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) names.push(st.name.text);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
      }
    }
    expect(names.sort()).toEqual([...EXPORTS].sort());
  });
});

describe("S3: app-db.ts's exports match the reviewed snapshot", () => {
  // Every statement on the app database lives in app-db.ts (PLAN.md §6.2 layer 7), so a new
  // export is a new way to reach every user's identity or tokens. This list changes in the same
  // commit as the export, where a reviewer sees it. (S3's other half, no per-user function
  // exported from db.ts at module level, is the block above.)
  const SNAPSHOT = [
    "APP_SCHEMA (re-export)",
    "APP_SCHEMA_VERSION (re-export)",
    "AppIdentityRow (type)",
    "TokenRow (type)",
    "USER_STATUSES (re-export)",
    "UserRow (type)",
    "UserStatus (re-export)",
    "acquireAppLock (function)",
    "appDatabaseUrl (function)",
    "bindAdminAccount (function)",
    "deleteTokens (function)",
    "deleteTokensIfUnchanged (function)",
    "ensureAppSchema (function)",
    "findUserByAccountId (function)",
    "getAppMeta (function)",
    "insertTokensIfAbsent (function)",
    "moveStatus (function)",
    "readIdentityRow (function)",
    "readTokenRow (function)",
    "recordAppEvent (function)",
    "recordSignIn (function)",
    "releaseAppLock (function)",
    "setAppMeta (function)",
    "setAppMetaIfAbsent (function)",
    "updateTokensIfUnchanged (function)",
    "writeSignInTokens (function)",
    // Phase 3, the sync queue. Cross-user by design: readOwnerAlarm, claimDueUsers (the claim),
    // grantFailuresSince; each takes no uid and returns scheduling, never data (sync-queue.test.ts).
    "Claim (type)",
    "ClaimedUser (type)",
    "OwnerAlarmRow (type)",
    "Release (type)",
    "TICK_STATEMENT_TIMEOUT_MS (const)",
    "claimDueUsers (function)",
    "claimRescan (function)",
    "claimUser (function)",
    "countRpCall (function)",
    "extendCooldown (function)",
    "finishGrantConfirm (function)",
    "grantFailuresSince (function)",
    "oneAttemptFetch (function)",
    "readOwnerAlarm (function)",
    "releaseLease (function)",
    "scheduleRescan (function)",
    "stampTick (function)",
    "startGrantConfirm (function)",
    // Phase 4a, sign-up. Cross-user by design: createJoinRequest (no uid: a stranger's insert,
    // bounded in SQL), requestForJoinToken (the join link), claimInvite (binds the signing-in
    // account to the invite its request cookie names, once); join-request.test.ts, t9-claim.test.ts.
    "INVITE_TTL_MS (const)",
    "JOIN_PENDING_CAP (const)",
    "JOIN_PER_HOUR (const)",
    "SEATS (const)",
    "JoinRefusal (type)",
    "JoinResult (type)",
    "RequestState (type)",
    "claimInvite (function)",
    "createJoinRequest (function)",
    "requestForJoinToken (function)",
    "requestState (function)",
    // The deletion job's runner: only deletion.ts's listed statements (t11-deletion.test.ts).
    "execDeletionStatements (function)",
    // Log out: one user's epoch and token row, by the gate's uid (logout-disconnect.test.ts).
    "endSessionsAndCapture (function)",
    // invalid_grant (§5.4): the request path's stop-and-keep, steps 3-5's read, the revocation;
    // each takes one uid (t14-invalid-grant.test.ts).
    "markGrantDead (function)",
    "markRevoked (function)",
    "readGrantCase (function)",
    // The daily chores (§7.11): uids and times for the deletion job, and the sweeps (daily-4a.test.ts).
    "DailyCandidates (type)",
    "dailyCandidates (function)",
    "dailySweeps (function)",
    // The health check (§7.10): counts by code and state, and its red-verdict record (health-4a.test.ts).
    "readHealth (function)",
    "recordHealthRed (function)",
    // The planted probe's reply: one uid's count of one code (planted-probe.test.ts).
    "countEvents (function)",
  ];

  it("lists every export", () => {
    const { sf } = FILES.find((f) => f.rel === "src/lib/app-db.ts")!;
    const out: string[] = [];
    const exported = (n: ts.Node) =>
      (ts.canHaveModifiers(n) ? (ts.getModifiers(n) ?? []) : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const e of st.exportClause.elements) out.push(`${e.name.text} (re-export)`);
      } else if (ts.isExportAssignment(st)) {
        out.push("default (export assignment)");
      } else if (exported(st)) {
        if (ts.isFunctionDeclaration(st)) out.push(`${st.name?.text} (function)`);
        else if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) out.push(`${st.name.text} (type)`);
        else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) out.push(`${d.name.getText(sf)} (const)`);
        else if (ts.isClassDeclaration(st)) out.push(`${st.name?.text} (class)`);
        else out.push(`${st.getText(sf).slice(0, 40)} (other)`);
      }
    }
    expect(out.sort()).toEqual([...SNAPSHOT].sort());
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
    "src/lib/app-db.ts: g": "the one app-database client, keyed by its URL: global by meaning, holds no user data",
    "src/lib/token-keys.ts: verdict": "the key check's verdict for the configured keys and database: per deployment, no user data",
    "src/lib/playlists-sync.ts: currentSync": "Map<Uid, task id>",
    "src/lib/user-bucket.ts: windows": "per (limit name, uid) call counts, one window each (user-bucket.test.ts)",
    "src/lib/now-playing-memo.ts: memo": "Map<Uid, last 200 answer>, about 5 s each (now-playing-memo.test.ts)",
    "src/lib/tasks/registry.ts: store": "tasks carry their owner; getTaskFor checks it",
    "src/lib/tasks/registry.ts: running": "completion promises by task id; holds no result",
    "src/lib/han-fold.ts: TABLE": "a fixed folding table filled at module load; no user data",
    "src/lib/spotify/client.ts: cooldownUntil": "app-wide on purpose: Spotify's rate limit is per app (PLAN.md §4.3)",
    "src/lib/spotify/client.ts: bucketUntil": "keyed by quota bucket, app-wide on purpose: a long ban is the developer account's on that endpoint family (PLAN.md §4.3, §7.8)",
    "src/app/(app)/use-search-mode.ts: lastKbHeight": BROWSER,
    "src/components/now-playing-context.tsx: markedNowPlayingReady": BROWSER,
    "src/components/now-playing-context.tsx: npChangeSeq": BROWSER,
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
    // Set by the sign-out form for the rest of that page load; signing in again is a navigation.
    "src/lib/search-cache.ts: ended": BROWSER,
    "src/lib/db.ts: g":
      "clients by db_name, each uid's db_name as its users row last said, owner verdicts and schema runs by (uid, db_name), the telemetry client, the app-wide budget mode's memo",
    "src/lib/budget/request-meter.ts: g": "the process's meter: counts by (day, route, uid), the in-flight requests by Next's request scope and as a set, the cold-start flag, the process CPU already in a row",
    "src/lib/budget/request-meter.ts: open": "WeakMap keyed by Next's per-request scope: one in-flight request's counts, gone with it",
    "src/lib/budget/request-meter.ts: shared": "the process's meter (see g): its cold-start flag, CPU booked and in-flight set",
    "src/lib/budget/sync-interval.ts: current": BROWSER,
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
  // PENDING: user data under a bare name. None left: the (app) layout renders the uid and every
  // user-data name is built from it, lane 1905's IndexedDB database included (lane 33's stitch).
  const PENDING = new Set<string>([]);
  // IndexedDB names, opened through indexedDB.open(name, …).
  const IDB = /^(window\.)?indexedDB\.open$/;

  it("every storage name is built by userStorageName, device-level, or pending", () => {
    const all = [...new Set(calls((c) => STORAGE.test(c) || IDB.test(c)))];
    const bad = all.filter((s) => !/\(userStorageName\(/.test(s) && !DEVICE.has(s) && !PENDING.has(s));
    expect(bad).toEqual([]);
    for (const p of PENDING) expect(all, `${p} is gone: drop it from PENDING`).toContain(p);
  });

  // The now-playing leader's Web Lock is requested inside leaderElection (now-playing-poll.ts),
  // whose second argument is the lock's name.
  it("every leaderElection lock name is built by userStorageName", () => {
    const bad: string[] = [];
    for (const { rel, sf } of FILES) {
      visit(sf, (n) => {
        if (!ts.isCallExpression(n) || n.expression.getText(sf) !== "leaderElection") return;
        const name = n.arguments[1]?.getText(sf) ?? "";
        if (!/^userStorageName\(/.test(name)) bad.push(`${rel}: leaderElection(…, ${name})`);
      });
    }
    expect(bad).toEqual([]);
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
    "meterFlush",
    "readMeter",
    "recordBudgetDay",
    "readBudgetDay",
  ]);
  const ALLOWED: Record<string, string> = {
    "src/app/api/cron/daily/route.ts": "the daily chores",
    "src/lib/usage-check.ts": "run by the daily chores and the usage-check cron route",
    "src/app/(app)/usage/telemetry.ts": "/usage, settled one section at a time",
    "src/app/api/cron/health/route.ts": "the health check reads the CPU meter's last write (the hourly cron, no user path)",
    "src/lib/isolation.ts": "an isolation event's telemetry row, beside its events row; a rare path, 4 s cap",
    "src/instrumentation.ts": "server errors only, after the response (STORE_MIGRATION §6 item 4)",
    "src/lib/budget/request-meter.ts": "the CPU meter's flush, inside after()",
    "src/lib/budget/daily.ts": "the budget record, run by the daily chores",
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

describe("the planted-bug self-test keeps every plant (PLAN.md §6.4)", () => {
  // planted-bugs.test.ts proves each check fails over a broken implementation; a plant deleted
  // there would pass unseen, so the four PLAN §6.4 names are listed here (lane 13's review).
  // Each must keep a case that expects the check to fail (`.rejects`) and one over the real code.
  const PLANTS = [
    "planted: an unstable_cache keyed without the user",
    "planted: the cache stub reverted to a pass-through",
    "planted: one in-flight refresh promise for every user",
    "planted: a URL template that ignores the uid",
  ];

  it("each plant is there, with a failing case and a passing one", () => {
    const rel = "tests/isolation/planted-bugs.test.ts";
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const found = new Map<string, { cases: number; rejects: boolean }>();
    visit(sf, (n) => {
      if (!ts.isCallExpression(n) || n.expression.getText(sf) !== "describe") return;
      const title = n.arguments[0];
      if (!title || !ts.isStringLiteral(title) || !title.text.startsWith("planted:")) return;
      let cases = 0;
      visit(n.arguments[1], (m) => {
        if (ts.isCallExpression(m) && m.expression.getText(sf) === "it") cases++;
      });
      found.set(title.text, { cases, rejects: /\.rejects\./.test(n.arguments[1].getText(sf)) });
    });
    for (const p of PLANTS) {
      const hit = [...found.entries()].find(([t]) => t.startsWith(p));
      expect(hit, `${p} is gone from ${rel}`).toBeDefined();
      expect(hit![1].cases, `${p}: a failing case and a passing one`).toBeGreaterThanOrEqual(2);
      expect(hit![1].rejects, `${p}: no case expects the check to fail`).toBe(true);
    }
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
