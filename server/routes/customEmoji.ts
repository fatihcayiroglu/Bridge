/**
 * @openapi
 * tags:
 *   - name: CustomEmoji
 *     description: CustomEmoji API endpoints

 *
 * /servers/{sid}/emojis:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu ozel emojilerini listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Emoji listesi
 *   post:
 *     tags: [Servers]
 *     summary: Ozel emoji ekle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [name, file]
 *             properties:
 *               name: { type: string, maxLength: 32 }
 *               file: { type: string, format: binary }
 *     responses:
 *       201:
 *         description: Emoji eklendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/emojis/{emojiId}:
 *   patch:
 *     tags: [Servers]
 *     summary: Emoji adini guncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: emojiId
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
 *               name: { type: string }
 *     responses:
 *       200:
 *         description: Guncellendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Servers]
 *     summary: Emojiyi sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: emojiId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Silindi
 *       403: { $ref: '#/components/responses/Forbidden' }

 *
 * /servers/{sid}/emojis/all:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu tum ozel emojilerini getir (sayfalama yok)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Tum emoji listesi
 *
 * /servers/{sid}/emojis:
 *   get:
 *     tags: [Servers]
 *     summary: Ozel emojileri sayfalı listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Sayfalı emoji listesi
 */

// server/routes/customEmoji.ts — Server Custom Emoji (No Nitro Required)
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router({ mergeParams: true });
import { Servers, Members, Roles, ServerAssets } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';

const UPLOAD_DIR = path.join(__dirname, '../uploads/emojis');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).toLowerCase();
    cb(null, `emoji_${uuidv4()}${ext}`);
  },
});

const emojiUpload = multer({
  storage,
  limits: { fileSize: 512 * 1024 }, // 512KB — animasyonlu GIF için daha geniş limit
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png','image/gif','image/webp','image/jpeg'];
    if (allowed.includes(file.mimetype)) cb(null, true); else cb(new Error('Only PNG, GIF, WebP, JPEG allowed'));
  },
});

async function isMember(userId: string, serverId: string): Promise<boolean> {
  return !!(await Members.findOne(userId, serverId));
}

async function isOwnerOrAdmin(userId: string, serverId: string): Promise<boolean> {
  const server = await Servers.findById(serverId);
  if (!server) return false;
  if (server.ownerId === userId) return true;
  const membership = await Members.findOne(userId, serverId);
  if (!membership) return false;
  let roleIds = membership.roles || [];
  if (typeof roleIds === 'string') {
    try { roleIds = JSON.parse(roleIds); } catch { roleIds = []; }
  }
  if (!roleIds.length) return false;
  const roles = await Roles.findWhere({ _id: { $in: roleIds } });
  return roles.some(r => ((r.permissions ?? 0) & 64) || ((r.permissions ?? 0) & 1)); // ADMINISTRATOR or MANAGE_CHANNELS
}

// GET /api/servers/:sid/emojis
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isMember(_u.id, String(req.params.sid ?? '')))
    return res.status(403).json({ error: 'Not a member' });
  const emojis = await ServerAssets.findEmojisSorted(String(req.params.sid ?? ''));
  res.json(emojis);
});

// GET /api/servers/:sid/emojis/all — cross-server: tüm üye olduğun sunucuların emojileri
router.get('/all', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  // Kullanıcının üye olduğu tüm sunucuları bul
  const memberships = await Members.findByUser(_u.id);
  const serverIds   = memberships.map(m => m.serverId);
  if (!serverIds.length) return res.json([]);

  // Tüm sunucuların emojilerini çek + sunucu adını ekle
  const allEmojis: Record<string, unknown>[] = [];
  // PERF: Bulk fetch servers instead of N+1 loop
  const serverList = await Servers.findByIds(serverIds);
  const serverMap  = new Map(serverList.map(s => [s._id, s]));
  await Promise.all(serverIds.map(async (sid) => {
    const emojis = await ServerAssets.findEmojisSorted(sid);
    const server = serverMap.get(sid);
    for (const e of emojis) {
      allEmojis.push({ ...e, serverName: server?.name || 'Unknown', serverIcon: server?.icon || '🌐' });
    }
  }));
  res.json(allEmojis);
});

// POST /api/servers/:sid/emojis — upload emoji
router.post('/', authMiddleware, limits.write(), (req, res, next) => {
  emojiUpload.single('emoji')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwnerOrAdmin(_u.id, String(req.params.sid ?? '')))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const name = (req.body.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
  if (!name) return res.status(400).json({ error: 'Emoji name required (a-z, 0-9, _)' });

  // Check dupe
  const existing = await ServerAssets.findEmojiByServerAndName(String(req.params.sid ?? ''), name);
  if (existing) {
    fs.unlinkSync(req.file.path);
    return res.status(409).json({ error: `Emoji :${name}: already exists` });
  }

  // Limit yok — Discord Nitro'nun aksine Bridge'de emoji sınırsız

  const emoji = await ServerAssets.insertEmoji({
    _id: uuidv4(),
    serverId: String(req.params.sid ?? ''),
    name,
    url: `/uploads/emojis/${req.file.filename}`,
    uploadedBy: _u.id,
    createdAt: Date.now(),
  });

  res.json(emoji);
});

// DELETE /api/servers/:sid/emojis/:eid
router.delete('/:eid', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwnerOrAdmin(_u.id, String(req.params.sid ?? '')))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const emoji = await ServerAssets.findEmojiByIdAndServer(String(req.params.eid ?? ''), String(req.params.sid ?? ''));
  if (!emoji) return res.status(404).json({ error: 'Emoji not found' });

  // Delete file
  const filePath = path.join(__dirname, '../uploads/emojis', path.basename(emoji.url));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  await ServerAssets.deleteEmoji(String(req.params.eid ?? ''), String(req.params.sid ?? ''));
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
