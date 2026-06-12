// server/routes/serverProfile.ts  (Sprint 91 extension)
// Per-server member profil: nickname, bio, pronouns, bannerColor, avatarUrl, bannerUrl
// GET  /api/servers/:serverId/members/me/profile
// Sprint 105: OpenAPI annotations eklendi

/**
 * @openapi
 * /servers/{serverId}/members/me/profile:
 *   get:
 *     tags: [ServerMemberProfile]
 *     summary: Kendi sunucu profil bilgilerini getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Sunucu profili }
 *   put:
 *     tags: [ServerMemberProfile]
 *     summary: Sunucu profilini güncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nickname:    { type: string, maxLength: 32 }
 *               bio:         { type: string, maxLength: 190 }
 *               pronouns:    { type: string, maxLength: 40 }
 *               bannerColor: { type: string, pattern: '^#[0-9a-fA-F]{6}$' }
 *     responses:
 *       200: { description: Profil güncellendi }
 * /servers/{serverId}/members/me/avatar:
 *   post:
 *     tags: [ServerMemberProfile]
 *     summary: Sunucu profil resmi yükle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200: { description: Avatar yüklendi }
 * /servers/{serverId}/members/me/banner:
 *   post:
 *     tags: [ServerMemberProfile]
 *     summary: Sunucu profil banner yükle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200: { description: Banner yüklendi }
 */
// PUT  /api/servers/:serverId/members/me/profile
// POST /api/servers/:serverId/members/me/avatar   (multipart)
// POST /api/servers/:serverId/members/me/banner   (multipart)

import express        from 'express';
import multer         from 'multer';
import path           from 'path';
import fs             from 'fs';
import { v4 as uuidv4 } from 'uuid';
import sharp          from 'sharp';

import { authMiddleware} from '../middleware/auth';
import { Members, Servers }           from '../db/repositories';
import { limits }                     from '../middleware/rateLimit';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router({ mergeParams: true });

// ── Multer storage ──────────────────────────────────────────────────────────

const UPLOAD_DIR = path.join(__dirname, '../uploads/member-profiles');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const profileStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).toLowerCase() || '.jpg';
    cb(null, `mp_${uuidv4()}${ext}`);
  },
});
const profileUpload = multer({
  storage: profileStorage,
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true); else cb(new Error('Only JPEG/PNG/GIF/WebP'));
  },
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeHex(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  return /^#[0-9a-fA-F]{6}$/.test(val) ? val : undefined;
}

function sanitizeStr(val: unknown, max: number): string {
  return typeof val === 'string' ? val.trim().slice(0, max) : '';
}

async function resizeAndSave(srcPath: string, destPath: string, size: number): Promise<void> {
  await sharp(srcPath).resize(size, size, { fit: 'cover' }).toFile(destPath);
  fs.unlinkSync(srcPath);
}

// ── GET /profile ─────────────────────────────────────────────────────────────

router.get('/members/me/profile', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);
  const { serverId } = req.params as { serverId: string };

  const server = await Servers.findById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const member = await Members.findOne(user.id, serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  // serverProfile is stored as a sub-document on member row
  const profile = {
    serverId,
    userId:      user.id,
    nickname:    member.serverProfile?.nickname    ?? member.displayName ?? '',
    bio:         member.serverProfile?.bio         ?? '',
    pronouns:    member.serverProfile?.pronouns    ?? '',
    bannerColor: member.serverProfile?.bannerColor ?? '#2d9cdb',
    avatarUrl:   member.serverProfile?.avatarUrl   ?? member.avatarUrl  ?? null,
    bannerUrl:   member.serverProfile?.bannerUrl   ?? null,
    updatedAt:   member.serverProfile?.updatedAt   ?? null,
  };

  return res.json(profile);
});

// ── PUT /profile ─────────────────────────────────────────────────────────────

router.put('/members/me/profile', authMiddleware, limits.messages(), async (req, res) => {
  const { user } = castAuthed(req);
  const { serverId } = req.params as { serverId: string };

  const server = await Servers.findById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const member = await Members.findOne(user.id, serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  const nickname    = sanitizeStr(req.body.nickname,    32);
  const bio         = sanitizeStr(req.body.bio,         190);
  const pronouns    = sanitizeStr(req.body.pronouns,    40);
  const bannerColor = sanitizeHex(req.body.bannerColor) ?? '#2d9cdb';
  const avatarUrl   = typeof req.body.avatarUrl === 'string' ? req.body.avatarUrl : undefined;
  const bannerUrl   = typeof req.body.bannerUrl === 'string' ? req.body.bannerUrl : undefined;

  const serverProfile: Record<string, unknown> = {
    ...(member.serverProfile ?? {}),
    nickname, bio, pronouns, bannerColor,
    updatedAt: Date.now(),
  };
  if (avatarUrl) serverProfile.avatarUrl = avatarUrl;
  if (bannerUrl) serverProfile.bannerUrl = bannerUrl;

  await Members.update(user.id, serverId, { serverProfile });

  return res.json({
    serverId, userId: user.id,
    nickname, bio, pronouns, bannerColor,
    avatarUrl: serverProfile.avatarUrl ?? null,
    bannerUrl: serverProfile.bannerUrl ?? null,
    updatedAt: serverProfile.updatedAt,
  });
});

// ── POST /members/me/avatar ──────────────────────────────────────────────────

router.post('/members/me/avatar', authMiddleware, profileUpload.single('file'), async (req, res) => {
  const { user } = castAuthed(req);
  const { serverId } = req.params as { serverId: string };

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const member = await Members.findOne(user.id, serverId);
  if (!member) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Not a member' }); }

  const destName = `mp_av_${uuidv4()}.webp`;
  const destPath = path.join(UPLOAD_DIR, destName);
  try {
    await resizeAndSave(req.file.path, destPath, 256);
  } catch (e) {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: 'Image processing failed' });
  }

  const avatarUrl = `/uploads/member-profiles/${destName}`;
  await Members.update(user.id, serverId, {
    serverProfile: { ...(member.serverProfile ?? {}), avatarUrl, updatedAt: Date.now() }
  });

  // Delete old avatar file if it was a server-profile avatar
  const oldAvatarUrl = typeof member.serverProfile?.avatarUrl === 'string' ? member.serverProfile.avatarUrl : undefined;
  if (oldAvatarUrl?.startsWith('/uploads/member-profiles/')) {
    const old = path.join(__dirname, '..', oldAvatarUrl);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }

  return res.json({ avatarUrl });
});

// ── POST /members/me/banner ──────────────────────────────────────────────────

router.post('/members/me/banner', authMiddleware, profileUpload.single('file'), async (req, res) => {
  const { user } = castAuthed(req);
  const { serverId } = req.params as { serverId: string };

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const member = await Members.findOne(user.id, serverId);
  if (!member) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Not a member' }); }

  const destName = `mp_bn_${uuidv4()}.webp`;
  const destPath = path.join(UPLOAD_DIR, destName);
  try {
    await sharp(req.file.path).resize(1024, 256, { fit: 'cover' }).toFile(destPath);
    fs.unlinkSync(req.file.path);
  } catch {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: 'Image processing failed' });
  }

  const bannerUrl = `/uploads/member-profiles/${destName}`;
  await Members.update(user.id, serverId, {
    serverProfile: { ...(member.serverProfile ?? {}), bannerUrl, updatedAt: Date.now() }
  });

  const oldBannerUrl = typeof member.serverProfile?.bannerUrl === 'string' ? member.serverProfile.bannerUrl : undefined;
  if (oldBannerUrl?.startsWith('/uploads/member-profiles/')) {
    const old = path.join(__dirname, '..', oldBannerUrl);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }

  return res.json({ bannerUrl });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
