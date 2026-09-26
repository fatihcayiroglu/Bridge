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
import db from '../db/loader';
import logger from '../lib/logger';
import { hasLiveUploadReference } from '../lib/uploadReferenceSafety';
import { canonicalExtensionForMime, checkMagicBytes } from '../lib/uploadFileSafety';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import { respondDiscardingBody } from '../lib/httpRequestDrain';
import { uploadDir } from '../lib/runtimePaths';
const router = express.Router({ mergeParams: true });

// ── Multer storage ──────────────────────────────────────────────────────────

const UPLOAD_DIR = uploadDir('member-profiles');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const profileStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext = canonicalExtensionForMime(file.mimetype) ?? '.img';
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

function safeUnlink(filePath: string): void {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

async function requireCurrentMembership(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const userId = castAuthed(req).user.id;
  const serverId = String(req.params.serverId ?? '');
  const member = await Members.findOne(userId, serverId);
  if (!member) {
    // Yetki Multer'DAN ONCE cozulur. Gövde hala akiyorken duz `res.json`
    // yazmak istemciye 403 yerine ECONNRESET gosteriyordu; gövde akitilip
    // `end` beklenir. Bkz. lib/httpRequestDrain.ts
    respondDiscardingBody(req, res, 403, { error: 'Not a member' });
    return;
  }
  next();
}

async function cleanupOldMemberProfileAsset(url: string | undefined): Promise<void> {
  if (!url?.startsWith('/uploads/member-profiles/')) return;
  const fileName = path.basename(url);
  const canonicalKey = `uploads/member-profiles/${fileName}`;
  const filePath = path.join(UPLOAD_DIR, fileName);
  try {
    if (!await hasLiveUploadReference(db._pool, canonicalKey)) safeUnlink(filePath);
  } catch (error) {
    logger.error({ err: error, url, event: 'member_profile.cleanup_failed' },
      'Member profile DB update succeeded but physical cleanup was blocked');
  }
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
  if (Object.prototype.hasOwnProperty.call(req.body, 'avatarUrl') || Object.prototype.hasOwnProperty.call(req.body, 'bannerUrl')) {
    return res.status(400).json({ error: 'avatarUrl/bannerUrl must be changed through the upload endpoints' });
  }

  const serverProfile: Record<string, unknown> = {
    ...(member.serverProfile ?? {}),
    nickname, bio, pronouns, bannerColor,
    updatedAt: Date.now(),
  };
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

router.post('/members/me/avatar', authMiddleware, limits.upload(), requireCurrentMembership, profileUpload.single('file'), async (req, res) => {
  const { user } = castAuthed(req);
  const { serverId } = req.params as { serverId: string };

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!checkMagicBytes(req.file.path, req.file.mimetype)) {
    safeUnlink(req.file.path);
    return res.status(400).json({ error: 'File content does not match declared type' });
  }

  let member;
  try {
    member = await Members.findOne(user.id, serverId);
  } catch (error) {
    safeUnlink(req.file.path);
    throw error;
  }
  if (!member) { safeUnlink(req.file.path); return res.status(403).json({ error: 'Not a member' }); }

  const destName = `mp_av_${uuidv4()}.webp`;
  const destPath = path.join(UPLOAD_DIR, destName);
  try {
    await resizeAndSave(req.file.path, destPath, 256);
  } catch {
    safeUnlink(req.file.path);
    safeUnlink(destPath);
    return res.status(500).json({ error: 'Image processing failed' });
  }

  const avatarUrl = `/uploads/member-profiles/${destName}`;
  try {
    await Members.update(user.id, serverId, {
      serverProfile: { ...(member.serverProfile ?? {}), avatarUrl, updatedAt: Date.now() }
    });
  } catch (error) {
    // The new file was never committed to DB ownership.
    safeUnlink(destPath);
    throw error;
  }

  const oldAvatarUrl = typeof member.serverProfile?.avatarUrl === 'string' ? member.serverProfile.avatarUrl : undefined;
  await cleanupOldMemberProfileAsset(oldAvatarUrl);

  return res.json({ avatarUrl });
});

// ── POST /members/me/banner ──────────────────────────────────────────────────

router.post('/members/me/banner', authMiddleware, limits.upload(), requireCurrentMembership, profileUpload.single('file'), async (req, res) => {
  const { user } = castAuthed(req);
  const { serverId } = req.params as { serverId: string };

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!checkMagicBytes(req.file.path, req.file.mimetype)) {
    safeUnlink(req.file.path);
    return res.status(400).json({ error: 'File content does not match declared type' });
  }

  let member;
  try {
    member = await Members.findOne(user.id, serverId);
  } catch (error) {
    safeUnlink(req.file.path);
    throw error;
  }
  if (!member) { safeUnlink(req.file.path); return res.status(403).json({ error: 'Not a member' }); }

  const destName = `mp_bn_${uuidv4()}.webp`;
  const destPath = path.join(UPLOAD_DIR, destName);
  try {
    await sharp(req.file.path).resize(1024, 256, { fit: 'cover' }).toFile(destPath);
    safeUnlink(req.file.path);
  } catch {
    safeUnlink(req.file.path);
    safeUnlink(destPath);
    return res.status(500).json({ error: 'Image processing failed' });
  }

  const bannerUrl = `/uploads/member-profiles/${destName}`;
  try {
    await Members.update(user.id, serverId, {
      serverProfile: { ...(member.serverProfile ?? {}), bannerUrl, updatedAt: Date.now() }
    });
  } catch (error) {
    safeUnlink(destPath);
    throw error;
  }

  const oldBannerUrl = typeof member.serverProfile?.bannerUrl === 'string' ? member.serverProfile.bannerUrl : undefined;
  await cleanupOldMemberProfileAsset(oldBannerUrl);

  return res.json({ bannerUrl });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
