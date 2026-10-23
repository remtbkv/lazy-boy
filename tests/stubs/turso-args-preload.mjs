// The scripts a suite spawns open @libsql/client too: this points them at libsql-client.mjs, which
// applies Turso's rule for a statement's args. tests/setup.ts puts it in NODE_OPTIONS for every child
// a test file starts; package.json's node suites import it themselves.
import { registerHooks } from "node:module";

const guarded = new URL("./libsql-client.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@libsql/client") return { url: guarded, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
