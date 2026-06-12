// server/routes/admin/sfu.ts
// SFU Cluster istatistikleri — admin only
/**
 * @openapi
 * /admin/sfu/stats:
 *   get:
 *     tags: [Admin]
 *     summary: SFU (mediasoup) cluster istatistikleri
 *     description: Mediasoup yüklü değilse available:false ile 200 döner.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: SFU durumu
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 available:  { type: boolean }
 *                 totalPeers: { type: integer }
 *                 uptime:     { type: number }
 *                 localRoomDetails:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       channelId: { type: string }
 *                       peerCount: { type: integer }
 *                       peers:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             userId:      { type: string }
 *                             displayName: { type: string }
 *                             hasVideo:    { type: boolean }
 *                             hasAudio:    { type: boolean }
 *                       createdAt: { type: integer }
 *                 error: { type: string }
 *       403: { $ref: '#/components/responses/Forbidden' }

 *
 * /admin/sfu/rooms:
 *   get:
 *     tags: [Admin]
 *     summary: Aktif SFU odalarini listele
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Aktif oda listesi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /admin/sfu/rooms/{roomId}:
 *   delete:
 *     tags: [Admin]
 *     summary: SFU odasini kapat
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Oda kapatildi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /admin/sfu/workers:
 *   get:
 *     tags: [Admin]
 *     summary: Mediasoup worker durumlarini getir
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Worker listesi
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

import express, { Request, Response, Router } from 'express';
import { authMiddleware } from '../../middleware/auth';
import * as sfuRegistry from '../../lib/sfuRegistry';
import { adminOnly } from './core';

export const router: Router = express.Router();

router.get('/sfu/stats', authMiddleware, adminOnly, async (_req: Request, res: Response) => {
  let sfuStats: Record<string, unknown> = { available: false };
  try {
    const stats = await sfuRegistry.getStats();

    let localRoomDetails: object[] = [];
    type SfuMod = {
        sfuRooms: Map<string, { peers: Map<string, { userId: string; displayName: string; producers?: Map<string, { kind: string }> }>; router?: { rtpCapabilities?: { codecs?: { mimeType: string }[] } }; createdAt: number }>;
        sfuPeers: unknown;
        isSFUReady(): boolean;
      };
    try {
      const { sfuRooms, sfuPeers: _sfuPeers, isSFUReady } = await import('../../socket/handlers/mediasoup') as unknown as SfuMod;
      if (isSFUReady()) {
        localRoomDetails = [...sfuRooms.entries()].map(([channelId, room]) => ({
          channelId,
          peerCount: room.peers.size,
          peers: [...room.peers.values()].map(p => ({
            userId:      p.userId,
            displayName: p.displayName,
            hasVideo:    p.producers ? [...p.producers.values()].some(pr => pr.kind === 'video') : false,
            hasAudio:    p.producers ? [...p.producers.values()].some(pr => pr.kind === 'audio') : false,
          })),
          routerRtpCapabilities: room.router?.rtpCapabilities?.codecs?.map(c => c.mimeType) ?? [],
          createdAt: room.createdAt,
        }));
      }
    } catch { /* mediasoup yüklü değil */ }

    sfuStats = {
      available: true,
      ...stats as object,
      localRoomDetails,
      totalPeers: localRoomDetails.reduce((sum, r) => sum + (r as { peerCount: number }).peerCount, 0),
      uptime: process.uptime(),
    };
  } catch (_e) {
    const e = _e as Error;
    sfuStats = { available: false, error: e.message };
  }

  res.json(sfuStats);
});

export default router;
