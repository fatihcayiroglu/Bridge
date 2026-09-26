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
import { parseBoundedPositiveIntQuery, parseNonNegativeSafeIntQuery } from '../lib/queryNumbers';
const router       = express.Router();
import { Channels, Members, Messages } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { canViewChannel } from '../lib/permissions';

// ════════════════════════════════════════════════════════════════════════════
// FAZ J-SONRASI GUVENLIK DUZELTMESI — SUNUCU UYELIGI KANAL GORUNURLUGU DEGILDIR
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR (canli urunde olculdu):
//   Ayni ozel kanal (`gizli-oda`), ayni kullanici (uye B, VIEW_CHANNELS YOK):
//     GET /api/channels/:cid/messages -> 403   (dogru)
//     GET /api/channels/:cid/pinned   -> 403   (dogru)
//     GET /api/channels/:cid/pins     -> 200   <-- ACIK
//     GET /api/channels/:cid/files    -> 200   <-- ACIK
//
//   Bu iki uc YALNIZCA `Members.findOne(user, channel.serverId)` denetliyordu.
//   Sunucunun herhangi bir uyesi, GOREMEDIGI ozel kanallarin sabitlenmis
//   mesajlarini ve dosya listesini okuyabiliyordu.
//
//   Bos dizi donmesi guvenlik KANITI DEGILDIR: `gizli-oda` henuz sabitlenmis
//   mesaj icermedigi icin sizinti gorunmuyordu. Kusur veriye degil DENETIME
//   bagliydi.
//
// AYNI KUSUR AILESI: Faz D'de `search.ts`, Faz J'de `channel_permissions`
// magaza ayrimi. Ilke degismiyor: AYNI VERIYE GIDEN HER YOL AYNI DENETIMI
// UYGULAMAK ZORUNDADIR.
//
// DUZELTME: kanonik `canViewChannel` (fail-closed) kullanilir; yeni bir yetki
// mantigi YAZILMAZ.
// ════════════════════════════════════════════════════════════════════════════
// GET /api/channels/:cid/pins
router.get('/:cid/pins', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await Channels.findById(String(req.params.cid ?? ''));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const membership = await Members.findOne(_u.id, channel.serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  if (!(await canViewChannel(_u.id, channel.serverId, String(req.params.cid ?? ''))))
    return res.status(403).json({ error: 'Bu kanalı görüntüleyemezsiniz.' });
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
  if (!(await canViewChannel(_u.id, channel.serverId, String(req.params.cid ?? ''))))
    return res.status(403).json({ error: 'Bu kanalı görüntüleyemezsiniz.' });
  const limit  = parseBoundedPositiveIntQuery(req.query.limit, 50, 100);
  const before = parseNonNegativeSafeIntQuery(req.query.before, Date.now() + 1);
  if (limit === null || before === null) {
    return res.status(400).json({ error: 'limit/before must be safe non-negative integers (limit >= 1)' });
  }
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
