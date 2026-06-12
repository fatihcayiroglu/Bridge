// ⚠️  DEPRECATED — Sprint 121 FIX 21: Bu dosya artık kullanılmıyor.
// Aktif router: server/routes/channels/index.ts (setupRoutes.ts tarafından import edilir)
// Bu dosyayı düzenlemeyin — değişiklikler channels/crud.ts'e yapılmalı.
// Sürümde silinecek. Şimdilik referans olarak tutuluyor.
//
// server/routes/channels.ts — Channel management (create/rename/delete)
// NOTE: These routes duplicate the ones now in servers.ts.
// They are kept for backward compatibility; servers.ts takes precedence
// when both are mounted (servers.ts mounted last wins on conflicts).
import express, { Request, Response, Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthedRequest, authMiddleware} from '../middleware/auth';

import { Channels, Messages } from '../db/repositories';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
    findById(id: string): Promise<ChannelRow | null>;
    findByIdAndServer(cid: string, sid: string): Promise<ChannelRow | null>;
    insert(doc: object): Promise<ChannelRow>;
    updateByIdAndServer(cid: string, sid: string, updates: object): Promise<void>;
    delete(id: string): Promise<void>;
  };
  Messages: { deleteByChannel(cid: string): Promise<void> };
};
import { getMemberPerms, hasPermission, PERMS } from './roles';
  hasPermission(perms: number, perm: number): boolean;
  PERMS: Record<string, number>;
};
import { limits } from '../middleware/rateLimit';
};

interface ChannelRow {
  _id: string;
  serverId: string;
  name: string;
  type: string;
  topic?: string;
  category?: string;
  order?: number;
  slowmode?: number;
  forumTags?: string;
  createdAt: number;
}

const SLOWMODE_ALLOWED = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];

const router: Router = express.Router();

// POST /api/servers/:sid/channels
/**
 * @openapi
 * /servers/{serverId}/channels:
 *   post:
 *     tags: [Channels]
 *     summary: Kanal oluştur
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, type]
 *             properties:
 *               name:     { type: string, minLength: 1, maxLength: 100 }
 *               type:     { type: string, enum: [text, voice, announcement, stage, forum] }
 *               topic:    { type: string, maxLength: 1024 }
 *               position: { type: integer }
 *     responses:
 *       201:
 *         description: Kanal oluşturuldu
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Channel' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /servers/{serverId}/channels/{channelId}:
 *   get:
 *     tags: [Channels]
 *     summary: Kanal detayı
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *       - { name: channelId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Kanal
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Channel' }
 *   patch:
 *     tags: [Channels]
 *     summary: Kanal güncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *       - { name: channelId, in: path, required: true, schema: { type: string } }
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
 *       200: { description: Güncellendi }
 *   delete:
 *     tags: [Channels]
 *     summary: Kanal sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *       - { name: channelId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       204: { description: Silindi }
 *       403: { $ref: '#/components/responses/Forbidden' }

 *
 * /channels/{sid}/channels:
 *   post:
 *     tags: [Channels]
 *     summary: Yeni kanal olustur
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
 * /channels/{sid}/channels/{cid}:
 *   get:
 *     tags: [Channels]
 *     summary: Kanal detayini getir
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
 *         description: Kanal
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Channel' }
 *       404: { $ref: '#/components/responses/NotFound' }
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
router.post('/:sid/channels', authMiddleware, limits.channels(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { name, type, topic, category } = req.body as { name?: string; type?: string; topic?: string; category?: string };
  if (!name?.trim()) return void res.status(400).json({ error: 'Channel name required' });
  if (!['text', 'voice'].includes(type ?? '')) return void res.status(400).json({ error: 'Invalid channel type' });

  const existing = await Channels.findByServer(String(req.params.sid ?? ''));
  const channel  = await Channels.insert({
    _id:       uuidv4(),
    serverId:  String(req.params.sid ?? ''),
    name:      name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-').slice(0, 32),
    type:      type === 'voice' ? 'voice' : 'text',
    topic:     topic?.trim().slice(0, 100) || '',
    category:  category?.trim().toUpperCase().slice(0, 32) || 'GENERAL',
    order:     existing.length,
    createdAt: Date.now(),
  });
  res.json(channel);
});

// PATCH /api/servers/:sid/channels/:cid
router.patch('/:sid/channels/:cid', authMiddleware, limits.channels(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { name, topic, category, order, slowmode, forumTags } = req.body as {
    name?: string; topic?: string; category?: string; order?: number; slowmode?: number;
    forumTags?: { id?: string; name?: string; color?: string }[];
  };
  const updates: Record<string, unknown> = {};

  if (name?.trim())              updates['name']     = name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-').slice(0, 32);
  if (typeof topic === 'string') updates['topic']    = topic.trim().slice(0, 100);
  if (category?.trim())          updates['category'] = category.trim().toUpperCase().slice(0, 32);
  if (typeof order === 'number') updates['order']    = order;
  if (typeof slowmode === 'number') {
    updates['slowmode'] = SLOWMODE_ALLOWED.includes(slowmode) ? slowmode : 0;
  }
  if (Array.isArray(forumTags)) {
    updates['forumTags'] = JSON.stringify(
      forumTags.slice(0, 20).map(t => ({
        id:    String(t.id   || `tag-${Date.now()}-${Math.random()}`).slice(0, 40),
        name:  String(t.name || '').trim().slice(0, 20),
        color: /^#[0-9a-fA-F]{6}$/.test(t.color ?? '') ? t.color : '#2d9cdb',
      })).filter(t => t.name)
    );
  }
  if (Object.keys(updates).length === 0) return void res.status(400).json({ error: 'Nothing to update' });

  await Channels.updateByIdAndServer(String(req.params.cid ?? ''), String(req.params.sid ?? ''), updates);
  const raw = await Channels.findById(String(req.params.cid ?? ''));
  const updated = raw ? {
    ...raw,
    forumTags: (() => { try { return JSON.parse(raw.forumTags || '[]'); } catch { return []; } })(),
  } : raw;
  res.json(updated);
});

// GET /api/servers/:sid/channels/:cid
router.get('/:sid/channels/:cid', authMiddleware, async (req: Request, res: Response) => {
  const ch = await Channels.findByIdAndServer(String(req.params.cid ?? ''), String(req.params.sid ?? ''));
  if (!ch) return void res.status(404).json({ error: 'Channel not found' });
  res.json({
    ...ch,
    forumTags: (() => { try { return JSON.parse(ch.forumTags || '[]'); } catch { return []; } })(),
  });
});

// DELETE /api/servers/:sid/channels/:cid
router.delete('/:sid/channels/:cid', authMiddleware, limits.channels(), async (req: Request, res: Response) => {
  const _u = castAuthed(req as AuthedRequest);
  const perms = await getMemberPerms(_u.user.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const channels = await Channels.findByServer(String(req.params.sid ?? ''));
  if (channels.length <= 1)
    return void res.status(400).json({ error: 'Cannot delete the last channel' });

  await Channels.delete(String(req.params.cid ?? ''));
  await Messages.deleteByChannel(String(req.params.cid ?? ''));
  res.json({ deleted: true });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
