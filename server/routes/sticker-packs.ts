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

import express, { Request, Response, ErrorRequestHandler } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { canonicalExtensionForMime, checkMagicBytes } from '../lib/uploadFileSafety';
import { stripUploadedImageOrRefuse } from '../lib/imageMetadata';
import { Servers, ServerAssets } from '../db/repositories';
import type { StickerPackRecord, StickerPackItemRecord } from '../db/repositories/types/entities';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import { respondDiscardingBody } from '../lib/httpRequestDrain';
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
    const ext = canonicalExtensionForMime(file.mimetype) ?? '';
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
      // `status` ZORUNLUDUR: global errorHandler (middleware/errorHandler.ts:20)
      // status'suz her hatayı 500 sayar ve mesajı "Internal server error" ile
      // DEĞİŞTİRİR. Statüsüz bırakılırsa kullanıcı yanlış format yüklediğinde
      // eyleme dönüştürülebilir mesaj yerine sunucu hatası görürdü.
      const e = new Error('Geçersiz sticker formatı. PNG, WebP veya GIF gerekli.') as Error & { status?: number };
      e.status = 415;
      cb(e);
    }
  },
});

// ── Types ─────────────────────────────────────────────────────────────────────
//
// KALICILIK (migrations_pg/021): paketler artık PostgreSQL'de tutulur.
// Önceden modül seviyesi bir Map (`serverId → paketler`) kullanılıyordu; süreç
// yeniden başladığında tüm paketler kayboluyor, çok süreçli çalışmada süreçler
// birbirinden ayrışıyordu.
//
// GENEL SÖZLEŞME DEĞİŞMEDİ. DB satırları ile API gövdeleri birebir aynı
// DEĞİLDİR, bu yüzden aşağıdaki iki dönüştürücü tek yetkili sınırdır:
//   • öğe birincil anahtarı DB'de `_id`, API'de `id`
//   • `seq` / `position` / öğe `createdAt` DAHİLİdir — asla yayınlanmaz
//   • `createdAt` BIGINT'tir; node-postgres onu STRING döndürür (global tip
//     ayrıştırıcı yok), bu yüzden Number() ile sayıya çevrilir

interface StickerRow {
  id:      string;
  packId:  string;
  name:    string;
  url:     string;
  tags:    string[];
  width:   number;
  height:  number;
}

interface StickerPackRow {
  _id:         string;
  serverId:    string;
  name:        string;
  description: string;
  authorId:    string;
  stickers:    StickerRow[];
  createdAt:   number;
}

/** DB öğe satırı → genel sticker gövdesi (`_id` → `id`). */
function toPublicSticker(row: StickerPackItemRecord): StickerRow {
  return {
    id:     row._id,          // DB birincil anahtarı `_id`, genel API `id`
    packId: row.packId,
    name:   row.name,
    url:    row.url,
    tags:   Array.isArray(row.tags) ? row.tags : [],
    width:  Number(row.width),
    height: Number(row.height),
  };
  // `position` ve `createdAt` bilerek DIŞARIDA bırakıldı — DB-özel alanlardır.
}

/** DB paket satırı + öğeleri → genel paket gövdesi. */
function toPublicPack(row: StickerPackRecord, items: StickerPackItemRecord[]): StickerPackRow {
  return {
    _id:         row._id,
    serverId:    row.serverId,
    name:        row.name,
    description: row.description,
    authorId:    row.authorId,
    stickers:    items.map(toPublicSticker),
    // BIGINT olarak saklanır; node-postgres STRING döndürür → sayıya çevir.
    createdAt:   Number(row.createdAt),
  };
  // `seq` bilerek DIŞARIDA bırakıldı — sıralama için dahili alandır.
}

/**
 * Bu isteğe ait yüklenmiş dosyaları temizler.
 *
 * Multer dosyaları handler doğrulaması TAMAMLANMADAN diske yazar; paket kalıcı
 * olmazsa dosyalar sahipsiz kalır. Yalnız BU isteğin dosyaları silinir —
 * sticker yükleme dizini asla toplu temizlenmez. En iyi çaba: silme hatası
 * yutulur, böylece dosya sistemi yolları istemciye sızmaz ve asıl HTTP hatası
 * korunur.
 */
async function cleanupRequestUploads(files: Express.Multer.File[] | undefined): Promise<void> {
  await Promise.all((files ?? []).map(f => fs.unlink(f.path).catch(() => {})));
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/servers/:serverId/sticker-packs
 * Sunucunun sticker paketlerini listele
 */
router.get(
  '/',
  authMiddleware,
  limits.api(),
  async (req: Request, res: Response) => {
    const serverId = String(req.params.serverId ?? '');
    const userId = castAuthed(req).user.id;

    try {
      // Sunucu üyesi olup olmadığını kontrol et
      const perms = await resolvePermissions(userId, serverId);
      if (!hasPermission(perms, PERMS.VIEW_CHANNELS)) {
        return res.status(403).json({ error: 'Bu sunucuya erişim izniniz yok.' });
      }

      // Ekleme sırası dahili `seq` ile korunur (bkz. repository).
      const packs = await ServerAssets.findStickerPacksByServer(serverId);
      const items = await ServerAssets.findStickerItemsByPackIds(packs.map(p => p._id));

      // Öğeler `position` ile sıralı gelir; gruplama bu sırayı bozmaz.
      const byPack = new Map<string, StickerPackItemRecord[]>();
      for (const item of items) {
        const bucket = byPack.get(item.packId);
        if (bucket) bucket.push(item);
        else byPack.set(item.packId, [item]);
      }

      return res.json(packs.map(p => toPublicPack(p, byPack.get(p._id) ?? [])));
    } catch {
      return res.status(500).json({ error: 'Sticker paketleri yüklenemedi.' });
    }
  },
);

async function requireManageStickerPacks(req: Request, res: Response, next: import('express').NextFunction): Promise<void> {
  const serverId = String(req.params.serverId ?? '');
  const userId = castAuthed(req).user.id;
  try {
    const perms = await resolvePermissions(userId, serverId);
    if (!hasPermission(perms, PERMS.MANAGE_SERVER)) {
      // Gövde akitilip `end` beklenir; aksi halde istemci 403 yerine
      // ECONNRESET gorur. Baytlar diske YAZILMAZ.
      respondDiscardingBody(req, res, 403, { error: 'Sticker paketi oluşturma izniniz yok.' });
      return;
    }
    next();
  } catch {
    // Authorization uncertainty fails closed before multer can write anything.
    respondDiscardingBody(req, res, 403, { error: 'Sticker paketi oluşturma izniniz yok.' });
  }
}

/**
 * POST /api/servers/:serverId/sticker-packs
 * Yeni sticker paketi oluştur (MANAGE_SERVER gerekiyor)
 */
router.post(
  '/',
  authMiddleware,
  limits.upload(),
  requireManageStickerPacks,
  upload.array('sticker', 50),
  async (req: Request, res: Response) => {
    const serverId = String(req.params.serverId ?? '');
    const userId = castAuthed(req).user.id;
    // Multer bu noktada dosyaları çoktan diske yazmıştır. Paket kalıcı olmadan
    // dönülen HER yol, bu isteğin dosyalarını temizlemek zorundadır.
    const files = req.files as Express.Multer.File[] | undefined;

    try {
      const server = await Servers.findById(serverId);
      if (!server) {
        await cleanupRequestUploads(files);
        return res.status(404).json({ error: 'Sunucu bulunamadı.' });
      }

      const { name, description = '' } = req.body as { name?: string; description?: string };
      if (!name?.trim()) {
        await cleanupRequestUploads(files);
        return res.status(400).json({ error: 'Paket adı gerekli.' });
      }

      if (!files?.length) return res.status(400).json({ error: 'En az bir sticker gerekli.' });
      if (files.some(file => !checkMagicBytes(file.path, file.mimetype))) {
        await cleanupRequestUploads(files);
        return res.status(400).json({ error: 'Sticker içeriği belirtilen formatla eşleşmiyor.' });
      }
      for (const file of files) { // P7 B3: no location/device metadata
        if (!(await stripUploadedImageOrRefuse(res, file))) {
          await cleanupRequestUploads(files);
          return;
        }
      }

      const packId    = uuidv4();
      const createdAt = Date.now();
      const stickers: StickerRow[] = files.map(file => ({
        id:     uuidv4(),
        packId,
        name:   path.basename(file.originalname, path.extname(file.originalname)),
        url:    `/uploads/stickers/${file.filename}`,
        tags:   [],
        width:  160,
        height: 160,
      }));

      // ATOMİK: paket ve TÜM ilk öğeleri tek transaction'da yazılır. Öğe
      // yazımı başarısız olursa paket satırı da kalıcı olmaz — yarım yazılmış
      // (öğesiz) bir paket asla oluşmaz.
      await ServerAssets.createStickerPack({
        packId,
        serverId,
        name:        name.trim(),
        description: description.trim(),
        authorId:    userId,
        createdAt,
        items:       stickers,
      });

      // Yanıt yerel veriden kurulur: `createdAt` böylece SAYI kalır ve
      // gereksiz bir okuma yapılmaz.
      const pack: StickerPackRow = {
        _id:         packId,
        serverId,
        name:        name.trim(),
        description: description.trim(),
        authorId:    userId,
        stickers,
        createdAt,
      };

      return res.status(201).json(pack);
    } catch {
      await cleanupRequestUploads(files);
      return res.status(500).json({ error: 'Sticker paketi oluşturulamadı.' });
    }
  },
);

/**
 * DELETE /api/servers/:serverId/sticker-packs/:packId
 * Sticker paketini sil — YALNIZCA MANAGE_SERVER.
 *
 * NOT: bu yorum eskiden "MANAGE_SERVER veya paket sahibi" diyordu; kod
 * `authorId`'yi hiç okumaz, sahiplik geçersiz kılması HİÇ olmadı. Yorum
 * gerçek davranışa göre düzeltildi; yetkilendirme DEĞİŞTİRİLMEDİ.
 */
router.delete(
  '/:packId',
  authMiddleware,
  limits.api(),
  async (req: Request, res: Response) => {
    const serverId = String(req.params.serverId ?? '');
    const packId = String(req.params.packId ?? '');
    const userId = castAuthed(req).user.id;

    try {
      const perms = await resolvePermissions(userId, serverId);
      if (!hasPermission(perms, PERMS.MANAGE_SERVER)) {
        return res.status(403).json({ error: 'Sticker paketi silme izniniz yok.' });
      }

      // GÜVENLİK: paket (packId + serverId) ile çözülür. Yalnız packId ile
      // arama, UUID'yi bilen bir MANAGE_SERVER sahibinin BAŞKA sunucunun
      // paketini silmesine izin verirdi.
      const pack = await ServerAssets.findStickerPackByIdAndServer(packId, serverId);
      if (!pack) return res.status(404).json({ error: 'Sticker paketi bulunamadı.' });

      // Historical sticker integrity rule: persisted files under
      // server/uploads/stickers are never physically deleted by application
      // CRUD. The DB rows are the mutable product state; keeping the object is
      // safer than risking deletion of the historical 242-file baseline or a
      // shared legacy reference. Request-scoped failed uploads are still cleaned
      // separately because those filenames are known to have been created by the
      // current request and were never committed.
      await ServerAssets.deleteStickerPack(packId, serverId);

      return res.status(204).send();
    } catch {
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
  limits.api(),
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

      // GÜVENLİK — İKİ ADIM, SIRA ÖNEMLİ:
      // 1) paket (packId + serverId) ile çözülür → sunucu sahipliği kanıtlanır
      // 2) öğe yalnızca O paketin içinde aranır
      // Öğeyi tek başına stickerId ile aramak, sunucular arası yetki aşımı olurdu.
      const pack = await ServerAssets.findStickerPackByIdAndServer(packId, serverId);
      if (!pack) return res.status(404).json({ error: 'Paket bulunamadı.' });

      const sticker = await ServerAssets.findStickerItemByIdAndPack(stickerId, packId);
      if (!sticker) return res.status(404).json({ error: 'Sticker bulunamadı.' });

      const { name, tags } = req.body as { name?: string; tags?: string[] };
      // Sınırlar korunur: en fazla 10 etiket, her biri en fazla 32 karakter.
      const nextName = name?.trim() ? name.trim() : undefined;
      const nextTags = Array.isArray(tags)
        ? tags.slice(0, 10).map(t => String(t).slice(0, 32))
        : undefined;

      const fields: Record<string, unknown> = {};
      if (nextName) fields['name'] = nextName;
      if (nextTags) fields['tags'] = nextTags;

      if (Object.keys(fields).length) {
        await ServerAssets.updateStickerItem(stickerId, packId, fields);
      }

      return res.json(toPublicSticker({
        ...sticker,
        ...(nextName ? { name: nextName } : {}),
        ...(nextTags ? { tags: nextTags } : {}),
      }));
    } catch {
      return res.status(500).json({ error: 'Sticker güncellenemedi.' });
    }
  },
);

/**
 * YÜKLEME HATA SINIRI.
 *
 * NEDEN VAR: multer, handler ÇALIŞMADAN ÖNCE hata verebilir (geçersiz format,
 * dosya boyutu, dosya sayısı, bozuk multipart). O durumda rota gövdesindeki
 * `catch` HİÇ çalışmaz; iki sonuç doğardı:
 *   1) global errorHandler status'suz hatayı 500 + "Internal server error"e
 *      çevirir → kullanıcı düzeltebileceği bir hatayı sunucu hatası sanır,
 *   2) multer'ın O ANA KADAR diske yazdığı dosyalar SAHİPSİZ kalır.
 *
 * Bu sınır ikisini de kapatır: 4xx'e eşler ve YALNIZ bu isteğin dosyalarını
 * temizler. Tarihsel `uploads/stickers` içeriğine ASLA dokunulmaz.
 */
const uploadErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  const status = (err as { status?: number }).status;
  const isMulter = err instanceof multer.MulterError;
  if (!isMulter && status !== 415) return next(err);

  // Yarım kalan yükleme dosyaları bırakılmaz (en iyi çaba).
  void cleanupRequestUploads(req.files as Express.Multer.File[] | undefined);

  if (isMulter) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Sticker dosyası çok büyük (en fazla 512 KB).' });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'En fazla 50 sticker yüklenebilir.' });
    }
    return res.status(400).json({ error: 'Yükleme isteği geçersiz.' });
  }

  // fileFilter reddi (status 415) — mesajı kullanıcıya dönüktür.
  return res.status(415).json({ error: (err as Error).message });
};
router.use(uploadErrorHandler);

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
