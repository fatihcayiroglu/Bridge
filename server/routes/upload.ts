// server/routes/upload.ts — Chunked upload (up to 2GB) + legacy 500MB + GIF 100MB
// Sprint 73: cdnStorage.ts kaldırıldı — artık storageAdapter.ts üzerinden çalışır.
//            CDN_PROVIDER=local|s3|r2|minio|b2 (provider-agnostic)
// Sprint 74: sharp require→dynamic import, storage isim çakışması giderildi,
//            DELETE /upload/cdn endpoint'ine dosya sahipliği kontrolü eklendi,
 
//            S3 credential boş string startup validasyonu eklendi.
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { ErrorRequestHandler } from 'express';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { scanFile } from '../lib/contentScanner';
import { db } from '../db/postgres'; // Sprint 93: boost tier upload limit
import { sanitizeSvgFile } from '../lib/svgSanitizer';
import { getStorageAdapter, getProvider } from '../lib/storageAdapter';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router();

// ── WebP otomatik dönüşüm (sharp, opsiyonel) ─────────────────────────────────
// WEBP_CONVERT=true env ile aktif edilir.
// Kalite: WEBP_QUALITY (0-100, varsayılan 82)
// Yalnızca raster görüntüler dönüştürülür: jpeg/png/tiff/bmp
// GIF ve SVG atlanır (animasyon/vektör korunur)
// Sprint 74: require() → dynamic import() (no eslint-disable workaround needed)
type SharpFn = (input: string) => {
  webp(opts: Record<string, unknown>): { toFile(out: string): Promise<{ size: number }> };
};
let _sharp: SharpFn | null = null;
let _sharpLoaded = false;

const WEBP_CONVERT = process.env.WEBP_CONVERT === 'true';
const WEBP_QUALITY = parseInt(process.env.WEBP_QUALITY || '82', 10);
const WEBP_RASTER  = new Set(['image/jpeg', 'image/png', 'image/tiff', 'image/bmp']);

async function getSharp(): Promise<SharpFn | null> {
  if (_sharpLoaded) return _sharp;
  _sharpLoaded = true;
  try {
    const mod = await import('sharp');
    _sharp = (mod.default ?? mod) as unknown as SharpFn;
  } catch {
    const { default: logger } = await import('../lib/logger');
    logger.warn(
      { event: 'upload.webp.sharp_missing' },
      'WEBP_CONVERT=true ama sharp yüklü değil — npm install sharp',
    );
  }
  return _sharp;
}

async function maybeConvertToWebP(
  filePath: string,
  mimetype: string,
): Promise<{ filePath: string; mimetype: string; converted: boolean }> {
  if (!WEBP_CONVERT || !WEBP_RASTER.has(mimetype)) {
    return { filePath, mimetype, converted: false };
  }
  const sharp = await getSharp();
  if (!sharp) return { filePath, mimetype, converted: false };
  const webpPath = filePath.replace(/\.[^.]+$/, '.webp');
  await sharp(filePath).webp({ quality: WEBP_QUALITY, effort: 4 }).toFile(webpPath);
  fs.unlink(filePath, () => {});
  return { filePath: webpPath, mimetype: 'image/webp', converted: true };
}

// ── Upload sahipliği kaydı ─────────────────────────────────────────────────────
// Sprint 75: DELETE /cdn artık bu tabloya bakıyor — messages ILIKE araması yok.
async function recordUpload(userId: string, key: string, originalName: string, mimeType: string): Promise<void> {
  try {
    const { default: db } = await import('../db/loader');
    await (db as unknown as { uploads: { insert(doc: Record<string, unknown>): Promise<unknown> } })
      .uploads.insert({
        _id:          uuidv4(),
        userId,
        key,
        originalName: originalName.slice(0, 500),
        mimeType:     mimeType.slice(0, 100),
        createdAt:    Date.now(),
      });
  } catch {
    // kayıt başarısız olsa da upload yanıtı kesilmemeli — sessizce geç
  }
}

const UPLOAD_DIR = path.join(__dirname, '../uploads');
const CHUNK_DIR  = path.join(__dirname, '../uploads/_chunks');
[UPLOAD_DIR, CHUNK_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/tiff', 'image/bmp',
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
  'application/x-tar', 'application/gzip',
  'application/json', 'text/xml', 'application/xml',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/aac', 'audio/webm', 'audio/mp4',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo',
  // SECURITY: text/html, text/css, text/javascript, application/javascript kaldırıldı.
  // Bu MIME türleri tarayıcıda doğrudan çalıştırılabilir — XSS vektörü.
  // Kullanıcı kodu paylaşmak istiyorsa text/plain kullanmalı.
];

const MAGIC = [
  { mime: 'image/jpeg',       bytes: [0xFF, 0xD8, 0xFF], check: null },
  { mime: 'image/png',        bytes: [0x89, 0x50, 0x4E, 0x47], check: null },
  { mime: 'image/gif',        bytes: [0x47, 0x49, 0x46], check: null },
  { mime: 'image/webp',       bytes: null, check: (b: Buffer) => b.slice(8, 12).toString() === 'WEBP' },
  { mime: 'application/pdf',  bytes: [0x25, 0x50, 0x44, 0x46], check: null },
  { mime: 'application/zip',  bytes: [0x50, 0x4B, 0x03, 0x04], check: null },
];

const SKIP_MAGIC = [
  // text/ türleri artık yalnızca text/plain, text/markdown, text/csv, text/xml — bunların magic byte'ı yok
  'text/',
  'audio/', 'video/', 'application/json', 'application/javascript',
  'application/xml', 'text/xml', 'application/msword',
  'application/x-rar-compressed', 'application/x-7z-compressed',
  'application/x-tar', 'application/gzip',
  'image/svg+xml', 'image/tiff', 'image/bmp',
];

export function checkMagicBytes(filePath: string, declaredMime: string): boolean {
  if (SKIP_MAGIC.some(p => declaredMime.startsWith(p))) return true;
  const rule = MAGIC.find(m => m.mime === declaredMime);
  if (!rule) return true;
  try {
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    if (rule.check) return rule.check(buf);
    return (rule.bytes ?? []).every((byte, i) => buf[i] === byte);
  } catch { return false; }
}

const MAX_FILE_SIZE    = parseInt(process.env.MAX_FILE_SIZE_MB || '5120') * 1024 * 1024;
const CHUNK_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB per chunk

/** CDN nesne key'i oluştur; local modda null döner */
function _cdnKey(filename: string): string | null {
  return getProvider() !== 'local' ? `uploads/${filename}` : null;
}


// ── Sprint 93: Boost tier upload limit ───────────────────────────────────────
const BOOST_LIMITS: Record<number, number> = { 0: 25, 1: 25, 2: 50, 3: 100 };

async function getBoostUploadLimitBytes(userId: string): Promise<number> {
  try {
    // Kullanıcının üye olduğu en yüksek tier'lı sunucuyu bul
    const result = await db._pool.query<{ boostTier: number }>(
      `SELECT COALESCE(MAX(s."boostTier"), 0) AS "boostTier"
       FROM members m JOIN servers s ON s._id = m."serverId"
       WHERE m."userId" = $1`,
      [userId]
    );
    const tier = result.rows[0]?.boostTier ?? 0;
    const limitMB = BOOST_LIMITS[tier] ?? 25;
    return limitMB * 1024 * 1024;
  } catch {
    return 25 * 1024 * 1024; // fallback
  }
}

// ── LEGACY SINGLE UPLOAD (≤ 500 MB, multer) ──────────────────────────────────
const smallUpload = multer({
  storage: diskStorage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(Object.assign(new Error('File type not allowed'), { status: 415 }));
  },
});

/**
 * @openapi
 * /upload:
 *   post:
 *     tags: [Upload]
 *     summary: Dosya yükle (max 500MB, legacy — büyük dosyalar için /upload/chunk kullanın)
 *     security: [{ bearerAuth: [] }]
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
 *         description: Yükleme başarılı
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:      { type: string, format: uri }
 *                 fileName: { type: string }
 *                 fileType: { type: string }
 *                 size:     { type: integer }
 *                 webp:     { type: boolean }
 *                 cdn:      { type: string }
 *                 key:      { type: string }
 *       415: { description: Desteklenmeyen dosya türü }
 *       429: { description: Rate limit aşıldı }
 */
router.post('/', authMiddleware, limits.upload(), smallUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const filePath = req.file.path;

  // Sprint 93: Boost tier upload limit kontrolü
  const userId = castAuthed(req).user?.id;
  if (userId) {
    const limitBytes = await getBoostUploadLimitBytes(userId);
    if (req.file.size > limitBytes) {
      fs.unlink(filePath, () => {});
      const limitMB = Math.round(limitBytes / 1024 / 1024);
      return res.status(413).json({ error: `File too large. Your server's boost tier allows max ${limitMB} MB.`, code: 'BOOST_LIMIT' });
    }
  }

  if (!checkMagicBytes(filePath, req.file.mimetype)) {
    fs.unlink(filePath, () => {});
    return res.status(400).json({ error: 'File content does not match its declared type' });
  }

  try {
    await scanFile(filePath, {
      userId:   req.user?.id,
      username: req.user?.username,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      fileSize: req.file.size,
    });
  } catch (scanErr: unknown) {
    const e = scanErr as { statusCode?: number; message?: string; code?: string };
    return res.status(e.statusCode || 422).json({ error: e.message, code: e.code });
  }

  // SVG sanitizasyonu
  if (req.file.mimetype === 'image/svg+xml') {
    const svgResult = await sanitizeSvgFile(filePath);
    if (!svgResult.safe) {
      fs.unlink(filePath, () => {});
      return res.status(422).json({ error: 'SVG contains dangerous content', code: 'SVG_UNSAFE' });
    }
  }

  const safeOriginalName = path.basename(req.file.originalname).replace(/[^\w.-]/g, '_').slice(0, 200);

  // WebP dönüşüm (opsiyonel)
  const webpResult    = await maybeConvertToWebP(filePath, req.file.mimetype);
  const finalPath     = webpResult.filePath;
  const finalMime     = webpResult.mimetype;
  const finalExt      = webpResult.converted ? '.webp' : path.extname(req.file.filename);
  const finalFilename = webpResult.converted
    ? req.file.filename.replace(/\.[^.]+$/, '.webp')
    : req.file.filename;

  // Depolama (provider-agnostic)
  const cdnAdapter = getStorageAdapter();
  const cdnKey     = _cdnKey(finalFilename);
  const result     = await cdnAdapter.uploadFile(finalPath, cdnKey ?? finalFilename);

  // Sahiplik kaydı — DELETE /cdn bu tabloya bakacak
  const uploadKey = cdnKey ?? `uploads/${finalFilename}`;
  const authUser  = castAuthed(req).user as { id: string };
  await recordUpload(authUser.id, uploadKey, safeOriginalName, finalMime);

  res.json({
    url:      result.url,
    fileName: safeOriginalName.replace(/\.[^.]+$/, finalExt),
    fileType: finalMime,
    size:     req.file.size,
    ...(webpResult.converted              && { webp: true }),
    ...(result.provider !== 'local'       && { cdn: result.provider, key: result.key }),
  });
});

// ── CHUNKED UPLOAD (resumable, ≤ 2 GB) ───────────────────────────────────────
/**
 * @openapi
 * /upload/chunk:
 *   post:
 *     tags: [Upload]
 *     summary: Parçalı yükleme (chunked upload, max 2GB)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: x-upload-id,    in: header, required: true,  schema: { type: string } }
 *       - { name: x-chunk-index,  in: header, required: true,  schema: { type: integer } }
 *       - { name: x-total-chunks, in: header, required: true,  schema: { type: integer } }
 *       - { name: x-file-name,    in: header, required: true,  schema: { type: string } }
 *       - { name: x-file-type,    in: header, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/octet-stream:
 *           schema: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Chunk alındı — done:true son chunk'ta gelir
 */
router.post('/chunk', authMiddleware, async (req, res) => {
  const uploadId    = String(req.headers['x-upload-id']    || '').replace(/[^a-z0-9-]/gi, '').slice(0, 64);
  const chunkIndex  = parseInt(req.headers['x-chunk-index']  as string || '0');
  const totalChunks = parseInt(req.headers['x-total-chunks'] as string || '1');
  const fileName    = String(req.headers['x-file-name']    || 'file').slice(0, 200);
  const fileType    = String(req.headers['x-file-type']    || 'application/octet-stream').slice(0, 100);

  if (!uploadId || isNaN(chunkIndex) || isNaN(totalChunks)) {
    return res.status(400).json({ error: 'Missing chunk metadata headers' });
  }
  if (!ALLOWED_TYPES.includes(fileType)) {
    return res.status(415).json({ error: 'File type not allowed' });
  }

  const sessionDir = path.join(CHUNK_DIR, uploadId);
  fs.mkdirSync(sessionDir, { recursive: true });

  if (totalChunks * CHUNK_SIZE_LIMIT > MAX_FILE_SIZE + CHUNK_SIZE_LIMIT) {
    return res.status(413).json({ error: `File too large (max ${process.env.MAX_FILE_SIZE_MB || 5120}MB)` });
  }

  const chunkPath   = path.join(sessionDir, `chunk_${String(chunkIndex).padStart(6, '0')}`);
  const writeStream = fs.createWriteStream(chunkPath);

  let chunkSize = 0;
  req.on('data', (d: Buffer) => {
    chunkSize += d.length;
    if (chunkSize > CHUNK_SIZE_LIMIT) {
      writeStream.destroy();
      fs.unlink(chunkPath, () => {});
      return res.status(413).json({ error: 'Single chunk too large (max 10MB per chunk)' });
    }
  });

  req.pipe(writeStream);
  writeStream.on('error', () => {
    if (res.headersSent) return;
    res.status(500).json({ error: 'Chunk write failed' });
  });
  writeStream.on('finish', async () => {
    if (res.headersSent) return;
    if (chunkIndex !== totalChunks - 1) {
      return res.json({ done: false, received: chunkIndex });
    }

    const ext       = path.extname(fileName).slice(0, 10).toLowerCase();
    const finalName = `${uuidv4()}${ext}`;
    const finalPath = path.join(UPLOAD_DIR, finalName);

    try {
      await mergeChunks(sessionDir, totalChunks, finalPath);
      const { size } = fs.statSync(finalPath);

      if (size > MAX_FILE_SIZE) {
        fs.unlink(finalPath, () => {});
        return res.status(413).json({ error: `File too large (max ${process.env.MAX_FILE_SIZE_MB || 5120}MB)` });
      }
      if (!checkMagicBytes(finalPath, fileType)) {
        fs.unlink(finalPath, () => {});
        return res.status(400).json({ error: 'File content does not match its declared type' });
      }

      try {
        await scanFile(finalPath, {
          userId:   req.user?.id,
          username: req.user?.username,
          filename: fileName,
          mimetype: fileType,
          fileSize: size,
        });
      } catch (scanErr: unknown) {
        const e = scanErr as { statusCode?: number; message?: string; code?: string };
        return res.status(e.statusCode || 422).json({ error: e.message, code: e.code });
      }

      if (fileType === 'image/svg+xml') {
        const svgResult = await sanitizeSvgFile(finalPath);
        if (!svgResult.safe) {
          fs.unlink(finalPath, () => {});
          return res.status(422).json({ error: 'SVG contains dangerous content', code: 'SVG_UNSAFE' });
        }
      }

      // WebP dönüşüm
      const chunkWebp      = await maybeConvertToWebP(finalPath, fileType);
      const chunkFinalPath = chunkWebp.filePath;
      const chunkFinalMime = chunkWebp.mimetype;
      const chunkFinalName = chunkWebp.converted ? finalName.replace(/\.[^.]+$/, '.webp') : finalName;
      const safeFileName   = path.basename(fileName).replace(/[^\w.-]/g, '_').slice(0, 200);

      // Depolama (provider-agnostic)
      const cdnAdapter = getStorageAdapter();
      const cdnKey = _cdnKey(chunkFinalName);
      const result = await cdnAdapter.uploadFile(chunkFinalPath, cdnKey ?? chunkFinalName);

      // Sahiplik kaydı
      const chunkAuthUser = castAuthed(req).user as { id: string };
      await recordUpload(chunkAuthUser.id, cdnKey ?? `uploads/${chunkFinalName}`, safeFileName, chunkFinalMime);

      res.json({
        done:     true,
        url:      result.url,
        fileName: safeFileName.replace(/\.[^.]+$/, chunkWebp.converted ? '.webp' : ext),
        fileType: chunkFinalMime,
        size,
        ...(result.provider !== 'local' && { cdn: result.provider, key: result.key }),
      });
    } catch (e: unknown) {
      const err = e as Error;
      res.status(500).json({ error: 'Merge failed: ' + err.message });
    } finally {
      fs.rm(sessionDir, { recursive: true, force: true }, () => {});
    }
  });
});

async function mergeChunks(sessionDir: string, totalChunks: number, finalPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(finalPath);
    let idx = 0;
    function writeNext() {
      if (idx === totalChunks) { out.end(); return; }
      const chunkPath = path.join(sessionDir, `chunk_${String(idx).padStart(6, '0')}`);
      const inp = fs.createReadStream(chunkPath);
      inp.pipe(out, { end: false });
      inp.on('error', reject);
      inp.on('end', () => { idx++; writeNext(); });
    }
    out.on('error', reject);
    out.on('finish', resolve);
    writeNext();
  });
}

// ── SERVER GIF UPLOAD ─────────────────────────────────────────────────────────
const gifUpload = multer({
  storage: diskStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/gif', 'image/webp', 'image/png', 'image/jpeg'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(Object.assign(new Error('Only image files allowed for GIFs'), { status: 415 }));
  },
});

/**
 * @openapi
 * /upload/server-gif:
 *   post:
 *     tags: [Upload]
 *     summary: Sunucu GIF emoji yükle
 */
router.post('/server-gif', authMiddleware, gifUpload.single('gif'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!checkMagicBytes(req.file.path, req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'File content mismatch' });
  }
  const store  = getStorageAdapter();
  const cdnKey = _cdnKey(req.file.filename);
  const result = await store.uploadFile(req.file.path, cdnKey ?? req.file.filename);
  const gifAuthUser = castAuthed(req).user as { id: string };
  await recordUpload(gifAuthUser.id, cdnKey ?? `uploads/${req.file.filename}`, req.file.originalname, req.file.mimetype);
  res.json({
    url:      result.url,
    fileType: req.file.mimetype,
    size:     req.file.size,
    ...(result.provider !== 'local' && { cdn: result.provider, key: result.key }),
  });
});

/**
 * @openapi
 * /upload/cdn:
 *   delete:
 *     tags: [Upload]
 *     summary: CDN'den dosya sil
 *     description: >
 *       Yalnızca dosyayı yükleyen kullanıcı veya MANAGE_MESSAGES iznine sahip
 *       kullanıcılar silebilir. Admin kullanıcılar her zaman silebilir.
 */
router.delete('/cdn', authMiddleware, async (req, res) => {
  const key = String(req.query.key ?? '').replace(/\.\./g, '').slice(0, 512);
  if (!key || !key.startsWith('uploads/')) {
    return res.status(400).json({ error: 'Geçersiz CDN key' });
  }

  const authedUser = castAuthed(req).user as { id: string; isAdmin?: boolean };
  const userId = authedUser.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  // ── Sahiplik Kontrolü ─────────────────────────────────────────────────────
  // Admin kullanıcılar doğrudan silebilir.
  const isAdmin = authedUser.isAdmin === true;

  if (!isAdmin) {
    // Sprint 75: uploads tablosundan doğrudan key+userId kontrolü.
    // Mesaj silinmiş olsa bile sahip bilgisi korunur — ILIKE araması yok.
    const { default: db } = await import('../db/loader');
    const uploadRecord = await (db as unknown as {
      uploads: { findOne(q: Record<string, unknown>): Promise<Record<string, unknown> | null> }
    }).uploads.findOne({ key, userId });

    if (!uploadRecord) {
      return res.status(404).json({ error: 'Dosya bulunamadı veya bu dosyanın sahibi değilsiniz' });
    }
  }

  const cdnAdapter = getStorageAdapter();
  await cdnAdapter.deleteFile(key);
  res.json({ deleted: true, key });
});

// Error handler
const errHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (err instanceof multer.MulterError || (err as { status?: number }).status === 415) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'File too large' });
    return res.status(400).json({ error: (err as Error).message });
  }
  next(err);
};
router.use(errHandler);

export default router;
