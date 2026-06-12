import type { Metadata } from "next";
import { Figtree, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

// Figtree — a geometric sans close to Spotify's "Circular", so the app feels
// familiar to Spotify users.
const fontSans = Figtree({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Lazy Boy",
  description: "The app that does stuff for you in Spotify.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${fontSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* Chrome is non-selectable by default; content (song/playlist names) opts
          back in with `select-text` so it can still be copied. */}
      <body className="flex min-h-full select-none flex-col">
        {/* Canonicalize the host to the loopback IP before anything renders. Spotify's
            OAuth round-trip is pinned to 127.0.0.1, and browser cookies are per-host
            (localhost ≠ 127.0.0.1), so starting on localhost breaks sign-in. A server
            redirect can't fix it (Next's dev server treats the two as one origin and just
            loops), but the browser distinguishes them — so we bounce localhost → 127.0.0.1
            here, client-side. No-ops on 127.0.0.1 and on the deployed domain. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if(location.hostname==='localhost'){location.replace('http://127.0.0.1'+(location.port?':'+location.port:'')+location.pathname+location.search+location.hash)}",
          }}
        />
        {children}
        {/* Subtle, Spotify-style toasts: neutral, centered, low on the screen — sitting
            just above the bottom search pill (FloatingBar spans ~24–62px from the bottom)
            with a small gap, so it lands in the same spot on every page. */}
        <Toaster position="bottom-center" offset="6rem" />
      </body>
    </html>
  );
}
