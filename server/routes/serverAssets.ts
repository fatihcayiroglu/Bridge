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
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router({ mergeParams: true });
import { Servers, Members, Roles } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { getStorageAdapter } from '../lib/storageAdapter';

const UPLOAD_DIR = path.join(__dirname, '../uploads/server-assets');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).toLowerCase();
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

async function isOwner(userId: string, serverId: string): Promise<boolean> {
  const server = await Servers.findById(serverId);
  if (!server) return false;
  if (server.ownerId === userId) return true;
  const membership = await Members.findOne(userId, serverId);
  if (!membership) return false;
  const roleIds = membership.roles || [];
  if (!roleIds.length) return false;
  const roles = await Roles.findWhere({ _id: { $in: roleIds } });
  return roles.some(r => ((r.permissions ?? 0) & 64) || ((r.permissions ?? 0) & 1));
}

/**
 * Eski asset'i sil: remote provider'da key üzerinden, local modda dosya yoluyla.
 */
async function deleteOldAsset(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const store = getStorageAdapter();
  try {
    const key = store.keyFromUrl(url);
    await store.deleteFile(key);
  } catch {
    // Silme hatası kritik değil — loglama yeterli
  }
}

// POST /api/servers/:sid/banner
router.post('/banner', authMiddleware, limits.write(), (req, res, next) => {
  assetUpload.single('banner')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwner(_u.id, String(req.params.sid ?? '')))
    return res.status(403).json({ error: 'Only server admins can set a banner' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const server = await Servers.findById(String(req.params.sid ?? ''));
  await deleteOldAsset(server?.bannerUrl);

  const store     = getStorageAdapter();
  const cdnKey    = `uploads/server-assets/${req.file.filename}`;
  const result    = await store.uploadFile(req.file.path, cdnKey);
  const bannerUrl = result.url;

  await Servers.update(String(req.params.sid ?? ''), { bannerUrl });
  res.json({ bannerUrl });
});

// DELETE /api/servers/:sid/banner
router.delete('/banner', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwner(_u.id, String(req.params.sid ?? '')))
    return res.status(403).json({ error: 'Only server admins can remove the banner' });

  const server = await Servers.findById(String(req.params.sid ?? ''));
  await deleteOldAsset(server?.bannerUrl);
  await Servers.update(String(req.params.sid ?? ''), { bannerUrl: null });
  res.json({ bannerUrl: null });
});

// POST /api/servers/:sid/icon-image
router.post('/icon-image', authMiddleware, limits.write(), (req, res, next) => {
  assetUpload.single('icon')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwner(_u.id, String(req.params.sid ?? '')))
    return res.status(403).json({ error: 'Only server admins can set a server icon' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const server = await Servers.findById(String(req.params.sid ?? ''));
  await deleteOldAsset(server?.iconUrl);

  const store   = getStorageAdapter();
  const cdnKey  = `uploads/server-assets/${req.file.filename}`;
  const result  = await store.uploadFile(req.file.path, cdnKey);
  const iconUrl = result.url;

  await Servers.update(String(req.params.sid ?? ''), { iconUrl });
  res.json({ iconUrl });
});

// DELETE /api/servers/:sid/icon-image
router.delete('/icon-image', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwner(_u.id, String(req.params.sid ?? '')))
    return res.status(403).json({ error: 'Only server admins can remove the server icon' });

  const server = await Servers.findById(String(req.params.sid ?? ''));
  await deleteOldAsset(server?.iconUrl);
  await Servers.update(String(req.params.sid ?? ''), { iconUrl: null });
  res.json({ iconUrl: null });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
