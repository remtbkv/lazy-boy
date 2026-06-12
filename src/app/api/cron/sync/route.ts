import { timingSafeEqual } from "node:crypto";
import { getValidAccessToken } from "@/lib/auth";
import { spotifyClient } from "@/lib/spotify";
import { syncRecentPlays } from "@/lib/sync/history";
import { syncLibrary } from "@/lib/sync/library";
import { getLibrarySyncedAt } from "@/lib/db";

// Rebuild the library index at most hourly (snapshot-diffing makes a run cheap, but no
// need to do it every 5-minute tick). Takes a token getter — a cold full scan can
// outlive the ~1h access token.
async function maybeSyncLibrary(token: () => Promise<string>): Promise<string> {
  const at = await getLibrarySyncedAt();
  if (at && Date.now() - Date.parse(at) < 55 * 60 * 1000) return "fresh";
  await syncLibrary(spotifyClient(token, true));
  return "synced";
}

// Constant-time string compare so the cron secret can't be guessed via response timing.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Backstop sync, triggered by the schedulers (GitHub Actions every 5 min + Vercel daily
// cron, see vercel.json). Runs without a session using the stored token, so history stays
// current even when the app hasn't been opened. Callers send `Authorization: Bearer
// $CRON_SECRET`; anything else is rejected so the endpoint can't be triggered by randoms.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  // Fail closed: a missing secret must reject every caller, not wave them through. (An
  // unset CRON_SECRET in a deploy would otherwise leave this endpoint open to anyone.)
  if (!secret || !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  const token = await getValidAccessToken();
  if (!token) {
    // Nobody signed in / refresh token dead — nothing to do, not an error.
    return Response.json({ ok: true, skipped: "no token" });
  }
  // Getter for the longer-running work below — re-validates through the shared
  // refresh lock if the run crosses the token's expiry.
  const freshToken = async () => {
    const t = await getValidAccessToken();
    if (!t) throw new Error("token expired mid-sync");
    return t;
  };
  try {
    const { added } = await syncRecentPlays(spotifyClient(token));
    // Heavier, lower-frequency upkeep — each self-gates so this stays cheap on most ticks.
    const library = await maybeSyncLibrary(freshToken);
    return Response.json({ ok: true, added, library });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "sync failed" },
      { status: 500 },
    );
  }
}
