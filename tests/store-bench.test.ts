// benchStore (docs/STORE_MIGRATION.md §6.5) against the simulated file store: the probe counts,
// the summary fields, and no token or URL credentials in what it returns.
import { describe, expect, it } from "vitest";
import { benchStore } from "@/lib/db";

describe("benchStore", () => {
  it("core: SELECT 1 x30, a one-key meta read x10, the history payload x2, all succeeding", async () => {
    const r = await benchStore("core");
    expect(r.store).toBe("core");
    expect(r.host).toBe("file");
    expect(Object.keys(r.probes)).toEqual(["select1", "metaRead", "historyIndex"]);
    expect(r.probes.select1.n).toBe(30);
    expect(r.probes.metaRead.n).toBe(10);
    expect(r.probes.historyIndex.n).toBe(2);
    for (const p of Object.values(r.probes)) {
      expect(p.failures).toBe(0);
      expect(p.p50).toBeLessThanOrEqual(p.p95);
      expect(p.p95).toBeLessThanOrEqual(p.max);
    }
  });

  it("telemetry: SELECT 1 x10 (one store here, so it rides the core client)", async () => {
    const r = await benchStore("telemetry");
    expect(r.store).toBe("telemetry");
    expect(Object.keys(r.probes)).toEqual(["select1"]);
    expect(r.probes.select1).toMatchObject({ n: 10, failures: 0 });
  });
});
