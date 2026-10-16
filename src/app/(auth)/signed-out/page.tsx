import Link from "next/link";
import { ClearUserStorage } from "@/components/clear-user-storage";

// The page after Log out (RULINGS Oct 15 1:33 PM): it says plainly that recording stopped and how
// to resume. No session, no reads.
export default function SignedOutPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <ClearUserStorage />
      <div className="w-full max-w-sm space-y-4 text-center text-sm">
        <h1 className="text-2xl font-semibold tracking-tight">You&apos;re logged out</h1>
        <p>You&apos;re logged out of Lazy Boy on every browser, and it has stopped recording your listening history.</p>
        <p>
          To start again, <Link href="/login" className="underline underline-offset-4">sign in</Link>. Songs you play
          while logged out come back only as far as Spotify&apos;s recently played list reaches: your last 50.
        </p>
        <p className="text-muted-foreground">Your history so far is kept. To delete it, sign in and choose Disconnect.</p>
      </div>
    </main>
  );
}
