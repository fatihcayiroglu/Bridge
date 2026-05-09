// @ts-nocheck
// server/routes/admin/sfu.js
// SFU Cluster istatistikleri — admin only

'use strict';

const express    = require('express');
const router     = express.Router();
const { authMiddleware } = require('../../middleware/auth');
const asyncHandler       = require('../../middleware/asyncHandler');
const { adminOnly }      = require('./core');

// GET /api/admin/sfu/stats
router.get('/sfu/stats', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  let sfuStats = { available: false };
  try {
    const sfuRegistry = require('../../lib/sfuRegistry');
    const stats = await sfuRegistry.getStats();

    let localRoomDetails = [];
    try {
      const { sfuRooms, sfuPeers, isSFUReady } = require('../../socket/handlers/mediasoup');
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
      ...stats,
      localRoomDetails,
      totalPeers: localRoomDetails.reduce((sum, r) => sum + r.peerCount, 0),
      uptime: process.uptime(),
    };
  } catch (e) {
    sfuStats = { available: false, error: e.message };
  }

  res.json(sfuStats);
}));

module.exports = router;
export {};
