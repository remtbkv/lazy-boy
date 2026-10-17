// The planted-bug self-test keeps every plant (PLAN.md §6.4: "each run asserts the suite still
// reports every one, so the suite cannot quietly lose its teeth"). planted-bugs.test.ts runs each
// isolation check over a deliberately broken implementation, where it must fail, and over the real
// one; deleting a plant's block, or its failing case, left `npm test` green. Lane 13's review pinned
// Phase 1's four plants on mu/rv-p1 (static.test.ts, 73a101b); Phases 2, 3 and 4a and their turns
// added thirteen more, which nothing listed (lane 21's whole-diff review). Here every plant on the
// stitched stack is listed, the file must hold exactly these, and each keeps a case that expects
// its check to fail (`toThrow`) and a case over the real code. A new plant adds its title here.
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PLANTS = [
  // Phase 1 (PLAN §6.4's four)
  "planted: an unstable_cache keyed without the user",
  "planted: the cache stub reverted to a pass-through",
  "planted: one in-flight refresh promise for every user (01e A2)",
  "planted: a URL template that ignores the uid",
  // Phase 2
  "planted: a cipher that drops the associated data",
  "planted: a cipher that reuses its IV",
  "planted: a refresh write that is not conditional (security R4)",
  "planted: a TokenStore that answers another uid's row",
  "planted: an identity read that ignores SIGNUPS (PLAN.md §12.1)",
  "planted: a key check that opens only the first key's sentinel (PLAN.md §5.3)",
  // Phase 3
  "planted: a step handed another user's store",
  "planted: a lease released without the owner check",
  // Phase 4a and its turn
  "planted: a claim without its compare-and-set",
  "planted: a Log out that leaves capture on",
  "planted: a deletion with no admin refusal",
  "planted: a /usage read that takes the viewer's uid for the admin's (Phase 4a's turn)",
  "planted: a now-playing memo keyed by nobody",
  // Lane 1970's review of /join's counter.
  "planted: a /join that counts the places whatever SIGNUPS says",
];

type Plant = { title: string; failing: number; passing: number };

function plantsIn(rel: string): Plant[] {
  const text = readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const out: Plant[] = [];
  const visit = (n: ts.Node, f: (n: ts.Node) => void) => {
    f(n);
    n.forEachChild((c) => visit(c, f));
  };
  visit(sf, (n) => {
    if (!ts.isCallExpression(n) || n.expression.getText(sf) !== "describe") return;
    const title = n.arguments[0];
    if (!title || !ts.isStringLiteral(title) || !title.text.startsWith("planted:")) return;
    const p: Plant = { title: title.text, failing: 0, passing: 0 };
    visit(n.arguments[1], (m) => {
      if (!ts.isCallExpression(m) || m.expression.getText(sf) !== "it") return;
      // A case that expects the check to throw over the plant, or one that runs it over the real code.
      if (/\.toThrow\(/.test(m.arguments[1]?.getText(sf) ?? "")) p.failing++;
      else p.passing++;
    });
    out.push(p);
  });
  return out;
}

describe("the planted-bug self-test keeps every plant (PLAN.md §6.4)", () => {
  const found = plantsIn("tests/isolation/planted-bugs.test.ts");

  it("planted-bugs.test.ts holds exactly the listed plants", () => {
    expect(found.map((p) => p.title).sort()).toEqual([...PLANTS].sort());
  });

  it.each(PLANTS)("%s: a case where its check fails over the plant, and one over the real code", (title) => {
    const p = found.find((x) => x.title === title);
    expect(p, `${title} is gone`).toBeDefined();
    expect(p!.failing, "no case expects the check to fail over the plant").toBeGreaterThanOrEqual(1);
    expect(p!.passing, "no case runs the check over the real code").toBeGreaterThanOrEqual(1);
  });
});
