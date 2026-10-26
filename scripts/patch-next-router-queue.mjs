#!/usr/bin/env node
// Next 16.2's router queue lets a navigation the person already left become the router's state
// (lane 0597, Oct 26, 2026; docs/GOTCHAS.md "Tab switching"). When an action the queue discarded
// (a navigation or a server action superseded by a newer navigation) settles, runRemainingActions
// advances `pending` past the navigation that replaced it. The next dispatch then finds the queue
// idle and does not discard that navigation, so it settles after the newer one and becomes the
// router's state, off screen, until the next server action renders it: Rem's ghost, Home and then
// Playlists under his search. Next 16.3.0 fixed it upstream (runRemainingActions advances only when
// the settled action is still the head); this applies that change to the installed 16.2.x on every
// install (`postinstall`), to both copies a build can bundle (dist/ and dist/esm/).
//
// A Next whose queue it does not recognise fails the install, so an upgrade decides on purpose: from
// 16.3.0 on, the queue carries the fix and this script only checks it; delete it then.
// Known answers: tests/next-router-queue.test.ts.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXED = "actionQueue.pending === settledAction";

/** The queue module's text with the upstream fix applied; unchanged when it already has it. */
export function patchQueue(src) {
  if (src.includes(FIXED)) return src;
  const fn = src.match(/function runRemainingActions\(actionQueue, setState\) \{[\s\S]*?\n\}\n(?=async function runAction)/);
  if (!fn) throw new Error("runRemainingActions(actionQueue, setState) not found");
  const refresh = fn[0].match(/type: ([\w.]*ACTION_REFRESH)/)?.[1];
  if (!refresh) throw new Error("the ACTION_REFRESH dispatch in runRemainingActions not found");
  let out = src.replace(
    fn[0],
    `function runRemainingActions(actionQueue, settledAction, setState) {
    // Patched by lazyboy's scripts/patch-next-router-queue.mjs (the Next 16.3.0 fix): advance
    // the queue only if the settled action is still its head. A discarded action's navigation
    // replaced it and is still in flight.
    if (${FIXED}) {
        actionQueue.pending = settledAction.next;
        if (actionQueue.pending !== null) {
            runAction({
                actionQueue,
                action: actionQueue.pending,
                setState
            });
            return;
        }
    }
    if (actionQueue.pending === null && actionQueue.needsRefresh) {
        actionQueue.needsRefresh = false;
        actionQueue.dispatch({
            type: ${refresh}
        }, setState);
    }
}
`,
  );
  const calls = out.split("runRemainingActions(actionQueue, setState);").length - 1;
  if (calls !== 3) throw new Error(`expected 3 runRemainingActions calls in runAction, found ${calls}`);
  out = out.replaceAll("runRemainingActions(actionQueue, setState);", "runRemainingActions(actionQueue, action, setState);");
  const anchor = "newAction.next = actionQueue.pending.next;\n";
  if (out.split(anchor).length !== 2) throw new Error("the navigation branch of dispatchAction not found");
  const indent = out.slice(0, out.indexOf(anchor)).match(/[ \t]*$/)[0];
  out = out.replace(anchor, `${anchor}${indent}if (actionQueue.last === actionQueue.pending) {\n${indent}    actionQueue.last = newAction;\n${indent}}\n`);
  return out;
}

const FILES = ["dist/client/components/app-router-instance.js", "dist/esm/client/components/app-router-instance.js"];

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const next = path.join(root, "node_modules/next");
  const { version } = JSON.parse(readFileSync(path.join(next, "package.json"), "utf8"));
  for (const rel of FILES) {
    const file = path.join(next, rel);
    const src = readFileSync(file, "utf8");
    if (src.includes(FIXED)) {
      console.log(`patch-next-router-queue: next@${version} ${rel} already holds the fix`);
      continue;
    }
    if (!version.startsWith("16.2.")) {
      throw new Error(`patch-next-router-queue: next@${version} is not 16.2.x and its queue lacks the 16.3.0 fix; read the script's header`);
    }
    writeFileSync(file, patchQueue(src));
    console.log(`patch-next-router-queue: patched next@${version} ${rel}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
