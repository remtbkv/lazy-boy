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
      "The session never names its user (auth.ts's jwt callback reads the one global token row for every cookie), so a friend's, a revoked friend's, or any other validly signed cookie reaches Rem's store and Rem's Spotify grant on every user entry point. Today only the owner-only signIn callback (src/lib/owner.ts) and AUTH_SECRET's secrecy stand in front of it. Closed for Phase 1 in its turn (lane 12): every request's cookie passes the identity check (src/lib/identity.ts), which knows one uid, OWNER_UID; requireUser is the only source of a uid. Phase 2 adds status and session_epoch.",
    owner: "P1: the uid on the session, its identity check and requireUser (lane 12); P2: status and session_epoch from the identity read (lane 15)",
  },
  F2: {
    title: "A session whose Spotify grant is gone still reads the whole library and history",
    detail:
      "The two search routes, the six history actions, /api/metrics and /api/tasks/[id] check only that a session exists (!!auth()). Once the token row is gone (Log out, or invalid_grant) the session carries `error` and every page refuses it, but these keep serving Rem's data to it, including a cookie copied before Log out. PLAN §5.4 says requireUser applies the pages' rule to them; mu/phase1's gateFromSession allows an errored session (canCallSpotify: false), which would keep serving it. Closed in Phase 1's turn (lane 12): requireUser refuses a session whose grant is gone on every entry point (src/lib/session-gate.ts).",
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
      "The logout server action clears the global Spotify token row in after() whoever posts it: no cookie, a forged or stale cookie, a friend. Anyone who can post the action stops closed-app capture until Rem signs in again (the cron then answers 503 'no token'), and plays past Spotify's last 50 are lost. Closed in Phase 1's turn (lane 12): logout clears only the gated user's own token row; a refused caller gets only its cookie cleared.",
    owner: "P1 (lane 12, item 6: every action onto requireActionUser, logout included)",
  },
  F5: {
    title: "/usage has no admin rule",
    detail:
      "Any session sees the operator's page: the rows-read ledger, per-page client timings and the Spotify call breakdown with raw paths. PLAN §6.2 layer 7 says both 'require is_admin' and 'for any user but the admin, aggregated'; lane 12's brief says admin-only, which this map takes. Closed in Phase 1's turn (lane 12): /usage is the admin's; anyone else gets notFound() after requirePageUser.",
    owner: "P1 (lane 12, item 6)",
  },
  F6: {
    title: "Search payloads carry no user: ETags without a uid, bodies revalidated from the HTTP cache",
    detail:
      "The library and history ETags are \"lib-<shape>-<version>-<day>\" with per-store counters that collide across users, the bodies are `private, max-age=0, must-revalidate` (kept in the HTTP cache after sign-out) and carry no `u`, and the cached reads behind them key on the version alone. Closed in Phase 1's turn (lane 12): both ETags carry the uid and the store epoch, the bodies are `private, no-store` with `u`, and every cached read goes through userCache (uid and epoch in the key).",
    owner: "P1 (lane 12, items 3-4; PLAN §6.2 layers 4 and 6)",
  },
  F7: {
    title: "One cron check for every cron route, and CRON_SECRET_EXT about to join it",
    detail:
      "Until the store split, /api/cron/sync ran the daily chores for any CRON_SECRET holder who sent x-vercel-cron; origin/main moved them to /api/cron/daily (75aea82), so that header opens nothing now (the red team pins it). What is left: all four cron routes share cronAuthorized() in src/lib/cron-auth.ts. Lane 07's brief takes mu/phase1's src/lib/cron-auth.ts byte for byte, a different file under the same name (cronCaller, no cronAuthorized): taken whole it removes the export four routes import; folded into cronAuthorized it opens /api/cron/daily, /api/cron/store-bench and /api/cron/usage-check to cron-job.org's secret, which PLAN §5.5 forbids (EXT opens /api/cron/sync and /api/cron/health only). Today the rule is explicit (EXT is unknown to every route); the cronjobOrg cells of those three routes are the tripwire.",
    owner: "L07 (lane 07, done on mu/pinger: cronAuthorized stays CRON_SECRET-only, cronCaller beside it opens /api/cron/sync alone); P1 (lane 12's rebase meets the same add/add on cron-auth.ts)",
  },
  F8: {
    title: "/home reads Rem's store before its gate",
    detail:
      "home/page.tsx runs getHomePayload, the cooldown and capture health in one Promise.all with auth(): an anonymous request pays three store reads before the redirect (nothing ships; the cost lands on the shared store budget). Closed in Phase 1's turn (lane 12): Home's reads start after requirePageUser.",
    owner: "P1 (lane 12, item 6: Home's first wave behind the gate)",
  },
  F9: {
    title: "Phase 1's claims are not checked: a cookie never expires by age",
    detail:
      "auth_time is not read, so a 31-day-old sign-in is still a session as long as the cookie keeps being renewed (F3). PLAN §5.4 bounds a session to 30 days from its sign-in. Closed by the identity check (mu/phase1): auth_time over 30 days refuses the cookie.",
    owner: "P1 (lane 12: the identity check reads auth_time)",
  },
  F10: {
    title: "The cron's owner alarm and per-user outcome would go to cron-job.org",
    detail:
      "/api/cron/sync answers its outcome (added counts, the 503 'no token' alarm) to whoever holds a secret. PLAN §7.2 step 0: cron-job.org gets a bare {\"ok\":true}, since it keeps response bodies and disables a job after a run of failures.",
    owner: "L07 (lane 07, item 2, done on mu/pinger: the owner alarm and the outcome answer the Zenbook's CRON_SECRET only, cron-job.org gets a bare {\"ok\":true}); P3 (lane 17: Phase 3's tick keeps both, and the Zenbook's outcome names no friend's trigger or count)",
  },
  F11: {
    title: "Background tasks have no owner",
    detail:
      "/api/tasks/[id] answers any session the task's full record, result included; only the random id stands in the way. Closed by mu/phase1: tasks record their owner and getTaskFor answers another user's task as missing.",
    owner: "P1 (mu/phase1 built getTaskFor; lane 12 carries it)",
  },
};

// ── Rules shared by many cells ───────────────────────────────────────────────────────────
const R = {
  owner: "the owner's session: the identity check allows OWNER_UID, Phase 1's one user (src/lib/identity.ts)",
  noCookie: "carries no session cookie; user entry points read only the cookie, so auth() is null and the Authorization header is never consulted",
  badJwe: "the JWE does not decrypt under the current AUTH_SECRET, so Auth.js answers no session (auth() null)",
  friend:
    "requireUser: Phase 1's identity check knows one uid, OWNER_UID, so this cookie's uid is refused (the jwt callback signs it out) before any read",
  deadGrantRefused:
    "the token row is gone, so the jwt callback sets session.error and requireUser refuses it, the pages' rule (PLAN §5.4)",
  cronOnly: "cronAuthorized() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET`, timing-safe, an unset secret matching nobody; a cookie is not a secret",
  cronCaller: "cronCaller() (src/lib/cron-auth.ts) reads only `Authorization: Bearer $CRON_SECRET` (the Zenbook) or `Bearer $CRON_SECRET_EXT` (cron-job.org), timing-safe, an unset secret matching nobody; a cookie is not a secret",
};

function userCells(anonRule: string, over: Partial<Record<Principal, Cell>> = {}): Record<Principal, Cell> {
  const cells: Record<Principal, Cell> = {
    anon: { target: "deny", rule: anonRule },
    rem: { target: "allow", rule: R.owner },
    friendA: { target: "isolated", rule: R.friend },
    friendB: { target: "isolated", rule: R.friend },
    revoked: { target: "deny", rule: R.friend },
    vercelCron: { target: "deny", rule: R.noCookie },
    zenbookPinger: { target: "deny", rule: R.noCookie },
    zenbookRecorder: { target: "deny", rule: R.noCookie },
    cronjobOrg: { target: "deny", rule: R.noCookie },
    staleSecret: { target: "deny", rule: R.badJwe },
    staleLogout: { target: "deny", rule: R.deadGrantRefused },
    forged: { target: "deny", rule: R.badJwe },
  };
  return { ...cells, ...over };
}

function publicCells(rule: string, over: Partial<Record<Principal, Cell>> = {}): Record<Principal, Cell> {
  const cells = Object.fromEntries(PRINCIPALS.map((p) => [p, { target: "allow", rule } as Cell])) as Record<Principal, Cell>;
  return { ...cells, ...over };
}

function cronCells(over: Partial<Record<Principal, Cell>> = {}, check: string = R.cronOnly): Record<Principal, Cell> {
  const deny = (why: string): Cell => ({ target: "deny", rule: `${check}; ${why}` });
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
    gate: "const user = await requireUser();",
    does: "reads Spotify's player state (/me/player) with Rem's grant; reads and writes the context-name cache (contexts)",
    cells: userCells("requireUser refused → 200 {playing:null} with no store read (deliberately not 401: polled every 6 s)"),
    refused: nowPlayingRefused,
    invoke: async () => (await route("@/app/api/now-playing/route", "GET")())(),
  },
  {
    id: "POST /api/sync",
    file: "src/app/api/sync/route.ts",
    kind: "route",
    gate: "const user = await requireRouteUser();",
    does: "harvests recently-played with Rem's grant into plays/tracks; writes meta user_tz from the tzoffset cookie and the sync stamps",
    cells: userCells("requireRouteUser: no session → 401 with the signed-out marker before any read"),
    invoke: async () => (await route("@/app/api/sync/route", "POST")())(),
  },
  {
    id: "POST /api/metrics",
    file: "src/app/api/metrics/route.ts",
    kind: "route",
    gate: "const user = await requireRouteUser();",
    does: "appends client timing rows to client_metrics under the session's uid (shown on /usage); drops server-only event names",
    cells: userCells("requireRouteUser: no session → 401 with the signed-out marker before any read"),
    invoke: async () =>
      (await route("@/app/api/metrics/route", "POST")())(
        request("/api/metrics", { method: "POST", body: { session: "s", events: [{ page: "/home", event: "ttfb", value: 1 }] } }),
      ),
  },
  {
    id: "GET /api/search/library",
    file: "src/app/api/search/library/route.ts",
    kind: "route",
    gate: "const user = await requireRouteUser();",
    does: "returns every track in a playlist or Liked Songs (the library index), ETag'd with the uid, private, no-store",
    cells: userCells("requireRouteUser: no session → 401 with the signed-out marker before any read"),
    invoke: async () => (await route("@/app/api/search/library/route", "GET")())(request("/api/search/library")),
  },
  {
    id: "GET /api/search/history",
    file: "src/app/api/search/history/route.ts",
    kind: "route",
    gate: "const user = await requireRouteUser();",
    does: "returns every played track and every play (the history index), ETag'd with the uid, private, no-store",
    cells: userCells("requireRouteUser: no session → 401 with the signed-out marker before any read"),
    invoke: async () => (await route("@/app/api/search/history/route", "GET")())(request("/api/search/history")),
  },
  {
    id: "GET /api/tasks/[id]",
    file: "src/app/api/tasks/[id]/route.ts",
    kind: "route",
    gate: "const user = await requireRouteUser();",
    does: "returns one background task's progress and result from the in-process registry, to its owner only (getTaskFor)",
    cells: userCells("requireRouteUser: no session → 401 with the signed-out marker before any read"),
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
    gate: "const user = await requireRouteUser();",
    does: "reads one playlist's snapshot from Spotify with Rem's grant; re-fetches and rewrites its cached tracks when changed",
    cells: userCells("requireRouteUser: no session → 401 with the signed-out marker before any read"),
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
    gate: "const user = await requireRouteUser();",
    does: "starts a full library scan with Rem's grant as a background task; rewrites playlists, playlist_tracks, saved_tracks",
    cells: userCells("requireRouteUser: no session → 401 with the signed-out marker before any read"),
    invoke: async () => (await route("@/app/api/playlists/sync/route", "POST")())(),
  },
  {
    id: "GET /api/cron/sync",
    file: "src/app/api/cron/sync/route.ts",
    kind: "route",
    gate: "if (!caller) return { status: 401",
    gateFile: "src/lib/sync/tick.ts",
    does: "the tick, at most one per 45 s whoever calls (app_meta.tick_at): the claim of every due user, each one's /me/player probe and, when the policy says so, a recently-played harvest with that user's own grant into their own plays; one library rescan; the daily chores when daily_at is over 26 h old",
    cells: cronCells(
      {
        vercelCron: { target: "allow", rule: "Bearer $CRON_SECRET → the tick (vercel.json, 07:00 UTC)" },
        cronjobOrg: {
          target: "allow",
          rule: "Bearer $CRON_SECRET_EXT → the tick, after the reply; the reply is a bare {\"ok\":true}, never the outcome or the owner alarm (PLAN §7.2 step 0)",
          finding: "F10",
        },
      },
      R.cronCaller,
    ),
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
  {
    id: "GET /api/cron/health",
    reaches: false,
    file: "src/app/api/cron/health/route.ts",
    kind: "route",
    gate: "if (!cronCaller(req.headers.get(\"authorization\"))) {",
    does: "the hourly health check: the owner's capture health, the daily stamp, the pace verdict, isolation events; replies ok/reasons/unchecked and nothing about anyone's listening",
    cells: cronCells({
      vercelCron: { target: "allow", rule: "cronCaller(): Bearer $CRON_SECRET (src/lib/cron-auth.ts)" },
      zenbookPinger: { target: "allow", rule: "cronCaller(): Bearer $CRON_SECRET (src/lib/cron-auth.ts)" },
      cronjobOrg: { target: "allow", rule: "cronCaller(): Bearer $CRON_SECRET_EXT opens this route and /api/cron/sync only (PLAN §5.5)" },
    }),
    invoke: async () => (await route("@/app/api/cron/health/route", "GET")())(request("/api/cron/health")),
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
      ...userCells("no cookie → null"),
      rem: { target: "allow", rule: "the cookie decodes; the session callback adds `uid`, `admin` and `error` (tokens stay off the session, SECURITY.md)" },
      friendA: { target: "isolated", rule: "the jwt callback's identity check refuses a uid that is not OWNER_UID → no session (null)" },
      friendB: { target: "isolated", rule: "the jwt callback's identity check refuses a uid that is not OWNER_UID → no session (null)" },
      revoked: { target: "deny", rule: "the jwt callback's identity check refuses a uid that is not OWNER_UID → no session (null)" },
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
    gate: "if (!(await isOwnerSignIn(profile?.id ?? undefined))) return false;",
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
    gate: "const user = await requireActionUser();",
    does: "deletes the gated user's Spotify token row (after the response) and this browser's cookie",
    cells: (() => {
      const refused: Cell = {
        target: "deny",
        rule: "requireActionUser refuses → only this browser's cookie is cleared; no token row is touched",
      };
      return {
        anon: refused,
        rem: { target: "allow", rule: "the owner signing out: clears his own token row, which stops capture (RULINGS Oct 15 1:33 PM)" },
        friendA: { ...refused, target: "isolated" },
        friendB: { ...refused, target: "isolated" },
        revoked: refused,
        vercelCron: refused,
        zenbookPinger: refused,
        zenbookRecorder: refused,
        cronjobOrg: refused,
        staleSecret: refused,
        staleLogout: { target: "deny", rule: "requireActionUser refuses a session whose grant is gone; nothing to clear either" },
        forged: refused,
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
      gate: "const user = await requireActionUser();",
      reaches: true,
      does,
      cells: userCells("requireActionUser: no session → { ok: false } before any read"),
      invoke: async () => action(name, ...(args as readonly unknown[])),
    }),
  ),
  {
    id: "action startCleanAction",
    file: "src/app/(app)/actions.ts",
    kind: "action",
    gate: "const user = await requireActionUser();",
    does: "dedupes a playlist into a new one on Rem's account (and a backup); takes a clean:<id> lock; a background reconcile task",
    cells: userCells("requireActionUser: no session → { ok: false } before any read"),
    invoke: async () => action("startCleanAction", REM_PLAYLIST),
  },
  {
    id: "action deletePlaylistAction",
    file: "src/app/(app)/actions.ts",
    kind: "action",
    gate: "const user = await requireActionUser();",
    does: "unfollows a playlist on Rem's account and deletes it from the store",
    cells: userCells("requireActionUser: no session → { ok: false } before any read"),
    invoke: async () => action("deletePlaylistAction", REM_PLAYLIST),
  },
  {
    id: "action trackMenuAction",
    file: "src/app/(app)/actions.ts",
    kind: "action",
    gate: "const user = await requireActionUser();",
    does: "looks a track up by name and artist in Rem's library, with the playlists that hold it",
    cells: userCells("requireActionUser: no session → { ok: false } before any read"),
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
      gate: "const user = await requireActionUser();",
      does,
      cells: userCells("gated(): requireActionUser refused → an empty answer before any read"),
      invoke: async () => historyAction(name, ...(args as readonly unknown[])),
    }),
  ),
  {
    id: "action refreshHistoryAction",
    file: "src/app/(app)/history-actions.ts",
    kind: "action",
    gate: "const user = await requireActionUser();",
    does: "harvests recently-played with Rem's grant, then re-reads the strip, all-time totals and the visible day",
    cells: userCells("gated(): requireActionUser refused → NO_REFRESH before any read"),
    invoke: async () => historyAction("refreshHistoryAction", "latest", 14, null),
  },

  // Pages and layouts
  {
    id: "page /home",
    file: "src/app/(app)/home/page.tsx",
    kind: "page",
    gate: "const user = await requirePageUser();",
    does: "renders the day strip, all-time card and the opening day's rows from the Home payload",
    cells: userCells("requirePageUser: no session → redirect('/login') before any read"),
    invoke: async () => (await import("@/app/(app)/home/page")).default(),
  },
  {
    id: "page /playlists",
    file: "src/app/(app)/playlists/page.tsx",
    kind: "page",
    gate: "(await requirePageUser())",
    does: "renders every stored playlist and the unique-song count",
    cells: userCells("requirePageUser: no session → redirect('/login') before any read"),
    invoke: async () => (await import("@/app/(app)/playlists/page")).default(),
  },
  {
    id: "page /playlists/[id]",
    file: "src/app/(app)/playlists/[id]/page.tsx",
    kind: "page",
    gate: "(await requirePageUser())",
    does: "renders one playlist's cached tracks; a cold playlist is fetched with Rem's grant and cached",
    cells: userCells("requirePageUser: no session → redirect('/login') before any read"),
    invoke: async () => (await import("@/app/(app)/playlists/[id]/page")).default(params({ id: REM_PLAYLIST })),
  },
  {
    id: "page /usage",
    file: "src/app/(app)/usage/page.tsx",
    kind: "page",
    gate: "if (!user.admin) notFound();",
    does: "renders the admin's page: per-page timings, the rows-read ledger, the Spotify call breakdown, capture health",
    cells: userCells("requirePageUser: no session → redirect('/login') before any read", {
      friendA: { target: "deny", rule: "requirePageUser refuses a uid that is not OWNER_UID; past it, /usage is the admin's (notFound() otherwise)" },
      friendB: { target: "deny", rule: "requirePageUser refuses a uid that is not OWNER_UID; past it, /usage is the admin's (notFound() otherwise)" },
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
    gate: "const user = await requirePageUser();",
    does: "renders the chrome with the session's name and image and the uid for the browser's storage names; not a gate for its pages (SECURITY.md)",
    cells: userCells("requirePageUser: no session → redirect('/login')"),
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
