import Link from "next/link";

// /privacy and /terms: public, no session, no data reads. They sit outside the (app) group so
// its auth redirect never applies (Spotify requires both to be shown before sign-up).
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 select-text space-y-6 p-6 text-sm leading-relaxed text-muted-foreground [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:text-foreground [&_h2]:pt-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
      {children}
      <nav className="flex gap-4 border-t border-border pt-4 text-xs">
        <Link href="/login">Sign in</Link>
        <Link href="/privacy">Privacy Policy</Link>
        <Link href="/terms">Terms of Use</Link>
      </nav>
    </main>
  );
}
