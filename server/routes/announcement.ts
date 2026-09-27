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
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router();
import { Announcements }             from '../db/repositories/AnnouncementRepository.js';
import { Channels, Members, Messages } from '../db/repositories';
import { authMiddleware}  from '../middleware/auth';
import { limits }                      from '../middleware/rateLimit';
import type { Server as IOServer }     from 'socket.io';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';

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
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? req.body as Record<string, unknown>
    : {};
  const targetChannelId = typeof body.targetChannelId === 'string' && body.targetChannelId.length > 0
    ? body.targetChannelId
    : '';
  if (!targetChannelId) return res.status(400).json({ error: 'targetChannelId required' });

  // Kaynak kanal announcement mı?
  const source = await assertAnnouncementChannel(cid);
  if (!source) return res.status(400).json({ error: 'Source channel is not an announcement channel', code: 'NOT_ANNOUNCEMENT' });

  // Hedef kanal var ve kullanıcı o sunucunun üyesi mi?
  const target = await Channels.findById(targetChannelId) as { _id: string; name: string; serverId: string; type: string } | null;
  if (!target) return res.status(404).json({ error: 'Target channel not found' });
  if (!['text', 'announcement', 'forum'].includes(String(target.type ?? ''))) {
    return res.status(400).json({ error: 'Target channel does not support announcement messages' });
  }

  const membership = await Members.findOne(me.id, target.serverId);
  if (!membership) return res.status(403).json({ error: 'You are not a member of the target server' });
  const [sourcePerms, targetPerms] = await Promise.all([
    resolvePermissions(me.id, source.serverId, source._id).catch(() => 0),
    resolvePermissions(me.id, target.serverId, target._id).catch(() => 0),
  ]);
  if (!hasPermission(sourcePerms, PERMS.VIEW_CHANNELS))
    return res.status(403).json({ error: 'Source channel is not visible' });
  if (!hasPermission(targetPerms, PERMS.VIEW_CHANNELS) ||
      (!hasPermission(targetPerms, PERMS.MANAGE_WEBHOOKS) && !hasPermission(targetPerms, PERMS.MANAGE_CHANNELS)))
    return res.status(403).json({ error: 'No permission to configure announcement follows in target channel' });

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
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? req.body as Record<string, unknown>
    : {};
  const targetChannelId = typeof body.targetChannelId === 'string' && body.targetChannelId.length > 0
    ? body.targetChannelId
    : '';
  if (!targetChannelId) return res.status(400).json({ error: 'targetChannelId required' });

  const target = await Channels.findById(targetChannelId) as { serverId: string } | null;
  if (!target) return res.status(404).json({ error: 'Target channel not found' });

  const membership = await Members.findOne(me.id, target.serverId);
  if (!membership) return res.status(403).json({ error: 'Forbidden' });
  const targetPerms = await resolvePermissions(me.id, target.serverId, targetChannelId).catch(() => 0);
  if (!hasPermission(targetPerms, PERMS.VIEW_CHANNELS) ||
      (!hasPermission(targetPerms, PERMS.MANAGE_WEBHOOKS) && !hasPermission(targetPerms, PERMS.MANAGE_CHANNELS)))
    return res.status(403).json({ error: 'No permission to remove announcement follows in target channel' });

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
  const perms = await resolvePermissions(me.id, ch.serverId, cid).catch(() => 0);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS)) return res.status(403).json({ error: 'Forbidden' });

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
    _id: string; channelId?: string; serverId?: string; content: string; displayName: string; userId: string;
    username?: string; avatarColor?: string; avatarUrl?: string | null;
    fileUrl?: string; fileName?: string; fileType?: string; createdAt: number;
  } | null;
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (String(msg.channelId ?? '') !== source._id || String(msg.serverId ?? source.serverId) !== source.serverId)
    return res.status(400).json({ error: 'Message does not belong to announcement channel' });

  // Üye mi ve mesaj yazarı mı / moderatör mü?
  const membership = await Members.findOne(me.id, source.serverId) as { roles?: string[] } | null;
  if (!membership) return res.status(403).json({ error: 'Forbidden' });
  const sourcePerms = await resolvePermissions(me.id, source.serverId, source._id).catch(() => 0);
  if (!hasPermission(sourcePerms, PERMS.VIEW_CHANNELS)) return res.status(403).json({ error: 'Forbidden' });
  const canPublishOwn = String(msg.userId) === me.id && hasPermission(sourcePerms, PERMS.SEND_MESSAGES);
  if (!canPublishOwn && !hasPermission(sourcePerms, PERMS.MANAGE_MESSAGES))
    return res.status(403).json({ error: 'No permission to publish this message' });

  // Takipçi kanalları bul
  const followRows = await Announcements.getFollowers(cid);

  if (!followRows.length) {
    return res.json({ ok: true, crosspostedTo: 0, message: 'No followers' });
  }

  // Her takipçi kanala GERÇEK, kalıcı ve idempotent crosspost oluştur.
  // Follow satırı geçmişte doğru olsa bile hedef kanal silinmiş/taşınmış veya
  // bozuk bir DB satırı başka tenant'a işaret ediyor olabilir; execution-time
  // channel→server bağını tekrar kanıtlamadan persistence/realtime yapılmaz.
  const createdAt = Date.now();
  const bridgedFrom = {
    channelId: source._id,
    channelName: source.name,
    serverId: source.serverId,
    messageId: mid,
  };

  let crosspostedCount = 0;
  const errors: string[] = [];

  for (const { targetChannelId, targetServerId } of followRows) {
    try {
      const target = await Channels.findByIdAndServer(targetChannelId, targetServerId) as
        { _id: string; serverId: string; type?: string } | null;
      if (!target) throw new Error('Stale or cross-tenant follower channel');
      if (target.type && !['text', 'announcement', 'forum'].includes(target.type))
        throw new Error('Follower channel does not support messages');

      const persisted = await Announcements.persistCrosspost({
        bridgeMessageId: uuidv4(),
        sourceMessageId: mid,
        sourceChannelId: source._id,
        sourceServerId: source.serverId,
        targetChannelId: target._id,
        targetServerId: target.serverId,
        userId: msg.userId,
        username: msg.username ?? msg.displayName,
        displayName: `📢 ${msg.displayName}`,
        avatarColor: msg.avatarColor ?? '#f47fff',
        avatarUrl: msg.avatarUrl ?? null,
        content: msg.content,
        fileUrl: msg.fileUrl ?? null,
        fileName: msg.fileName ?? null,
        fileType: msg.fileType ?? null,
        createdAt,
      });

      // Emit yalnız transaction gerçekten yeni/healed bir message persist ettiyse.
      // Idempotent tekrar publish mevcut mesajı ikinci kez realtime'a basmaz.
      if (_io && persisted.created) {
        _io.to(`channel:${target._id}`).emit('new_message', {
          _id: persisted.bridgeMessageId,
          channelId: target._id,
          serverId: target.serverId,
          userId: msg.userId,
          username: msg.username ?? msg.displayName,
          displayName: `📢 ${msg.displayName}`,
          content: msg.content,
          type: 'crosspost',
          bridgedFrom,
          fileUrl: msg.fileUrl ?? null,
          fileName: msg.fileName ?? null,
          fileType: msg.fileType ?? null,
          avatarColor: msg.avatarColor ?? '#f47fff',
          avatarUrl: msg.avatarUrl ?? null,
          createdAt,
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
