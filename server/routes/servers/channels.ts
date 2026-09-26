/**
 * @openapi
 * /servers/{sid}/channels:
 *   get:
 *     tags: [Channels]
 *     summary: List server channels
 *     parameters: [{ in: path, name: sid, required: true, schema: { type: string } }]
 *     responses: { '200': { description: Channel list } }
 *   post:
 *     tags: [Channels]
 *     summary: Create server channel
 *     parameters: [{ in: path, name: sid, required: true, schema: { type: string } }]
 *     responses: { '201': { description: Channel created } }
 * /servers/{sid}/channels/{cid}:
 *   get:
 *     tags: [Channels]
 *     summary: Get server channel
 *     parameters: [{ in: path, name: sid, required: true, schema: { type: string } }, { in: path, name: cid, required: true, schema: { type: string } }]
 *     responses: { '200': { description: Channel } }
 *   patch:
 *     tags: [Channels]
 *     summary: Update server channel
 *     parameters: [{ in: path, name: sid, required: true, schema: { type: string } }, { in: path, name: cid, required: true, schema: { type: string } }]
 *     responses: { '200': { description: Channel updated } }
 *   delete:
 *     tags: [Channels]
 *     summary: Delete server channel
 *     parameters: [{ in: path, name: sid, required: true, schema: { type: string } }, { in: path, name: cid, required: true, schema: { type: string } }]
 *     responses: { '200': { description: Channel deleted } }
 */
/**
 * Canonical server-channel CRUD owner.
 * Mounted by routes/servers/index.ts at /api[/v1]/servers/:sid/channels.
 *
 * This module is the single production owner for channel CRUD. Keep
 * all channel CRUD business rules in this file so production and tests cannot
 * drift onto two different implementations.
 */
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
import { normalizeChannelName } from '../../lib/channelName';
import { Channels, Members } from '../../db/repositories';
import { authMiddleware } from '../../middleware/auth';
import { getMemberPerms, hasPermission, PERMS } from '../roles';
import { resolvePermissions, viewableChannelIds } from '../../lib/permissions';
import { limits } from '../../middleware/rateLimit';
import { cache } from '../../lib/redisAdapter';
import { envSafeInt } from '../../lib/envNumbers';
import type { ChannelType } from '../../db/repositories/types/entities';

const router = express.Router({ mergeParams: true });
const VALID_CHANNEL_TYPES = new Set<ChannelType>(['text', 'voice', 'announcement', 'forum', 'stage']);
export const SLOWMODE_ALLOWED = Object.freeze([0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600]);
const CHANNEL_LIST_TTL_S = 30;

function channelListKey(serverId: string): string { return `channels:list:${serverId}`; }

function isChannelType(value: string): value is ChannelType {
  return VALID_CHANNEL_TYPES.has(value as ChannelType);
}

export async function invalidateChannelList(serverId: string): Promise<void> {
  try { await cache.del(channelListKey(serverId)); } catch { /* cache is optional */ }
}

function serverChannelCap(): number {
  return envSafeInt('MAX_CHANNELS_PER_SERVER', 500, { min: 1, max: 2_000 });
}

function normalizeForumTags(value: unknown): Array<{ id: string; name: string; color: string }> | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 20).map((raw, index) => {
    const tag = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const name = typeof tag.name === 'string' ? tag.name.trim().slice(0, 20) : '';
    const suppliedId = typeof tag.id === 'string' ? tag.id.trim() : '';
    const id = (suppliedId || `tag-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 40);
    const color = typeof tag.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(tag.color) ? tag.color : '#2d9cdb';
    return { id, name, color };
  }).filter((tag) => tag.name.length > 0);
}

function readForumTags(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/**
 * Kanal satırını istemci sözleşmesine çevirir: `forumTags` her zaman DİZİDİR.
 *
 * Depoda bu sütun JSON metni olarak tutulur; ham hâliyle döndürülürse istemci
 * bir dizgeyi diziymiş gibi işlemeye çalışır. Dönüş tipi bilinçli olarak
 * `Record<string, unknown>`tir — satırın geri kalanı ŞEFFAF taşınır ve burada
 * ikinci bir kanal şeması TANIMLANMAZ.
 */
type ChannelRow = Record<string, unknown>;

function presentChannel<T extends ChannelRow | null | undefined>(
  channel: T,
): T extends null | undefined ? T : ChannelRow {
  if (!channel) return channel as never;
  return { ...channel, forumTags: readForumTags(channel.forumTags) } as never;
}

// GET /api/servers/:sid/channels
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = castAuthed(req).user.id;
    const sid = String(req.params.sid ?? '');
    const membership = await Members.findOne(userId, sid);
    if (!membership) return void res.status(403).json({ error: 'Not a member' });

    const key = channelListKey(sid);
    let channels: Awaited<ReturnType<typeof Channels.findByServer>> | null = null;
    let cacheHit = false;
    try {
      const cached = await cache.get(key);
      if (Array.isArray(cached)) { channels = cached as Awaited<ReturnType<typeof Channels.findByServer>>; cacheHit = true; }
    } catch { /* cache read failure falls back to canonical DB */ }
    if (!channels) {
      channels = await Channels.findByServer(sid);
      try { await cache.set(key, channels, CHANNEL_LIST_TTL_S); } catch { /* cache write is best effort */ }
    }

    const visible = await viewableChannelIds(userId, sid, channels.map((ch) => String(ch._id)));
    res.setHeader('X-Cache', cacheHit ? 'HIT' : 'MISS');
    return void res.json(channels.filter((ch) => visible.has(String(ch._id))).map((ch) => presentChannel(ch as unknown as ChannelRow)));
  } catch {
    return void res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/servers/:sid/channels
router.post('/', authMiddleware, limits.channels(), async (req, res) => {
  try {
    const userId = castAuthed(req).user.id;
    const sid = String(req.params.sid ?? '');
    const perms = await getMemberPerms(userId, sid);
    if (!hasPermission(perms, PERMS.MANAGE_CHANNELS)) return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.name !== 'string' || !body.name.trim()) return void res.status(400).json({ error: 'Channel name required' });
    if (typeof body.type !== 'string' || !isChannelType(body.type)) return void res.status(400).json({ error: 'Invalid channel type' });
    if (body.topic !== undefined && typeof body.topic !== 'string') return void res.status(400).json({ error: 'Invalid topic' });
    if (body.category !== undefined && typeof body.category !== 'string') return void res.status(400).json({ error: 'Invalid category' });
    if (body.nsfw !== undefined && typeof body.nsfw !== 'boolean' && body.nsfw !== 0 && body.nsfw !== 1) return void res.status(400).json({ error: 'Invalid nsfw value' });
    if (body.bitrate !== undefined && (typeof body.bitrate !== 'number' || !Number.isSafeInteger(body.bitrate))) return void res.status(400).json({ error: 'Invalid bitrate' });
    if (body.slowmode !== undefined && (typeof body.slowmode !== 'number' || !Number.isSafeInteger(body.slowmode) || !SLOWMODE_ALLOWED.includes(body.slowmode))) return void res.status(400).json({ error: 'Invalid slowmode' });
    if (body.forumTags !== undefined && !Array.isArray(body.forumTags)) return void res.status(400).json({ error: 'Invalid forumTags' });

    const cap = serverChannelCap();
    const created = await Channels.createUnderCapAtomic({
      id: uuidv4(),
      serverId: sid,
      name: normalizeChannelName(body.name).slice(0, 32),
      type: body.type,
      topic: typeof body.topic === 'string' ? body.topic.trim().slice(0, 1024) : '',
      category: typeof body.category === 'string' && body.category.trim() ? body.category.trim().toUpperCase().slice(0, 32) : 'GENERAL',
      nsfw: body.nsfw ? 1 : 0,
      bitrate: body.type === 'voice' && typeof body.bitrate === 'number' ? Math.min(384000, Math.max(8000, body.bitrate)) : 64000,
      slowmode: typeof body.slowmode === 'number' ? body.slowmode : 0,
      forumTags: normalizeForumTags(body.forumTags) ?? [],
      createdAt: Date.now(),
      cap,
    });
    if (created.status === 'server_not_found') return void res.status(404).json({ error: 'Server not found' });
    if (created.status === 'limit') return void res.status(400).json({ error: `Channel limit reached (max ${cap} per server)` });
    await invalidateChannelList(sid);
    // Channel metadata is intentionally NOT broadcast to the whole server
    // room. Private-channel visibility is requester/channel scoped; clients
    // reload the authorized list after their own successful mutation.
    return void res.status(201).json(presentChannel(created.channel as unknown as ChannelRow));
  } catch {
    return void res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/servers/:sid/channels/:cid
router.patch('/:cid', authMiddleware, limits.channels(), async (req, res) => {
  try {
    const userId = castAuthed(req).user.id;
    const sid = String(req.params.sid ?? '');
    const cid = String(req.params.cid ?? '');
    const channel = await Channels.findByIdAndServer(cid, sid);
    if (!channel) return void res.status(404).json({ error: 'Channel not found' });
    const perms = await resolvePermissions(userId, sid, cid).catch(() => 0);
    if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.MANAGE_CHANNELS)) return void res.status(403).json({ error: 'Missing channel permission' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) return void res.status(400).json({ error: 'Invalid channel name' });
      updates.name = normalizeChannelName(body.name).slice(0, 32);
    }
    if (body.topic !== undefined) {
      if (typeof body.topic !== 'string') return void res.status(400).json({ error: 'Invalid topic' });
      updates.topic = body.topic.trim().slice(0, 1024);
    }
    if (body.category !== undefined) {
      if (typeof body.category !== 'string' || !body.category.trim()) return void res.status(400).json({ error: 'Invalid category' });
      updates.category = body.category.trim().toUpperCase().slice(0, 32);
    }
    if (body.order !== undefined) {
      if (typeof body.order !== 'number' || !Number.isSafeInteger(body.order) || body.order < 0) return void res.status(400).json({ error: 'Invalid order' });
      updates.order = body.order;
    }
    if (body.position !== undefined) {
      if (typeof body.position !== 'number' || !Number.isSafeInteger(body.position) || body.position < 0) return void res.status(400).json({ error: 'Invalid position' });
      updates.position = body.position;
    }
    if (body.slowmode !== undefined) {
      if (typeof body.slowmode !== 'number' || !Number.isSafeInteger(body.slowmode) || !SLOWMODE_ALLOWED.includes(body.slowmode)) return void res.status(400).json({ error: 'Invalid slowmode' });
      updates.slowmode = body.slowmode;
    }
    if (body.forumTags !== undefined) {
      const tags = normalizeForumTags(body.forumTags);
      if (!tags) return void res.status(400).json({ error: 'Invalid forumTags' });
      updates.forumTags = tags;
    }
    if (body.nsfw !== undefined) {
      if (typeof body.nsfw !== 'boolean' && body.nsfw !== 0 && body.nsfw !== 1) return void res.status(400).json({ error: 'Invalid nsfw value' });
      updates.nsfw = body.nsfw ? 1 : 0;
    }
    if (body.bitrate !== undefined) {
      if (typeof body.bitrate !== 'number' || !Number.isSafeInteger(body.bitrate)) return void res.status(400).json({ error: 'Invalid bitrate' });
      updates.bitrate = Math.min(384000, Math.max(8000, body.bitrate));
    }
    if (!Object.keys(updates).length) return void res.status(400).json({ error: 'Nothing to update' });

    await Channels.updateByIdAndServer(cid, sid, updates);
    const updated = await Channels.findByIdAndServer(cid, sid);
    await invalidateChannelList(sid);
    return void res.json(presentChannel(updated as unknown as ChannelRow));
  } catch {
    return void res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/servers/:sid/channels/:cid
router.get('/:cid', authMiddleware, async (req, res) => {
  try {
    const userId = castAuthed(req).user.id;
    const sid = String(req.params.sid ?? '');
    const cid = String(req.params.cid ?? '');
    const channel = await Channels.findByIdAndServer(cid, sid);
    if (!channel) return void res.status(404).json({ error: 'Channel not found' });
    const perms = await resolvePermissions(userId, sid, cid).catch(() => 0);
    if (!hasPermission(perms, PERMS.VIEW_CHANNELS)) return void res.status(404).json({ error: 'Channel not found' });
    return void res.json(presentChannel(channel as unknown as ChannelRow));
  } catch {
    return void res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/servers/:sid/channels/:cid
router.delete('/:cid', authMiddleware, limits.channels(), async (req, res) => {
  try {
    const userId = castAuthed(req).user.id;
    const sid = String(req.params.sid ?? '');
    const cid = String(req.params.cid ?? '');
    const channel = await Channels.findByIdAndServer(cid, sid);
    if (!channel) return void res.status(404).json({ error: 'Channel not found' });
    const perms = await resolvePermissions(userId, sid, cid).catch(() => 0);
    if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.MANAGE_CHANNELS)) return void res.status(403).json({ error: 'Missing channel permission' });

    const result = await Channels.deleteGraphAtomic(cid, sid);
    if (result === 'not_found') return void res.status(404).json({ error: 'Channel not found' });
    if (result === 'last_channel') return void res.status(400).json({ error: 'Cannot delete the last channel' });
    await invalidateChannelList(sid);
    return void res.json({ deleted: true });
  } catch {
    return void res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
module.exports = router;
module.exports.default = router;
// Assigning module.exports above replaces TypeScript's generated named-export
// object. Preserve the public cache/invariant helpers for CommonJS consumers
// and tests instead of silently returning undefined at runtime.
module.exports.invalidateChannelList = invalidateChannelList;
module.exports.SLOWMODE_ALLOWED = SLOWMODE_ALLOWED;
