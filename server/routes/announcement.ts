// server/routes/announcement.ts — Sprint 94
// Sprint 98: pool.query() → AnnouncementRepository geçişi ✅
// Sprint 105: OpenAPI annotations eklendi

/**
 * @openapi
 * /channels/{cid}/follow:
 *   post:
 *     tags: [Announcements]
 *     summary: Duyuru kanalını takip et
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: cid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Takip başarılı }
 *       409: { description: Zaten takip ediliyor }
 *   delete:
 *     tags: [Announcements]
 *     summary: Duyuru kanalı takibini bırak
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: cid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Takip bırakıldı }
 * /channels/{cid}/followers:
 *   get:
 *     tags: [Announcements]
 *     summary: Kanalı takip eden sunucular
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: cid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Takipçi listesi }
 * /channels/{cid}/messages/{mid}/crosspost:
 *   post:
 *     tags: [Announcements]
 *     summary: Mesajı takipçi sunuculara yayınla
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: cid, in: path, required: true, schema: { type: string } }
 *       - { name: mid, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Crosspost başarılı }
 */

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router();
import { Announcements }             from '../db/repositories/AnnouncementRepository.js';
import { Channels, Members, Messages } from '../db/repositories';
import { authMiddleware}  from '../middleware/auth';
import { limits }                      from '../middleware/rateLimit';
import type { Server as IOServer }     from 'socket.io';

let _io: IOServer | null = null;
export function setIo(io: IOServer): void { _io = io; }

// ── Yardımcı: kanal announcement mı? ────────────────────────────────────────
async function assertAnnouncementChannel(channelId: string): Promise<{ _id: string; name: string; serverId: string } | null> {
  const ch = await Channels.findById(channelId) as { _id: string; name: string; type: string; serverId: string } | null;
  if (!ch || ch.type !== 'announcement') return null;
  return ch;
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/channels/:cid/follow
// Bu kanalı kendi sunucundaki bir kanala takip et
// body: { targetChannelId: string }
// ────────────────────────────────────────────────────────────────────────────
router.post('/:cid/follow', authMiddleware, limits.api(), async (req, res) => {
  const me  = castAuthed(req).user as { id: string };
  const cid = String(req.params.cid ?? '');
  const { targetChannelId } = req.body as { targetChannelId?: string };
  if (!targetChannelId) return res.status(400).json({ error: 'targetChannelId required' });

  // Kaynak kanal announcement mı?
  const source = await assertAnnouncementChannel(cid);
  if (!source) return res.status(400).json({ error: 'Source channel is not an announcement channel', code: 'NOT_ANNOUNCEMENT' });

  // Hedef kanal var ve kullanıcı o sunucunun üyesi mi?
  const target = await Channels.findById(targetChannelId) as { _id: string; name: string; serverId: string; type: string } | null;
  if (!target) return res.status(404).json({ error: 'Target channel not found' });

  const membership = await Members.findOne(me.id, target.serverId);
  if (!membership) return res.status(403).json({ error: 'You are not a member of the target server' });

  // Kendiyle aynı kanalı takip edemez
  if (source._id === target._id) return res.status(400).json({ error: 'Cannot follow own channel' });

  try {
    await Announcements.followChannel(source._id, source.serverId, target._id, target.serverId, me.id);
  } catch {
    return res.status(500).json({ error: 'DB error' });
  }

  // Hedef kanala sistem mesajı gönder
  _sendSystemMessage(target._id, target.serverId,
    `📢 **${source.name}** kanalını takip etmeye başladınız. Crosspost mesajlar burada görünecek.`
  );

  res.json({ ok: true, sourceChannelId: source._id, targetChannelId: target._id });
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/channels/:cid/follow
// Takibi bırak
// body: { targetChannelId: string }
// ────────────────────────────────────────────────────────────────────────────
router.delete('/:cid/follow', authMiddleware, async (req, res) => {
  const me  = castAuthed(req).user as { id: string };
  const cid = String(req.params.cid ?? '');
  const { targetChannelId } = req.body as { targetChannelId?: string };
  if (!targetChannelId) return res.status(400).json({ error: 'targetChannelId required' });

  const target = await Channels.findById(targetChannelId) as { serverId: string } | null;
  if (!target) return res.status(404).json({ error: 'Target channel not found' });

  const membership = await Members.findOne(me.id, target.serverId);
  if (!membership) return res.status(403).json({ error: 'Forbidden' });

  await Announcements.unfollowChannel(cid, targetChannelId);
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/channels/:cid/followers
// Bu kanalı takip eden kanalların listesi
// ────────────────────────────────────────────────────────────────────────────
router.get('/:cid/followers', authMiddleware, async (req, res) => {
  const me  = castAuthed(req).user as { id: string };
  const cid = String(req.params.cid ?? '');

  const ch = await Channels.findById(cid) as { serverId: string } | null;
  if (!ch) return res.status(404).json({ error: 'Channel not found' });

  const membership = await Members.findOne(me.id, ch.serverId);
  if (!membership) return res.status(403).json({ error: 'Forbidden' });

  const followers = await Announcements.getFollowers(cid);
  res.json({ followers, count: followers.length });
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/channels/:cid/messages/:mid/crosspost
// Bir mesajı tüm takipçi kanallara yayınla (Publish)
// ────────────────────────────────────────────────────────────────────────────
router.post('/:cid/messages/:mid/crosspost', authMiddleware, limits.api(), async (req, res) => {
  const me  = castAuthed(req).user as { id: string };
  const cid = String(req.params.cid ?? '');
  const mid = String(req.params.mid ?? '');

  // Kaynak kanal announcement mı?
  const source = await assertAnnouncementChannel(cid);
  if (!source) return res.status(400).json({ error: 'Not an announcement channel', code: 'NOT_ANNOUNCEMENT' });

  // Mesaj bu kanala mı ait?
  const msg = await Messages.findById(mid) as {
    _id: string; content: string; displayName: string; userId: string;
    fileUrl?: string; fileName?: string; fileMime?: string; createdAt: number;
  } | null;
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  // Üye mi ve mesaj yazarı mı / moderatör mü?
  const membership = await Members.findOne(me.id, source.serverId) as {
    roles?: string[];
  } | null;
  if (!membership) return res.status(403).json({ error: 'Forbidden' });

  // Takipçi kanalları bul
  const followRows = await Announcements.getFollowers(cid);

  if (!followRows.length) {
    return res.json({ ok: true, crosspostedTo: 0, message: 'No followers' });
  }

  // Her takipçi kanala bridge mesaj oluştur
  const { v4: uuidv4 } = await import('uuid');
  const crosspostPayload = {
    content:     msg.content,
    displayName: `📢 ${msg.displayName}`,
    type:        'crosspost',
    bridgedFrom: {
      channelId:   source._id,
      channelName: source.name,
      serverId:    source.serverId,
      messageId:   mid,
    },
    fileUrl:   msg.fileUrl,
    fileName:  msg.fileName,
    fileMime:  msg.fileMime,
    createdAt: Date.now(),
  };

  let crosspostedCount = 0;
  const errors: string[] = [];

  for (const { targetChannelId, targetServerId } of followRows) {
    try {
      const newId = uuidv4();
      await Announcements.recordCrosspost(mid, source._id, source.serverId, targetChannelId, targetServerId, newId);

      // Socket ile hedef kanala anlık gönder
      if (_io) {
        _io.to(`channel:${targetChannelId}`).emit('new_message', {
          _id:         newId,
          channelId:   targetChannelId,
          serverId:    targetServerId,
          displayName: crosspostPayload.displayName,
          content:     msg.content,
          type:        'crosspost',
          bridgedFrom: crosspostPayload.bridgedFrom,
          avatarColor: '#f47fff',
          createdAt:   crosspostPayload.createdAt,
        });
      }
      crosspostedCount++;
    } catch (err) {
      errors.push(`${targetChannelId}: ${(err as Error).message}`);
    }
  }

  res.json({ ok: true, crosspostedTo: crosspostedCount, errors: errors.length ? errors : undefined });
});

// ── Sistem mesajı yardımcısı ─────────────────────────────────────────────────
function _sendSystemMessage(channelId: string, serverId: string, content: string): void {
  if (!_io) return;
  _io.to(`channel:${channelId}`).emit('new_message', {
    _id:         `sys_${Date.now()}`,
    channelId, serverId,
    displayName: 'Sistem',
    content,
    type:        'system',
    avatarColor: '#888',
    createdAt:   Date.now(),
  });
}

export { router };
