"use client";

import { useEffect, useRef, useState } from "react";

// Square playlist/album image with a themed fallback. Plain <img> (Spotify serves art from
// many CDN hosts, so next/image domain config buys little for these thumbnails). The cover URL
// is stored in the DB and refreshed on library sync; this only governs how the bytes load.
//
// Loading polish: a steady skeleton (subtle pulse) sits under the image, which fades in once
// it decodes — so covers arriving at different times read as a smooth fill, not a broken grid.
// `priority` eager-loads + high-prioritizes the covers in the first view (the rest stay lazy)
// so what you actually see loads immediately instead of being deferred.
export function PlaylistThumb({
  src,
  name,
  priority = false,
  className = "",
}: {
  src: string | null;
  name: string;
  priority?: boolean;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    // An already-cached image is complete on mount and never fires onLoad — show it at once.
    if (ref.current?.complete) setLoaded(true);
  }, [src]);

  if (!src) {
    return (
      <div
        className={`flex aspect-square w-full items-center justify-center rounded-md bg-gradient-to-br from-secondary to-muted text-muted-foreground ${className}`}
      >
        <svg viewBox="0 0 24 24" className="size-1/3" fill="currentColor" fillRule="evenodd" aria-hidden>
          <path d="M6 3h15v15.167a3.5 3.5 0 1 1-3.5-3.5H19V5H8v13.167a3.5 3.5 0 1 1-3.5-3.5H6V3zm0 13.667H4.5a1.5 1.5 0 1 0 1.5 1.5v-1.5zm13 0h-1.5a1.5 1.5 0 1 0 1.5 1.5v-1.5z" />
        </svg>
      </div>
    );
  }

  return (
    <div
      className={`relative aspect-square w-full overflow-hidden rounded-md bg-muted ${loaded ? "" : "animate-pulse"} ${className}`}
    >
      <img
        ref={ref}
        src={src}
        alt={name}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={`size-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
}
