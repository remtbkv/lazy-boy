import { cookies } from "next/headers";
import { requestState, type RequestState } from "@/lib/app-db";
import { REQUEST_COOKIE, verifyRequestCookie } from "@/lib/request-cookie";
import { JoinView } from "./join-view";

export const dynamic = "force-dynamic";

// /join: a friend's first visit (RULINGS Oct 15 12:46 PM; PLAN.md §12.1, §12.6). No session.
// With a request cookie it shows where that request stands, and only that; without one, what a
// friend gets and the request form.
async function cookieRequestState(): Promise<RequestState> {
  const rid = verifyRequestCookie((await cookies()).get(REQUEST_COOKIE)?.value, Date.now());
  return rid ? requestState(rid).catch(() => null) : null;
}

export default async function JoinPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  const state = await cookieRequestState();
  return <JoinView state={state} error={Array.isArray(error) ? error[0] : error} />;
}
