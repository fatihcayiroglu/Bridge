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
 * Before deletion, migration 091's durable reservation and one batched
 * live-reference scan serialize against reference writers. Shared objects are
 * retained; late references to reserved objects are refused. Without verified
 * PostgreSQL evidence the outbox retries instead of deleting.
 */
import { storageDeleteKey, type UploadReferenceQueryable } from './uploadReferenceSafety';
import { reserveUploadReleaseKeys } from './uploadReleaseFence';
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
 * A prepared batch holds durable deletion reservations, not just a cached
 * negative reference answer. Keys outside it are reserved individually.
 */
export function createChannelObjectReleaser(
  pool: UploadReferenceQueryable | null | undefined,
  batch?: { keys: ReadonlySet<string>; referenced: ReadonlySet<string> },
): ObjectReleaser {
  return {
    async release(url: string) {
      const canonicalKey = rootAttachmentKey(url);
      const asset = canonicalKey ? null : locateAsset(url);
      const key = canonicalKey ?? asset?.canonicalKey;
      if (!key) return 'unrecognized';
      const referenced = batch?.keys.has(key)
        ? batch.referenced.has(key)
        : (await reserveUploadReleaseKeys(pool, [key])).has(key);
      if (referenced) return 'still_referenced';
      if (canonicalKey) {
        await getPrivateStorageAdapter().deleteFile(storageDeleteKey(canonicalKey, getPrivateStorageProvider()));
        // Ownership metadata only; the byte decision is already made.
        await pool?.query('DELETE FROM uploads WHERE key = $1', [canonicalKey]).catch(() => undefined);
        return 'released';
      }
      let failure: unknown = null;
      const result = await releaseUnreferencedUploads(pool, [url], (_url, err) => { failure = err; });
      if (failure) throw failure;
      if (result.stillReferenced) return 'still_referenced';
      return result.alreadyAbsent ? 'absent' : 'released';
    },
    async forBatch(urls: readonly string[]) {
      const keys = new Set(urls.map(url => rootAttachmentKey(url) ?? locateAsset(url)?.canonicalKey)
        .filter((key): key is string => key !== null && key !== undefined));
      const referenced = await reserveUploadReleaseKeys(pool, [...keys]);
      return createChannelObjectReleaser(pool, { keys, referenced });
    },
  };
}
