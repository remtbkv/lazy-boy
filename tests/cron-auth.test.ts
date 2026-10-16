// The one CRON_SECRET check every /api/cron/* route rides (src/lib/cron-auth.ts; docs/SECURITY.md
// "Cron auth (fail-closed)"). An unset secret must reject every caller, including one that
// sends the literal header an unset secret would template to.
import { afterEach, describe, expect, it } from "vitest";
import { cronAuthorized } from "@/lib/cron-auth";

const req = (authorization?: string) =>
  new Request("https://lazy-boy.example/api/cron/daily", {
    headers: authorization === undefined ? {} : { authorization },
  });

describe("cronAuthorized", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("fails closed with CRON_SECRET unset or empty", () => {
    for (const secret of [undefined, ""]) {
      if (secret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = secret;
      for (const h of [undefined, "", "Bearer ", "Bearer undefined", "Bearer"]) {
        expect(cronAuthorized(req(h)), `secret ${JSON.stringify(secret)}, header ${JSON.stringify(h)}`).toBe(false);
      }
    }
  });

  it("accepts exactly `Bearer <secret>`", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(cronAuthorized(req("Bearer s3cret"))).toBe(true);
    for (const h of [undefined, "s3cret", "Bearer s3cre", "Bearer s3cretX", "Bearer S3cret", "bearer s3cret"]) {
      expect(cronAuthorized(req(h)), JSON.stringify(h)).toBe(false);
    }
  });
});
