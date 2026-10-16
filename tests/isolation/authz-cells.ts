// Runs the map's cells (authz-registry.ts) as tests: one per entry point and principal. A cell
// with `today` pins what today's code does and names the phase that changes it; the day that
// phase lands the cell goes red, and the lane deletes `today` and `phase` from it.
import { describe, expect, it } from "vitest";
import { describeObservation, installSpotify, observe, PRINCIPAL_LABEL, PRINCIPALS, type Observed } from "./authz-harness";
import { ENTRIES, type Cell, type Entry, type Kind } from "./authz-registry";

/** AUTHZ_TARGET=1 runs every cell against its target instead of today's pin: the red cells are
 *  exactly what the phases still owe. */
export const TARGET_MODE = !!process.env.AUTHZ_TARGET;

export function expectedObservations(e: Entry, cell: Cell): Observed[] {
  if (cell.today && !TARGET_MODE) return [cell.today];
  if (cell.target === "deny") return ["deny"];
  if (cell.target === "isolated") return ["deny", "allow-own"];
  const reaches = e.reaches ?? (e.gate !== null && e.cells.anon.target === "deny");
  return reaches ? ["allow"] : ["allow", "allow-own"];
}

export function runCells(kinds: Kind[]): void {
  installSpotify();
  for (const e of ENTRIES.filter((x) => kinds.includes(x.kind) && x.invoke)) {
    describe(e.id, () => {
      for (const p of PRINCIPALS) {
        const cell = e.cells[p];
        const pin = cell.today ? ` [today ${cell.today}; ${cell.phase} makes it ${cell.target}]` : "";
        it(`${PRINCIPAL_LABEL[p]} → ${cell.target}${pin}`, async () => {
          const obs = await observe(p, () => e.invoke!(p), { refused: e.refused, before: e.before, watch: e.watch });
          const want = expectedObservations(e, cell);
          if (process.env.AUTHZ_DEBUG) console.log(`${e.id} | ${p} | ${describeObservation(obs)}`);
          const note = cell.today && !TARGET_MODE
            ? `pinned: today's code does "${cell.today}"; if this changed, ${cell.phase} landed — drop today/phase from the cell`
            : `target ${cell.target}`;
          expect(want, `${e.id} as ${p}: ${describeObservation(obs)} — ${note}`).toContain(obs.observed);
        });
      }
    });
  }
}

/** A red-team check whose target a phase has not reached: today's predicate holds now, the
 *  target's holds once `phase` lands (and under AUTHZ_TARGET=1 the target is what is asserted). */
export function expectPinned<T>(
  phase: string,
  actual: T,
  today: (v: T) => boolean,
  target: (v: T) => boolean,
  what: string,
): void {
  if (TARGET_MODE) expect(target(actual), `${what} — target, owed by ${phase}: got ${JSON.stringify(actual)}`).toBe(true);
  else
    expect(today(actual), `${what} — pinned to today's behaviour; if this fails, ${phase} landed: rewrite it to the target (got ${JSON.stringify(actual)})`).toBe(true);
}
