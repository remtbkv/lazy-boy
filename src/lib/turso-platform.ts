// Turso's Platform API in the runtime (docs/multi-user/PLAN.md §5.5, §12.3; decision 24): the
// deletion job's look at a user database's owner and its destroy. TURSO_PLATFORM_TOKEN is
// Production only and read here and nowhere else in src/; unset (dev, Preview, tests), every call
// throws, so a deletion waits as `pending` and the daily chores retry it where the token exists.
// The owner read opens the database with the runtime's group token over the store fetch.
import "server-only";
import { createClient } from "@libsql/client";
import { makeStoreFetch } from "@/lib/store-fetch";

const API = "https://api.turso.tech/v1";

function platformToken(): string {
  const t = process.env.TURSO_PLATFORM_TOKEN;
  if (!t) throw new Error("TURSO_PLATFORM_TOKEN is unset");
  return t;
}

const org = () => process.env.TURSO_ORG || "remtbkv";

async function call(method: "GET" | "DELETE", p: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${API}/organizations/${org()}${p}`, {
    method,
    headers: { Authorization: `Bearer ${platformToken()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, json: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
}

/** `meta.owner_uid` of a user database; null when Turso has no database by that name. */
export async function userDatabaseOwner(dbName: string): Promise<string | null> {
  const r = await call("GET", `/databases/${encodeURIComponent(dbName)}`);
  if (r.status === 404) return null;
  const host = (r.json.database as { Hostname?: string } | undefined)?.Hostname;
  if (r.status !== 200 || !host) throw new Error(`platform: GET ${dbName} answered ${r.status}`);
  const c = createClient({ url: `https://${host}`, authToken: process.env.TURSO_AUTH_TOKEN, intMode: "number", fetch: makeStoreFetch() });
  try {
    const rs = await c.execute("SELECT value FROM meta WHERE key = 'owner_uid'");
    return rs.rows[0]?.value == null ? "" : String(rs.rows[0].value);
  } finally {
    c.close();
  }
}

/** Destroy a user database (§12.3 step 2). Already gone counts as done. */
export async function destroyUserDatabase(dbName: string): Promise<void> {
  if (!/^lb-u-[a-z2-7]{12}$/.test(dbName)) throw new Error("platform: only a friend's lb-u-<uid> database is ever destroyed");
  const r = await call("DELETE", `/databases/${encodeURIComponent(dbName)}`);
  if (r.status !== 200 && r.status !== 404) throw new Error(`platform: DELETE ${dbName} answered ${r.status}`);
}
