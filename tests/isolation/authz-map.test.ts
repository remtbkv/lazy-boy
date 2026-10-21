// The authz map's own checks: the census (every entry point in src/app is in the registry and
// every registry entry still exists), the anchors (each gate the map cites is still in its
// file), the registry's shape, and docs/multi-user/AUTHZ.md matching what the registry and the
// code render to today. `AUTHZ_WRITE=1 npx vitest run tests/isolation/authz-map.test.ts`
// rewrites the doc.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRINCIPALS } from "./authz-harness";
import { ENTRIES, FINDINGS } from "./authz-registry";
import { ROOT, censusFromCode, gateLine, registryFor, renderAuthz } from "./authz-doc";

const DOC = path.join(ROOT, "docs/multi-user/AUTHZ.md");

describe("authz census", () => {
  it("every entry point in src/app has a registry entry", () => {
    const missing = censusFromCode().filter((c) => registryFor(c).length === 0);
    expect(missing).toEqual([]);
  });

  it("every registry entry is still an entry point in the code", () => {
    const code = censusFromCode();
    const gone = ENTRIES.filter((e) => !code.some((c) => registryFor(c).includes(e)));
    expect(gone.map((e) => e.id)).toEqual([]);
  });

  it("every gate the map cites is still in its file", () => {
    const stale = ENTRIES.filter((e) => e.gate && gateLine(e) === null).map((e) => `${e.id}: ${e.gate}`);
    expect(stale).toEqual([]);
  });

  it("every entry has a cell for every principal, every pinned cell names its phase, every finding exists", () => {
    for (const e of ENTRIES) {
      expect(Object.keys(e.cells).sort(), e.id).toEqual([...PRINCIPALS].sort());
      for (const p of PRINCIPALS) {
        const c = e.cells[p];
        if (c.today) expect(c.phase, `${e.id} / ${p}`).toBeTruthy();
        if (c.finding) expect(FINDINGS[c.finding], `${e.id} / ${p}: ${c.finding}`).toBeTruthy();
        expect(c.rule.length, `${e.id} / ${p}`).toBeGreaterThan(0);
      }
    }
  });

  it("an entry with no invocation is none: every cell runs", () => {
    expect(ENTRIES.filter((e) => !e.invoke).map((e) => e.id)).toEqual([]);
  });
});

describe("docs/multi-user/AUTHZ.md", () => {
  it("matches the registry and the code", () => {
    const rendered = renderAuthz();
    if (process.env.AUTHZ_WRITE) writeFileSync(DOC, rendered);
    expect(readFileSync(DOC, "utf8"), "stale: run AUTHZ_WRITE=1 npx vitest run tests/isolation/authz-map.test.ts").toBe(rendered);
  });
});
