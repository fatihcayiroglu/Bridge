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
 *             required: [sound]
 *             properties:
 *               name: { type: string, maxLength: 32 }
 *               sound: { type: string, format: binary }
 *     responses:
 *       200:
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
import { Channels, Members, ServerAssets } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import logger from '../lib/logger';
import db from '../db/loader';
import { hasLiveUploadReference } from '../lib/uploadReferenceSafety';
import { canonicalExtensionForMime, checkMagicBytes } from '../lib/uploadFileSafety';
import { respondDiscardingBody } from '../lib/httpRequestDrain';
import {
  inspectSoundboardAudio,
  isAllowedSoundboardDuration,
  SOUNDBOARD_MAX_DURATION_SECONDS,
  SOUNDBOARD_MAX_FILE_BYTES,
} from '../lib/soundboardAudio';
import { findBuiltinSoundboardSound } from '../lib/soundboardCatalog';
import { isMemberTimedOut } from '../lib/memberTimeout';
import {
  decodeSoundboardCursor,
  type SoundboardCursor,
  type SoundboardListView,
} from '../db/repositories/ServerAssetRepository';

import { uploadDir } from '../lib/runtimePaths';
const UPLOAD_DIR = uploadDir('soundboard');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = canonicalExtensionForMime(file.mimetype) ?? '';
    cb(null, `sound_${uuidv4()}${ext}`);
  },
});

const soundUpload = multer({
  storage,
  limits: { fileSize: SOUNDBOARD_MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg','audio/mp3','audio/ogg','audio/wav','audio/x-wav','audio/webm','audio/aac','audio/flac'];
    if (allowed.includes(file.mimetype)) cb(null, true); else cb(new Error('Only MP3, OGG, WAV, WEBM, AAC, FLAC allowed'));
  },
});

const LIST_VIEWS = new Set<SoundboardListView>(['all', 'server', 'global', 'favorites', 'recent', 'frequent']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function scalarQuery(value: unknown): string | null {
  return typeof value === 'string' ? value : value === undefined ? '' : null;
}

function normalizedField(value: unknown, fallback: string, maxCodePoints: number): string | null {
  if (value !== undefined && typeof value !== 'string') return null;
  const normalized = String(value ?? fallback).trim().normalize('NFC');
  if (!normalized || CONTROL_CHARACTERS.test(normalized) || Array.from(normalized).length > maxCodePoints) return null;
  return normalized;
}

function discardUploadedFile(file: Express.Multer.File | undefined): void {
  if (!file) return;
  try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); }
  catch (error) { logger.warn({ err: error, path: file.path }, '[Soundboard] rejected upload cleanup failed'); }
}

function emitSoundboardMutation(req: express.Request, serverId: string, event: string, payload: unknown): void {
  const io = req.app.get('io') as { to(room: string): { emit(name: string, data: unknown): void } } | undefined;
  io?.to(`server:${serverId}`).emit(event, payload);
}

async function requireSoundboardMember(req: express.Request, res: express.Response, next: express.NextFunction) {
  const userId = castAuthed(req).user.id;
  const serverId = String(req.params.sid ?? '');
  try {
    const member = await Members.findOne(userId, serverId);
    if (!member) return res.status(403).json({ error: 'Not a member' });
    res.locals.soundboardMember = member;
    next();
  } catch (error) {
    logger.warn({ err: error, serverId, userId }, '[Soundboard] membership resolution failed');
    return res.status(403).json({ error: 'Not a member' });
  }
}

async function requireManageSoundboard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const userId = castAuthed(req).user.id;
  const serverId = String(req.params.sid ?? '');
  try {
    const perms = await resolvePermissions(userId, serverId);
    if (!hasPermission(perms, PERMS.MANAGE_SERVER)) {
      // Gövde HL akıyor olabilir; akıtılıp `end` beklenmezse istemci 403
      // yerine ECONNRESET görür (bkz. lib/httpRequestDrain.ts). Baytlar diske
      // YAZILMAZ — Multer bu noktada hiç devreye girmemiştir.
      respondDiscardingBody(req, res, 403, { error: 'Missing permission: MANAGE_SERVER' });
      return;
    }
    next();
  } catch (error) {
    logger.warn({ err: error, serverId, userId }, '[Soundboard] permission resolution failed');
    respondDiscardingBody(req, res, 403, { error: 'Missing permission: MANAGE_SERVER' });
    return;
  }
}

// GET /api/servers/:sid/soundboard
router.get('/', authMiddleware, limits.search(), requireSoundboardMember, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.sid ?? '');
  const paged = ['limit', 'cursor', 'q', 'scope', 'channelId'].some(key => Object.prototype.hasOwnProperty.call(req.query, key));
  const rawLimit = scalarQuery(req.query.limit);
  const query = scalarQuery(req.query.q);
  const rawCursor = scalarQuery(req.query.cursor);
  const rawView = scalarQuery(req.query.scope);
  const channelId = scalarQuery(req.query.channelId);
  if (rawLimit === null || query === null || rawCursor === null || rawView === null || channelId === null) {
    return res.status(400).json({ error: 'Soundboard query parameters must be scalar strings' });
  }
  if (query.length > 64 || CONTROL_CHARACTERS.test(query)) {
    return res.status(400).json({ error: 'Search query must be at most 64 characters' });
  }
  if (rawCursor.length > 512) return res.status(400).json({ error: 'Invalid soundboard cursor' });
  if (channelId.length > 64 || CONTROL_CHARACTERS.test(channelId)) {
    return res.status(400).json({ error: 'Invalid soundboard voice channel' });
  }
  const view = (rawView || (paged ? 'all' : 'server')) as SoundboardListView;
  if (!LIST_VIEWS.has(view)) return res.status(400).json({ error: 'Invalid soundboard scope' });
  if (rawLimit && !/^\d{1,3}$/.test(rawLimit)) return res.status(400).json({ error: 'Invalid soundboard page limit' });
  const limit = rawLimit ? Number(rawLimit) : paged ? 60 : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: 'Soundboard page limit must be between 1 and 100' });
  }

  let cursor: SoundboardCursor | null;
  try {
    cursor = rawCursor ? decodeSoundboardCursor(rawCursor, view, query) : null;
  } catch {
    return res.status(400).json({ error: 'Invalid soundboard cursor' });
  }

  const page = await ServerAssets.listSoundsPage({ serverId, userId: _u.id, limit, query, view, cursor });
  if (!paged) return res.json(page.items);

  let canManage = false;
  try {
    const perms = await resolvePermissions(_u.id, serverId);
    canManage = hasPermission(perms, PERMS.MANAGE_SERVER);
  } catch (error) {
    logger.warn({ err: error, serverId, userId: _u.id }, '[Soundboard] list permission annotation failed closed');
  }

  // `locked` is presentation metadata only; the socket play handler repeats
  // this exact authority check at action time. Supplying the current voice
  // channel lets the panel represent VIEW/CONNECT/SPEAK revocations honestly
  // without ever treating a browser-side state as authorization.
  let canPlay: boolean | null = null;
  if (channelId) {
    canPlay = false;
    try {
      const member = res.locals.soundboardMember as { timeoutUntil?: unknown } | undefined;
      const channel = await Channels.findByIdAndServer(channelId, serverId);
      if (member && !isMemberTimedOut(member.timeoutUntil)
        && channel && ['voice', 'stage'].includes(String((channel as { type?: unknown }).type ?? ''))) {
        const perms = await resolvePermissions(_u.id, serverId, channelId);
        canPlay = hasPermission(perms, PERMS.VIEW_CHANNELS)
          && hasPermission(perms, PERMS.CONNECT)
          && hasPermission(perms, PERMS.SPEAK);
      }
    } catch (error) {
      logger.warn({ err: error, serverId, channelId, userId: _u.id }, '[Soundboard] play permission annotation failed closed');
    }
  }
  const items = canPlay === null ? page.items : page.items.map(sound => ({ ...sound, canPlay, locked: !canPlay }));
  return res.json({ ...page, items, canManage, ...(canPlay === null ? {} : { canPlay }) });
});

// POST /api/servers/:sid/soundboard — upload sound
router.post('/', authMiddleware, limits.upload(), requireManageSoundboard, (req, res, next) => {
  // Authorization deliberately runs before multer: an unauthorized request
  // must never be able to write a temporary file to disk.
  soundUpload.single('sound')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const _u = castAuthed(req).user;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  if (!checkMagicBytes(req.file.path, req.file.mimetype)) {
    discardUploadedFile(req.file);
    return res.status(400).json({ error: 'File content does not match declared type' });
  }

  const audioInfo = inspectSoundboardAudio(req.file.path, req.file.mimetype);
  if (!audioInfo) {
    discardUploadedFile(req.file);
    return res.status(400).json({ error: 'Unsupported or malformed audio codec/container' });
  }
  if (!isAllowedSoundboardDuration(audioInfo)) {
    discardUploadedFile(req.file);
    return res.status(400).json({ error: `Sound must be at most ${SOUNDBOARD_MAX_DURATION_SECONDS} seconds` });
  }

  const filenameFallback = path.basename(req.file.originalname, path.extname(req.file.originalname));
  const name = normalizedField(req.body.name, filenameFallback, 32);
  const emoji = normalizedField(req.body.emoji, '🔊', 16);
  const category = normalizedField(req.body.category, 'Server', 32);
  if (!name || !emoji || !category) {
    discardUploadedFile(req.file);
    return res.status(400).json({ error: 'Invalid sound name, emoji, or category' });
  }

  let sound;
  const serverId = String(req.params.sid ?? '');
  try {
    sound = await ServerAssets.insertSound({
      _id:        uuidv4(),
      serverId,
      name,
      emoji,
      category,
      url:        `/uploads/soundboard/${req.file.filename}`,
      uploadedBy: _u.id,
      durationSeconds: audioInfo.durationSeconds,
      mimeType: req.file.mimetype.toLowerCase(),
      fileSize: req.file.size,
      createdAt:  Date.now(),
    });
  } catch (error) {
    // DB did not accept ownership; do not leave an orphaned physical object.
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }
    catch (cleanupError) { logger.error({ err: cleanupError, path: req.file.path }, '[Soundboard] upload rollback failed'); }
    throw error;
  }

  const payload = { ...sound, scope: 'server' as const, favorite: false, playCount: 0, favoritedAt: null, lastPlayedAt: null };
  emitSoundboardMutation(req, serverId, 'soundboard:created', { serverId, sound: payload });
  return res.json(payload);
});

// PATCH /api/servers/:sid/soundboard/:soundId — rename/re-categorize
router.patch('/:soundId', authMiddleware, limits.write(), requireManageSoundboard, async (req, res) => {
  const soundId = String(req.params.soundId ?? '');
  const serverId = String(req.params.sid ?? '');
  if (!soundId || soundId.length > 64) return res.status(400).json({ error: 'Invalid sound id' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Invalid sound update' });
  }
  const allowed = new Set(['name', 'emoji', 'category']);
  if (Object.keys(req.body).some(key => !allowed.has(key))) {
    return res.status(400).json({ error: 'Unknown sound update field' });
  }
  const fields: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
    const name = normalizedField(req.body.name, '', 32);
    if (!name) return res.status(400).json({ error: 'Invalid sound name' });
    fields.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'emoji')) {
    const emoji = normalizedField(req.body.emoji, '', 16);
    if (!emoji) return res.status(400).json({ error: 'Invalid sound emoji' });
    fields.emoji = emoji;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'category')) {
    const category = normalizedField(req.body.category, '', 32);
    if (!category) return res.status(400).json({ error: 'Invalid sound category' });
    fields.category = category;
  }
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'No sound updates supplied' });
  fields.updatedAt = Date.now();
  const sound = await ServerAssets.updateSound(soundId, serverId, fields);
  if (!sound) return res.status(404).json({ error: 'Sound not found' });
  const payload = { ...sound, scope: 'server' as const };
  emitSoundboardMutation(req, serverId, 'soundboard:updated', { serverId, sound: payload });
  return res.json(payload);
});

async function resolveFavoriteTarget(soundId: string, serverId: string): Promise<{ serverId: string | null } | null> {
  if (findBuiltinSoundboardSound(soundId)) return { serverId: null };
  const sound = await ServerAssets.findSoundByIdAndServer(soundId, serverId);
  return sound ? { serverId } : null;
}

// PUT/DELETE /api/servers/:sid/soundboard/:soundId/favorite
router.put('/:soundId/favorite', authMiddleware, limits.react(), requireSoundboardMember, async (req, res) => {
  const _u = castAuthed(req).user;
  const soundId = String(req.params.soundId ?? '');
  const serverId = String(req.params.sid ?? '');
  if (!soundId || soundId.length > 64) return res.status(400).json({ error: 'Invalid sound id' });
  const target = await resolveFavoriteTarget(soundId, serverId);
  if (!target) return res.status(404).json({ error: 'Sound not found' });
  const stat = await ServerAssets.setSoundFavorite(soundId, _u.id, target.serverId, true);
  return res.json({ ok: true, soundId, favorite: true, favoritedAt: stat?.favoritedAt ?? Date.now() });
});

router.delete('/:soundId/favorite', authMiddleware, limits.react(), requireSoundboardMember, async (req, res) => {
  const _u = castAuthed(req).user;
  const soundId = String(req.params.soundId ?? '');
  const serverId = String(req.params.sid ?? '');
  if (!soundId || soundId.length > 64) return res.status(400).json({ error: 'Invalid sound id' });
  const target = await resolveFavoriteTarget(soundId, serverId);
  if (!target) return res.status(404).json({ error: 'Sound not found' });
  await ServerAssets.setSoundFavorite(soundId, _u.id, target.serverId, false);
  return res.json({ ok: true, soundId, favorite: false, favoritedAt: null });
});

// DELETE /api/servers/:sid/soundboard/:soundId
router.delete('/:soundId', authMiddleware, limits.write(), requireManageSoundboard, async (req, res) => {
  const soundId = String(req.params.soundId ?? '');
  const serverId = String(req.params.sid ?? '');
  if (!soundId || soundId.length > 64) return res.status(400).json({ error: 'Invalid sound id' });
  const sound = await ServerAssets.findSoundByIdAndServer(soundId, serverId);
  if (!sound) return res.status(404).json({ error: 'Sound not found' });

  // Remove the canonical DB reference first. A storage failure may leave an
  // orphan for cleanup, but must never delete an object that the DB still owns.
  const deleted = await ServerAssets.deleteSound(soundId, serverId);
  if ((deleted.deleted ?? 0) < 1) return res.status(404).json({ error: 'Sound not found' });

  const fileName = path.basename(sound.url);
  const filePath = path.join(UPLOAD_DIR, fileName);
  const canonicalKey = `uploads/soundboard/${fileName}`;
  try {
    if (!await hasLiveUploadReference(db._pool, canonicalKey)) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  } catch (error) {
    logger.error({ err: error, soundId, serverId, filePath, event: 'soundboard.cleanup_failed' },
      '[Soundboard] physical cleanup failed/blocked after DB delete');
  }

  emitSoundboardMutation(req, serverId, 'soundboard:deleted', { serverId, soundId });
  return res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
