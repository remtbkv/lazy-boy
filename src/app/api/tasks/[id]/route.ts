import { NextRequest } from "next/server";
import { requireRouteUser } from "@/lib/require-user";
import { getTaskFor } from "@/lib/tasks/registry";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireRouteUser();
  if (user instanceof Response) return user;

  const { id } = await params;
  // Another user's task answers exactly as a missing one does.
  const task = getTaskFor(id, user.uid);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(task);
}
