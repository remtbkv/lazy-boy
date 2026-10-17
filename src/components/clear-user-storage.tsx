"use client";

import { useEffect } from "react";
import { clearThisBrowser } from "@/lib/user-storage";

// The pages a browser reaches once its session has ended (after Log out and Disconnect, and /login,
// where a browser whose session ended elsewhere lands at its next visit) clear this browser's stores
// of every user's data, IndexedDB's search payloads included (PLAN.md §6.2 layer 6): a server
// action's response cannot carry Clear-Site-Data, so the browser does it.
export function ClearUserStorage() {
  useEffect(() => {
    clearThisBrowser();
  }, []);
  return null;
}
