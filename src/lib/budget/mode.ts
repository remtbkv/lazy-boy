// The app-wide budget mode as a hot path reads it: the stored key through db.ts's 10-minute
// memo, and normal when nothing is stored or the store cannot say (the path's own reads fail
// on the same outage; the mode must not add a second failure).
import "server-only";
import { getBudgetMode } from "@/lib/db";
import type { Mode } from "@/lib/budget/modes";

export async function currentMode(): Promise<Mode> {
  try {
    return (await getBudgetMode()) ?? "normal";
  } catch {
    return "normal";
  }
}
