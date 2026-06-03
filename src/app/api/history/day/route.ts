import { auth } from "@/lib/auth";
import { getPlaysByDay } from "@/lib/db";

// Songs played on one local day (YYYY-MM-DD), read from the local store — instant.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const day = new URL(req.url).searchParams.get("day") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return Response.json({ error: "bad day" }, { status: 400 });
  }
  return Response.json({ results: await getPlaysByDay(day) });
}
