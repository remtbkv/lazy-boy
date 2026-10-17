// The browser forgets a user when their session ends (PLAN.md §6.2 layer 6, M7; /privacy: logging
// out clears the browser's caches; RULINGS Oct 15 12:26 PM: a departed friend's data gone within
// five days). What it holds: Storage keys and, since lane 1905, an IndexedDB database per user with
// the whole history and library payloads. clearThisBrowser (user-storage.ts) empties both; its own
// behaviour is user-storage.test.ts's. This file pins where it runs, read from the source with the
// TypeScript compiler API like static.test.ts:
//   - every form whose action ends a session (Log out, Disconnect) clears before it submits, since a
//     server action's response cannot carry Clear-Site-Data, together with search-cache.ts's
//     clearStored, which also stops a payload still in flight from writing the copy back; both
//     forms are on (app) pages, so the clear names the page's user (lane 13's 253ea15: a browser
//     without indexedDB.databases() deletes that user's copy by name);
//   - the pages a browser lands on once its session has ended (/signed-out, /disconnected, and
//     /login, where a browser whose session ended elsewhere arrives at its next visit) clear it all,
//     IndexedDB included.
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
};
function visit(node: ts.Node, f: (n: ts.Node) => void): void {
  f(node);
  node.forEachChild((c) => visit(c, f));
}
/** The argument count of every call to `name` under `node`. */
const argCounts = (node: ts.Node, sf: ts.SourceFile, name: string): number[] => {
  const out: number[] = [];
  visit(node, (n) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === name) out.push(n.arguments.length);
  });
  return out;
};
const callsIn = (node: ts.Node, sf: ts.SourceFile): string[] => {
  const out: string[] = [];
  visit(node, (n) => {
    if (ts.isCallExpression(n)) out.push(n.expression.getText(sf));
  });
  return out;
};

// The server actions that end a session (src/app/(app)/actions.ts).
const ENDS_SESSION = ["logout", "disconnectAction"];

/** Each <form> in the file whose action ends a session, with the calls its onSubmit makes. */
function sessionEndingForms(rel: string): { action: string; onSubmitCalls: string[]; clearArgs: number[] }[] {
  const sf = read(rel);
  // useActionState(async (...) => disconnectAction(...)) hands back the action as its 2nd element.
  const wrapped = new Set<string>();
  visit(sf, (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isArrayBindingPattern(n.name) &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      n.initializer.expression.getText(sf) === "useActionState" &&
      ENDS_SESSION.some((a) => callsIn(n.initializer!, sf).includes(a))
    ) {
      const el = n.name.elements[1];
      if (el && ts.isBindingElement(el)) wrapped.add(el.name.getText(sf));
    }
  });
  const forms: { action: string; onSubmitCalls: string[]; clearArgs: number[] }[] = [];
  visit(sf, (n) => {
    const tag = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
    if (!tag || tag.tagName.getText(sf) !== "form") return;
    const attr = (name: string) =>
      tag.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === name);
    const action = attr("action")?.initializer;
    const actionText = action && ts.isJsxExpression(action) && action.expression ? action.expression.getText(sf) : "";
    if (!ENDS_SESSION.includes(actionText) && !wrapped.has(actionText)) return;
    const onSubmit = attr("onSubmit")?.initializer;
    forms.push({
      action: actionText,
      onSubmitCalls: onSubmit ? callsIn(onSubmit, sf) : [],
      clearArgs: onSubmit ? argCounts(onSubmit, sf, "clearThisBrowser") : [],
    });
  });
  return forms;
}

describe("a browser forgets its user when the session ends", () => {
  it.each(["src/app/(app)/chrome.tsx", "src/app/(app)/disconnect/disconnect-form.tsx"])(
    "%s: every form that ends a session clears this browser, IndexedDB included, before it submits",
    (rel) => {
      const forms = sessionEndingForms(rel);
      expect(forms.length, "the file's session-ending form").toBeGreaterThan(0);
      for (const f of forms) {
        expect(f.onSubmitCalls, `${rel} <form action={${f.action}}>`).toContain("clearThisBrowser");
        expect(f.onSubmitCalls, `${rel} <form action={${f.action}}>`).toContain("clearStored");
        expect(f.clearArgs, `${rel} <form action={${f.action}}>: clearThisBrowser(uid)`).toEqual([1]);
      }
    },
  );

  it("the clear the pages after a session run reaches IndexedDB, not only Storage", () => {
    const sf = read("src/components/clear-user-storage.tsx");
    expect(callsIn(sf, sf)).toContain("clearThisBrowser");
  });

  it.each(["src/app/(auth)/signed-out/page.tsx", "src/app/(auth)/disconnected/page.tsx", "src/app/(auth)/login/page.tsx"])(
    "%s renders the clear",
    (rel) => {
      const sf = read(rel);
      const tags: string[] = [];
      visit(sf, (n) => {
        if (ts.isJsxSelfClosingElement(n)) tags.push(n.tagName.getText(sf));
      });
      expect(tags).toContain("ClearUserStorage");
    },
  );
});
