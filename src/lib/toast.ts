import { toast as sonner } from "sonner";

// Thin wrapper over sonner: each toast's id is its message, so firing the *same* toast
// again replaces the existing one instead of stacking a duplicate, while a *different*
// message gets a different id and stacks normally. Call sites use `toast.success/error`
// exactly as before — just import from here instead of "sonner".
export const toast = {
  success: (message: string) => sonner.success(message, { id: message }),
  error: (message: string) => sonner.error(message, { id: message }),
};
