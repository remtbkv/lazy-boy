// requireUser(): the one source of a uid for an entry point (docs/multi-user/PLAN.md §5.1,
// §6.2 layer 2). It wraps auth() and answers in the shape each kind of entry point needs:
//   - allowed: the branded uid, whether the user is the admin, whether Spotify can be called;
//   - refused (no session, or a session without a uid): a page redirects to /login, a route
//     answers 401 with the signed-out marker (the browser clears its stores on it, §6.2 layer
//     6), an action answers { ok: false };
//   - unavailable (the identity check could not run): never a redirect and never a 401, so
//     the browser keeps its stores; a route answers 503, a page throws a retryable error, an
//     action answers { ok: false, retry: true }.
import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { gateFromSession, type Gate, type GateResult } from "@/lib/session-gate";
import { SIGNED_OUT_HEADER } from "@/lib/user-storage";

export type { Gate };

export async function requireUser(): Promise<GateResult> {
  return gateFromSession(await auth());
}

export class RetryableAuthError extends Error {
  constructor() {
    super("Couldn't confirm your session just now. Try again in a moment.");
    this.name = "RetryableAuthError";
  }
}

export async function requirePageUser(): Promise<Gate> {
  const r = await requireUser();
  if (r.kind === "allowed") return r.gate;
  if (r.kind === "unavailable") throw new RetryableAuthError();
  redirect("/login");
}

export async function requireRouteUser(): Promise<Gate | Response> {
  const r = await requireUser();
  if (r.kind === "allowed") return r.gate;
  if (r.kind === "unavailable") {
    return Response.json({ error: "unavailable", retry: true }, { status: 503, headers: { "retry-after": "5" } });
  }
  return Response.json({ error: "unauthorized" }, { status: 401, headers: { [SIGNED_OUT_HEADER]: "1" } });
}

export type ActionRefusal = { ok: false; error: string; retry?: true };

export async function requireActionUser(): Promise<Gate | ActionRefusal> {
  const r = await requireUser();
  if (r.kind === "allowed") return r.gate;
  if (r.kind === "unavailable") return { ok: false, error: new RetryableAuthError().message, retry: true };
  return { ok: false, error: "Not authenticated" };
}
