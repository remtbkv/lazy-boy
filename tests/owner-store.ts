// The simulated owner's store. tests/setup.ts sets OWNER_UID, so forUser() maps it to Rem's
// database, `lazyboy` — the throwaway file TURSO_DATABASE_URL points at — exactly as Phase 1
// maps production's owner.
import { forUser, type UserStore } from "@/lib/db";
import { mintUid, type Uid } from "@/lib/identity";

export const ownerUid = (): Uid => mintUid(process.env.OWNER_UID as string);

export function ownerStore(): UserStore {
  return forUser(ownerUid());
}
