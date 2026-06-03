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
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
