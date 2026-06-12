/**
 * @openapi
 * tags:
 *   - name: Servers
 *     description: Servers API endpoints

 *
 * /servers/{sid}/channels:
 *   get:
 *     tags: [Channels]
 *     summary: Sunucunun kanal listesini getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Kanal listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Channel' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [Channels]
 *     summary: Sunucuya yeni kanal ekle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:       { type: string, maxLength: 100 }
 *               type:       { type: string, enum: [text, voice, announcement, stage, forum] }
 *               categoryId: { type: string }
 *     responses:
 *       201:
 *         description: Kanal olusturuldu
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Channel' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/channels/{cid}:
 *   patch:
 *     tags: [Channels]
 *     summary: Kanali guncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:     { type: string }
 *               topic:    { type: string }
 *               position: { type: integer }
 *     responses:
 *       200:
 *         description: Guncellendi
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Channel' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Channels]
 *     summary: Kanali sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Silindi
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// server/routes/servers/channels.ts — Channel CRUD routes
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router = express.Router({ mergeParams: true });

import { Channels, Members, Messages } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import { getMemberPerms, hasPermission, PERMS } from '../roles';
import { limits } from '../../middleware/rateLimit';
import { cache } from '../../lib/redisAdapter';

const VALID_CHANNEL_TYPES = ['text', 'voice', 'announcement', 'forum', 'stage'] as const;

// Channel list cache TTL — kanallar nadiren değişir; 30s agresif olmayan TTL.
// Kanal eklendiğinde/silindiğinde/güncellendiğinde cache invalidate edilir.
const CHANNEL_LIST_TTL_S = 30;

/** Cache key helper */
function channelListKey(serverId: string): string {
  return `channels:list:${serverId}`;
}

/** Channel list cache'i geçersiz kıl — yazma işlemlerinde çağrılmalı */
export async function invalidateChannelList(serverId: string): Promise<void> {
  try {
    await cache.del(channelListKey(serverId));
  } catch { /* cache hatası → sessizce geç */ }
}

// GET /api/servers/:sid/channels
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const sid = String(String(req.params.sid ?? '') ?? "");

  const membership = await Members.findOne(_u.id, sid);
  if (!membership) return res.status(403).json({ error: 'Not a member' });

  // Cache hit yolu
  const cacheKey = channelListKey(sid);
  try {
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }
  } catch { /* cache erişim hatası → DB'ye fall through */ }

  const channels = await Channels.findByServer(sid);

  // Cache'e yaz (hata durumunda yanıtı engelleme)
  try {
    await cache.set(cacheKey, channels, CHANNEL_LIST_TTL_S);
  } catch { /* cache yazma hatası → devam et */ }

  res.setHeader('X-Cache', 'MISS');
  res.json(channels);
});

// POST /api/servers/:sid/channels
router.post('/', authMiddleware, limits.servers(), async (req, res) => {
  const _u  = castAuthed(req).user;
  const sid = String(String(req.params.sid ?? '') ?? "");
  const perms = await getMemberPerms(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { name, type, topic, category, nsfw, bitrate } = req.body as { name?: string; type?: string; topic?: string; category?: string; nsfw?: boolean | number; bitrate?: number | string };
  if (!name?.trim()) return res.status(400).json({ error: 'Channel name required' });
  if (typeof type !== 'string' || !VALID_CHANNEL_TYPES.includes(type as typeof VALID_CHANNEL_TYPES[number])) return res.status(400).json({ error: 'Invalid channel type' });

  const channelData = {
    _id:       uuidv4(),
    serverId:  sid,
    name:      name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-').slice(0, 32),
    type: type as typeof VALID_CHANNEL_TYPES[number],
    topic:     topic?.trim().slice(0, 100) || '',
    category:  category?.trim().slice(0, 32) || 'GENERAL',
    nsfw:      nsfw ? 1 : 0,
    bitrate:   type === 'voice' ? Math.min(384000, Math.max(8000, parseInt(String(bitrate)) || 64000)) : 64000,
    order:     Date.now(),
    createdAt: Date.now(),
  };
  const channel = await Channels.insert(channelData);
  await invalidateChannelList(sid);
  res.json(channel);
});

// PATCH /api/servers/:sid/channels/:cid
router.patch('/:cid', authMiddleware, limits.servers(), async (req, res) => {
  const _u  = castAuthed(req).user;
  const sid = String(String(req.params.sid ?? '') ?? "");
  const perms = await getMemberPerms(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { name, topic, nsfw, bitrate } = req.body as { name?: string; topic?: string; nsfw?: boolean | number; bitrate?: number };
  const updates: Record<string, unknown> = {};
  if (name?.trim()) updates.name = name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-').slice(0, 32);
  if (typeof topic === 'string') updates.topic = topic.trim().slice(0, 100);
  if (typeof nsfw === 'boolean' || nsfw === 0 || nsfw === 1) updates.nsfw = nsfw ? 1 : 0;
  if (typeof bitrate === 'number') updates.bitrate = Math.min(384000, Math.max(8000, bitrate));
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  await Channels.updateByIdAndServer(String(req.params.cid ?? ''), sid, updates);
  const updated = await Channels.findById(String(req.params.cid ?? ''));
  await invalidateChannelList(sid);

  const io = req.app.get('io');
  if (io) io.to(`server:${sid}`).emit('channel:update', updated);
  res.json(updated);
});

// DELETE /api/servers/:sid/channels/:cid
router.delete('/:cid', authMiddleware, limits.servers(), async (req, res) => {
  const _u  = castAuthed(req).user;
  const sid = String(String(req.params.sid ?? '') ?? "");
  const perms = await getMemberPerms(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const channel = await Channels.findByIdAndServer(String(req.params.cid ?? ''), sid);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  await Messages.deleteByChannel(String(req.params.cid ?? ''));
  await Channels.delete(String(req.params.cid ?? ''));
  await invalidateChannelList(sid);
  res.json({ deleted: true });
});

export default router;
