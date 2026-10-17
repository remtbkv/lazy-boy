"use client";

import { useEffect } from "react";
import { clearThisBrowser } from "@/lib/user-storage";

// The pages after Log out and Disconnect clear this browser's stores of every user's data
// (PLAN.md §6.2 layer 6): a server action's response cannot carry Clear-Site-Data, so the browser
// does it, IndexedDB's search copy included (clearThisBrowser). The chrome's Log out form clears
// before it submits too; Disconnect's form does not, so /disconnected is a leaving friend's clear.
export function ClearUserStorage() {
  useEffect(() => {
    clearThisBrowser();
  }, []);
  return null;
}
