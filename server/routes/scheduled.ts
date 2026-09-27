/**
 * @openapi
 * tags:
 *   - name: Scheduled
 *     description: Scheduled API endpoints

 *
 * /scheduled/{channelId}:
 *   get:
 *     tags: [Messages]
 *     summary: Zamanlanmış mesajları listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Zamanlanmış mesaj listesi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /scheduled/{channelId}/{messageId}:
 *   patch:
 *     tags: [Messages]
 *     summary: Zamanlanmış mesajı güncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content:     { type: string }
 *               scheduledAt: { type: integer, description: 'Unix ms timestamp' }
 *     responses:
 *       200:
 *         description: Güncellendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Messages]
 *     summary: Zamanlanmış mesajı iptal et
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: İptal edildi
 *       403: { $ref: '#/components/responses/Forbidden' }

 *
 * /scheduled:
 *   post:
 *     tags: [Messages]
 *     summary: Yeni zamanlanmis mesaj olustur
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [channelId, content, scheduledAt]
 *             properties:
 *               channelId:   { type: string }
 *               content:     { type: string, maxLength: 2000 }
 *               scheduledAt: { type: integer, description: 'Unix ms timestamp' }
 *     responses:
 *       201:
 *         description: Zamanlanmis mesaj olusturuldu
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// server/routes/scheduled.ts
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router  = express.Router();
import { Members, ScheduledMessages, Channels } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { hasPermission, PERMS, resolvePermissions } from '../lib/permissions';
import { limits } from '../middleware/rateLimit';

// POST /api/scheduled
router.post('/', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const body = req.body as Record<string, unknown>;
  const { channelId, serverId, content, sendAt } = body;
  if (typeof channelId !== 'string' || channelId.length < 1 ||
      typeof serverId !== 'string' || serverId.length < 1 ||
      typeof content !== 'string' || !content.trim() ||
      typeof sendAt !== 'string' || !sendAt.trim()) {
    return res.status(400).json({ error: 'channelId, serverId, content, sendAt required' });
  }
  const ts = new Date(sendAt).getTime();
  if (isNaN(ts) || ts <= Date.now()) return res.status(400).json({ error: 'sendAt must be a future date' });
  if (ts - Date.now() > 30 * 24 * 60 * 60 * 1000) return res.status(400).json({ error: 'Cannot schedule more than 30 days ahead' });

  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const channel = await Channels.findById(channelId) as { _id: string; serverId: string } | null;
  if (!channel || String(channel.serverId) !== serverId) return res.status(400).json({ error: 'Channel/server mismatch' });
  const perms = await resolvePermissions(_u.id, serverId, channelId).catch(() => 0);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.SEND_MESSAGES))
    return res.status(403).json({ error: 'No permission to schedule messages in this channel' });

  const msg = await ScheduledMessages.insert({
    channelId, serverId,
    userId:      _u.id,
    displayName: _u.displayName || _u.username,
    username:    _u.username,
    avatarColor: _u.avatarColor,
    content:     content.trim().slice(0, 2000),
    sendAt:      ts,
  });
  res.json(msg);
});

// GET /api/scheduled
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const msgs = await ScheduledMessages.findPending(_u.id);
  res.json(msgs);
});

// DELETE /api/scheduled/:id
router.delete('/:id', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const id = String(req.params.id ?? '');
  const result = await ScheduledMessages.cancelPending(id, _u.id);
  if (result === 'not_found') return res.status(404).json({ error: 'Not found' });
  if (result === 'sent') return res.status(400).json({ error: 'Already sent' });
  if (result === 'dispatching') {
    return res.status(409).json({ error: 'Message is already being dispatched; cancellation did not take effect' });
  }
  res.json({ cancelled: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
