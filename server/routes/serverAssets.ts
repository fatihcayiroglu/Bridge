/**
 * @openapi
 * tags:
 *   - name: ServerAssets
 *     description: ServerAssets API endpoints

 *
 * /servers/{sid}/banner:
 *   post:
 *     tags: [Servers]
 *     summary: Sunucu banner resmi yükle
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
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Banner yüklendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Servers]
 *     summary: Sunucu bannerını sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Silindi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/icon-image:
 *   post:
 *     tags: [Servers]
 *     summary: Sunucu ikonu yükle
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
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: İkon yüklendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Servers]
 *     summary: Sunucu ikonunu sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Silindi
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// server/routes/serverAssets.ts — Server Banner & Icon Image Upload
// Sprint 73: CDN entegrasyonu — getStorageAdapter() ile local/S3/R2/MinIO/B2 desteği
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router({ mergeParams: true });
import { Servers } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { getStorageAdapter } from '../lib/storageAdapter';
import { PERMS, hasPermission, resolvePermissions } from '../lib/permissions';
import db from '../db/loader';
import logger from '../lib/logger';
import { hasLiveUploadReference, normalizeUploadKey } from '../lib/uploadReferenceSafety';
import { canonicalExtensionForMime, checkMagicBytes } from '../lib/uploadFileSafety';
import { stripUploadedImageOrRefuse } from '../lib/imageMetadata';
import { afterDiscardingBody, respondDiscardingBody } from '../lib/httpRequestDrain';

import { uploadDir } from '../lib/runtimePaths';
const UPLOAD_DIR = uploadDir('server-assets');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = canonicalExtensionForMime(file.mimetype) ?? '';
    cb(null, `sa_${uuidv4()}${ext}`);
  },
});

const assetUpload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    const ok = ['image/png','image/gif','image/webp','image/jpeg'].includes(file.mimetype);
    if (ok) cb(null, true); else cb(new Error('Only images allowed'));
  },
});

async function canManageServer(userId: string, serverId: string): Promise<boolean> {
  const perms = await resolvePermissions(userId, serverId);
  return hasPermission(perms, PERMS.MANAGE_SERVER);
}

async function requireManageServerAsset(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const userId = castAuthed(req).user.id;
  const serverId = String(req.params.sid ?? '');
  try {
    if (!await canManageServer(userId, serverId)) {
      // Yetki Multer'DAN ONCE cozulur (yetkisiz istek diske yazamaz). Gövde
      // hala akiyorken duz `res.json` yazmak istemciye 403 yerine ECONNRESET
      // gosteriyordu; gövde akitilip `end` beklenir. Bkz. lib/httpRequestDrain.ts
      respondDiscardingBody(req, res, 403, { error: 'Missing permission: MANAGE_SERVER' });
      return;
    }
    next();
  } catch (error) {
    // The same unread-body rule applies when the authorization authority is
    // unavailable. Drain first, then let the canonical error middleware decide
    // what detail is safe to expose for this environment.
    afterDiscardingBody(req, () => next(error));
  }
}

function canonicalKeyFromStorageKey(storageKey: string): string | null {
  const normalized = storageKey.startsWith('uploads/') ? storageKey : `uploads/${storageKey}`;
  return normalizeUploadKey(normalized);
}

/**
 * DB referansı kaldırıldıktan sonra fiziksel objeyi best-effort temizle.
 * Başka bir canlı DB satırı aynı objeyi kullanıyorsa dosya korunur. DB sorgusu
 * başarısız olursa fail-closed: fiziksel silme yapılmaz.
 */
async function cleanupUnreferencedAsset(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const store = getStorageAdapter();
  const storageKey = store.keyFromUrl(url);
  const canonicalKey = canonicalKeyFromStorageKey(storageKey);
  if (!canonicalKey) {
    logger.warn({ url, storageKey, event: 'server_asset.cleanup_invalid_key' }, 'Server asset cleanup key rejected');
    return;
  }
  try {
    if (await hasLiveUploadReference(db._pool, canonicalKey)) return;
    await store.deleteFile(storageKey);
  } catch (error) {
    logger.error({ err: error, url, storageKey, event: 'server_asset.cleanup_failed' },
      'Server asset physical cleanup failed; DB state remains authoritative');
  }
}

async function rollbackNewAsset(url: string): Promise<void> {
  // The new URL has not been committed to the server row, so a normal
  // unreferenced cleanup is safe and still checks for unexpected sharing.
  await cleanupUnreferencedAsset(url);
}

// POST /api/servers/:sid/banner
router.post('/banner', authMiddleware, limits.write(), requireManageServerAsset, (req, res, next) => {
  assetUpload.single('banner')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  if (!checkMagicBytes(req.file.path, req.file.mimetype)) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'File content does not match declared type' });
  }
  if (!(await stripUploadedImageOrRefuse(res, req.file))) return; // P7 B3: no location/device metadata

  const serverId  = String(req.params.sid ?? '');
  let server;
  try {
    server = await Servers.findById(serverId);
  } catch (error) {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    throw error;
  }
  if (!server) {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    return res.status(404).json({ error: 'Server not found' });
  }
  const oldUrl    = server.bannerUrl;
  const store     = getStorageAdapter();
  const cdnKey    = `uploads/server-assets/${req.file.filename}`;
  let result;
  try {
    result = await store.uploadFile(req.file.path, cdnKey, { contentType: req.file.mimetype });
  } catch (error) {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    throw error;
  }
  const bannerUrl = result.url;

  try {
    // New DB reference first; only then may the old physical object disappear.
    await Servers.update(serverId, { bannerUrl });
  } catch (error) {
    await rollbackNewAsset(bannerUrl);
    throw error;
  }
  await cleanupUnreferencedAsset(oldUrl);
  res.json({ bannerUrl });
});

// DELETE /api/servers/:sid/banner
router.delete('/banner', authMiddleware, limits.write(), requireManageServerAsset, async (req, res) => {
  const serverId = String(req.params.sid ?? '');
  const server = await Servers.findById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const oldUrl = server.bannerUrl;
  await Servers.update(serverId, { bannerUrl: null });
  await cleanupUnreferencedAsset(oldUrl);
  res.json({ bannerUrl: null });
});

// POST /api/servers/:sid/icon-image
router.post('/icon-image', authMiddleware, limits.write(), requireManageServerAsset, (req, res, next) => {
  assetUpload.single('icon')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  if (!checkMagicBytes(req.file.path, req.file.mimetype)) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'File content does not match declared type' });
  }
  if (!(await stripUploadedImageOrRefuse(res, req.file))) return; // P7 B3: no location/device metadata

  const serverId = String(req.params.sid ?? '');
  let server;
  try {
    server = await Servers.findById(serverId);
  } catch (error) {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    throw error;
  }
  if (!server) {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    return res.status(404).json({ error: 'Server not found' });
  }
  const oldUrl = server.iconUrl;
  const store   = getStorageAdapter();
  const cdnKey  = `uploads/server-assets/${req.file.filename}`;
  let result;
  try {
    result = await store.uploadFile(req.file.path, cdnKey, { contentType: req.file.mimetype });
  } catch (error) {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    throw error;
  }
  const iconUrl = result.url;

  try {
    await Servers.update(serverId, { iconUrl });
  } catch (error) {
    await rollbackNewAsset(iconUrl);
    throw error;
  }
  await cleanupUnreferencedAsset(oldUrl);
  res.json({ iconUrl });
});

// DELETE /api/servers/:sid/icon-image
router.delete('/icon-image', authMiddleware, limits.write(), requireManageServerAsset, async (req, res) => {
  const serverId = String(req.params.sid ?? '');
  const server = await Servers.findById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const oldUrl = server.iconUrl;
  await Servers.update(serverId, { iconUrl: null });
  await cleanupUnreferencedAsset(oldUrl);
  res.json({ iconUrl: null });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
