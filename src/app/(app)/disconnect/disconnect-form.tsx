"use client";

import { useActionState, useState } from "react";
import { disconnectAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";

// Step 0 of the deletion job (PLAN.md §12.3): the export, built in the browser from the two
// payloads Home already loads (every play, and the library), offered before anything is deleted.
export function ExportButton() {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  async function save() {
    setState("busy");
    try {
      const [history, library] = await Promise.all(
        ["/api/search/history", "/api/search/library"].map(async (u) => {
          const r = await fetch(u, { cache: "no-store" });
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        }),
      );
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), history, library })], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "lazy-boy-export.json";
      a.click();
      URL.revokeObjectURL(a.href);
      setState("idle");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="space-y-1">
      <Button type="button" variant="outline" onClick={save} disabled={state === "busy"}>
        {state === "busy" ? "Preparing…" : "Download my history"}
      </Button>
      {state === "failed" && <p className="text-xs text-destructive">Couldn&apos;t build the download. Try again.</p>}
    </div>
  );
}

export function DisconnectForm() {
  const [state, run, pending] = useActionState(
    async (_prev: { error?: string } | null, data: FormData) => (await disconnectAction(data)) ?? null,
    null,
  );
  return (
    <form action={run} className="space-y-3">
      <label className="block text-sm">
        Type <strong>disconnect</strong> to confirm
        <input name="confirm" autoComplete="off" className="mt-1 w-full rounded-md border px-3 py-2" />
      </label>
      {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" variant="destructive" disabled={pending}>
        Disconnect and delete my data
      </Button>
    </form>
  );
}
