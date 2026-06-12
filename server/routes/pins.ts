/**
 * @openapi
 * tags:
 *   - name: Pins
 *     description: Pins API endpoints

 *
 * /channels/{channelId}/pins:
 *   get:
 *     tags: [Messages]
 *     summary: Kanalda sabitlenmiş mesajları listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Sabitlenmiş mesaj listesi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /channels/{channelId}/pins/{messageId}:
 *   delete:
 *     tags: [Messages]
 *     summary: Mesajı sabitleme listesinden çıkar
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
 *         description: Çıkarıldı
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// server/routes/pins.ts (extracted from index.js)
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router       = express.Router();
import { Channels, Members, Messages } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
// GET /api/channels/:cid/pins
router.get('/:cid/pins', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await Channels.findById(String(req.params.cid ?? ''));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const membership = await Members.findOne(_u.id, channel.serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const pins = await Messages.findPinsInChannel(String(req.params.cid ?? ''), 50);
  res.json(pins);
});

// GET /api/channels/:cid/files
router.get('/:cid/files', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await Channels.findById(String(req.params.cid ?? ''));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const membership = await Members.findOne(_u.id, channel.serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const limit  = Math.min(parseInt(String(req.query.limit ?? '')) || 50, 100);
  const before = parseInt(String(req.query.before ?? '')) || Date.now() + 1;
  const files  = await Messages.messagesFind({
    channelId: String(req.params.cid ?? ''),
    type:      'file',
    createdAt: { $lt: before },
  }).sort({ createdAt: -1 }).limit(limit);
  res.json(files.reverse());
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
