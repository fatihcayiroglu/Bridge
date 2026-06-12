// server/routes/channels/voice.ts
// Sprint 108: voice-state ve voice-members endpoint'leri channels/crud.ts'den ayrıştırıldı.
// Kapsam:
//   POST /api/channels/:channelId/voice-state    — mute/deaf güncelle
//   GET  /api/channels/:channelId/voice-members  — aktif peer listesi
//
// Düzeltmeler (Sprint 108 post-review):
//   - Dynamic import kaldırıldı: voiceRooms artık handlers/voice.ts'den statik import edilir
//     (circular import riski ortadan kalktı — routes → socket/index döngüsü kırıldı)
//   - (req as any) → castAuthed() ile tip güvenli erişim
//   - voiceState rate limit limits nesnesine eklendi (rateLimit.ts'e de eklendi)

import { Router }                    from 'express';
import { authMiddleware} from '../../middleware/auth';
import { limits }                    from '../../middleware/rateLimit';
import { Channels, Members }         from '../../db/repositories';
import { getIo }                     from '../../socket';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
// Statik import: handlers/voice.ts circular bağımlılık oluşturmaz
// (voice handler routes'u import etmez; bağımlılık tek yönlü kalır)
// Path: server/routes/channels/ → server/socket/handlers/voice.ts
import { voiceRooms }                from '../../socket/handlers/voice';

const router = Router({ mergeParams: true });

/**
 * @openapi
 * /api/channels/{channelId}/voice-state:
 *   post:
 *     tags: [Voice]
 *     summary: Ses durumunu güncelle (mute/deaf)
 *     description: Kullanıcının ses kanalındaki mute/deaf durumunu günceller ve socket ile diğer üyelere yayınlar.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *         description: Ses kanalı ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               selfMute: { type: boolean, description: Mikrofon kapalı mı? }
 *               selfDeaf: { type: boolean, description: Kulaklık kapalı mı? }
 *     responses:
 *       200:
 *         description: Durum güncellendi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.post(
  '/:channelId/voice-state',
  authMiddleware,
  limits.voiceState(),
  async (req, res) => {
    try {
      const channelId = String(req.params.channelId ?? '');
      const { id: userId } = castAuthed(req).user;

      const { selfMute, selfDeaf } = req.body as { selfMute?: boolean; selfDeaf?: boolean };
      if (typeof selfMute !== 'boolean' && typeof selfDeaf !== 'boolean')
        return void res.status(400).json({ error: 'selfMute veya selfDeaf gerekli.' });

      const channel = await Channels.findById(channelId);
      if (!channel) return void res.status(404).json({ error: 'Kanal bulunamadı.' });

      const membership = await Members.findOne(userId, channel.serverId);
      if (!membership) return void res.status(403).json({ error: 'Yetkisiz.' });

      // Voice state güncellemesini socket üzerinden sunucu odasına yay
      const io = getIo();
      if (io) {
        io.to(`server:${channel.serverId}`).emit('voice:state-update', {
          channelId,
          userId,
          selfMute:  !!selfMute,
          selfDeaf:  !!selfDeaf,
        });
      }

      return void res.json({ ok: true });
    } catch (err) {
      return void res.status(500).json({ error: 'Sunucu hatası.' });
    }
  },
);

/**
 * @openapi
 * /api/channels/{channelId}/voice-members:
 *   get:
 *     tags: [Voice]
 *     summary: Ses kanalı aktif üye listesi
 *     description: Ses kanalında aktif olarak bağlı kullanıcıların listesini döndürür.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Aktif ses üyeleri
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   userId:    { type: string }
 *                   socketId:  { type: string }
 *                   selfMute:  { type: boolean }
 *                   selfDeaf:  { type: boolean }
 *                   speaking:  { type: boolean }
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get(
  '/:channelId/voice-members',
  authMiddleware,
  async (req, res) => {
    try {
      const channelId = String(req.params.channelId ?? '');
      const { id: userId } = castAuthed(req).user;

      const channel = await Channels.findById(channelId);
      if (!channel) return void res.status(404).json({ error: 'Kanal bulunamadı.' });

      const membership = await Members.findOne(userId, channel.serverId);
      if (!membership) return void res.status(403).json({ error: 'Yetkisiz.' });

      const peers = voiceRooms.get(channelId) ?? [];

      return void res.json(peers);
    } catch (err) {
      return void res.status(500).json({ error: 'Sunucu hatası.' });
    }
  },
);

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
