// server/lib/deleteMessageCascade.ts
// Mesaj silme + thread cascade — messages-edit ve plugin actions ortak kullanımı.

import { Messages } from '../db/repositories';
import Threads from '../db/repositories/ThreadRepository';
import { tryRequire } from './_optional-require';
import logger from './logger';

type DbClient = { query(sql: string, params?: unknown[]): Promise<void> };
type DbModule = { _transaction?: (fn: (client: DbClient) => Promise<void>) => Promise<void> };

// null = henüz yüklenmedi; yüklendikten sonra DbModule | null (messages-edit ile aynı semantik)
let _db: DbModule | null = null;
let _dbResolved = false;
function getDb(): DbModule | null {
  if (!_dbResolved) {
    _db = tryRequire<DbModule>('../db/loader', require);
    _dbResolved = true;
  }
  return _db;
}

export interface MessageForDelete {
  _id:       string;
  channelId: string;
  serverId:  string;
  threadId?: string;
}

/** Mesajı sil; tx varsa thread + unread cascade. Başarısızlıkta false döner. */
export async function deleteMessageWithCascade(
  messageId: string,
  channelId: string,
  msg: MessageForDelete,
  deletedBy = 'system',
): Promise<boolean> {
  const db = getDb();
  // In-memory mockDb (_reset) — repository silme; gerçek PG'de _transaction kullan
  const isMockDb = !!(db as { _reset?: () => void } | null)?._reset;
  const withTx     = !isMockDb && typeof db?._transaction === 'function';

  try {
    if (withTx && db?._transaction) {
      await db._transaction(async (client: DbClient) => {
        if (msg.threadId) {
          await client.query('DELETE FROM thread_messages WHERE "threadId" = $1', [msg.threadId]);
          await client.query('DELETE FROM threads WHERE _id = $1', [msg.threadId]);
        }
        // Canonical delete semantics are soft-delete across REST, Socket.IO and
        // plugin transports. Scrub every user-controlled payload field so a
        // deleted row cannot leak original plaintext/ciphertext/attachment data
        // through a raw API client while retaining only audit metadata.
        await client.query(
          `UPDATE messages
              SET content = '[Mesaj silindi]',
                  "deletedAt" = $1,
                  "deletedBy" = $2,
                  embeds = NULL,
                  "encryptedContent" = NULL,
                  iv = NULL,
                  "fileUrl" = NULL,
                  "fileName" = NULL,
                  "fileType" = NULL,
                  "editHistory" = '[]'::jsonb,
                  transcript = NULL
            WHERE _id = $3`,
          [Date.now(), deletedBy, messageId],
        );
        // Sprint 122: bu mesaja yapılmış yanıtların anlık görüntüsü (replyTo JSONB)
        // soft-delete sonrasında da mesajda kalır. Discord gibi "orijinal mesaj silindi"
        // gösterebilmek için işaretlenir — böylece durum reload'dan sonra da korunur.
        await client.query(
          `UPDATE messages
              SET "replyTo" = jsonb_set("replyTo", '{deleted}', 'true'::jsonb)
            WHERE "channelId" = $1
              AND "replyTo" IS NOT NULL
              AND "replyTo"->>'_id' = $2`,
          [channelId, messageId],
        );
        await client.query(
          `UPDATE unread_counts
           SET count = GREATEST(0, count - 1), "updatedAt" = $1
           WHERE "channelId" = $2
             AND count > 0
             AND "userId" IN (
               SELECT m."userId" FROM members m WHERE m."serverId" = $3
             )`,
          [Date.now(), channelId, msg.serverId],
        );
      });
    } else {
      if (msg.threadId) {
        await Messages.deleteByChannel?.(msg.threadId);
        await Threads.delete(msg.threadId);
      }
      await Messages.softDelete(messageId, deletedBy);
      // tx'siz yol (mock/in-memory): aynı işaretleme repository üzerinden.
      await Messages.markRepliesDeleted?.(msg.channelId, messageId);
    }
    return true;
  } catch (err) {
    logger.error(
      { err: (err as Error).message, messageId, event: 'message.delete.cascade.error' },
      'deleteMessageWithCascade failed',
    );
    return false;
  }
}
