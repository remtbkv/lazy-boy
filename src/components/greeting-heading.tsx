"use client";

import { useState } from "react";

// Holds the greeting chosen on the server at mount. Keeping it in state means a
// background re-render (router.refresh after a sync) won't re-roll it — it only
// changes when the user actually revisits /me (a fresh mount).
export function GreetingHeading({ initial }: { initial: string }) {
  const [text] = useState(initial);
  return <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{text}</h1>;
}
