import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { getTask } from "@/lib/tasks/registry";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const task = getTask(id);
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(task);
}
