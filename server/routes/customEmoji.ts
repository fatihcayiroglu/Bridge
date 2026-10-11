/**
 * @openapi
 * tags:
 *   - name: CustomEmoji
 *     description: CustomEmoji API endpoints
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
 */

// server/routes/customEmoji.ts — Server Custom Emoji (No Nitro Required)
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router({ mergeParams: true });
import { Servers, Members, ServerAssets } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { PERMS, hasPermission, resolvePermissions } from '../lib/permissions';
import db from '../db/loader';
import logger from '../lib/logger';
import { hasLiveUploadReference } from '../lib/uploadReferenceSafety';
import { canonicalExtensionForMime, checkMagicBytes } from '../lib/uploadFileSafety';
import { stripUploadedImageOrRefuse } from '../lib/imageMetadata';
import { respondDiscardingBody } from '../lib/httpRequestDrain';

import { uploadDir } from '../lib/runtimePaths';
const UPLOAD_DIR = uploadDir('emojis');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = canonicalExtensionForMime(file.mimetype) ?? '';
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

async function canManageEmoji(userId: string, serverId: string): Promise<boolean> {
  const perms = await resolvePermissions(userId, serverId);
  return hasPermission(perms, PERMS.MANAGE_SERVER);
}

async function requireManageEmoji(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const userId = castAuthed(req).user.id;
  const serverId = String(req.params.sid ?? '');
  if (!await canManageEmoji(userId, serverId)) {
    // Yetki Multer'DAN ONCE cozulur. Gövde hala akiyorken duz `res.json`
    // yazmak istemciye 403 yerine ECONNRESET gosteriyordu; gövde akitilip
    // `end` beklenir. Bkz. lib/httpRequestDrain.ts
    respondDiscardingBody(req, res, 403, { error: 'Missing permission: MANAGE_SERVER' });
    return;
  }
  next();
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
router.post('/', authMiddleware, limits.write(), requireManageEmoji, (req, res, next) => {
  emojiUpload.single('emoji')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const _u = castAuthed(req).user;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  if (!checkMagicBytes(req.file.path, req.file.mimetype)) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'File content does not match declared type' });
  }

  const name = (req.body?.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
  if (!name) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'Emoji name required (a-z, 0-9, _)' });
  }

  // Check dupe
  let existing;
  try {
    existing = await ServerAssets.findEmojiByServerAndName(String(req.params.sid ?? ''), name);
  } catch (error) {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    throw error;
  }
  if (existing) {
    fs.unlinkSync(req.file.path);
    return res.status(409).json({ error: `Emoji :${name}: already exists` });
  }

  // Limit yok — Discord Nitro'nun aksine Bridge'de emoji sınırsız

  // P7 B3: no location/device metadata is stored — after every check that can
  // refuse the request, so a refused upload is never rewritten first.
  if (!(await stripUploadedImageOrRefuse(res, req.file))) return;

  let emoji;
  try {
    emoji = await ServerAssets.insertEmoji({
      _id: uuidv4(),
      serverId: String(req.params.sid ?? ''),
      name,
      url: `/uploads/emojis/${req.file.filename}`,
      uploadedBy: _u.id,
      createdAt: Date.now(),
    });
  } catch (error) {
    // DB ownership was not established; rollback the newly written file.
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }
    catch (cleanupError) { logger.error({ err: cleanupError, path: req.file.path }, '[Emoji] upload rollback failed'); }
    throw error;
  }

  res.json(emoji);
});

// DELETE /api/servers/:sid/emojis/:eid
router.delete('/:eid', authMiddleware, limits.write(), requireManageEmoji, async (req, res) => {
  const emoji = await ServerAssets.findEmojiByIdAndServer(String(req.params.eid ?? ''), String(req.params.sid ?? ''));
  if (!emoji) return res.status(404).json({ error: 'Emoji not found' });

  // Canonical DB row first. If it cannot be removed, the physical object stays.
  const emojiId = String(req.params.eid ?? '');
  const serverId = String(req.params.sid ?? '');
  await ServerAssets.deleteEmoji(emojiId, serverId);

  const canonicalKey = `uploads/emojis/${path.basename(emoji.url)}`;
  const filePath = path.join(UPLOAD_DIR, path.basename(emoji.url));
  try {
    if (!await hasLiveUploadReference(db._pool, canonicalKey)) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  } catch (error) {
    // Reference lookup failure is fail-closed for destructive storage cleanup.
    logger.error({ err: error, emojiId, serverId, filePath, event: 'emoji.cleanup_failed' },
      'Emoji DB row removed but physical cleanup failed/was blocked');
  }
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
