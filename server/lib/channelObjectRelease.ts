/**
 * P7 D2: production ObjectReleaser for expired-channel uploads (migration 089).
 *
 * Only exact locations Bridge owns are ever deleted; everything else is
 * `unrecognized` and retained (an external URL's basename must never be mapped
 * onto a local file of the same name):
 *   /uploads/<file>                  root attachment or voice message in the
 *                                    PRIVATE storage (local disk, S3, R2, MinIO, B2)
 *   /uploads/recordings/<file>, ...  persistent assets recognised by
 *                                    lib/uploadRelease.ts (local or adapter)
 * Before every delete, `hasLiveUploadReference` re-checks every column that can
 * point at an upload; a still-referenced object (a crosspost, a copy in another
 * channel) is retained. The check is fail-closed: without PostgreSQL it throws
 * and the outbox retries later instead of deleting.
 */
import { hasLiveUploadReference, storageDeleteKey, type UploadReferenceQueryable } from './uploadReferenceSafety';
import { locateAsset, releaseUnreferencedUploads } from './uploadRelease';
import { getPrivateStorageAdapter, getPrivateStorageProvider } from './storageAdapter';
import type { ObjectReleaser } from './channelExpiryWorker';

const ROOT_ATTACHMENT = /^\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]{0,200})$/;

export function createChannelObjectReleaser(pool: UploadReferenceQueryable | null | undefined): ObjectReleaser {
  return {
    async release(url: string) {
      const root = ROOT_ATTACHMENT.exec(url);
      const fileName = root?.[1];
      if (fileName && !fileName.includes('..')) {
        const canonicalKey = `uploads/${fileName}`;
        if (await hasLiveUploadReference(pool, canonicalKey)) return 'still_referenced';
        await getPrivateStorageAdapter().deleteFile(storageDeleteKey(canonicalKey, getPrivateStorageProvider()));
        // Ownership metadata only; the byte decision is already made.
        await pool?.query('DELETE FROM uploads WHERE key = $1', [canonicalKey]).catch(() => undefined);
        return 'released';
      }
      if (!locateAsset(url)) return 'unrecognized';
      let failure: unknown = null;
      const result = await releaseUnreferencedUploads(pool, [url], (_url, err) => { failure = err; });
      if (failure) throw failure;
      if (result.stillReferenced) return 'still_referenced';
      return result.alreadyAbsent ? 'absent' : 'released';
    },
  };
}
