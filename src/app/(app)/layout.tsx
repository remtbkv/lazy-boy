import type { Viewport } from "next";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { CleanProgressWatcher } from "@/components/clean-progress";
import { SyncOnLoad } from "@/components/sync-on-load";
import { TimezoneCookie } from "@/components/timezone-cookie";
import { NowPlayingProvider } from "@/components/now-playing-context";
import { ScrollbarHover } from "@/components/scrollbar-hover";
import { MetricsCollector } from "@/components/metrics-collector";
import { DenChrome } from "./chrome";
import "./den.css";

// viewport-fit=cover so the fixed bottom pieces (search island, action sheets) can pad
// themselves with env(safe-area-inset-bottom) instead of sitting under the iOS home
// indicator. interactive-widget: the iOS keyboard historically only PANS the page (the
// layout viewport keeps its height and fixed-bottom elements end up behind the keys);
// resizes-content makes supporting Safaris (18.4+) shrink the layout viewport instead, so
// 100dvh, the locked Home frame and the search pill all land above the keyboard natively.
// Older Safaris ignore it and fall back to the search island's visualViewport lift.
export const viewport: Viewport = {
  themeColor: "#0b0b0e",
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

// The chrome lives HERE, not in the pages. A layout persists across navigation between its
// child routes — it is not re-rendered — so the header and its state survive a page change.
//
// It used to be rendered per-page, which meant every navigation unmounted and remounted the
// whole header: the avatar's ring recomputed from scratch (the flash), and the
// NowPlayingProvider remounted and re-ran its poll, so the current song popped back in. None
// of that data can change in the time it takes to switch pages, so none of it should be
// re-fetched or re-derived. Hoisting the provider up here also means one poller for the whole
// app, not one per page view.
//
// Pages bring their own <main> (each route wants different padding and, on Home, a viewport
// lock) — so there's deliberately no shared <main> wrapper here.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // The session cookie is pinned to 127.0.0.1, so on `localhost` auth() sees no session and
  // would detour through /login (a full server render) before the root-layout canonicalizer
  // bounces to 127.0.0.1. Skip that: render nothing here and let the canonicalizer jump
  // straight to 127.0.0.1, where the cookie exists and the real page loads. No-op everywhere
  // else (127.0.0.1, the deployed domain).
  const host = (await headers()).get("host") ?? "";
  if (host.startsWith("localhost")) return null;

  const session = await auth();
  if (!session || session.error) redirect("/login");

  const name = session.user?.name ?? "You";
  const image = session.user?.image ?? null;

  return (
    <div id="den-root" className="flex min-h-dvh flex-col">
      <NowPlayingProvider>
        <DenChrome name={name} image={image} />
        {children}
        <CleanProgressWatcher />
        <SyncOnLoad />
        <TimezoneCookie />
        <ScrollbarHover />
        <MetricsCollector />
      </NowPlayingProvider>
    </div>
  );
}
