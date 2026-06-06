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
      <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" fillRule="evenodd" aria-hidden>
        <path d="M6 3h15v15.167a3.5 3.5 0 1 1-3.5-3.5H19V5H8v13.167a3.5 3.5 0 1 1-3.5-3.5H6V3zm0 13.667H4.5a1.5 1.5 0 1 0 1.5 1.5v-1.5zm13 0h-1.5a1.5 1.5 0 1 0 1.5 1.5v-1.5z" />
      </svg>
    </div>
  );
}
