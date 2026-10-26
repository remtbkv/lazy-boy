"use client";

import { useState } from "react";

// The text this mount was first given, kept through later renders. Home draws its greeting at
// random per server render, and a dock action that revalidates (Merge, Clean, Save queue, a
// subtract's save) makes Next refresh Home in place right as the sheet leaves: the greeting
// swapped under it (lane 0598's recordings, 2026-10-26). A real visit (navigation, reload)
// mounts afresh and draws a new one.
export function StableText({ text }: { text: string }) {
  const [first] = useState(text);
  return first;
}
