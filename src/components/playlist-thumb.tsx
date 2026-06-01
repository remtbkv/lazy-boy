// Small square playlist/album image with a themed fallback. Uses a plain <img>:
// Spotify serves art from many CDN hosts, so next/image domain config adds burden
// with little benefit for these tiny thumbnails (see eslint.config.mjs).

export function PlaylistThumb({
  src,
  name,
  className = "",
}: {
  src: string | null;
  name: string;
  className?: string;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`aspect-square w-full rounded-md object-cover ${className}`}
      />
    );
  }
  return (
    <div
      className={`flex aspect-square w-full items-center justify-center rounded-md bg-gradient-to-br from-secondary to-muted text-muted-foreground ${className}`}
    >
      <svg viewBox="0 0 24 24" className="size-1/3" fill="currentColor" aria-hidden>
        <path d="M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
      </svg>
    </div>
  );
}
