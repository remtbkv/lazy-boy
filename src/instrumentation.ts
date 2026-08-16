// Server-side error recorder. Production RSC errors reach the browser as a digest and a
// generic line; the REAL message lives only in Vercel's runtime logs, which age out within
// the hour — twice now a digest outlived the log that could decode it (2026-08-16). So
// every server render/route error writes itself into the store (client_metrics, event
// "server-error": digest + the actual message), where /usage and any later analysis can
// read it. Best-effort by design: when the store itself is the thing that failed, this
// write fails too, and the error still surfaces normally.
import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async (err, request) => {
  try {
    const { recordClientMetrics } = await import("@/lib/db");
    const e = err as { digest?: string; message?: string };
    await recordClientMetrics([
      {
        session: "server",
        page: request.path ?? "",
        event: "server-error",
        value: null,
        meta: `${e.digest ?? "no-digest"} ${e.message ?? String(err)}`.slice(0, 200),
      },
    ]);
  } catch {
    /* the store may be the very thing that failed — never add a second error */
  }
};
