/**
 * @openapi
 * tags:
 *   - name: Soundboard
 *     description: Soundboard API endpoints

 *
 * /soundboard:
 *   get:
 *     tags: [Servers]
 *     summary: Soundboard seslerini listele
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Ses listesi
 *   post:
 *     tags: [Servers]
 *     summary: Soundboard'a yeni ses ekle
 *     security: [{ bearerAuth: [] }]
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
 *         description: Ses eklendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /soundboard/{soundId}:
 *   delete:
 *     tags: [Servers]
 *     summary: Soundboard sesini sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: soundId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Silindi
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// server/routes/soundboard.ts Soundboard (Discord Nitro'da ücretli, Bridge'de bedava)
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router  = express.Router({ mergeParams: true });
import { Servers, Members, Roles, ServerAssets } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';

const UPLOAD_DIR = path.join(__dirname, '../uploads/soundboard');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).toLowerCase();
    cb(null, `sound_${uuidv4()}${ext}`);
  },
});

const soundUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg','audio/mp3','audio/ogg','audio/wav','audio/webm','audio/aac','audio/flac'];
    if (allowed.includes(file.mimetype)) cb(null, true); else cb(new Error('Only MP3, OGG, WAV, WEBM, AAC, FLAC allowed'));
  },
});

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
  return roles.some(r => ((r.permissions ?? 0) & 64) || ((r.permissions ?? 0) & 1));
}

// GET /api/servers/:sid/soundboard
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const member = await Members.findOne(_u.id, String(req.params.sid ?? ''));
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const sounds = await ServerAssets.findSoundsSorted(String(req.params.sid ?? ''));
  res.json(sounds);
});

// POST /api/servers/:sid/soundboard — upload sound
router.post('/', authMiddleware, limits.write(), (req, res, next) => {
  soundUpload.single('sound')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwnerOrAdmin(_u.id, String(req.params.sid ?? '')))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Max 64 sounds per server
  const existing = await ServerAssets.findSounds(String(req.params.sid ?? ''));
  if (existing.length >= 64) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Maximum 64 sounds per server' });
  }

  const name  = (req.body.name  || '').trim().slice(0, 32) || path.basename(req.file.originalname, path.extname(req.file.originalname)).slice(0, 32);
  const emoji = (req.body.emoji || '🔊').trim().slice(0, 8);

  const sound = await ServerAssets.insertSound({
    _id:        uuidv4(),
    serverId:   String(req.params.sid ?? ''),
    name,
    emoji,
    url:        `/uploads/soundboard/${req.file.filename}`,
    uploadedBy: _u.id,
    createdAt:  Date.now(),
  });

  res.json(sound);
});

// DELETE /api/servers/:sid/soundboard/:soundId
router.delete('/:soundId', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwnerOrAdmin(_u.id, String(req.params.sid ?? '')))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const sound = await ServerAssets.findSoundByIdAndServer(String(req.params.soundId ?? ''), String(req.params.sid ?? ''));
  if (!sound) return res.status(404).json({ error: 'Sound not found' });

  const filePath = path.join(UPLOAD_DIR, path.basename(sound.url));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  await ServerAssets.deleteSound(String(req.params.soundId ?? ''), String(req.params.sid ?? ''));
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
