"use client";

import { useEffect } from "react";
import { clearUserStorage } from "@/lib/user-storage";

// The pages after Log out and Disconnect clear this browser's stores of every user's data
// (PLAN.md §6.2 layer 6): a server action's response cannot carry Clear-Site-Data, so the browser
// does it. The chrome's own forms clearing before they submit is Phase 4a's turn (chrome.tsx).
export function ClearUserStorage() {
  useEffect(() => {
    try {
      clearUserStorage([window.localStorage, window.sessionStorage]);
    } catch {
      /* storage disabled: nothing to clear */
    }
  }, []);
  return null;
}
