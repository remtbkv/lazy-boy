// The cron secret checks (src/lib/cron-auth.ts; docs/SECURITY.md "Cron auth (fail-closed)"):
// cronAuthorized for every /api/cron/* route but sync, cronCaller for sync. An unset secret must
// reject every caller, including one that sends the literal header an unset secret would
// template to.
import { afterEach, describe, expect, it } from "vitest";
import { cronAuthorized, cronCaller } from "@/lib/cron-auth";

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

  it("refuses CRON_SECRET_EXT: cron-job.org's secret opens no route that uses this check (PLAN §5.5)", () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.CRON_SECRET_EXT = "ext-s3cret";
    try {
      expect(cronAuthorized(req("Bearer ext-s3cret"))).toBe(false);
    } finally {
      delete process.env.CRON_SECRET_EXT;
    }
  });
});

// /api/cron/sync's check (PLAN §7.2 step 0): the secret names the caller.
describe("cronCaller", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.CRON_SECRET_EXT;
  });

  it("names the Zenbook for CRON_SECRET and cron-job.org for CRON_SECRET_EXT", () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.CRON_SECRET_EXT = "ext-s3cret";
    expect(cronCaller("Bearer s3cret")).toBe("zenbook");
    expect(cronCaller("Bearer ext-s3cret")).toBe("ext");
    for (const h of [null, "", "ext-s3cret", "Bearer ext-s3cre", "Bearer ext-s3cretX", "bearer ext-s3cret", "Bearer s3cretext-s3cret"]) {
      expect(cronCaller(h), JSON.stringify(h)).toBe(null);
    }
  });

  it("an unset or empty secret matches nobody, whichever of the two it is", () => {
    for (const unset of ["CRON_SECRET", "CRON_SECRET_EXT"] as const) {
      for (const v of [undefined, ""]) {
        process.env.CRON_SECRET = "s3cret";
        process.env.CRON_SECRET_EXT = "ext-s3cret";
        if (v === undefined) delete process.env[unset];
        else process.env[unset] = v;
        for (const h of [null, "", "Bearer ", "Bearer undefined", "Bearer"]) {
          expect(cronCaller(h), `${unset}=${JSON.stringify(v)}, header ${JSON.stringify(h)}`).toBe(null);
        }
      }
    }
    process.env.CRON_SECRET = "s3cret";
    delete process.env.CRON_SECRET_EXT;
    expect(cronCaller("Bearer s3cret")).toBe("zenbook");
    delete process.env.CRON_SECRET;
    process.env.CRON_SECRET_EXT = "ext-s3cret";
    expect(cronCaller("Bearer ext-s3cret")).toBe("ext");
  });
});
