// Names of the playlists the clean creates. Shared so the library query can identify them.
// A clean's library must NOT include the target's OWN output (`Cleaned: <target>`), which
// holds exactly the songs it just kept — counting it makes the reconcile pass treat them as
// "saved elsewhere" and cannibalize the playlist to empty. Every OTHER `Cleaned: …` playlist
// DOES count, so the same song can't survive in two cleaned playlists (first clean wins).
// Backups (`Dupes removed from: …`) are discard piles and never count. See `db.getLibraryTracks`.
export const CLEANED_PREFIX = "Cleaned: ";
export const BACKUP_PREFIX = "Dupes removed from: ";

// Clamped at the SOURCE of every derived name: Spotify stores at most ~100 chars, and a
// derived name longer than the stored one made the clean's name-based self-exclusion miss
// its own output for any playlist name > 91 chars (wave-3 adversarial review, P1). The
// clamp must match resources.createPlaylist's send-side clamp exactly.
export const PLAYLIST_NAME_MAX = 100;
export const cleanedName = (name: string) => `${CLEANED_PREFIX}${name}`.slice(0, PLAYLIST_NAME_MAX);
export const backupName = (name: string) => `${BACKUP_PREFIX}${name}`.slice(0, PLAYLIST_NAME_MAX);
