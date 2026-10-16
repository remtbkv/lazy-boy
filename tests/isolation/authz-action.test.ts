// The authz map's action cells (docs/multi-user/AUTHZ.md), run through the real Auth.js.
import { vi } from "vitest";
import { runCells } from "./authz-cells";

vi.mock("next/headers", async () => (await import("./authz-context")).nextHeadersMock());
vi.mock("next/server", async (orig) => (await import("./authz-context")).nextServerMock(await orig()));
vi.mock("next/font/google", () => ({ Figtree: () => ({ variable: "" }), Geist_Mono: () => ({ variable: "" }) }));

runCells(["action"]);
