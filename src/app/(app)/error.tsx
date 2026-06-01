"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function AppError({ error }: { error: Error & { digest?: string } }) {
  const isAuthError = /not authenticated/i.test(error.message);
  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      <p className="text-sm text-muted-foreground">
        {isAuthError
          ? "Your Spotify session expired. Please sign in again."
          : error.message}
      </p>
      <Link href="/login" className={buttonVariants()}>
        Back to sign in
      </Link>
    </div>
  );
}
