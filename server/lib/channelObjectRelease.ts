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
 * Before every delete, the live-reference check (hasLiveUploadReference, or for a
 * leased batch liveUploadReferenceKeys with identical semantics) covers every
 * column that can point at an upload; a still-referenced object (a crosspost, a
 * copy in another channel) is retained. The check is fail-closed: without
 * PostgreSQL it throws and the outbox retries later instead of deleting.
 */
import {
  hasLiveUploadReference, liveUploadReferenceKeys, storageDeleteKey, type UploadReferenceQueryable,
} from './uploadReferenceSafety';
import { locateAsset, releaseUnreferencedUploads } from './uploadRelease';
import { getPrivateStorageAdapter, getPrivateStorageProvider } from './storageAdapter';
import type { ObjectReleaser } from './channelExpiryWorker';

const ROOT_ATTACHMENT = /^\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]{0,200})$/;

/** The canonical key of a root attachment URL, or null. */
function rootAttachmentKey(url: string): string | null {
  const fileName = ROOT_ATTACHMENT.exec(url)?.[1];
  return fileName && !fileName.includes('..') ? `uploads/${fileName}` : null;
}

/**
 * `batch`, when given, answers the reference check for the root attachments of
 * one leased batch from a single query (liveUploadReferenceKeys); keys outside
 * it are checked one by one as before.
 */
export function createChannelObjectReleaser(
  pool: UploadReferenceQueryable | null | undefined,
  batch?: { keys: ReadonlySet<string>; referenced: ReadonlySet<string> },
): ObjectReleaser {
  return {
    async release(url: string) {
      const canonicalKey = rootAttachmentKey(url);
      if (canonicalKey) {
        const referenced = batch?.keys.has(canonicalKey)
          ? batch.referenced.has(canonicalKey)
          : await hasLiveUploadReference(pool, canonicalKey);
        if (referenced) return 'still_referenced';
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
    async forBatch(urls: readonly string[]) {
      const keys = new Set(urls.map(rootAttachmentKey).filter((k): k is string => k !== null));
      const referenced = await liveUploadReferenceKeys(pool, [...keys]);
      return createChannelObjectReleaser(pool, { keys, referenced });
    },
  };
}
