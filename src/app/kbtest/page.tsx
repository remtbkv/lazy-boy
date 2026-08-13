import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { KbTest } from "./kbtest-client";
import "../(app)/den.css";

// DEV-ONLY iOS-keyboard test fixture — 404s in production. The real phone bugs of
// 2026-08-13 (focus zoom, keyboard pan, pill placement) only reproduce in a real iOS
// browser, and the authed pages can't be opened in an iOS Simulator (Spotify OAuth), so
// this page renders the same SearchIsland over dummy rows with the same viewport meta.
// Driven by idb against the Simulator; see the session notes / commit message.
export const viewport: Viewport = {
  themeColor: "#0b0b0e",
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function KbTestPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <KbTest />;
}
