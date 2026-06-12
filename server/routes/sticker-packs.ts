// server/routes/sticker-packs.ts
// Sprint 82: Sticker Paket API — sunucu özel sticker paketi CRUD
// Endpoint: /api/servers/:serverId/sticker-packs
// Sprint 105: OpenAPI annotations eklendi

/**
 * @openapi
 * /servers/{serverId}/sticker-packs:
 *   get:
 *     tags: [StickerPacks]
 *     summary: Sunucu sticker paketlerini listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Sticker paket listesi }
 *   post:
 *     tags: [StickerPacks]
 *     summary: Yeni sticker paketi oluştur
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, maxLength: 50 }
 *               file: { type: string, format: binary }
 *     responses:
 *       201: { description: Sticker paketi oluşturuldu }
 * /servers/{serverId}/sticker-packs/{packId}:
 *   delete:
 *     tags: [StickerPacks]
 *     summary: Sticker paketini sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *       - { name: packId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Paket silindi }
 * /servers/{serverId}/sticker-packs/{packId}/stickers/{stickerId}:
 *   patch:
 *     tags: [StickerPacks]
 *     summary: Sticker meta verisini güncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *       - { name: packId, in: path, required: true, schema: { type: string } }
 *       - { name: stickerId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, maxLength: 50 }
 *               tags: { type: array, items: { type: string } }
 *     responses:
 *       200: { description: Sticker güncellendi }
 */

import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { Servers } from '../db/repositories';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router({ mergeParams: true });

// ── Multer ────────────────────────────────────────────────────────────────────

const STICKER_MAX_SIZE = 512 * 1024; // 512 KB
const STICKER_ALLOWED_TYPES = new Set(['image/png', 'image/webp', 'image/gif']);
const STICKER_UPLOAD_DIR = process.env['STICKER_UPLOAD_DIR'] ?? 'uploads/stickers';

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await fs.mkdir(STICKER_UPLOAD_DIR, { recursive: true });
    cb(null, STICKER_UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: STICKER_MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (STICKER_ALLOWED_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Geçersiz sticker formatı. PNG, WebP veya GIF gerekli.'));
    }
  },
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface StickerPackRow {
  _id:         string;
  serverId:    string;
  name:        string;
  description: string;
  authorId:    string;
  stickers:    StickerRow[];
  createdAt:   number;
}

interface StickerRow {
  id:      string;
  packId:  string;
  name:    string;
  url:     string;
  tags:    string[];
  width:   number;
  height:  number;
}

// In-memory store (production'da PostgreSQL tablosuna taşı)
const _stickerPacks = new Map<string, StickerPackRow[]>(); // serverId → packs

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/servers/:serverId/sticker-packs
 * Sunucunun sticker paketlerini listele
 */
router.get(
  '/',
  authMiddleware,
  limits.api,
  async (req: Request, res: Response) => {
    const serverId = String(req.params.serverId ?? '');
    const userId = castAuthed(req).user.id;

    try {
      // Sunucu üyesi olup olmadığını kontrol et
      const perms = await resolvePermissions(userId, serverId);
      if (!hasPermission(perms, PERMS.VIEW_CHANNELS)) {
        return res.status(403).json({ error: 'Bu sunucuya erişim izniniz yok.' });
      }

      const packs = _stickerPacks.get(serverId) ?? [];
      return res.json(packs);
    } catch (err) {
      return res.status(500).json({ error: 'Sticker paketleri yüklenemedi.' });
    }
  },
);

/**
 * POST /api/servers/:serverId/sticker-packs
 * Yeni sticker paketi oluştur (MANAGE_SERVER gerekiyor)
 */
router.post(
  '/',
  authMiddleware,
  limits.upload,
  upload.array('sticker', 50),
  async (req: Request, res: Response) => {
    const serverId = String(req.params.serverId ?? '');
    const userId = castAuthed(req).user.id;

    try {
      const perms = await resolvePermissions(userId, serverId);
      if (!hasPermission(perms, PERMS.MANAGE_SERVER)) {
        // Yüklenen dosyaları temizle
        const files = req.files as Express.Multer.File[];
        await Promise.all(files?.map(f => fs.unlink(f.path).catch(() => {})) ?? []);
        return res.status(403).json({ error: 'Sticker paketi oluşturma izniniz yok.' });
      }

      const server = await Servers.findById(serverId);
      if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı.' });

      const { name, description = '' } = req.body as { name?: string; description?: string };
      if (!name?.trim()) return res.status(400).json({ error: 'Paket adı gerekli.' });

      const files  = req.files as Express.Multer.File[];
      if (!files?.length) return res.status(400).json({ error: 'En az bir sticker gerekli.' });

      const packId = uuidv4();
      const stickers: StickerRow[] = files.map(file => ({
        id:     uuidv4(),
        packId,
        name:   path.basename(file.originalname, path.extname(file.originalname)),
        url:    `/uploads/stickers/${file.filename}`,
        tags:   [],
        width:  160,
        height: 160,
      }));

      const pack: StickerPackRow = {
        _id:         packId,
        serverId,
        name:        name.trim(),
        description: description.trim(),
        authorId:    userId,
        stickers,
        createdAt:   Date.now(),
      };

      if (!_stickerPacks.has(serverId)) _stickerPacks.set(serverId, []);
      _stickerPacks.get(serverId)!.push(pack);

      return res.status(201).json(pack);
    } catch (err) {
      return res.status(500).json({ error: 'Sticker paketi oluşturulamadı.' });
    }
  },
);

/**
 * DELETE /api/servers/:serverId/sticker-packs/:packId
 * Sticker paketini sil (MANAGE_SERVER veya paket sahibi)
 */
router.delete(
  '/:packId',
  authMiddleware,
  limits.api,
  async (req: Request, res: Response) => {
    const serverId = String(req.params.serverId ?? '');
    const packId = String(req.params.packId ?? '');
    const userId = castAuthed(req).user.id;

    try {
      const perms = await resolvePermissions(userId, serverId);
      if (!hasPermission(perms, PERMS.MANAGE_SERVER)) {
        return res.status(403).json({ error: 'Sticker paketi silme izniniz yok.' });
      }

      const packs = _stickerPacks.get(serverId) ?? [];
      const pack  = packs.find(p => p._id === packId);
      if (!pack) return res.status(404).json({ error: 'Sticker paketi bulunamadı.' });

      // Dosyaları sil
      await Promise.all(pack.stickers.map(s => {
        const filePath = path.join(STICKER_UPLOAD_DIR, path.basename(s.url));
        return fs.unlink(filePath).catch(() => {});
      }));

      _stickerPacks.set(serverId, packs.filter(p => p._id !== packId));

      return res.status(204).send();
    } catch (err) {
      return res.status(500).json({ error: 'Sticker paketi silinemedi.' });
    }
  },
);

/**
 * PATCH /api/servers/:serverId/sticker-packs/:packId/stickers/:stickerId
 * Sticker meta verilerini güncelle (isim, tags)
 */
router.patch(
  '/:packId/stickers/:stickerId',
  authMiddleware,
  limits.api,
  async (req: Request, res: Response) => {
    const serverId = String(req.params.serverId ?? '');
    const packId = String(req.params.packId ?? '');
    const stickerId = String(req.params.stickerId ?? '');
    const userId = castAuthed(req).user.id;

    try {
      const perms = await resolvePermissions(userId, serverId);
      if (!hasPermission(perms, PERMS.MANAGE_SERVER)) {
        return res.status(403).json({ error: 'İzin gerekli.' });
      }

      const packs   = _stickerPacks.get(serverId) ?? [];
      const pack    = packs.find(p => p._id === packId);
      if (!pack) return res.status(404).json({ error: 'Paket bulunamadı.' });

      const sticker = pack.stickers.find(s => s.id === stickerId);
      if (!sticker) return res.status(404).json({ error: 'Sticker bulunamadı.' });

      const { name, tags } = req.body as { name?: string; tags?: string[] };
      if (name?.trim())          sticker.name = name.trim();
      if (Array.isArray(tags))   sticker.tags = tags.slice(0, 10).map(t => String(t).slice(0, 32));

      return res.json(sticker);
    } catch (err) {
      return res.status(500).json({ error: 'Sticker güncellenemedi.' });
    }
  },
);

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
