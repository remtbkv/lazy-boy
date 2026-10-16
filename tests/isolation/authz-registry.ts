// The authorization map (docs/multi-user/AUTHZ.md is generated from this file): every server
// entry point against every principal, each cell allow / deny / isolated, the rule in today's
// code that decides it (or a finding where there is none), and, where today's single-user code
// does not meet the target yet, what it does today and the phase that changes it.
//
// Targets:
//   allow    — reaches what `does` says (for Rem's own entry points: Rem's data, rows or grant);
//              for a public entry point: not refused.
//   deny     — refused, and nothing of Rem's read into the answer, written, or called on Spotify.
//   isolated — a friend: never Rem's data, rows or Spotify grant. Until Phase 4a that means
//              refused (only the owner signs in); from Phase 4a, their own data only.
//
// `today` is set only where today's observed verdict differs from the target; the suite pins it
// (tests/isolation/authz-map.test.ts) so the cell flips red the day its phase lands, and that
// lane deletes `today` and `phase` from the cell.
//   P1  lane 1945_lb_mu_12 (Phase 1's turn): requireUser everywhere, the uid on the session and
//       its identity check, forUser, userCache, uid in ETags and bodies, /usage admin-only,
//       /api/metrics' uid, auth_time's 30 days.
//   P2  lane 15 (Phase 2's turn): the identity read (status, session_epoch), per-user tokens.
//   P3  lane 17 (Phase 3's turn): the per-user tick and the daily chores under daily_at.
//   P4a lane 19 (Phase 4a's turn): Log out bumps session_epoch, the invite claim, the bounds.
//   L07 lane 1945_lb_mu_07 (the interim pinger): CRON_SECRET_EXT on /api/cron/sync.
import {
  OWNER_UID,
  type Observed,
  type Outcome,
  type Principal,
  PRINCIPALS,
  REM_DAY,
  REM_PLAYLIST,
  params,
  request,
} from "./authz-harness";
import { ctx } from "./authz-context";

export type Target = "allow" | "deny" | "isolated";
export type Phase = "P1" | "P2" | "P3" | "P4a" | "L07";
export type FindingId = `F${number}`;
export type Cell = { target: Target; today?: Observed; phase?: Phase; rule: string; finding?: FindingId };
export type Kind = "route" | "action" | "page" | "layout" | "auth";
export type Entry = {
  id: string;
  file: string;
  kind: Kind;
  /** Where today's code decides who gets in: a string that must still be in `gateFile ?? file`. */
  gate: string | null;
  gateFile?: string;
  /** Does an allowed call touch Rem's data, rows or Spotify grant? Then Rem's allow cell must
   *  observe exactly that (the positive control); otherwise allow only means "not refused". */
  reaches?: boolean;
  does: string;
  cells: Record<Principal, Cell>;
  invoke?: (p: Principal) => Promise<unknown>;
  refused?: (o: Outcome) => boolean;
  /** Runs after the principal is set up, before the call (e.g. start a task to poll). */
  before?: () => Promise<void>;
};

// ── Findings: cells for which today's code has no explicit rule ────────────────────────────
export const FINDINGS: Record<FindingId, { title: string; detail: string; owner: string }> = {
  F1: {
    title: "Any cookie signed with AUTH_SECRET is served as the owner",
    detail:
      "The session never names its user (auth.ts's jwt callback reads the one global token row for every cookie), so a friend's, a revoked friend's, or any other validly signed cookie reaches Rem's store and Rem's Spotify grant on every user entry point. Today only the owner-only signIn callback (src/lib/owner.ts) and AUTH_SECRET's secrecy stand in front of it.",
    owner: "P1: the uid on the session, its identity check and requireUser (lane 12); P2: status and session_epoch from the identity read (lane 15)",
  },
  F2: {
    title: "A session whose Spotify grant is gone still reads the whole library and history",
    detail:
      "The two search routes, the six history actions, /api/metrics and /api/tasks/[id] check only that a session exists (!!auth()). Once the token row is gone (Log out, or invalid_grant) the session carries `error` and every page refuses it, but these keep serving Rem's data to it, including a cookie copied before Log out. PLAN §5.4 says requireUser applies the pages' rule to them; mu/phase1's gateFromSession allows an errored session (canCallSpotify: false), which would keep serving it.",
    owner: "P1 (lane 12): requireUser applying PLAN §5.4's rule; P4a (lane 19): Log out bumps session_epoch",
  },
  F3: {
    title: "Log out does not end a cookie",
    detail:
      "logout deletes the browser's cookie and the global token row, but the JWE stays valid for its 30 days, and GET /api/auth/session re-issues it with a fresh 30 days on every read. A copy left on a shared computer is refused only while the token row is absent: the next sign-in anywhere brings it back to full access.",
    owner: "P1: auth_time's 30-day bound (lane 12); P4a: Log out bumps session_epoch (lane 19)",
  },
  F4: {
    title: "logout runs with no session check",
    detail:
      "The logout server action clears the global Spotify token row in after() whoever posts it: no cookie, a forged or stale cookie, a friend. Anyone who can post the action stops closed-app capture until Rem signs in again (the cron then answers 503 'no token'), and plays past Spotify's last 50 are lost.",
    owner: "P1 (lane 12, item 6: every action onto requireActionUser, logout included)",
  },
  F5: {
    title: "/usage has no admin rule",
    detail:
      "Any session sees the operator's page: the rows-read ledger, per-page client timings and the Spotify call breakdown with raw paths. PLAN §6.2 layer 7 says both 'require is_admin' and 'for any user but the admin, aggregated'; lane 12's brief says admin-only, which this map takes.",
    owner: "P1 (lane 12, item 6)",
  },
  F6: {
    title: "Search payloads carry no user: ETags without a uid, bodies revalidated from the HTTP cache",
    detail:
      "The library and history ETags are \"lib-<shape>-<version>-<day>\" with per-store counters that collide across users, the bodies are `private, max-age=0, must-revalidate` (kept in the HTTP cache after sign-out) and carry no `u`, and the cached reads behind them key on the version alone.",
    owner: "P1 (lane 12, items 3-4; PLAN §6.2 layers 4 and 6)",
  },
  F7: {
    title: "One cron check for every cron route, and CRON_SECRET_EXT about to join it",
    detail:
      "Until the store split, /api/cron/sync ran the daily chores for any CRON_SECRET holder who sent x-vercel-cron; origin/main moved them to /api/cron/daily (75aea82), so that header opens nothing now (the red team pins it). What is left: all four cron routes share cronAuthorized() in src/lib/cron-auth.ts. Lane 07's brief takes mu/phase1's src/lib/cron-auth.ts byte for byte, a different file under the same name (cronCaller, no cronAuthorized): taken whole it removes the export four routes import; folded into cronAuthorized it opens /api/cron/daily, /api/cron/store-bench and /api/cron/usage-check to cron-job.org's secret, which PLAN §5.5 forbids (EXT opens /api/cron/sync and /api/cron/health only). Today the rule is explicit (EXT is unknown to every route); the cronjobOrg cells of those three routes are the tripwire.",
    owner: "L07 (lane 07: keep cronAuthorized CRON_SECRET-only, add cronCaller beside it); P1 (lane 12's rebase meets the same add/add on cron-auth.ts)",
  },
  F8: {
    title: "/home reads Rem's store before its gate",
    detail:
      "home/page.tsx runs getHomePayload, the cooldown and capture health in one Promise.all with auth(): an anonymous request pays three store reads before the redirect (nothing ships; the cost lands on the shared store budget).",
    owner: "P1 (lane 12, item 6: Home's first wave behind the gate)",
  },
  F9: {
    title: "Phase 1's claims are not checked: a cookie never expires by age",
    detail:
      "auth_time is not read, so a 31-day-old sign-in is still a session as long as the cookie keeps being renewed (F3). PLAN §5.4 bounds a session to 30 days from its sign-in.",
    owner: "P1 (lane 12: the identity check reads auth_time)",
  },
  F10: {
    title: "The cron's owner alarm and per-user outcome would go to cron-job.org",
    detail:
      "/api/cron/sync answers its outcome (added counts, the 503 'no token' alarm) to whoever holds a secret. PLAN §7.2 step 0: cron-job.org gets a bare {\"ok\":true}, since it keeps response bodies and disables a job after a run of failures.",
    owner: "L07 (lane 07, item 2)",
  },
  F11: {
    title: "Background tasks have no owner",
    detail:
      "/api/tasks/[id] answers any session the task's full record, result included; only the random id stands in the way.",
    owner: "P1 (mu/phase1 built getTaskFor; lane 12 carries it)",
  },
};

// ── Rules shared by many cells ───────────────────────────────────────────────────────────
const R = {
  owner: "the owner's session: today every session is the owner's",
  noCookie: "carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted",
  badJwe: "the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)",
  friend: "none: no per-request identity (F1), so the cookie is served Rem's store and grant",
  deadGrantRefused: "the token row is gone, so the jwt callback sets session.error and this gate refuses it",
  deadGrantAllowed: "none: this gate checks only that a session exists (F2)",
  cronOnly: "cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret",
};

type UserGate = "session" | "session+grant";

function userCells(gate: UserGate, anonRule: string, over: Partial<Record<Principal, Cell>> = {}): Record<Principal, Cell> {
  const cells: Record<Principal, Cell> = {
    anon: { target: "deny", rule: anonRule },
    rem: { target: "allow", rule: R.owner },
    friendA: { target: "isolated", today: "allow", phase: "P1", rule: R.friend, finding: "F1" },
    friendB: { target: "isolated", today: "allow", phase: "P1", rule: R.friend, finding: "F1" },
    revoked: { target: "deny", today: "allow", phase: "P1", rule: R.friend, finding: "F1" },
    vercelCron: { target: "deny", rule: R.noCookie },
    zenbookPinger: { target: "deny", rule: R.noCookie },
    zenbookRecorder: { target: "deny", rule: R.noCookie },
    cronjobOrg: { target: "deny", rule: R.noCookie },
    staleSecret: { target: "deny", rule: R.badJwe },
    staleLogout:
      gate === "session+grant"
        ? { target: "deny", rule: R.deadGrantRefused }
        : { target: "deny", today: "allow", phase: "P1", rule: R.deadGrantAllowed, finding: "F2" },
    forged: { target: "deny", rule: R.badJwe },
  };
  return { ...cells, ...over };
}

function publicCells(rule: string, over: Partial<Record<Principal, Cell>> = {}): Record<Principal, Cell> {
  const cells = Object.fromEntries(PRINCIPALS.map((p) => [p, { target: "allow", rule } as Cell])) as Record<Principal, Cell>;
  return { ...cells, ...over };
}

function cronCells(over: Partial<Record<Principal, Cell>> = {}): Record<Principal, Cell> {
  const deny = (why: string): Cell => ({ target: "deny", rule: `${R.cronOnly}; ${why}` });
  const cells: Record<Principal, Cell> = {
    anon: deny("no header → 401"),
    rem: deny("Rem's cookie → 401"),
    friendA: deny("a cookie → 401"),
    friendB: deny("a cookie → 401"),
    revoked: deny("a cookie → 401"),
    vercelCron: { target: "allow", rule: "Bearer $CRON_SECRET" },
    zenbookPinger: { target: "allow", rule: "Bearer $CRON_SECRET" },
    zenbookRecorder: deny("a Spotify bearer is not the secret → 401"),
    cronjobOrg: deny("CRON_SECRET_EXT never opens this route (PLAN §5.5)"),
    staleSecret: deny("a cookie → 401"),
    staleLogout: deny("a cookie → 401"),
    forged: deny("a cookie → 401"),
  };
  return { ...cells, ...over };
}

const EXT_TRIPWIRE: Cell = {
  target: "deny",
  rule: "CRON_SECRET_EXT is unknown to cronAuthorized() → 401; PLAN §5.5 keeps it out of every cron route but sync and health",
  finding: "F7",
};

// ── Invocation helpers ───────────────────────────────────────────────────────────────────
const route = <M extends string>(path: string, method: M) => async () => {
  const mod = (await import(/* @vite-ignore */ path)) as Record<M, (...a: unknown[]) => Promise<Response>>;
  return mod[method];
};

async function action(name: string, ...args: unknown[]): Promise<unknown> {
  const mod = (await import("@/app/(app)/actions")) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  return mod[name](...args);
}

async function historyAction(name: string, ...args: unknown[]): Promise<unknown> {
  const mod = (await import("@/app/(app)/history-actions")) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  return mod[name](...args);
}

async function authRoute(method: "GET" | "POST", path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  const { GET, POST } = await import("@/app/api/auth/[...nextauth]/route");
  const req = request(path, { method, body: init.body, headers: init.headers });
  const { NextRequest } = await import("next/server");
  return (method === "GET" ? GET : POST)(new NextRequest(req));
}

/** Auth.js's double-submit CSRF pair: the cookie it sets and the token a form posts back. */
async function csrf(): Promise<string> {
  const res = await authRoute("GET", "/api/auth/csrf");
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    ctx.cookies.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return ((await res.json()) as { csrfToken: string }).csrfToken;
}

function absorbCookies(res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const [kv, ...attrs] = c.split(";");
    const i = kv.indexOf("=");
    const name = kv.slice(0, i);
    const value = kv.slice(i + 1);
    if (!value || attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a.trim()))) ctx.cookies.delete(name);
    else ctx.cookies.set(name, value);
  }
}

/** Run the OAuth round trip as `person` (whose Spotify code the stand-in maps to them) and
 *  return the callback's response. Without `dance`, the callback arrives with no state or PKCE
 *  cookie: a replayed or injected callback URL. */
export async function oauthCallback(person: string | null, dance = true): Promise<Response> {
  let state = "authz-no-state";
  if (dance) {
    const token = await csrf();
    const res = await authRoute("POST", "/api/auth/signin/spotify", {
      body: new URLSearchParams({ csrfToken: token, callbackUrl: "/home" }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    absorbCookies(res);
    const loc = res.headers.get("location") ?? "";
    state = new URL(loc).searchParams.get("state") ?? state;
  }
  const code = `code-${person ?? "REM"}`;
  return authRoute("GET", `/api/auth/callback/spotify?code=${code}&state=${encodeURIComponent(state)}`);
}

const PERSON: Partial<Record<Principal, string>> = { rem: "REM", friendA: "A", friendB: "B", revoked: "R", anon: "NOTREG" };

const sessionBodyRefused = (o: Outcome) =>
  o.kind === "response" && (o.status >= 400 || o.text.trim() === "null" || o.text.trim() === "{}");
const nowPlayingRefused = (o: Outcome) =>
  o.kind === "response" && o.status === 200 && (JSON.parse(o.text) as { playing?: unknown }).playing === null;
const callbackRefused = (o: Outcome) =>
  o.kind === "response" && /\/login\?error=|error=/.test(o.headers.get("location") ?? "");

// ── The entries ──────────────────────────────────────────────────────────────────────────
export const ENTRIES: Entry[] = [
  // Route handlers
  {
    id: "GET /api/build",
    file: "src/app/api/build/route.ts",
    kind: "route",
    gate: null,
    does: "returns this deployment's build id; no store, no session",
    cells: publicCells("public by design: a git sha already public in every asset URL (route comment, GOTCHAS)"),
    invoke: async () => (await route("@/app/api/build/route", "GET")())(),
  },
  {
    id: "GET /api/now-playing",
    file: "src/app/api/now-playing/route.ts",
    kind: "route",
    gate: "const accessToken = session && !session.error ? await spotifyAccessToken() : undefined;",
    does: "reads Spotify's currently-playing with Rem's grant; reads and writes the context-name cache (contexts)",
    cells: userCells("session+grant", "auth() null → 200 {playing:null} with no store read (deliberately not 401: polled every 6 s)"),
    refused: nowPlayingRefused,
    invoke: async () => (await route("@/app/api/now-playing/route", "GET")())(),
  },
  {
    id: "POST /api/sync",
    file: "src/app/api/sync/route.ts",
    kind: "route",
    gate: "const accessToken = session && !session.error ? await spotifyAccessToken() : undefined;",
    does: "harvests recently-played with Rem's grant into plays/tracks; writes meta user_tz from the tzoffset cookie and the sync stamps",
    cells: userCells("session+grant", "auth() null → 401 before any read"),
    invoke: async () => (await route("@/app/api/sync/route", "POST")())(),
  },
  {
    id: "POST /api/metrics",
    file: "src/app/api/metrics/route.ts",
    kind: "route",
    gate: "if (!(await auth())) return new Response(\"Unauthorized\", { status: 401 });",
    does: "appends client timing rows to client_metrics (shown on /usage)",
    cells: userCells("session", "auth() null → 401 before the body is read"),
    invoke: async () =>
      (await route("@/app/api/metrics/route", "POST")())(
        request("/api/metrics", { method: "POST", body: { session: "s", events: [{ page: "/home", event: "ttfb", value: 1 }] } }),
      ),
  },
  {
    id: "GET /api/search/library",
    file: "src/app/api/search/library/route.ts",
    kind: "route",
    gate: "if (!(await auth())) return new Response(\"Unauthorized\", { status: 401 });",
    does: "returns every track in a playlist or Liked Songs (the library index), ETag'd",
    cells: userCells("session", "auth() null → 401 before any read", {}),
    invoke: async () => (await route("@/app/api/search/library/route", "GET")())(request("/api/search/library")),
  },
  {
    id: "GET /api/search/history",
    file: "src/app/api/search/history/route.ts",
    kind: "route",
    gate: "if (!(await auth())) return new Response(\"Unauthorized\", { status: 401 });",
    does: "returns every played track and every play (the history index), ETag'd",
    cells: userCells("session", "auth() null → 401 before any read"),
    invoke: async () => (await route("@/app/api/search/history/route", "GET")())(request("/api/search/history")),
  },
  {
    id: "GET /api/tasks/[id]",
    file: "src/app/api/tasks/[id]/route.ts",
    kind: "route",
    gate: "if (!session) return Response.json({ error: \"unauthorized\" }, { status: 401 });",
    does: "returns one background task's progress and result from the in-process registry",
    cells: userCells("session", "auth() null → 401", {
      friendA: { target: "isolated", today: "allow", phase: "P1", rule: R.friend, finding: "F11" },
      friendB: { target: "isolated", today: "allow", phase: "P1", rule: R.friend, finding: "F11" },
    }),
    before: async () => {
      const { runTask, taskDone } = await import("@/lib/tasks/registry");
      // Owned by Rem: Phase 1's runTask takes the owner's uid as a third argument; today's ignores it.
      const run = runTask as unknown as (label: string, work: () => Promise<string>, owner: string) => { id: string };
      const t = run("authz", async () => "REM-only-task-result", OWNER_UID);
      await taskDone(t.id);
      ctx.headers["x-authz-task"] = t.id;
    },
    invoke: async () => {
      const id = ctx.headers["x-authz-task"];
      return (await route("@/app/api/tasks/[id]/route", "GET")())(request(`/api/tasks/${id}`), params({ id }));
    },
  },
  {
    id: "POST /api/playlists/[id]/tracks",
    file: "src/app/api/playlists/[id]/tracks/route.ts",
    kind: "route",
    gate: "const accessToken = session && !session.error ? await spotifyAccessToken() : undefined;",
    does: "reads one playlist's snapshot from Spotify with Rem's grant; re-fetches and rewrites its cached tracks when changed",
    cells: userCells("session+grant", "auth() null → 401 before any read"),
    invoke: async () =>
      (await route("@/app/api/playlists/[id]/tracks/route", "POST")())(
        request(`/api/playlists/${REM_PLAYLIST}/tracks`, { method: "POST", body: { snapshot: "old" } }),
        params({ id: REM_PLAYLIST }),
      ),
  },
  {
    id: "POST /api/playlists/sync",
    file: "src/app/api/playlists/sync/route.ts",
    kind: "route",
    gate: "if (!session || session.error || !(await spotifyAccessToken())) throw new Error(\"unauthorized\");",
    gateFile: "src/lib/playlists-sync.ts",
    does: "starts a full library scan with Rem's grant as a background task; rewrites playlists, playlist_tracks, saved_tracks",
    cells: userCells("session+grant", "startLibrarySync: auth() null → 'unauthorized' → 401"),
    invoke: async () => (await route("@/app/api/playlists/sync/route", "POST")())(),
  },
  {
    id: "GET /api/cron/sync",
    file: "src/app/api/cron/sync/route.ts",
    kind: "route",
    gate: "if (!cronAuthorized(req)) {",
    does: "the tick: currently-playing and recently-played with Rem's stored grant, harvest stamps, plays; a library rescan every 30 min",
    cells: cronCells({
      vercelCron: { target: "allow", rule: "Bearer $CRON_SECRET → the tick (vercel.json, 07:00 UTC)" },
      cronjobOrg: {
        target: "allow",
        today: "deny",
        phase: "L07",
        rule: "CRON_SECRET_EXT is unknown today → 401 (its job's old bearer went stale at the Aug 10 rotation); lane 07 accepts it and answers a bare {\"ok\":true}",
        finding: "F10",
      },
    }),
    invoke: async () => (await route("@/app/api/cron/sync/route", "GET")())(request("/api/cron/sync")),
  },
  {
    id: "GET /api/cron/usage-check",
    reaches: false,
    file: "src/app/api/cron/usage-check/route.ts",
    kind: "route",
    gate: "if (!cronAuthorized(req)) {",
    does: "runUsageCheck: Turso's org usage with TURSO_PLATFORM_TOKEN and yesterday's reconciliation into the read-cost ledger (no per-user data)",
    cells: cronCells({ cronjobOrg: EXT_TRIPWIRE }),
    invoke: async () => (await route("@/app/api/cron/usage-check/route", "GET")())(request("/api/cron/usage-check")),
  },
  {
    id: "GET /api/cron/daily",
    file: "src/app/api/cron/daily/route.ts",
    kind: "route",
    gate: "if (!cronAuthorized(req)) {",
    does: "the daily chores: recompute all-time totals, rebuild the Home payload, prune api_log and client_metrics, the played_at check, the usage check",
    cells: cronCells({
      vercelCron: { target: "allow", rule: "Bearer $CRON_SECRET → the chores (vercel.json, 09:00 UTC)" },
      cronjobOrg: EXT_TRIPWIRE,
    }),
    invoke: async () => (await route("@/app/api/cron/daily/route", "GET")())(request("/api/cron/daily")),
  },
  {
    id: "GET /api/cron/store-bench",
    reaches: false,
    file: "src/app/api/cron/store-bench/route.ts",
    kind: "route",
    gate: "if (!cronAuthorized(req)) {",
    does: "timed reads of the core or telemetry store; the reply names the store's host, never a token",
    cells: cronCells({ cronjobOrg: EXT_TRIPWIRE }),
    invoke: async () => (await route("@/app/api/cron/store-bench/route", "GET")())(request("/api/cron/store-bench")),
  },
  // Auth.js
  {
    id: "GET /api/auth/session",
    reaches: false,
    file: "src/app/api/auth/[...nextauth]/route.ts",
    kind: "auth",
    gate: "async session({ session, token }) {",
    gateFile: "src/lib/auth.ts",
    does: "answers the cookie's own session (name, email, expiry, error; never a token) and re-issues the cookie with a fresh 30 days",
    cells: {
      ...userCells("session", "no cookie → null"),
      rem: { target: "allow", rule: "the cookie decodes; the session callback copies only `error` (tokens stay off the session, SECURITY.md)" },
      friendA: { target: "isolated", rule: "answers the cookie's own claims only; no identity check (F1), harmless here", finding: "F1" },
      friendB: { target: "isolated", rule: "answers the cookie's own claims only; no identity check (F1), harmless here", finding: "F1" },
      revoked: { target: "deny", today: "allow-own", phase: "P1", rule: "none: a revoked friend's cookie still gets its session (F1)", finding: "F1" },
      staleLogout: {
        target: "deny",
        today: "allow-own",
        phase: "P4a",
        rule: "none: the copied cookie still decodes and is re-issued with a fresh 30 days (F3)",
        finding: "F3",
      },
    },
    refused: sessionBodyRefused,
    invoke: async () => authRoute("GET", "/api/auth/session"),
  },
  {
    id: "GET /api/auth/csrf",
    file: "src/app/api/auth/[...nextauth]/route.ts",
    kind: "auth",
    gate: null,
    does: "issues Auth.js's CSRF token and cookie",
    cells: publicCells("public: Auth.js's double-submit token"),
    invoke: async () => authRoute("GET", "/api/auth/csrf"),
  },
  {
    id: "GET /api/auth/providers",
    file: "src/app/api/auth/[...nextauth]/route.ts",
    kind: "auth",
    gate: null,
    does: "lists the configured provider (Spotify)",
    cells: publicCells("public: provider metadata"),
    invoke: async () => authRoute("GET", "/api/auth/providers"),
  },
  {
    id: "POST /api/auth/signin/spotify",
    file: "src/app/api/auth/[...nextauth]/route.ts",
    kind: "auth",
    gate: null,
    does: "starts OAuth: state and PKCE cookies, a redirect to accounts.spotify.com",
    cells: publicCells("public: anyone may start a sign-in; the callback decides"),
    invoke: async () => {
      const token = await csrf();
      return authRoute("POST", "/api/auth/signin/spotify", {
        body: new URLSearchParams({ csrfToken: token, callbackUrl: "/home" }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
    },
  },
  {
    id: "GET /api/auth/callback/spotify",
    file: "src/app/api/auth/[...nextauth]/route.ts",
    kind: "auth",
    gate: "return isOwnerSignIn(profile?.id ?? undefined);",
    gateFile: "src/lib/auth.ts",
    does: "finishes OAuth: exchanges the code, reads /v1/me uncached-by-design, runs signIn (owner only), writes the token row, sets the session cookie",
    cells: {
      anon: { target: "deny", rule: "a stranger off the dev-mode allowlist: /v1/me 403 → /login?error=SpotifyNotRegistered, nothing written" },
      rem: { target: "allow", rule: "SPOTIFY_OWNER_ID matches → the token row is written and a cookie set" },
      friendA: {
        target: "isolated",
        rule: "owner-only signIn (src/lib/owner.ts) → AccessDenied before the token write; from P4a an invite claim gives them their own uid and row",
      },
      friendB: {
        target: "isolated",
        rule: "owner-only signIn (src/lib/owner.ts) → AccessDenied before the token write; from P4a an invite claim gives them their own uid and row",
      },
      revoked: { target: "deny", rule: "owner-only signIn → AccessDenied; from P2 a disabled row is refused with 'ask Rem'" },
      vercelCron: { target: "deny", rule: "a callback with no state or PKCE cookie → Auth.js InvalidCheck → /login?error=" },
      zenbookPinger: { target: "deny", rule: "a callback with no state or PKCE cookie → Auth.js InvalidCheck → /login?error=" },
      zenbookRecorder: { target: "deny", rule: "a callback with no state or PKCE cookie → Auth.js InvalidCheck → /login?error=" },
      cronjobOrg: { target: "deny", rule: "a callback with no state or PKCE cookie → Auth.js InvalidCheck → /login?error=" },
      staleSecret: { target: "deny", rule: "a replayed callback URL with Rem's code but no state cookie → InvalidCheck" },
      staleLogout: { target: "deny", rule: "a replayed callback URL with Rem's code but no state cookie → InvalidCheck" },
      forged: { target: "deny", rule: "a replayed callback URL with Rem's code but no state cookie → InvalidCheck" },
    },
    refused: callbackRefused,
    invoke: async (p) => {
      const person = PERSON[p];
      return person ? oauthCallback(person) : oauthCallback("REM", false);
    },
  },
  {
    id: "POST /api/auth/signout",
    file: "src/app/api/auth/[...nextauth]/route.ts",
    kind: "auth",
    gate: null,
    does: "deletes this browser's session cookie (CSRF-checked); touches no store row",
    cells: publicCells("public: only clears the caller's own cookie"),
    invoke: async () => {
      const token = await csrf();
      return authRoute("POST", "/api/auth/signout", {
        body: new URLSearchParams({ csrfToken: token, callbackUrl: "/login" }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
    },
  },

  // Server actions: actions.ts
  {
    id: "action login",
    file: "src/app/(app)/actions.ts",
    kind: "action",
    gate: null,
    does: "starts OAuth (signIn('spotify')): a redirect to accounts.spotify.com",
    cells: publicCells("public: starting a sign-in reads and writes nothing"),
    invoke: async () => action("login"),
  },
  {
    id: "action logout",
    file: "src/app/(app)/actions.ts",
    kind: "action",
    gate: null,
    does: "deletes the global Spotify token row (after the response) and this browser's cookie",
    cells: (() => {
      const f4: Cell = { target: "deny", today: "allow", phase: "P1", rule: "none: no session check before the token row is cleared (F4)", finding: "F4" };
      return {
        anon: f4,
        rem: { target: "allow", rule: "the owner signing out (today: clears the one token row, which stops capture)" },
        friendA: { ...f4, target: "isolated" },
        friendB: { ...f4, target: "isolated" },
        revoked: f4,
        vercelCron: f4,
        zenbookPinger: f4,
        zenbookRecorder: f4,
        cronjobOrg: f4,
        staleSecret: f4,
        staleLogout: { target: "deny", rule: "nothing left to clear: the token row is already gone; still no session check (F4)", finding: "F4" },
        forged: f4,
      } satisfies Record<Principal, Cell>;
    })(),
    invoke: async () => action("logout"),
  },
  ...(
    [
      ["mergeAction", "creates a playlist from several on Rem's account; records it in playlists", [REM_PLAYLIST, "rem-pl-2"]],
      ["saveQueueAction", "reads Rem's queue and saves it as a new playlist; records it", []],
      ["subtractPreviewAction", "reads cached (or live) tracks of the named playlists; returns the set difference", [REM_PLAYLIST, [{ id: "rem-pl-2", name: "other" }]]],
      ["saveCompareDiffAction", "creates a playlist on Rem's account from the given uris; records it", ["authz", ["spotify:track:rem-t1"]]],
      ["addToQueueAction", "adds a track to Rem's playback queue", ["spotify:track:rem-t1"]],
      ["playTrackAction", "starts a track on Rem's active device", ["spotify:track:rem-t1"]],
      ["playFromPlaylistAction", "starts a playlist at a track on Rem's device", [REM_PLAYLIST, "spotify:track:rem-t1"]],
      ["playPlaylistAction", "starts a playlist on Rem's device", [REM_PLAYLIST]],
      ["saveToLikedAction", "saves a track to Rem's Liked Songs", ["rem-t1"]],
      ["removeFromPlaylistAction", "removes a track from one of Rem's playlists; rewrites the cached copy", [REM_PLAYLIST, "spotify:track:rem-t1", 0]],
      ["playerSetPlayingAction", "pauses or resumes Rem's playback", [true]],
      ["playPlaylistTrackAction", "plays a track within a playlist on Rem's device", [REM_PLAYLIST, "spotify:track:rem-t1"]],
      ["resumePlaylistAction", "reads the playlist's cached order and Rem's plays in it; starts playback after the last one", [REM_PLAYLIST]],
    ] as const
  ).map(
    ([name, does, args]): Entry => ({
      id: `action ${name}`,
      file: "src/app/(app)/actions.ts",
      kind: "action",
      gate: "const accessToken = session && !session.error ? await spotifyAccessToken() : undefined;",
      gateFile: "src/lib/session.ts",
      reaches: true,
      does,
      cells: userCells("session+grant", "getSpotify(): no session or no token → redirect('/login') before any read (src/lib/session.ts)"),
      invoke: async () => action(name, ...(args as readonly unknown[])),
    }),
  ),
  {
    id: "action startCleanAction",
    file: "src/app/(app)/actions.ts",
    kind: "action",
    gate: "if (!session || session.error || !(await spotifyAccessToken())) {",
    does: "dedupes a playlist into a new one on Rem's account (and a backup); takes a clean:<id> lock; a background reconcile task",
    cells: userCells("session+grant", "auth() null → { ok: false, 'Not authenticated' } before any read"),
    invoke: async () => action("startCleanAction", REM_PLAYLIST),
  },
  {
    id: "action deletePlaylistAction",
    file: "src/app/(app)/actions.ts",
    kind: "action",
    gate: "if (!session || session.error || !(await spotifyAccessToken())) {",
    does: "unfollows a playlist on Rem's account and deletes it from the store",
    cells: userCells("session+grant", "auth() null → { ok: false, 'Not authenticated' } before any read"),
    invoke: async () => action("deletePlaylistAction", REM_PLAYLIST),
  },
  {
    id: "action trackMenuAction",
    file: "src/app/(app)/actions.ts",
    kind: "action",
    gate: "if (!session || session.error) return { ok: false, error: \"Not signed in.\" };",
    does: "looks a track up by name and artist in Rem's library, with the playlists that hold it",
    cells: userCells("session+grant", "auth() null → { ok: false, 'Not signed in.' } before any read"),
    invoke: async () => action("trackMenuAction", "REM-only-song-1", "REM-only-artist"),
  },

  // Server actions: history-actions.ts
  ...(
    [
      ["dockDataAction", "reads every stored playlist, me_id, the clean-backup preference and the sync stamp", []],
      ["dayTracksAction", "reads one day's plays", [REM_DAY]],
      ["dailyStatsAction", "reads per-day play counts for up to 100,000 days", [14]],
      ["allTimePlaysAction", "reads the 300 most-played tracks", []],
      ["searchPlaysAction", "LIKE-searches every play by name or artist", ["REM"]],
    ] as const
  ).map(
    ([name, does, args]): Entry => ({
      id: `action ${name}`,
      file: "src/app/(app)/history-actions.ts",
      kind: "action",
      gate: "return !!(await auth());",
      does,
      cells: userCells("session", "allowed(): auth() null → an empty answer before any read"),
      invoke: async () => historyAction(name, ...(args as readonly unknown[])),
    }),
  ),
  {
    id: "action refreshHistoryAction",
    file: "src/app/(app)/history-actions.ts",
    kind: "action",
    gate: "return !!(await auth());",
    does: "harvests recently-played with Rem's grant, then re-reads the strip, all-time totals and the visible day",
    cells: userCells("session", "allowed(): auth() null → NO_REFRESH before any read", {
      staleLogout: { target: "deny", rule: "allowed() passes, then getSpotify() finds no token and redirects to /login before any read" },
    }),
    invoke: async () => historyAction("refreshHistoryAction", "latest", 14, null),
  },

  // Pages and layouts
  {
    id: "page /home",
    file: "src/app/(app)/home/page.tsx",
    kind: "page",
    gate: "if (!session || session.error) redirect(\"/login\");",
    does: "renders the day strip, all-time card and the opening day's rows from the Home payload",
    cells: userCells("session+grant", "auth() null → redirect('/login'), after three store reads", {
      anon: { target: "deny", rule: "auth() null → redirect('/login'); nothing ships, but three store reads run first (F8)", finding: "F8" },
    }),
    invoke: async () => (await import("@/app/(app)/home/page")).default(),
  },
  {
    id: "page /playlists",
    file: "src/app/(app)/playlists/page.tsx",
    kind: "page",
    gate: "if (!session || session.error) redirect(\"/login\");",
    does: "renders every stored playlist and the unique-song count",
    cells: userCells("session+grant", "auth() null → redirect('/login') before any read"),
    invoke: async () => (await import("@/app/(app)/playlists/page")).default(),
  },
  {
    id: "page /playlists/[id]",
    file: "src/app/(app)/playlists/[id]/page.tsx",
    kind: "page",
    gate: "if (!session || session.error) redirect(\"/login\");",
    does: "renders one playlist's cached tracks; a cold playlist is fetched with Rem's grant and cached",
    cells: userCells("session+grant", "auth() null → redirect('/login') before any read"),
    invoke: async () => (await import("@/app/(app)/playlists/[id]/page")).default(params({ id: REM_PLAYLIST })),
  },
  {
    id: "page /usage",
    file: "src/app/(app)/usage/page.tsx",
    kind: "page",
    gate: "if (!session || session.error) redirect(\"/login\");",
    does: "renders the operator's page: per-page timings, the rows-read ledger, the Spotify call breakdown, capture health",
    cells: userCells("session+grant", "auth() null → redirect('/login') before any read", {
      friendA: { target: "deny", today: "allow", phase: "P1", rule: "none: no admin rule (F5); any session is the owner (F1)", finding: "F5" },
      friendB: { target: "deny", today: "allow", phase: "P1", rule: "none: no admin rule (F5); any session is the owner (F1)", finding: "F5" },
    }),
    invoke: async () => (await import("@/app/(app)/usage/page")).default(),
  },
  {
    id: "page /friends",
    file: "src/app/(app)/friends/page.tsx",
    kind: "page",
    gate: null,
    does: "a constant placeholder; no data, no session read (prerendered)",
    cells: publicCells("a constant with no data (page comment); reached through the (app) layout, which redirects a missing session"),
    invoke: async () => (await import("@/app/(app)/friends/page")).default(),
  },
  {
    id: "layout (app)",
    reaches: false,
    file: "src/app/(app)/layout.tsx",
    kind: "layout",
    gate: "if (!session || session.error) redirect(\"/login\");",
    does: "renders the chrome with the session's name and image; not a gate for its pages (SECURITY.md)",
    cells: userCells("session+grant", "auth() null → redirect('/login')", {
      friendA: { target: "isolated", rule: "renders the cookie's own name and image; no identity check (F1), no store read", finding: "F1" },
      friendB: { target: "isolated", rule: "renders the cookie's own name and image; no identity check (F1), no store read", finding: "F1" },
      revoked: { target: "deny", today: "allow-own", phase: "P1", rule: "none: renders the chrome for a revoked friend's cookie (F1)", finding: "F1" },
    }),
    invoke: async () => (await import("@/app/(app)/layout")).default({ children: null }),
  },
  {
    id: "page /",
    file: "src/app/page.tsx",
    kind: "page",
    gate: null,
    does: "redirects to /home",
    cells: publicCells("public: a redirect, no read"),
    invoke: async () => (await import("@/app/page")).default(),
  },
  {
    id: "page /login",
    file: "src/app/(auth)/login/page.tsx",
    kind: "page",
    gate: null,
    does: "the sign-in button; a live session is sent on to /home",
    cells: publicCells("public: the sign-in page"),
    invoke: async () => (await import("@/app/(auth)/login/page")).default({ searchParams: Promise.resolve({}) } as never),
  },
  {
    id: "page /privacy",
    file: "src/app/(legal)/privacy/page.tsx",
    kind: "page",
    gate: null,
    does: "the privacy policy; no session, no data",
    cells: publicCells("public by Spotify's terms §V (shown before sign-up)"),
    invoke: async () => (await import("@/app/(legal)/privacy/page")).default(),
  },
  {
    id: "page /terms",
    file: "src/app/(legal)/terms/page.tsx",
    kind: "page",
    gate: null,
    does: "the end-user terms; no session, no data",
    cells: publicCells("public by Spotify's terms §V (shown before sign-up)"),
    invoke: async () => (await import("@/app/(legal)/terms/page")).default(),
  },
  {
    id: "layout (legal)",
    file: "src/app/(legal)/layout.tsx",
    kind: "layout",
    gate: null,
    does: "the legal pages' frame; no session, no data",
    cells: publicCells("public"),
    invoke: async () => (await import("@/app/(legal)/layout")).default({ children: null }),
  },
  {
    id: "layout (root)",
    file: "src/app/layout.tsx",
    kind: "layout",
    gate: null,
    does: "html, fonts, the host canonicalizer; no session, no data",
    cells: publicCells("public"),
    invoke: async () => (await import("@/app/layout")).default({ children: null }),
  },
  {
    id: "page /kbtest",
    file: "src/app/kbtest/page.tsx",
    kind: "page",
    gate: "if (process.env.NODE_ENV === \"production\") notFound();",
    does: "a dev-only keyboard fixture over dummy rows",
    cells: Object.fromEntries(
      PRINCIPALS.map((p) => [p, { target: "deny", rule: "notFound() in production builds; dummy rows in dev" } as Cell]),
    ) as Record<Principal, Cell>,
    invoke: async () => {
      const env = process.env as Record<string, string | undefined>;
      const was = env.NODE_ENV;
      env.NODE_ENV = "production";
      try {
        return (await import("@/app/kbtest/page")).default();
      } finally {
        env.NODE_ENV = was;
      }
    },
  },
];
