import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { NowPlayingProvider } from "@/components/now-playing-context";
import { DenBottomNav, DenChrome } from "./chrome";
import "@/app/(app)/den.css";

export const metadata: Metadata = {
  title: "Lazy Boy — draft",
  robots: { index: false },
};

export const viewport: Viewport = {
  themeColor: "#0b0b0e",
  viewportFit: "cover",
};

// The design draft, kept alive alongside the shipped app so the two can be compared
// side by side. It renders the SAME components as /home — the skin, the day strip, the
// song table, the search island are literally the same files, imported, not copied, so
// this can't drift from what ships.
//
// The one thing it keeps of its own is the original action dock, whose sheets were never
// wired to Spotify (every button toasts "Draft preview"). That's the open design question:
// /home swapped those sheets for the real panels so Clean/Merge/Subtract actually run.
export default async function DraftLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (process.env.NODE_ENV === "production" && !session) redirect("/login");

  const name = session?.user?.name ?? "You";
  const image = session?.user?.image ?? null;

  return (
    <div id="den-root" className="flex min-h-dvh flex-col">
      <NowPlayingProvider>
        <DenChrome name={name} image={image} />
        {children}
        <DenBottomNav name={name} image={image} />
      </NowPlayingProvider>
    </div>
  );
}
