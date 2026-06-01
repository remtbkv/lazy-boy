"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/app/(app)/actions";

type Props<T> = {
  action: () => Promise<ActionResult<T>>;
  children: React.ReactNode;
  pendingText?: string;
  success: (res: Extract<ActionResult<T>, { ok: true }>) => string;
} & React.ComponentProps<typeof Button>;

/** Button that runs a server action, shows a pending label, and toasts the result. */
export function ActionButton<T>({
  action,
  children,
  pendingText,
  success,
  ...buttonProps
}: Props<T>) {
  const [pending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const res = await action();
      if (res.ok) toast.success(success(res));
      else toast.error(res.error);
    });
  }

  return (
    <Button {...buttonProps} disabled={pending || buttonProps.disabled} onClick={run}>
      {pending ? (pendingText ?? "Working…") : children}
    </Button>
  );
}
