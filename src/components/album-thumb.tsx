// Small square album-art thumbnail with a themed music-note fallback. Shared by
// the track list and the listening-history table.
export function AlbumThumb({
  src,
  className = "size-10",
}: {
  src?: string | null;
  className?: string;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        className={`${className} shrink-0 rounded bg-muted object-cover`}
      />
    );
  }
  return (
    <div
      className={`${className} flex shrink-0 items-center justify-center rounded bg-muted text-muted-foreground`}
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
        <path d="M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
      </svg>
    </div>
  );
}
