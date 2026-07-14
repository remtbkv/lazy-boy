"use client";

import { useEffect } from "react";

// Home is a single-viewport page: the page itself never scrolls, the song list scrolls
// inside it. That lock has to sit on #den-root (the flex shell), which lives in the shared
// (app) layout — but Playlists is a long grid that MUST scroll. So rather than locking the
// layout for every route, Home mounts this and the lock applies only while it's on
// screen. Desktop only; the media query lives in den.css so mobile keeps normal flow.
export function LockViewport() {
  useEffect(() => {
    const root = document.getElementById("den-root");
    if (!root) return;
    root.classList.add("den-locked");
    return () => root.classList.remove("den-locked");
  }, []);
  return null;
}
