import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import "./den.css";

export const metadata: Metadata = {
  title: "Lazy Boy — draft",
  robots: { index: false },
};

// viewport-fit=cover so the mobile bottom nav can pad itself with
// env(safe-area-inset-bottom) instead of sitting under the iOS home indicator.
export const viewport: Viewport = {
  themeColor: "#12100d",
  viewportFit: "cover",
};

export default async function DraftLayout({ children }: { children: React.ReactNode }) {
  // The draft renders without a session in dev (unattended design iteration); in
  // production it's gated exactly like the real app — it shows real listening data.
  if (process.env.NODE_ENV === "production") {
    const session = await auth();
    if (!session) redirect("/login");
  }

  return (
    <div
      id="den-root"
      data-skin="den"
      className="flex min-h-dvh flex-col"
      // The inline script below may rewrite data-skin from localStorage before
      // hydration — same pattern (and same suppression) as next-themes on <html>.
      suppressHydrationWarning
    >
      {/* Apply the saved skin before paint so toggling doesn't flash on reload. */}
      <script
        dangerouslySetInnerHTML={{
          __html:
            "try{var s=localStorage.getItem('lb-skin');if(s==='ink'||s==='den'){document.getElementById('den-root').dataset.skin=s}}catch(e){}",
        }}
      />
      {children}
    </div>
  );
}
