# Archived: "Sync liked" (Liked Songs → playlist mirror)

> Removed on request. This file is intentionally **not linked from `CLAUDE.md`, `AGENTS.md`, or any
> auto-loaded doc**, so it costs no context unless you open it. It's a complete restore kit: paste
> each block back where noted and it works again.

## What it did

A "Sync liked" quick-action pill on `/playlists` mirrored the user's Liked Songs into a normal
playlist called **"Liked songs as playlist"** (created on first use, then exact-replaced on each run
so it always equals the current Liked set, deduped by artist+title). Handy for sharing liked songs or
viewing them as a list. A backstop in the cron then re-mirrored it ~hourly.

**Not removed / unrelated:** the `saved_tracks` table + `storeSavedTracks` / `getLikedSignals` /
`getSavedSyncedAt` and the Liked-Songs fetch inside `syncLibrary`. Those index Liked Songs locally so
**Clean** knows what you've "saved elsewhere" — they are NOT the mirror feature and must stay.

## Restore kit

### 1. `src/lib/spotify/service.ts` — add the method back (uses existing `dedupeByKey` import)

```ts
  /** Mirror liked songs into a maintained playlist (exact replace). */
  async syncLikedToPlaylist(): Promise<{ id: string; count: number; name: string }> {
    const name = "Liked songs as playlist";
    const existing = (await this.resources.myPlaylists(true)).find((p) => p.name === name);
    const id = existing?.id ?? (await this.resources.createPlaylist(name));
    const liked = dedupeByKey(await this.resources.savedTracks());
    await this.resources.replaceItems(id, liked.map((t) => t.uri));
    return { id, count: liked.length, name };
  }
```

### 2. `src/lib/db.ts` — add the mirror/clean bookkeeping helpers back

```ts
/** The "Liked songs as playlist" mirror, registered when the user first creates it,
 *  so the backstop cron can keep it in sync. */
export async function getLikedMirrorId(): Promise<string | null> {
  return getMeta("liked_mirror_playlist_id");
}
export async function setLikedMirrorId(id: string): Promise<void> {
  await setMeta("liked_mirror_playlist_id", id);
}
export async function getLikedMirrorSyncedAt(): Promise<string | null> {
  return getMeta("liked_mirror_synced_at");
}
export async function setLikedMirrorSyncedAt(): Promise<void> {
  await setMeta("liked_mirror_synced_at", new Date().toISOString());
}

/** When a clean last ran — the liked-mirror auto-sync stays out of its way (won't run
 *  if a clean ran in the last few minutes). */
export async function getLastCleanAt(): Promise<string | null> {
  return getMeta("last_clean_at");
}
export async function setLastCleanAt(): Promise<void> {
  await setMeta("last_clean_at", new Date().toISOString());
}
```

Also re-add `await setLastCleanAt();` as the first line of `cleanPhase1` in
`src/lib/clean/run.ts` (and import `setLastCleanAt`), so the mirror's 5-minute "stay out of a clean's
way" guard works.

### 3. `src/app/(app)/actions.ts` — add the server action back

Import `setLikedMirrorId, setLikedMirrorSyncedAt` from `@/lib/db`, then:

```ts
export async function syncLikedAction(): Promise<
  ActionResult<{ name: string; count: number }>
> {
  try {
    const sp = await getSpotify();
    const r = await sp.syncLikedToPlaylist();
    // Register the mirror so the hourly backstop keeps it in sync from now on.
    await setLikedMirrorId(r.id);
    await setLikedMirrorSyncedAt();
    revalidatePath("/playlists");
    return { ok: true, name: r.name, count: r.count };
  } catch (e) {
    return fail(e);
  }
}
```

### 4. `src/app/api/cron/sync/route.ts` — add the hourly backstop back

Re-add to the `@/lib/db` import: `getLastCleanAt, getLikedMirrorId, getLikedMirrorSyncedAt,
setLikedMirrorSyncedAt`, keep `const HOUR_MS = 60 * 60 * 1000;`, then:

```ts
// Re-mirror Liked Songs into the registered "Liked songs as playlist" at most hourly,
// and stay out of a clean's way: skip if one ran in the last 5 minutes.
async function maybeSyncLikedMirror(token: string): Promise<string> {
  const mirrorId = await getLikedMirrorId();
  if (!mirrorId) return "no mirror";
  const mAt = await getLikedMirrorSyncedAt();
  if (mAt && Date.now() - Date.parse(mAt) < HOUR_MS) return "recent";
  const cleanAt = await getLastCleanAt();
  if (cleanAt && Date.now() - Date.parse(cleanAt) < 5 * 60 * 1000) return "clean running";
  await spotifyClient(token, true).syncLikedToPlaylist();
  await setLikedMirrorSyncedAt();
  return "synced";
}
```

And inside `GET`, after the `maybeSyncLibrary` call:

```ts
    const likedMirror = await maybeSyncLikedMirror(token);
    return Response.json({ ok: true, added, library, likedMirror });
```

### 5. `src/components/playlists-client.tsx` — add the pill back

Re-add `Heart` to the `lucide-react` import and `syncLikedAction` to the `@/app/(app)/actions`
import, restore the hint:

```ts
const SYNC_LIKED_HINT =
  "Mirrors your Liked Songs into a normal playlist — handy if you want to share them or just see them as a list.";
```

and the pill in the toolbar (it sat last, before `<PlaylistsSync />`):

```tsx
        <HoverTip
          label={SYNC_LIKED_HINT}
          delay={500}
          placement="bottom"
          tipClassName={TIP}
          className="inline-flex"
        >
          <ActionButton
            action={syncLikedAction}
            pendingText="Syncing…"
            success={(r) => `"${r.name}" now has ${r.count} songs`}
            variant="outline"
            className={CHIP}
          >
            <Heart className="size-4 text-foreground" />
            Sync liked
          </ActionButton>
        </HoverTip>
```

That's the whole feature.
