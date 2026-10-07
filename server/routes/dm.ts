// server/routes/dm.ts — Direct Messages
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router();
import { Dms, Users } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { sanitizeUser } from '../lib/userUtils';
import { limits } from '../middleware/rateLimit';
import { parseBoundedPositiveIntQuery, parseNonNegativeSafeIntQuery } from '../lib/queryNumbers';
import { evaluateDmAccess } from '../lib/dmAccessPolicy';
import { claimNewDmConversation } from '../lib/abusePolicy';
import logger from '../lib/logger';

function getDmId(a: string, b: string): string { return [a, b].sort().join(':'); }

// GET /api/dm
/**
 * @openapi
 * /dm:
 *   get:
 *     tags: [DM]
 *     summary: Direkt mesaj konuşmalarını listele
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: DM listesi
 * /dm/{userId}:
 *   post:
 *     tags: [DM]
 *     summary: DM mesajı gönder (konuşma yoksa oluşturur)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: userId, in: path, required: true, schema: { type: string } }
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
 *       200: { description: Mesaj gönderildi }
 * /dm/{dmId}/messages:
 *   get:
 *     tags: [DM]
 *     summary: DM geçmişini getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: dmId, in: path, required: true, schema: { type: string } }
 *       - { name: before, in: query, schema: { type: string } }
 *       - { name: limit, in: query, schema: { type: integer, default: 50, maximum: 100 } }
 *     responses:
 *       200:
 *         description: Mesaj listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Message' }
 */
/**
 * @openapi
 * /dm:
 *   get:
 *     tags: [DM]
 *     summary: DM listesi
 *     responses:
 *       200:
 *         description: Açık DM'ler
 *         content:
 *           application/json:
 *             schema: { type: array, items: { type: object } }
 */
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const convs  = await Dms.findConversationsByUser(_u.id);
  // PERF: Bulk fetch instead of N+1 loop
  const otherIds = convs
    .map(conv => conv.participants.find((p: string) => p !== _u.id))
    .filter((id): id is string => !!id);
  const userList = await Users.findByIds([...new Set(otherIds)]);
  const userMap  = new Map(userList.map(u => [u._id, u]));
  const visible = convs
    .map(conv => {
      const otherId = conv.participants.find((p: string) => p !== _u.id);
      const other   = otherId ? userMap.get(otherId) : undefined;
      if (!other) return null;
      return { conv, other };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Faz 10.3 — türetilmiş okunmamış sayacı. Yeni tablo/kolon YOK: mevcut
  // `readAt` imleci ile mesaj zaman damgalarından hesaplanır. GET salt
  // okumadır; burada hiçbir okundu durumu değiştirilmez.
  // Not: konuşma başına bir sayım sorgusu yapılır. DM listesi sınırlı
  // olduğundan kabul edilebilir; erken optimizasyon için index/migration
  // eklenmedi.
  const result = await Promise.all(visible.map(async ({ conv, other }) => {
    const readAt = (conv.readAt as Record<string, number> | undefined)?.[_u.id];
    const unreadCount = await Dms.countUnread(conv._id, _u.id, readAt);
    return { ...conv, other: sanitizeUser(other), unreadCount };
  }));

  res.json(result);
});

// POST /api/dm/:userId
/**
 * @openapi
 * /dm/{userId}:
 *   post:
 *     tags: [DM]
 *     summary: DM mesajı gönder
 *     parameters:
 *       - in: path
 *         name: userId
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
 *       201:
 *         description: Mesaj gönderildi
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Message' }
 */
router.post('/:userId', authMiddleware, limits.dm(), async (req, res) => {
  const _u = castAuthed(req).user;
  const other = await Users.findById(String(req.params.userId ?? ''));
  if (!other)                    return res.status(404).json({ error: 'User not found' });
  if (other._id === _u.id) return res.status(400).json({ error: 'Cannot DM yourself' });

  // Faz 10.8 — GİZLİLİK VE ENGEL KONTROLÜ.
  //
  // Bu uç önceden hiçbir kontrol yapmıyordu; oysa socket yolu
  // (socket/handlers/dm.ts:290-317) hem engeli hem `dmPrivacy`yi uyguluyordu.
  // Sonuç bir BYPASS ZİNCİRİYDİ: saldırgan REST ile konuşmayı açar, sonra
  // socket'in "konuşma zaten var" muafiyetine (a.g.e. satır 301-303) girerek
  // DM'i reddetmiş ya da kendisini engellemiş kullanıcıya KALICI erişim
  // kazanırdı. Aynı kurallar burada da uygulanır; sözleşme birebir aynıdır:
  // kısıtlama yalnız YENİ konuşma açılışına uygulanır.
  let access;
  try {
    access = await evaluateDmAccess(_u.id, other as { _id: string; dmPrivacy?: unknown });
  } catch (err) {
    logger.error({ event: 'dm.access_policy.failed', userId: _u.id, otherUserId: other._id, err },
      '[dm] privacy/block policy could not be evaluated');
    return res.status(503).json({ error: 'DM policy is temporarily unavailable' });
  }
  if (!access.allowed) {
    if (access.reason === 'blocked') return res.status(403).json({ error: 'Bu kullanıcıyla mesajlaşamazsınız.' });
    if (access.reason === 'privacy_none') return res.status(403).json({ error: 'Bu kullanıcı DM almıyor.' });
    return res.status(403).json({ error: 'Bu kullanıcı yalnızca arkadaşlarından DM kabul ediyor.' });
  }

  // P7 B1: a NEW conversation consumes the same budget as the socket path.
  if (!access.existingConversation) {
    const budget = await claimNewDmConversation(_u.id);
    if (!budget.allowed) {
      res.set('Retry-After', String(Math.ceil(budget.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'DM_NEW_CONVERSATION_LIMIT', retryAfterMs: budget.retryAfterMs });
    }
  }

  const { conv, dmId } = await Dms.findOrCreateConversation(_u.id, other._id);
  res.json({ ...conv, _id: dmId, other: sanitizeUser(other) });
});

// GET /api/dm/:dmId/messages
/**
 * @openapi
 * /dm/{dmId}/messages:
 *   get:
 *     tags: [DM]
 *     summary: DM mesajlarını listele
 *     parameters:
 *       - in: path
 *         name: dmId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: before
 *         schema: { type: string }
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
 */
router.get('/:dmId/messages', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const conv = await Dms.findConversation(String(req.params.dmId ?? ''));
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!conv.participants.includes(_u.id)) return res.status(403).json({ error: 'Forbidden' });

  const limit  = parseBoundedPositiveIntQuery(req.query.limit, 50, 100);
  const before = parseNonNegativeSafeIntQuery(req.query.before, Date.now() + 1);
  if (limit === null || before === null) {
    return res.status(400).json({ error: 'limit/before must be safe non-negative integers (limit >= 1)' });
  }
  // Faz 10.2 — kompozit cursor. `beforeId` opsiyoneldir: verilmezse eski
  // (yalnız zaman damgalı) davranış korunur. Aynı milisaniyede yazılmış
  // mesajlar sayfa sınırına denk geldiğinde bu ayırıcı olmadan sessizce
  // kayboluyorlardı (bkz. tests/dm-pagination.test.ts).
  const beforeIdRaw = String(req.query.beforeId ?? '').trim();
  const beforeId    = beforeIdRaw.length > 0 && beforeIdRaw.length <= 64 ? beforeIdRaw : undefined;

  const messages = await Dms.findMessages(String(req.params.dmId ?? ''), { limit, before, beforeId });
  // Fetching an authorized conversation is the canonical "opened" action;
  // keep the durable read cursor correct even when the socket is unavailable.
  await Dms.markRead(String(req.params.dmId ?? ''), _u.id);
  res.json(messages.reverse().map(({ clientNonce: _clientNonce, ...message }) => message));
});

export { router, getDmId };
export default router;
