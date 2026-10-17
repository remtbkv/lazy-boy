// The pages after Log out and Disconnect (/signed-out, /disconnected) clear this browser of every
// user's data (PLAN.md §6.2 layer 6, §12.3 step 6), IndexedDB included: the search payloads' copy
// there (search-cache.ts, `lb-search@<uid>`) holds every play and every library track. Disconnect's
// form clears nothing before it submits, so /disconnected is the only clear a leaving friend gets.
import { afterEach, describe, expect, it, vi } from "vitest";

// The component's one effect, run as it renders (no DOM here).
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => run() }));

import { ClearUserStorage } from "@/components/clear-user-storage";
import { userStorageName } from "@/lib/user-storage";
import { A, B } from "./harness";

function fakeStorage(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()].sort(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("ClearUserStorage (/signed-out, /disconnected)", () => {
  it("deletes every user's IndexedDB copy and their keys in both storages, nothing else", async () => {
    const live = new Set([userStorageName(A, "lb-search"), userStorageName(B, "lb-search"), "unrelated"]);
    vi.stubGlobal("indexedDB", {
      deleteDatabase: (n: string) => void live.delete(n),
      databases: async () => [...live].map((name) => ({ name, version: 1 })),
    });
    const local = fakeStorage({ [userStorageName(A, "lb-days")]: "x", theme: "dark" });
    const session = fakeStorage({ [userStorageName(B, "lb-days")]: "y" });
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    vi.stubGlobal("window", { localStorage: local, sessionStorage: session });

    ClearUserStorage();
    await new Promise((r) => setTimeout(r, 0));

    expect([...live]).toEqual(["unrelated"]);
    expect(local.keys()).toEqual(["theme"]);
    expect(session.keys()).toEqual([]);
  });
});
