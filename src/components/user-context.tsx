"use client";

// The signed-in user's uid in the browser (multi-user PLAN §6.2 layer 6). The (app) layout
// renders it from its gate; every storage, channel and lock name that holds the user's data is
// built from it (userStorageName), and every payload is checked against it (bodyIsFor). The
// uid is not a credential: it names the user to their own pages and nothing else.
import { createContext, useContext } from "react";

const UserContext = createContext<string | null>(null);

export function UserProvider({ uid, children }: { uid: string; children: React.ReactNode }) {
  return <UserContext.Provider value={uid}>{children}</UserContext.Provider>;
}

/** The page's user. Throws outside the (app) layout, where no user is signed in. */
export function useUid(): string {
  const uid = useContext(UserContext);
  if (!uid) throw new Error("useUid() outside the (app) layout's UserProvider");
  return uid;
}
