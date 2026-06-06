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
        loading="lazy"
        decoding="async"
        className={`aspect-square w-full rounded-md bg-muted object-cover ${className}`}
      />
    );
  }
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
