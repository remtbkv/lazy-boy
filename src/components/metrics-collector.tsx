"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { setPage, startMetrics } from "@/lib/metrics-client";

// Mounts the client performance collector (src/lib/metrics-client.ts) once for the whole
// app — like the other layout-level listeners here, it lives in the (app) layout so it
// survives navigation instead of restarting per page. All it does is tell the collector
// which route is on screen; the measuring happens in the lib. Renders nothing.
export function MetricsCollector() {
  const pathname = usePathname();
  useEffect(() => {
    setPage(pathname);
    startMetrics();
  }, [pathname]);
  return null;
}
