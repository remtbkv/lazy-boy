// Names of the playlists the clean creates. Shared so the library query can identify them.
// A clean's library must NOT include the target's OWN output (`Cleaned: <target>`), which
// holds exactly the songs it just kept — counting it makes the reconcile pass treat them as
// "saved elsewhere" and cannibalize the playlist to empty. Every OTHER `Cleaned: …` playlist
// DOES count, so the same song can't survive in two cleaned playlists (first clean wins).
// Backups (`Dupes removed from: …`) are discard piles and never count. See `db.getLibraryTracks`.
export const CLEANED_PREFIX = "Cleaned: ";
export const BACKUP_PREFIX = "Dupes removed from: ";

export const cleanedName = (name: string) => `${CLEANED_PREFIX}${name}`;
export const backupName = (name: string) => `${BACKUP_PREFIX}${name}`;
