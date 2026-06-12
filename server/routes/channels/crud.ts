// server/routes/channels/crud.ts
// Sprint 108: channels.ts'den ayrıştırıldı.
// Kapsam: POST/PATCH/GET/DELETE /servers/:sid/channels[/:cid]
//
// Düzeltmeler (Sprint 108 post-review):
//   - Tüm handler'larda tutarlı castAuthed() kullanımı (AuthedRequest cast tutarsızlığı giderildi)
//   - GET/DELETE handler'larına try/catch eklendi
//   - void res.json() kalıbı tutarlı hale getirildi
//   - Kullanılmayan AuthedRequest import'u kaldırıldı

import express                                  from 'express';
import type { Request, Response, Router }        from 'express';
import { v4 as uuidv4 }                          from 'uuid';
import { authMiddleware}             from '../../middleware/auth';
import { Channels, Messages }                    from '../../db/repositories';
import { getMemberPerms, hasPermission, PERMS }  from '../roles';
import { limits }                                from '../../middleware/rateLimit';

import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const SLOWMODE_ALLOWED = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];

const router: Router = express.Router();

/**
 * @openapi
 * /api/servers/{sid}/channels:
 *   post:
 *     tags: [Channels]
 *     summary: Kanal oluştur
 *     description: Sunucuda yeni bir metin, ses, duyuru veya forum kanalı oluşturur. MANAGE_CHANNELS yetkisi gerektirir.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *         description: Sunucu ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, type]
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 100
 *                 example: genel
 *               type:
 *                 type: string
 *                 enum: [text, voice, announcement, forum, stage]
 *                 example: text
 *               categoryId:
 *                 type: string
 *                 description: Bağlı kategori ID (opsiyonel)
 *               topic:
 *                 type: string
 *                 maxLength: 1024
 *                 description: Kanal konusu
 *               slowmode:
 *                 type: integer
 *                 description: Saniye cinsinden yavaş mod (0 = devre dışı)
 *                 enum: [0,5,10,15,30,60,120,300,600,900,1800,3600,7200,21600]
 *               nsfw:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       201:
 *         description: Kanal oluşturuldu
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Channel'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
// POST /api/servers/:sid/channels
router.post('/:sid/channels', authMiddleware, limits.channels(), async (req: Request, res: Response) => {
  try {
    const { id: userId } = castAuthed(req).user;
    const perms = await getMemberPerms(userId, String(req.params.sid ?? ''));
    if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
      return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

    const { name, type, topic, category } = req.body as {
      name?: string; type?: string; topic?: string; category?: string;
    };
    if (!name?.trim()) return void res.status(400).json({ error: 'Channel name required' });
    if (!['text', 'voice', 'announcement', 'stage', 'forum'].includes(type ?? ''))
      return void res.status(400).json({ error: 'Invalid channel type' });

    const existing = await Channels.findByServer(String(req.params.sid ?? ''));

    // SECURITY: Sunucu başına kanal üst sınırı — resource exhaustion önleme
    const MAX_CHANNELS_PER_SERVER = parseInt(process.env.MAX_CHANNELS_PER_SERVER || '500', 10);
    if (existing.length >= MAX_CHANNELS_PER_SERVER)
      return void res.status(400).json({ error: `Channel limit reached (max ${MAX_CHANNELS_PER_SERVER} per server)` });

    const channel  = await Channels.insert({
      _id:       uuidv4(),
      serverId:  String(req.params.sid ?? ''),
      name:      name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-').slice(0, 32),
      type:      type === 'voice' ? 'voice' : type ?? 'text',
      topic:     topic?.trim().slice(0, 100) || '',
      category:  category?.trim().toUpperCase().slice(0, 32) || 'GENERAL',
      order:     existing.length,
      createdAt: Date.now(),
    });
    return void res.status(201).json(channel);
  } catch {
    return void res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /api/servers/{sid}/channels/{cid}:
 *   patch:
 *     tags: [Channels]
 *     summary: Kanal güncelle
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
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:     { type: string, maxLength: 100 }
 *               topic:    { type: string, maxLength: 1024 }
 *               slowmode: { type: integer }
 *               nsfw:     { type: boolean }
 *               position: { type: integer }
 *     responses:
 *       200:
 *         description: Kanal güncellendi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Channel'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *   get:
 *     tags: [Channels]
 *     summary: Kanal detayı getir
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
 *         description: Kanal detayı
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Channel'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *   delete:
 *     tags: [Channels]
 *     summary: Kanal sil
 *     description: Kanalı ve içindeki tüm mesajları siler. MANAGE_CHANNELS yetkisi gerektirir.
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
 *         description: Kanal silindi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
// PATCH /api/servers/:sid/channels/:cid
router.patch('/:sid/channels/:cid', authMiddleware, limits.channels(), async (req: Request, res: Response) => {
  try {
    const { id: userId } = castAuthed(req).user;
    const perms = await getMemberPerms(userId, String(req.params.sid ?? ''));
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
    if (Object.keys(updates).length === 0)
      return void res.status(400).json({ error: 'Nothing to update' });

    await Channels.updateByIdAndServer(String(req.params.cid ?? ''), String(req.params.sid ?? ''), updates);
    const raw = await Channels.findById(String(req.params.cid ?? ''));
    const updated = raw ? {
      ...raw,
      forumTags: (() => { try { return JSON.parse(typeof raw.forumTags === 'string' ? raw.forumTags : JSON.stringify(raw.forumTags ?? [])); } catch { return []; } })(),
    } : raw;
    return void res.json(updated);
  } catch {
    return void res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/servers/:sid/channels/:cid — ayrıntı için yukarıdaki @openapi bloğuna bakın
router.get('/:sid/channels/:cid', authMiddleware, async (req: Request, res: Response) => {
  try {
    const ch = await Channels.findByIdAndServer(String(req.params.cid ?? ''), String(req.params.sid ?? ''));
    if (!ch) return void res.status(404).json({ error: 'Channel not found' });
    return void res.json({
      ...ch,
      forumTags: (() => { try { return JSON.parse(typeof ch.forumTags === 'string' ? ch.forumTags : JSON.stringify(ch.forumTags ?? [])); } catch { return []; } })(),
    });
  } catch {
    return void res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/servers/:sid/channels/:cid
router.delete('/:sid/channels/:cid', authMiddleware, limits.channels(), async (req: Request, res: Response) => {
  try {
    const { id: userId } = castAuthed(req).user;
    const perms = await getMemberPerms(userId, String(req.params.sid ?? ''));
    if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
      return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

    const channels = await Channels.findByServer(String(req.params.sid ?? ''));
    if (channels.length <= 1)
      return void res.status(400).json({ error: 'Cannot delete the last channel' });

    await Channels.delete(String(req.params.cid ?? ''));
    await Messages.deleteByChannel(String(req.params.cid ?? ''));
    return void res.json({ deleted: true });
  } catch {
    return void res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
