import { getValidAccessToken } from "@/lib/auth";
import { spotifyClient } from "@/lib/spotify";
import { syncRecentPlays } from "@/lib/sync/history";

// Daily backstop sync, triggered by Vercel Cron (see vercel.json). Runs without a
// session using the stored token, so history stays current even when the app hasn't
// been opened. Vercel sends `Authorization: Bearer $CRON_SECRET`; we reject anything
// else so the endpoint can't be triggered by randoms. Hobby crons run ~once/day; bump
// the schedule (and this stays unchanged) if you move to Pro.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  const token = await getValidAccessToken();
  if (!token) {
    // Nobody signed in / refresh token dead — nothing to do, not an error.
    return Response.json({ ok: true, skipped: "no token" });
  }
  try {
    const { added } = await syncRecentPlays(spotifyClient(token));
    return Response.json({ ok: true, added });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "sync failed" },
      { status: 500 },
    );
  }
}
