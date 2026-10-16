import { ClearUserStorage } from "@/components/clear-user-storage";

// The page after Disconnect (PLAN.md §12.3 step 6): the app cannot revoke a Spotify grant, so the
// person is told where to. No session, no reads.
export default function DisconnectedPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <ClearUserStorage />
      <div className="w-full max-w-sm space-y-4 text-center text-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Disconnected</h1>
        <p>
          Your Lazy Boy account is closed and everything it held about you is being deleted; it is gone within five
          days. Lazy Boy no longer reads anything from your Spotify account.
        </p>
        <p>
          One step only you can take: remove Lazy Boy at{" "}
          <a href="https://www.spotify.com/account/apps/" className="underline underline-offset-4">
            spotify.com/account/apps
          </a>{" "}
          (Manage apps, then Remove access).
        </p>
      </div>
    </main>
  );
}
