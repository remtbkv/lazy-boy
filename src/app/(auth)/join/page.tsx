import { cookies } from "next/headers";
import { requestState, seatsHeld, type RequestState } from "@/lib/app-db";
import { signupsMode } from "@/lib/identity";
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
  // SIGNUPS=owner: the door is shut, so the form is not offered at all (the POST refuses too).
  const closed = signupsMode() !== "invite";
  // The counter beside the form; a store error just leaves it out.
  const held = !closed && state === null ? await seatsHeld().catch(() => null) : null;
  return <JoinView state={state} closed={closed} held={held} error={Array.isArray(error) ? error[0] : error} />;
}
