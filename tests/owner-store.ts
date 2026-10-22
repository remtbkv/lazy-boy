// The simulated owner's store. tests/setup.ts sets OWNER_UID; his database, `lazyboy`, is the
// throwaway file TURSO_DATABASE_URL points at. ownerStore() names it the way a request's identity
// read names a user's database (multi-user Phase 2), so later forUser() calls in the test reach
// it; seedOwnerRow() writes the admin's `users` row that the session-less paths read
// (identity-read.ts adminStore), with the statement PLAN §11.4 step 1 runs.
import { createClient } from "@libsql/client";
import { appDatabaseUrl, readTokenRow } from "@/lib/app-db";
import { adminRowStatement } from "@/lib/app-schema";
import { forUserAt, type SpotifyTokens, type UserStore } from "@/lib/db";
import { mintUid, type Uid } from "@/lib/identity";
import { appTokenStore } from "@/lib/token-store-app";

export const ownerUid = (): Uid => mintUid(process.env.OWNER_UID as string);

export function ownerStore(): UserStore {
  return forUserAt(ownerUid(), "lazyboy");
}

export async function seedOwnerRow(): Promise<void> {
  await readTokenRow(ownerUid()); // the production open creates the app database's schema
  const c = createClient({ url: appDatabaseUrl(), intMode: "number" });
  try {
    await c.execute(adminRowStatement(ownerUid(), "owner-spotify", Date.now()));
  } finally {
    c.close();
  }
}

/** The app database as PLAN §11.4 leaves it for the owner, from empty: his `users` row and,
 *  given tokens, his encrypted token row (the token of record from Phase 2). Sets a fixed test
 *  TOKEN_KEYS when none is set. */
export async function seedOwnerApp(tokens?: SpotifyTokens): Promise<void> {
  process.env.TOKEN_KEYS ||= `v1:${Buffer.alloc(32, 9).toString("base64")}`;
  await readTokenRow(ownerUid());
  const c = createClient({ url: appDatabaseUrl(), intMode: "number" });
  try {
    for (const t of ["user_tokens", "sync_state", "events", "users"]) await c.execute(`DELETE FROM ${t}`);
  } finally {
    c.close();
  }
  await seedOwnerRow();
  if (tokens) await appTokenStore().set(ownerUid(), tokens);
}
