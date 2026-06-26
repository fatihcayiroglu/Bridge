// server/routes/dm.ts — Direct Messages
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router();
import { Dms, Users } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { sanitizeUser } from '../lib/userUtils';
import { limits } from '../middleware/rateLimit';

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
  const result = convs
    .map(conv => {
      const otherId = conv.participants.find((p: string) => p !== _u.id);
      const other   = otherId ? userMap.get(otherId) : undefined;
      if (!other) return null;
      return { ...conv, other: sanitizeUser(other) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
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

  const limit    = Math.min(parseInt(String(req.query.limit ?? '')) || 50, 100);
  const before   = parseInt(String(req.query.before ?? '')) || Date.now() + 1;
  const messages = await Dms.findMessages(String(req.params.dmId ?? ''), { limit, before });
  res.json(messages.reverse());
});

export { router, getDmId };
export default router;
