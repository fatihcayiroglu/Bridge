// server/routes/messages.ts
import express, { Request, Response, Router } from 'express';
import { authMiddleware} from '../middleware/auth';

import { Messages, Channels, Members, Notifications, MessageReports } from '../db/repositories';
import { limits } from '../middleware/rateLimit';
import { validateBody, schemas } from '../middleware/validate';
import { cache } from '../lib/redisAdapter';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { deleteChannelMessage, editChannelMessage, type MutationFailureCode } from '../lib/messageMutations';
import { clearUnread } from '../lib/notifications';
import logger from '../lib/logger';


interface CursorData { ts: number; id: string; dir: 'before' | 'after' }

function parseLegacyTimestampQuery(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

interface ReadAnchor {
  firstUnreadMessageId: string;
}

/**
 * Snapshot the user's previous chronological read position before this GET marks
 * the returned page as read. The marker is user-specific metadata, so it is
 * carried in response headers rather than the shared first-page cache body.
 */
async function getReadAnchor(userId: string, channelId: string): Promise<ReadAnchor | null> {
  try {
    const row = await Notifications.findChannelReadPosition(userId, channelId) as
      | { lastReadAt?: unknown; lastReadMessageId?: unknown } | null;
    if (!row) return null; // First visit establishes a baseline; history is not all "new".

    const lastReadAt = Number(row.lastReadAt);
    const lastReadMessageId = typeof row.lastReadMessageId === 'string' ? row.lastReadMessageId : '';
    if (!Number.isSafeInteger(lastReadAt) || lastReadAt < 0 || !lastReadMessageId) return null;

    const first = await Messages.findFirstUnreadAfter(channelId, userId, lastReadAt, lastReadMessageId) as
      | { _id?: unknown } | null;
    const firstUnreadMessageId = typeof first?._id === 'string' ? first._id : '';
    if (!firstUnreadMessageId) return null;
    return { firstUnreadMessageId };
  } catch (error) {
    logger.warn({
      event: 'channel_read_anchor_failed', userId, channelId,
      err: error instanceof Error ? error.message : String(error),
    }, 'Channel first-unread marker could not be resolved');
    return null;
  }
}

function attachReadAnchorHeaders(res: Response, anchor: ReadAnchor | null): void {
  if (!anchor) return;
  res.setHeader('X-Bridge-First-Unread-Id', anchor.firstUnreadMessageId);
}

function settleChannelRead(
  userId: string, channelId: string, page: ReadonlyArray<{ _id?: unknown; createdAt?: unknown }>,
): void {
  const newest = page[page.length - 1];
  const newestId = typeof newest?._id === 'string' ? newest._id : '';
  const newestAt = Number(newest?.createdAt);
  const tasks: Promise<unknown>[] = [
    clearUnread(userId, channelId),
    Notifications.markChannelAttentionRead(userId, channelId),
  ];
  if (newestId && Number.isSafeInteger(newestAt) && newestAt >= 0) {
    tasks.push(Notifications.advanceChannelReadPosition(userId, channelId, newestAt, newestId));
  }

  void Promise.allSettled(tasks).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn({ event: 'channel_read_settle_failed', userId, channelId,
          err: result.reason instanceof Error ? result.reason.message : String(result.reason) },
        'Message read state could not be fully persisted');
      }
    }
  });
}

async function requireChannelMembership(userId: string, channelId: string, res: Response) {
  const cacheKey = `channel:${channelId}`;
  let channel = await cache.get(cacheKey) as { _id: string; serverId: string } | null;
  if (!channel) {
    channel = await Channels.findById(channelId);
    if (channel) await cache.set(cacheKey, channel, 60);
  }
  if (!channel) { res.status(404).json({ error: 'Channel not found' }); return null; }
  const membership = await Members.findOne(userId, channel.serverId);
  if (!membership) { res.status(403).json({ error: 'Not a member' }); return null; }
  return channel;
}

/**
 * FAZ G4 — UYELIK + KANAL GORUNURLUGU.
 *
 * `requireChannelMembership` YALNIZ sunucu uyeligini dogrular. Bu, mesaj
 * ICERIGI donduren uclar icin YETERSIZDIR: ozel bir kanal ayni sunucunun
 * uyesine de kapali olabilir. `GET /:cid/messages` bu denetimi ayrica
 * yapiyordu, ancak iki kardes uc ATLANMISTI:
 *   · `GET /:cid/pinned`      — sabitlenmis mesajlarin TAM icerigi
 *   · `GET /messages/:id/history` — duzenleme gecmisi + guncel icerik
 *
 * Ikisi de sunucu uyesine, GOREMEDIGI kanallarin metnini veriyordu.
 */
async function requireChannelVisible(userId: string, channelId: string, res: Response) {
  const channel = await requireChannelMembership(userId, channelId, res);
  if (!channel) return null;
  const perms = await resolvePermissions(userId, channel.serverId, channelId).catch(() => 0);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS)) {
    res.status(403).json({ error: 'Bu kanalı görüntüleyemezsiniz.' });
    return null;
  }
  return channel;
}

const router: Router = express.Router();

// GET /api/channels/:cid/messages
/**
 * @openapi
 * /channels/{channelId}/messages:
 *   get:
 *     tags: [Messages]
 *     summary: Kanal mesajlarını listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: channelId, in: path, required: true, schema: { type: string } }
 *       - { name: before, in: query, schema: { type: string }, description: Cursor pagination }
 *       - { name: limit, in: query, schema: { type: integer, default: 50, maximum: 100 } }
 *     responses:
 *       200:
 *         description: Mesaj listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Message' }
 * /{messageId}:
 *   patch:
 *     tags: [Messages]
 *     summary: Mesajı düzenle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: messageId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content: { type: string, maxLength: 4000 }
 *     responses:
 *       200:
 *         description: Güncellendi
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Message' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Messages]
 *     summary: Mesajı sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: messageId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       204: { description: Silindi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /{messageId}/react:
 *   post:
 *     tags: [Messages]
 *     summary: Mesaja emoji tepkisi ekle / kaldır
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: messageId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [emoji]
 *             properties:
 *               emoji: { type: string, example: "👍" }
 *     responses:
 *       200: { description: Tepki güncellendi }
 */
/**
 * @openapi
 * /channels/{cid}/messages:
 *   get:
 *     tags: [Messages]
 *     summary: Kanal mesajlarını listele
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *         description: Kanal ID
 *       - in: query
 *         name: before
 *         schema: { type: string }
 *         description: Cursor — bu mesaj ID'sinden öncekiler
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 100 }
 *     responses:
 *       200:
 *         description: Mesaj listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Message' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
// ── POST /api/channels/:cid/read ────────────────────────────────────────────
// The viewer saw `messageId` arrive live in the open channel (Final21 Phase 15).
// Loading history already advances the read cursor; without this, a message read
// in real time would make the channel look unread again after switching away.
// The cursor is monotonic (NotificationRepository.advanceChannelReadPosition).
router.post('/:cid/read', authMiddleware, async (req: Request, res: Response) => {
  const user = castAuthed(req).user;
  const channelId = String(req.params.cid ?? '');
  const messageId = typeof (req.body as { messageId?: unknown } | undefined)?.messageId === 'string'
    ? String((req.body as { messageId: string }).messageId) : '';
  if (!messageId) return void res.status(400).json({ error: 'messageId required' });
  const channel = await requireChannelVisible(user.id, channelId, res);
  if (!channel) return;
  const message = await Messages.findById(messageId) as { _id?: unknown; channelId?: unknown; createdAt?: unknown } | null;
  const createdAt = Number(message?.createdAt);
  if (!message || String(message.channelId) !== channelId || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    return void res.status(404).json({ error: 'Message not found in this channel' });
  }
  await Notifications.advanceChannelReadPosition(user.id, channelId, createdAt, messageId);
  await Promise.allSettled([clearUnread(user.id, channelId), Notifications.markChannelAttentionRead(user.id, channelId)]);
  res.status(204).end();
});

router.get('/:cid/messages', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const channel = await requireChannelMembership(_u.id, String(req.params.cid ?? ''), res);
  if (!channel) return;

  const perms = await resolvePermissions(_u.id, channel.serverId, String(req.params.cid ?? ''));
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS))
    return void res.status(403).json({ error: 'No permission to view this channel' });
  if (!hasPermission(perms, PERMS.READ_HISTORY))
    return void res.status(403).json({ error: 'No permission to read message history' });

  let limit = 50;
  if (req.query.limit !== undefined) {
    if (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)) {
      return void res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
    }
    const parsedLimit = Number(req.query.limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return void res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
    }
    limit = parsedLimit;
  }

  let cursorData: CursorData | null = null;
  if (req.query.cursor !== undefined) {
    if (typeof req.query.cursor !== 'string' || req.query.cursor.length === 0 || req.query.cursor.length > 512) {
      return void res.status(400).json({ error: 'Invalid cursor' });
    }
    try {
      const decoded = JSON.parse(Buffer.from(req.query.cursor, 'base64').toString('utf8')) as Partial<CursorData> | null;
      // Final21 Faz 19 (19-27): PostgreSQL BIGINT `createdAt`'i node-pg METİN olarak döndürür ve bu
      // uç kendi imlecine `ts: "1790…"` yazıyordu; aşağıdaki doğrulama da onu REDDEDİYORDU (400).
      // Yayınlanmış istemcilerin elindeki bu biçimdeki imleçler de geçerli sayılır: yalnızca rakam.
      if (decoded && typeof decoded === 'object' && typeof decoded.ts === 'string' && /^\d{1,16}$/.test(decoded.ts)) {
        decoded.ts = Number(decoded.ts);
      }
      if (!decoded || typeof decoded !== 'object' ||
          !Number.isSafeInteger(decoded.ts) || (decoded.ts as number) < 0 ||
          typeof decoded.id !== 'string' || decoded.id.length === 0 || decoded.id.length > 200 ||
          (decoded.dir !== 'before' && decoded.dir !== 'after')) {
        return void res.status(400).json({ error: 'Invalid cursor' });
      }
      cursorData = decoded as CursorData;
    } catch {
      return void res.status(400).json({ error: 'Invalid cursor' });
    }
  }

  const legacyBefore = parseLegacyTimestampQuery(req.query.before);
  const legacyAfter  = parseLegacyTimestampQuery(req.query.after);
  if (legacyBefore === null || legacyAfter === null) {
    return void res.status(400).json({ error: 'before/after must be non-negative safe integer timestamps' });
  }
  const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : undefined;
  const isFirstPage  = !req.query.cursor && legacyBefore === undefined && legacyAfter === undefined && !searchQuery;
  const channelId = String(req.params.cid ?? '');
  const cacheKey     = `messages:${channelId}:first:${limit}`;
  const readAnchor = isFirstPage ? await getReadAnchor(_u.id, channelId) : null;

  if (isFirstPage) {
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      attachReadAnchorHeaders(res, readAnchor);
      const cachedMessages = Array.isArray((cached as { messages?: unknown }).messages)
        ? (cached as { messages: Array<{ _id?: unknown; createdAt?: unknown }> }).messages
        : [];
      settleChannelRead(_u.id, channelId, cachedMessages);
      return void res.json(cached);
    }
  }

  const raw     = await Messages.findByChannel(channelId, {
    limit: limit + 1,
    before:   cursorData?.dir === 'before' ? cursorData.ts : legacyBefore,
    beforeId: cursorData?.dir === 'before' ? cursorData.id : undefined,
    after:    cursorData?.dir === 'after' ? cursorData.ts : legacyAfter,
    afterId:  cursorData?.dir === 'after' ? cursorData.id : undefined,
    search: searchQuery,
  });
  // Sprint 122 FIX — sayfalama iki noktada bozuktu:
  //   1) Messages.findByChannel() en YENİ limit+1 kaydı ASC (eski→yeni) döndürür.
  //      raw.slice(0, limit) bu dizinin BAŞINI, yani en ESKİlerini alıyordu →
  //      sohbet açılışında en yeni mesajlar hiç gelmiyordu.
  //   2) Ardından page.reverse() ile sıra yeniden→eskiye çevriliyordu; hem istemci
  //      render sırası ters oluyor hem de "oldest/newest" değişkenleri yer değiştirdiği
  //      için prevCursor en yeni mesajı işaret edip sayfalama kendini tekrarlıyordu.
  //
  // Sözleşme: `messages` HER ZAMAN eskiden→yeniye (ASC) döner.
  //   - varsayılan / dir:'before' → en YENİ `limit` kayıt (dizinin sonu)
  //   - dir:'after'              → cursor'dan sonraki en ESKİ `limit` kayıt (bitişik sayfa)
  const hasMore = raw.length > limit;
  const isAfter = cursorData?.dir === 'after' || legacyAfter !== undefined;
  const page    = !hasMore
    ? raw
    : isAfter
      ? raw.slice(0, limit)
      : raw.slice(raw.length - limit);

  let nextCursor: string | null = null;
  let prevCursor: string | null = null;
  // Indeksli erisim `noUncheckedIndexedAccess` altinda `... | undefined` doner
  // ve `page.length > 0` kontrolu bunu daraltmaz. Ucu da tek bir kontrole
  // baglamak hem tip guvenli hem de daha dogru: bos olmayan bir sayfanin ilk
  // ve son ogesi ayni kosula tabidir.
  const oldest = page[0];
  const newest = page[page.length - 1];
  if (oldest && newest) {
    // İmleç `ts`si HER ZAMAN sayıdır (19-27): PostgreSQL'de `createdAt` metin gelir.
    prevCursor = Buffer.from(JSON.stringify({ ts: Number(oldest.createdAt), id: oldest._id, dir: 'before' })).toString('base64');
    if (hasMore || cursorData?.dir === 'after') {
      nextCursor = Buffer.from(JSON.stringify({ ts: Number(newest.createdAt), id: newest._id, dir: 'after' })).toString('base64');
    }
  }

  // ackId is an internal sender idempotency key. Reconciliation is delivered
  // through the private message:ack event; never broadcast/cache it as channel data.
  const publicPage = page.map((message) => {
    const result = { ...message } as Record<string, unknown>;
    delete result.ackId;
    return result;
  });
  const response = { messages: publicPage, hasMore, nextCursor, prevCursor, limit, count: publicPage.length };

  // Adaptive TTL: aktif kanallar (son mesaj < 2dk) 5s; ılımlı aktif (< 10dk) 15s; sessiz 45s.
  // 10s sabit TTL Roadmap'teki "Mesaj cache TTL optimizasyonu" maddesini karşılıyordu ama
  // aktif kanallarda bayat veri, sessiz kanallarda gereksiz DB hit'i yaratıyordu.
  if (isFirstPage && !searchQuery) {
    const newestMsg = page[page.length - 1];
    const ageMs     = newestMsg ? (Date.now() - newestMsg.createdAt) : Infinity;
    const ttl = ageMs < 2 * 60_000  ? 5   // çok aktif kanal   → 5s
               : ageMs < 10 * 60_000 ? 15  // orta aktif kanal  → 15s
               : 45;                        // sessiz kanal      → 45s
    await cache.set(cacheKey, response, ttl);
  }
  attachReadAnchorHeaders(res, readAnchor);
  settleChannelRead(_u.id, channelId, publicPage);
  res.setHeader('X-Cache', 'MISS');
  res.json(response);
});

// GET /api/channels/:cid/pinned
/**
 * @openapi
 * /channels/{cid}/pinned:
 *   get:
 *     tags: [Messages]
 *     summary: Sabitlenmiş mesajlar
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Sabitlenmiş mesaj listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Message' }
 */
router.get('/:cid/pinned', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const channel = await requireChannelVisible(_u.id, String(req.params.cid ?? ''), res);
  if (!channel) return;
  res.json(await Messages.findPinned(String(req.params.cid ?? '')));
});

// DELETE /api/messages/bulk — Sprint 121 FIX 18: Toplu mesaj silme (moderasyon)
/**
 * @openapi
 * /messages/bulk:
 *   delete:
 *     tags: [Messages]
 *     summary: Toplu mesaj sil (moderatör)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids: { type: array, items: { type: string }, maxItems: 100 }
 *     responses:
 *       200: { description: Silinen mesaj sayısı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.delete('/bulk', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { ids, serverId } = req.body as { ids?: unknown; serverId?: string };

  if (!Array.isArray(ids) || ids.length === 0) {
    return void res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (ids.length > 100) {
    return void res.status(400).json({ error: 'Maximum 100 messages per bulk delete' });
  }
  if (ids.some(id => typeof id !== 'string' || !id)) {
    return void res.status(400).json({ error: 'Every message id must be a non-empty string' });
  }
  if (!serverId || typeof serverId !== 'string') {
    return void res.status(400).json({ error: 'serverId required' });
  }

  const uniqueIds = Array.from(new Set(ids as string[]));
  const basePerms = await resolvePermissions(_u.id, serverId).catch(() => 0);
  if (!hasPermission(basePerms, PERMS.MANAGE_MESSAGES)) {
    return void res.status(403).json({ error: 'MANAGE_MESSAGES permission required for bulk delete' });
  }

  const rows = await Messages.findWhere({ _id: { $in: uniqueIds } });
  if (!Array.isArray(rows) || rows.length !== uniqueIds.length) {
    return void res.status(404).json({ error: 'One or more messages were not found' });
  }
  if (rows.some(message => String(message.serverId) !== serverId)) {
    return void res.status(403).json({ error: 'Message scope mismatch' });
  }

  const channelIds = Array.from(new Set(rows.map(message => String(message.channelId))));
  for (const channelId of channelIds) {
    const channelPerms = await resolvePermissions(_u.id, serverId, channelId).catch(() => 0);
    if (!hasPermission(channelPerms, PERMS.VIEW_CHANNELS) ||
        !hasPermission(channelPerms, PERMS.MANAGE_MESSAGES)) {
      return void res.status(403).json({ error: 'No moderation permission in one or more target channels' });
    }
  }

  const count = await Messages.bulkSoftDelete(uniqueIds, _u.id);
  res.json({ deleted: count });
});

// DELETE /api/messages/:id
/**
 * @openapi
 * /messages/{id}:
 *   delete:
 *     tags: [Messages]
 *     summary: Mesajı sil
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Mesaj silindi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
/**
 * HTTP status for a refused mutation (Final21 Phase 16). The rules themselves live in
 * lib/messageMutations.ts, shared with the socket handlers; before that this route had its own
 * copy that skipped AutoMod, the cache and the live broadcast (measured, p16-http-mutation-probe).
 */
function sendMutationRefusal(res: Response, code: MutationFailureCode, reason?: string): void {
  switch (code) {
    case 'NOT_FOUND':           res.status(404).json({ error: 'Message not found' }); return;
    case 'NOT_VISIBLE':         res.status(403).json({ error: 'Bu kanalı görüntüleyemezsiniz.' }); return;
    case 'FORBIDDEN':           res.status(403).json({ error: 'Not your message' }); return;
    case 'INVALID':             res.status(400).json({ error: reason === 'type' ? 'Cannot edit this message type' : 'Invalid message content' }); return;
    case 'AUTOMOD_BLOCKED':     res.status(422).json({ error: reason || 'Blocked by AutoMod', code }); return;
    case 'AUTOMOD_UNAVAILABLE': res.status(503).json({ error: 'AutoMod could not be evaluated; nothing was changed', code }); return;
    case 'CONFLICT':            res.status(409).json({ error: 'Message changed since editing began', code }); return;
    default:                    res.status(500).json({ error: 'Message could not be changed' });
  }
}

router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const id = String(req.params.id ?? '');
  const result = await deleteChannelMessage(req.app.get('io'), { actorId: _u.id, messageId: id });
  if (!result.ok) return void sendMutationRefusal(res, result.code, result.reason);
  res.json({ deleted: true, id });
});

// PATCH /api/messages/:id
/**
 * @openapi
 * /messages/{id}:
 *   patch:
 *     tags: [Messages]
 *     summary: Mesajı düzenle
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content: { type: string }
 *     responses:
 *       200:
 *         description: Düzenlenmiş mesaj
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Message' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.patch('/:id', authMiddleware, limits.messages(), validateBody(schemas['message']),
  async (req: Request, res: Response) => {
    const _u = castAuthed(req).user;
    const result = await editChannelMessage(req.app.get('io'), {
      actorId: _u.id,
      messageId: String(req.params.id ?? ''),
      content: (req.body as { content?: unknown }).content,
      requireNormalType: true,
    });
    if (!result.ok) return void sendMutationRefusal(res, result.code, result.reason);
    res.json(result.message);
  }
);

// POST /api/messages/:id/report
// User-facing community report flow. Missing and inaccessible messages share
// the same 404 response so this endpoint cannot be used as an existence oracle.
router.post('/:id/report', authMiddleware, limits.moderation(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const messageId = String(req.params.id ?? '').trim();
  const reason = String((req.body as { reason?: unknown } | undefined)?.reason ?? '').trim();
  const detail = String((req.body as { detail?: unknown } | undefined)?.detail ?? '').trim();
  const allowedReasons = new Set(['spam', 'harassment', 'hate', 'sexual', 'violence', 'other']);
  if (!messageId || !allowedReasons.has(reason) || detail.length > 500) {
    return void res.status(400).json({ error: 'Invalid report' });
  }

  const msg = await Messages.findById(messageId);
  if (!msg || msg.deletedAt) return void res.status(404).json({ error: 'Message not available' });
  const channel = await Channels.findByIdAndServer(String(msg.channelId ?? ''), String(msg.serverId ?? ''));
  if (!channel) return void res.status(404).json({ error: 'Message not available' });
  const perms = await resolvePermissions(_u.id, String(msg.serverId ?? ''), String(msg.channelId ?? '')).catch(() => 0);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.READ_HISTORY)) {
    return void res.status(404).json({ error: 'Message not available' });
  }
  if (String(msg.userId ?? '') === _u.id) return void res.status(400).json({ error: 'Cannot report your own message' });

  const result = await MessageReports.create({
    serverId: String(msg.serverId), channelId: String(msg.channelId), messageId,
    reporterId: _u.id,
    reason: reason as 'spam' | 'harassment' | 'hate' | 'sexual' | 'violence' | 'other',
    detail,
  });
  return void res.status(result.created ? 201 : 200).json({ reported: true, created: result.created, id: String(result.row._id) });
});

// GET /api/messages/:id/history
/**
 * @openapi
 * /messages/{id}/history:
 *   get:
 *     tags: [Messages]
 *     summary: Mesaj düzenleme geçmişi
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Düzenleme geçmişi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 */
router.get('/:id/history', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const msg = await Messages.findById(String(req.params.id ?? ''));
  if (!msg) return void res.status(404).json({ error: 'Message not found' });
  const channel = await requireChannelVisible(_u.id, msg.channelId, res);
  if (!channel) return;
  const perms = await resolvePermissions(_u.id, channel.serverId, msg.channelId).catch(() => 0);
  if (!hasPermission(perms, PERMS.READ_HISTORY))
    return void res.status(403).json({ error: 'No permission to read message history' });
  res.json({ editHistory: Array.isArray(msg.editHistory) ? msg.editHistory : [], current: { content: msg.content, editedAt: msg.editedAt } });
});

// POST /api/messages/:id/react
/**
 * @openapi
 * /messages/{id}/react:
 *   post:
 *     tags: [Messages]
 *     summary: Mesaja tepki ekle/kaldır
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [emoji]
 *             properties:
 *               emoji: { type: string, example: '👍' }
 *     responses:
 *       200: { description: Tepki güncellendi }
 */
router.post('/:id/react', authMiddleware, limits.react(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { emoji } = req.body as { emoji?: string };
  if (!emoji || typeof emoji !== 'string' || emoji.length > 12)
    return void res.status(400).json({ error: 'Invalid emoji' });

  const msg = await Messages.findById(String(req.params.id ?? ''));
  if (!msg) return void res.status(404).json({ error: 'Message not found' });

  const channel = await requireChannelVisible(_u.id, msg.channelId, res);
  if (!channel) return;
  const reactionPerms = await resolvePermissions(_u.id, msg.serverId, msg.channelId).catch(() => 0);
  if (!hasPermission(reactionPerms, PERMS.ADD_REACTIONS)) {
    return void res.status(403).json({ error: 'ADD_REACTIONS permission required' });
  }

  const reactions: Record<string, string[]> = (msg.reactions ?? {}) as Record<string, string[]>;

  // ── ATOMIK YOL (KAYIP GUNCELLEME YARISI) ─────────────────────────────────
  // Asagidaki oku-degistir-yaz, es zamanli iki reaksiyonda SON YAZANIN
  // kazanmasina ve digerinin SESSIZCE KAYBOLMASINA yol aciyordu (olculdu:
  // iki kullanici / iki emoji → 200,200 ama yalnizca 1 reaksiyon hayatta).
  // PostgreSQL'de degisim TEK ifadede yapilir; pencere kalmaz.
  const atomic = await Messages.toggleReactionAtomic(
    String(req.params.id ?? ''), emoji, _u.id,
  );
  if (atomic === false) {
    return void res.status(400).json({ error: 'Max 20 unique reactions per message' });
  }
  if (atomic !== null) {
    res.json(await Messages.findById(String(req.params.id ?? '')));
    return;
  }

  // Yedek yol: atomik guncellemeyi desteklemeyen adaptorler (mock/SQLite).
  if (!reactions[emoji] && Object.keys(reactions).length >= 20) {
    return void res.status(400).json({ error: 'Max 20 unique reactions per message' });
  }
  const users = reactions[emoji] || [];
  const idx   = users.indexOf(_u.id);
  if (idx === -1) users.push(_u.id); else users.splice(idx, 1);
  if (users.length === 0) delete reactions[emoji]; else reactions[emoji] = users;

  await Messages.update(String(req.params.id ?? ''), { reactions });
  res.json(await Messages.findById(String(req.params.id ?? '')));
});

 
export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
