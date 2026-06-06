// Names of the playlists the clean creates. Shared so the library index can exclude
// them: they're tooling artifacts, not real library membership, and counting their
// tracks as "saved elsewhere" makes a re-clean (or the reconcile pass) cannibalize the
// very songs it just kept — wiping the playlist.
export const CLEANED_PREFIX = "Cleaned: ";
export const BACKUP_PREFIX = "Dupes removed from: ";

export const cleanedName = (name: string) => `${CLEANED_PREFIX}${name}`;
export const backupName = (name: string) => `${BACKUP_PREFIX}${name}`;
