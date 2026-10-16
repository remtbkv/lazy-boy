import { auth } from "@/lib/auth";
import { FRESH_SIGN_IN_S } from "@/lib/account";
import { requirePageUser } from "@/lib/require-user";
import { reauthForDisconnect } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { DisconnectForm, ExportButton } from "./disconnect-form";

export const dynamic = "force-dynamic";

// Disconnect (RULINGS Oct 15 1:17 PM; PLAN.md §5.4, §12.3): the export first, then the typed word
// and a sign-in within the last ten minutes. Rem's own account is never deleted (decision 21 as
// ruled), so his page offers Log out only.
async function signedInRecently(): Promise<boolean> {
  const authTime = (await auth())?.authTime;
  return typeof authTime === "number" && Date.now() / 1000 - authTime <= FRESH_SIGN_IN_S;
}

export default async function DisconnectPage() {
  const gate = await requirePageUser();
  const fresh = await signedInRecently();
  return (
    <main className="mx-auto w-full max-w-lg space-y-6 p-6 text-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Disconnect</h1>
      {gate.admin ? (
        <p>
          This is Rem&apos;s account, and nothing in Lazy Boy ever deletes its data. Log out stops the recording and
          signs out every browser.
        </p>
      ) : (
        <>
          <p>
            Disconnect closes your Lazy Boy account and deletes everything it holds about you, within five days. Lazy Boy
            keeps no backups of your data, so this cannot be undone. Download your history first if you want a copy.
          </p>
          <ExportButton />
          {fresh ? (
            <DisconnectForm />
          ) : (
            <form action={reauthForDisconnect} className="space-y-2">
              <p>To confirm it&apos;s you, sign in with Spotify again first.</p>
              <Button type="submit">Sign in again</Button>
            </form>
          )}
          <p className="text-muted-foreground">
            Afterwards, remove Lazy Boy at spotify.com/account/apps: the app cannot do that for you.
          </p>
        </>
      )}
    </main>
  );
}
