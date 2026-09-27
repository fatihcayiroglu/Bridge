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
import { db } from '../db/postgres';
import { Boosts } from '../db/repositories'; // live boost entitlement source
import { sanitizeSvgFile } from '../lib/svgSanitizer';
import { getPrivateStorageAdapter, getPrivateStorageProvider, getStorageAdapter, getProvider } from '../lib/storageAdapter';
import logger from '../lib/logger';
import { hasLiveUploadReference, normalizeUploadKey, storageDeleteKey } from '../lib/uploadReferenceSafety';
import { canonicalExtensionForMime, checkMagicBytes } from '../lib/uploadFileSafety';
import {
  allChunksPresent,
  chunkFileName,
  mergeChunkFiles,
  chunkSessionKey,
  commitChunkTempFile,
  parseChunkContentLength,
  purgeChunkSessionIfIdle,
  tryAcquireChunkFinalization,
  validateChunkMetadata,
  validateFinalUploadSize,
} from '../lib/chunkUploadSafety';
import {
  chunkQuotaConfig,
  releaseChunkQuotaSession,
  reserveChunkQuota,
  type ChunkReservation,
} from '../lib/chunkUploadQuota';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import {
  CHUNK_NODE_ID,
  clearChunkStagingNode,
  markChunkStagingNode,
  readChunkStagingNode,
  readFinalizedChunkUpload,
  recordFinalizedChunkUpload,
} from '../lib/chunkUploadSession';
import { uploadRoot, uploadDir } from '../lib/runtimePaths';
import { envSafeInt } from '../lib/envNumbers';
import { isDatabaseAdmin } from '../lib/adminAuthority';
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
const WEBP_QUALITY = envSafeInt('WEBP_QUALITY', 82, { min: 1, max: 100 });
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
  try {
    await sharp(filePath).webp({ quality: WEBP_QUALITY, effort: 4 }).toFile(webpPath);
  } catch (error) {
    try { if (fs.existsSync(webpPath)) fs.unlinkSync(webpPath); } catch {}
    throw error;
  }
  fs.unlink(filePath, () => {});
  return { filePath: webpPath, mimetype: 'image/webp', converted: true };
}

// ── Upload sahipliği kaydı ─────────────────────────────────────────────────────
// Sprint 75: DELETE /cdn artık bu tabloya bakıyor — messages ILIKE araması yok.
async function recordUpload(userId: string, key: string, originalName: string, mimeType: string): Promise<void> {
  const { default: loaderDb } = await import('../db/loader');
  await (loaderDb as unknown as { uploads: { insert(doc: Record<string, unknown>): Promise<unknown> } })
    .uploads.insert({
      _id:          uuidv4(),
      userId,
      key,
      originalName: originalName.slice(0, 500),
      mimeType:     mimeType.slice(0, 100),
      createdAt:    Date.now(),
    });
}

/** `true` = the ownership row is durable, `false` = it is not, `null` = unknown. */
async function uploadRowCommitted(userId: string, key: string): Promise<boolean | null> {
  try {
    const { default: loaderDb } = await import('../db/loader');
    const row = await (loaderDb as unknown as { uploads: { findOne(q: Record<string, unknown>): Promise<unknown> } })
      .uploads.findOne({ key, userId });
    return Boolean(row);
  } catch {
    return null;
  }
}

async function recordUploadOrRollback(
  userId: string,
  key: string,
  originalName: string,
  mimeType: string,
  adapter: { deleteFile(key: string): Promise<void> },
  provider: string,
): Promise<void> {
  try {
    await recordUpload(userId, key, originalName, mimeType);
  } catch (err) {
    // A failed INSERT is not proof that nothing was written: the COMMIT can
    // reach PostgreSQL while its reply is lost. Deleting the bytes then leaves
    // an ownership row for an object that no longer exists (measured in the
    // multi-node harness, UPF-02). Resolve the outcome before any rollback.
    const committed = await uploadRowCommitted(userId, key);
    if (committed === true) {
      logger.warn({ key, event: 'upload.ownership_commit_ambiguous_resolved' },
        'Upload ownership INSERT reported an error but the row is durable; upload kept');
      return;
    }
    if (committed === null) {
      // Outcome unknown: keep the bytes. An unreferenced object is reclaimed by
      // the unreferenced-upload sweep; a row without bytes would be permanent.
      logger.error({ err, key, provider, event: 'upload.ownership_outcome_unknown' },
        'Upload ownership outcome unknown; stored object kept for the unreferenced-upload sweep');
      throw err;
    }
    try {
      await adapter.deleteFile(storageDeleteKey(key, provider));
    } catch (rollbackErr) {
      logger.error(
        { err: rollbackErr, key, provider, event: 'upload.ownership_rollback_failed' },
        'Upload ownership kaydı başarısız oldu ve storage rollback de başarısız oldu',
      );
    }
    throw err;
  }
}

// With a configured Redis the deployment may run several nodes; chunk staging
// locality is then recorded in the shared authority.
const CHUNK_STAGING_AUTHORITY = Boolean(process.env.REDIS_URL);

const UPLOAD_DIR = uploadRoot();
const CHUNK_DIR  = uploadDir('_chunks');
// `uploadDir()` creates `_chunks` recursively, which also guarantees that the
// upload root exists.  A second existence/mkdir pass here was unreachable and
// could only diverge from the canonical runtime-path helper.

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = canonicalExtensionForMime(file.mimetype) ?? '';
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
const ALLOWED_TYPE_SET = new Set(ALLOWED_TYPES);

export { checkMagicBytes };

const MAX_FILE_SIZE = envSafeInt('MAX_FILE_SIZE_MB', 2_048, { min: 1, max: 100_000 }) * 1024 * 1024;
const CHUNK_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB per chunk

/** CDN nesne key'i oluştur; local modda null döner */
function _privateStorageKey(filename: string): string | null {
  return getPrivateStorageProvider() !== 'local' ? `uploads/${filename}` : null;
}

/** Canonical application URL for protected root-level attachments. */
function protectedUploadUrl(filename: string): string {
  return `/uploads/${path.basename(filename)}`;
}


// ── Sprint 93: Boost tier upload limit ───────────────────────────────────────
const BOOST_LIMITS: Record<number, number> = { 0: 25, 1: 25, 2: 50, 3: 100 };

async function getBoostUploadLimitBytes(userId: string): Promise<number> {
  try {
    // SECURITY/CORRECTNESS: cached servers.boostTier is not an entitlement source.
    // A 30-day boost can expire without any write touching the denormalized cache,
    // and banned memberships must not keep granting perks. The repository derives
    // the tier from current, non-expired boosts on non-banned memberships.
    const tier = await Boosts.getHighestActiveTierForUser(userId);
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

/**
 * ════════════════════════════════════════════════════════════════════════════
 * COK PARCALI (multipart) AYRISTIRMA HATALARI 400 DONER, 500 DEGIL
 * ════════════════════════════════════════════════════════════════════════════
 * `multer`/`busboy` bozuk bir istegi REDDETTIGINDE hata rota koduna hic
 * ulasmadan global hata isleyicisine dusuyordu ve istemciye 500 donuyordu.
 *
 * DOGRUDAN OLCULDU — dosya adinda NULL bayti:
 *     POST /api/upload  (filename: "a\0.png")
 *       → 500 Internal server error
 *       → sunucu gunlugu: "Malformed part header"
 *
 * Bu bir GUVENLIK ACIGI DEGILDIR (veri sizmaz, dogrulama atlanmaz) ama
 * bozuk ISTEMCI girdisi SUNUCU hatasi olarak raporlanmamalidir: gercek
 * arizalari maskeler ve izleme gurultusu uretir.
 *
 * Boyut asimi da burada dogru kodla (413) yanitlanir.
 */
function handleUploadErrors(
  mw: (req: express.Request, res: express.Response, next: (err?: unknown) => void) => void,
) {
  return (req: express.Request, res: express.Response, next: (err?: unknown) => void): void => {
    mw(req, res, (err?: unknown) => {
      if (!err) return next();
      const e = err as { code?: string; status?: number; message?: string };
      if (e?.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'File too large' });
        return;
      }
      // ── NEDEN HER ZAMAN 400 ────────────────────────────────────────────
      // `fileFilter` reddettigi turlere `status: 415` isaretler, ancak
      // SEVK EDILMIS davranis 400'dur: global hata isleyicisi `err.status`
      // degerini kullanmiyordu ve `tests/upload.test.ts` bunu 400 olarak
      // BELGELIYOR. Bu duzeltmenin amaci 500 → 400 idi; mevcut 400 → 415
      // sozlesmesini DEGISTIRMEK degil. Istemciler kirilmasin diye
      // durum kodu OLDUGU GIBI birakilir.
      res.status(400).json({ error: e?.message || 'Invalid upload request' });
    });
  };
}

router.post('/', authMiddleware, limits.upload(), handleUploadErrors(smallUpload.single('file')), async (req, res) => {
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
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
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
  const cdnAdapter = getPrivateStorageAdapter();
  const cdnKey     = _privateStorageKey(finalFilename);
  let result;
  try {
    result = await cdnAdapter.uploadFile(finalPath, cdnKey ?? finalFilename, { contentType: finalMime });
  } catch (error) {
    try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch {}
    throw error;
  }

  // Sahiplik kaydı — DELETE /cdn bu tabloya bakacak
  const uploadKey = cdnKey ?? `uploads/${finalFilename}`;
  const authUser  = castAuthed(req).user as { id: string };
  await recordUploadOrRollback(authUser.id, uploadKey, safeOriginalName, finalMime, cdnAdapter, result.provider);

  res.json({
    // Never expose a remote public-origin URL for a private message attachment.
    // `/uploads/<id>` is authorized on every byte request and remote providers
    // are proxied through that same application boundary.
    url:      protectedUploadUrl(finalFilename),
    fileName: safeOriginalName.replace(/\.[^.]+$/, finalExt),
    fileType: finalMime,
    size:     req.file.size,
    ...(webpResult.converted && { webp: true }),
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
 *       409:
 *         description: Metadata/bytes conflict, or session no longer active
 *       411:
 *         description: Content-Length header missing or malformed
 *       413:
 *         description: Chunk over 10 MB or session over the file entitlement
 *       429:
 *         description: Rate, concurrent-session or temporary-storage quota exceeded
 *       503:
 *         description: Redis rate-limit or quota authority unavailable (fail closed)
 */
router.post('/chunk', authMiddleware, limits.uploadChunk(), async (req, res) => {
  const chunkAuthUser = castAuthed(req).user as { id: string };
  const metadata = validateChunkMetadata(
    req.headers as Record<string, string | string[] | undefined>,
    ALLOWED_TYPE_SET,
    MAX_FILE_SIZE,
    CHUNK_SIZE_LIMIT,
  );
  if (!metadata.ok) {
    const error = metadata.status === 413
      ? `File too large (max ${process.env.MAX_FILE_SIZE_MB || 2048}MB)`
      : metadata.error;
    return res.status(metadata.status).json({ error });
  }

  // The declared length is the quota lease: it is reserved before a single
  // body byte reaches disk, so it must be known up front. Node's HTTP parser
  // guarantees the delivered body never exceeds a declared Content-Length.
  const declaredLength = parseChunkContentLength(req.headers['content-length']);
  if (declaredLength === null) {
    return res.status(411).json({ error: 'Content-Length is required for chunk uploads' });
  }
  if (declaredLength > CHUNK_SIZE_LIMIT) {
    return res.status(413).json({ error: 'Single chunk too large (max 10MB per chunk)' });
  }

  const { uploadId, chunkIndex, totalChunks, fileName, fileType } = metadata.value;
  const sessionKey = chunkSessionKey(chunkAuthUser.id, uploadId);
  const sessionDir = path.join(CHUNK_DIR, sessionKey);
  const canonicalChunkPath = path.join(sessionDir, chunkFileName(chunkIndex));
  const manifestPath = path.join(sessionDir, 'manifest.json');
  const manifest = JSON.stringify({ uploadId, totalChunks, fileName, fileType });
  const sessionTtlSeconds = chunkQuotaConfig().sessionTtlMs / 1000;
  const sessionAuthorityUnavailable = (error: unknown) => {
    logger.error({ err: error, event: 'upload.chunk_session_authority_unavailable' }, 'Chunk session authority unavailable; chunk rejected');
    res.set('Retry-After', '1');
    return res.status(503).json({ error: 'Upload quota service temporarily unavailable' });
  };

  // An upload that already completed answers every retry with the SAME
  // completion: the final response can be lost after finalization closed the
  // session, and a retry must not open a new (orphan) session instead.
  let finalized: Awaited<ReturnType<typeof readFinalizedChunkUpload>>;
  try {
    finalized = await readFinalizedChunkUpload(sessionKey);
  } catch (error) {
    return sessionAuthorityUnavailable(error);
  }
  if (finalized) {
    if (finalized.manifest !== manifest) {
      return res.status(409).json({ error: 'Upload id is already bound to different metadata' });
    }
    return res.json(finalized.result);
  }

  // Multi-node: a session is staged on the node that received its first chunk
  // unless every node shares the upload root. A chunk that reaches a node
  // without the session's staging must fail loudly — accepting it would stage
  // a partial set that can never be finalized while every chunk returns 200.
  if (CHUNK_STAGING_AUTHORITY && !fs.existsSync(manifestPath)) {
    let stagedOn: string | null;
    try {
      stagedOn = await readChunkStagingNode(sessionKey);
    } catch (error) {
      return sessionAuthorityUnavailable(error);
    }
    if (stagedOn && stagedOn !== CHUNK_NODE_ID) {
      logger.warn({ uploadId, stagingNode: stagedOn, event: 'upload.chunk_staged_elsewhere' },
        'Chunk reached a node that does not hold the session staging');
      return res.status(409).json({
        error: 'This upload is staged on another server node; route the upload to that node or restart it',
        code: 'CHUNK_STAGED_ELSEWHERE',
        stagingNode: stagedOn,
      });
    }
    if (stagedOn === CHUNK_NODE_ID) {
      // This node staged the session but no longer has it (restart without
      // persistent storage, or the idle sweep). The committed chunks are gone:
      // return the quota the session still holds and make the client restart.
      await releaseChunkQuotaSession(chunkAuthUser.id, sessionKey).catch((error: unknown) => {
        logger.warn({ err: error, uploadId, event: 'upload.chunk_quota_release_failed' }, 'Chunk quota release failed; entry will expire');
      });
      await clearChunkStagingNode(sessionKey).catch(() => undefined);
      logger.warn({ uploadId, event: 'upload.chunk_staging_lost' }, 'Chunk session staging lost on this node; client must restart');
      return res.status(409).json({ error: 'Upload staging was lost; restart the upload', code: 'CHUNK_STAGING_LOST' });
    }
  }
  const boostLimitBytes = await getBoostUploadLimitBytes(chunkAuthUser.id);
  const sessionMaxBytes = Math.min(MAX_FILE_SIZE, boostLimitBytes);

  // A retry of an already committed chunk adds no committed bytes, so it is
  // not measured against the per-session entitlement (only the user total).
  const reserve = (retry: boolean) => reserveChunkQuota({
    userId: chunkAuthUser.id,
    sessionKey,
    bytes: declaredLength,
    retry,
    sessionMaxBytes,
  });
  let reservation: ChunkReservation;
  try {
    reservation = await reserve(fs.existsSync(canonicalChunkPath));
    if (!reservation.ok && reservation.reason === 'SESSION_BYTES' && fs.existsSync(canonicalChunkPath)) {
      // The same index was committed concurrently between the check and the
      // reservation: this request is a retry after all.
      reservation = await reserve(true);
    }
  } catch (error) {
    logger.error({ err: error, event: 'upload.chunk_quota_unavailable' }, 'Chunk quota authority unavailable; chunk rejected');
    res.set('Retry-After', '1');
    return res.status(503).json({ error: 'Upload quota service temporarily unavailable' });
  }

  if (!reservation.ok) {
    if (reservation.reason === 'SESSIONS') {
      res.set('Retry-After', '30');
      return res.status(429).json({
        error: 'Too many concurrent chunked uploads',
        code: 'CHUNK_SESSION_LIMIT',
        maxSessions: chunkQuotaConfig().maxSessions,
      });
    }
    if (reservation.reason === 'USER_BYTES') {
      res.set('Retry-After', '30');
      return res.status(429).json({ error: 'Chunked upload storage quota exceeded', code: 'CHUNK_QUOTA_EXCEEDED' });
    }
    // SESSION_BYTES: the distinct committed chunks plus this new one already
    // exceed the entitlement, so finalization can only reject this file.
    // Purge now (as finalization would) unless another request of the same
    // session is still streaming into the directory.
    if (reservation.sessionInflight === 0) {
      try {
        await releaseChunkQuotaSession(chunkAuthUser.id, sessionKey);
        fs.rmSync(sessionDir, { recursive: true, force: true });
        if (CHUNK_STAGING_AUTHORITY) await clearChunkStagingNode(sessionKey).catch(() => undefined);
      } catch (error) {
        logger.warn({ err: error, uploadId, event: 'upload.chunk_session_purge_failed' }, 'Over-limit chunk session could not be purged; the sweeper will reclaim it');
      }
    }
    const maxMB = Math.round(sessionMaxBytes / 1024 / 1024);
    if (boostLimitBytes <= MAX_FILE_SIZE) {
      return res.status(413).json({ error: `File too large. Your server's boost tier allows max ${maxMB} MB.`, code: 'BOOST_LIMIT' });
    }
    return res.status(413).json({ error: `File too large (max ${maxMB}MB)` });
  }

  const { lease } = reservation;
  // Every exit path that does not commit the lease returns its bytes. The
  // response `close` event is the backstop for aborts and early returns; a
  // refund that cannot reach the authority simply expires with the lease.
  const refundLease = (): void => {
    lease.refund().catch((error: unknown) => {
      logger.warn({ err: error, uploadId, event: 'upload.chunk_lease_refund_failed' }, 'Chunk quota lease refund failed; it will expire');
    });
  };
  res.once('close', refundLease);

  if (reservation.newSession) {
    // A session the quota does not know (never seen, expired or forgotten) may
    // still have an idle directory from an abandoned upload. Its bytes are
    // not accounted, so it is discarded instead of silently resumed.
    try { purgeChunkSessionIfIdle(sessionDir, Date.now(), chunkQuotaConfig().sessionTtlMs); } catch { /* sweeper fallback */ }
  }
  fs.mkdirSync(sessionDir, { recursive: true });

  // A reused uploadId must describe the exact same logical file. Without this
  // invariant one account could accidentally mix chunks from two uploads.
  try {
    fs.writeFileSync(manifestPath, manifest, { flag: 'wx', encoding: 'utf8' });
    if (CHUNK_STAGING_AUTHORITY) {
      await markChunkStagingNode(sessionKey, sessionTtlSeconds).catch((error: unknown) => {
        logger.warn({ err: error, uploadId, event: 'upload.chunk_staging_mark_failed' }, 'Chunk staging node could not be recorded');
      });
    }
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code !== 'EEXIST') {
      fs.rm(sessionDir, { recursive: true, force: true }, () => {});
      throw error;
    }
    try {
      if (fs.readFileSync(manifestPath, 'utf8') !== manifest) {
        return res.status(409).json({ error: 'Upload id is already bound to different metadata' });
      }
    } catch (readError) {
      fs.rm(sessionDir, { recursive: true, force: true }, () => {});
      throw readError;
    }
  }

  // Write into a unique temporary path first. Only a complete request body is
  // atomically committed to the canonical chunk name, so aborts and concurrent
  // retries cannot leave a partially-overwritten committed chunk.
  const tempChunkPath = path.join(sessionDir, `${chunkFileName(chunkIndex)}.part_${uuidv4()}`);
  const writeStream = fs.createWriteStream(tempChunkPath, { flags: 'wx' });

  let chunkSize = 0;
  let rejected = false;
  let requestAborted = false;
  const discardTemp = (): void => {
    try { if (fs.existsSync(tempChunkPath)) fs.unlinkSync(tempChunkPath); } catch {}
  };

  req.on('aborted', () => {
    requestAborted = true;
    writeStream.destroy();
    discardTemp();
  });
  req.on('data', (d: Buffer) => {
    if (rejected || requestAborted) return;
    chunkSize += d.length;
    // Defence in depth: the parser already bounds the body by Content-Length,
    // and Content-Length is bounded by CHUNK_SIZE_LIMIT above.
    if (chunkSize > CHUNK_SIZE_LIMIT || chunkSize > declaredLength) {
      rejected = true;
      req.unpipe(writeStream);
      req.resume();
      // Answer only after `close` (below) has removed the temp file, so the
      // refusal never races a late open that would recreate it.
      writeStream.once('close', () => {
        if (!res.headersSent) res.status(413).json({ error: 'Single chunk too large (max 10MB per chunk)' });
      });
      writeStream.destroy();
    }
  });

  req.pipe(writeStream);
  // A rejection or abort can land before the stream's asynchronous open has
  // created the temp file; `discardTemp()` above then finds nothing and the
  // late open leaves an unaccounted `.part` behind. `close` fires after the
  // descriptor is released, so the file is removed for certain.
  writeStream.on('close', () => {
    if (rejected || requestAborted) discardTemp();
  });
  writeStream.on('error', () => {
    discardTemp();
    if (rejected || requestAborted || res.headersSent) return;
    res.status(500).json({ error: 'Chunk write failed' });
  });
  writeStream.on('finish', async () => {
    if (rejected || requestAborted || res.headersSent) return;

    // Account the bytes BEFORE they become a committed chunk. If the
    // authority cannot confirm, nothing is committed (fail closed); an
    // unconfirmed lease only over-counts until it expires.
    let quotaCommit: 'committed' | 'gone';
    try {
      quotaCommit = await lease.commit();
    } catch (error) {
      discardTemp();
      logger.error({ err: error, uploadId, event: 'upload.chunk_quota_commit_failed' }, 'Chunk quota commit failed; chunk discarded');
      res.set('Retry-After', '1');
      return res.status(503).json({ error: 'Upload quota service temporarily unavailable' });
    }
    if (quotaCommit === 'gone') {
      discardTemp();
      return res.status(409).json({ error: 'Upload session is no longer active; retry the chunk', code: 'CHUNK_SESSION_EXPIRED' });
    }

    let commitResult: 'stored' | 'duplicate' | 'conflict';
    try {
      commitResult = commitChunkTempFile(sessionDir, chunkIndex, tempChunkPath);
    } catch (error) {
      await lease.uncommit().catch(() => undefined);
      logger.error({ err: error, uploadId, chunkIndex, event: 'upload.chunk_commit_failed' }, 'Chunk commit failed');
      return res.status(500).json({ error: 'Chunk commit failed' });
    }
    if (commitResult !== 'stored') {
      // Duplicate/conflicting bytes were not added to the session. A failed
      // correction over-counts (safe) until the session is released.
      await lease.uncommit().catch((error: unknown) => {
        logger.warn({ err: error, uploadId, event: 'upload.chunk_quota_uncommit_failed' }, 'Chunk quota correction failed');
      });
    }
    if (commitResult === 'conflict') {
      return res.status(409).json({ error: 'Chunk retry bytes do not match the committed chunk' });
    }

    // Any arrival can be the one that completes the set. This makes the API
    // genuinely resumable/out-of-order instead of assuming the numerically-last
    // chunk also arrives last.
    if (!allChunksPresent(sessionDir, totalChunks)) {
      return res.json({ done: false, received: chunkIndex, duplicate: commitResult === 'duplicate' });
    }

    let finalization;
    try {
      finalization = tryAcquireChunkFinalization(sessionDir);
    } catch (error) {
      logger.error({ err: error, uploadId, event: 'upload.chunk_finalize_lock_failed' }, 'Chunk finalization lock failed');
      return res.status(500).json({ error: 'Could not acquire upload finalization lock' });
    }
    if (!finalization.acquired) {
      return res.json({ done: false, received: chunkIndex, finalizing: true });
    }

    const ext       = canonicalExtensionForMime(fileType) ?? '';
    const finalName = `${uuidv4()}${ext}`;
    const finalPath = path.join(UPLOAD_DIR, finalName);
    let cleanupPath = finalPath;
    let purgeSession = false;
    // Terminal outcomes remove the session directory AND return its quota
    // before the client hears back, so a client that immediately starts its
    // next upload is not refused a slot this upload still appears to hold.
    let sessionClosed = false;
    const closeSession = async (): Promise<void> => {
      if (sessionClosed) return;
      sessionClosed = true;
      try {
        await fs.promises.rm(sessionDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn({ err: error, uploadId, event: 'upload.chunk_session_purge_failed' }, 'Chunk session directory could not be removed; the sweeper will reclaim it');
      }
      // If the authority is unreachable the entry over-counts until it goes
      // stale; it never under-counts.
      await releaseChunkQuotaSession(chunkAuthUser.id, sessionKey).catch((error: unknown) => {
        logger.warn({ err: error, uploadId, event: 'upload.chunk_quota_release_failed' }, 'Chunk quota release failed; entry will expire');
      });
      if (CHUNK_STAGING_AUTHORITY) await clearChunkStagingNode(sessionKey).catch(() => undefined);
    };

    try {
      await mergeChunkFiles(sessionDir, totalChunks, finalPath);
      const { size } = fs.statSync(finalPath);
      // Re-read the live entitlement: a boost can expire mid-upload.
      const finalBoostLimitBytes = await getBoostUploadLimitBytes(chunkAuthUser.id);
      const sizePolicy = validateFinalUploadSize(size, MAX_FILE_SIZE, finalBoostLimitBytes);
      if (!sizePolicy.ok) {
        purgeSession = true;
        fs.unlink(finalPath, () => {});
        await closeSession();
        const maxMB = Math.round(sizePolicy.maxBytes / 1024 / 1024);
        if (sizePolicy.code === 'BOOST_LIMIT') {
          return res.status(413).json({
            error: `File too large. Your server's boost tier allows max ${maxMB} MB.`,
            code: 'BOOST_LIMIT',
          });
        }
        return res.status(413).json({ error: `File too large (max ${maxMB}MB)` });
      }
      if (!checkMagicBytes(finalPath, fileType)) {
        purgeSession = true;
        fs.unlink(finalPath, () => {});
        await closeSession();
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
        purgeSession = true;
        try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch {}
        await closeSession();
        const e = scanErr as { statusCode?: number; message?: string; code?: string };
        return res.status(e.statusCode || 422).json({ error: e.message, code: e.code });
      }

      if (fileType === 'image/svg+xml') {
        const svgResult = await sanitizeSvgFile(finalPath);
        if (!svgResult.safe) {
          purgeSession = true;
          fs.unlink(finalPath, () => {});
          await closeSession();
          return res.status(422).json({ error: 'SVG contains dangerous content', code: 'SVG_UNSAFE' });
        }
      }

      const chunkWebp      = await maybeConvertToWebP(finalPath, fileType);
      const chunkFinalPath = chunkWebp.filePath;
      cleanupPath = chunkFinalPath;
      const chunkFinalMime = chunkWebp.mimetype;
      const chunkFinalName = chunkWebp.converted ? finalName.replace(/\.[^.]+$/, '.webp') : finalName;
      const safeFileName   = path.basename(fileName).replace(/[^\w.-]/g, '_').slice(0, 200);

      const cdnAdapter = getPrivateStorageAdapter();
      const cdnKey = _privateStorageKey(chunkFinalName);
      let result;
      try {
        result = await cdnAdapter.uploadFile(chunkFinalPath, cdnKey ?? chunkFinalName, { contentType: chunkFinalMime });
      } catch (error) {
        try { if (fs.existsSync(chunkFinalPath)) fs.unlinkSync(chunkFinalPath); } catch {}
        throw error;
      }

      await recordUploadOrRollback(chunkAuthUser.id, cdnKey ?? `uploads/${chunkFinalName}`, safeFileName, chunkFinalMime, cdnAdapter, result.provider);
      const completion = {
        done:     true as const,
        url:      protectedUploadUrl(chunkFinalName),
        fileName: safeFileName.replace(/\.[^.]+$/, chunkWebp.converted ? '.webp' : ext),
        fileType: chunkFinalMime,
        size,
      };
      // Recorded BEFORE the session closes, so no retry can fall into the gap
      // between "session gone" and "completion known".
      await recordFinalizedChunkUpload(sessionKey, { manifest, result: completion }, sessionTtlSeconds).catch((error: unknown) => {
        logger.warn({ err: error, uploadId, event: 'upload.chunk_completion_record_failed' }, 'Chunk upload completion could not be recorded; a lost response cannot be replayed');
      });
      purgeSession = true;
      await closeSession();

      res.json(completion);
    } catch (e: unknown) {
      // Storage/network/DB transient failures keep the committed chunks so the
      // client can retry a chunk and re-enter finalization without re-uploading
      // the whole file. Terminal validation failures above explicitly purge.
      try { if (fs.existsSync(cleanupPath)) fs.unlinkSync(cleanupPath); } catch {}
      try { if (cleanupPath !== finalPath && fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch {}
      const err = e as Error;
      if (!res.headersSent) res.status(500).json({ error: 'Finalization failed: ' + err.message });
    } finally {
      try { finalization.release(); } catch (error) {
        logger.warn({ err: error, uploadId, event: 'upload.chunk_finalize_unlock_failed' }, 'Chunk finalization lock cleanup failed');
      }
      if (purgeSession) await closeSession();
    }
  });
});


// ── SERVER GIF UPLOAD ─────────────────────────────────────────────────────────
const SERVER_GIF_DIR = path.join(UPLOAD_DIR, 'server-gifs');
if (!fs.existsSync(SERVER_GIF_DIR)) fs.mkdirSync(SERVER_GIF_DIR, { recursive: true });
const serverGifStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SERVER_GIF_DIR),
  filename: (_req, file, cb) => {
    const ext = canonicalExtensionForMime(file.mimetype) ?? '';
    cb(null, `gif_${uuidv4()}${ext}`);
  },
});
const gifUpload = multer({
  storage: serverGifStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
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
router.post('/server-gif', authMiddleware, limits.upload(), handleUploadErrors(gifUpload.single('gif')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const gifAuthUser = castAuthed(req).user as { id: string };
  const limitBytes = await getBoostUploadLimitBytes(gifAuthUser.id);
  if (req.file.size > limitBytes) {
    fs.unlink(req.file.path, () => {});
    const limitMB = Math.round(limitBytes / 1024 / 1024);
    return res.status(413).json({
      error: `File too large. Your server's boost tier allows max ${limitMB} MB.`,
      code: 'BOOST_LIMIT',
    });
  }
  if (!checkMagicBytes(req.file.path, req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'File content mismatch' });
  }
  try {
    await scanFile(req.file.path, {
      userId: req.user?.id,
      username: req.user?.username,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      fileSize: req.file.size,
    });
  } catch (scanErr: unknown) {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    const e = scanErr as { statusCode?: number; message?: string; code?: string };
    return res.status(e.statusCode || 422).json({ error: e.message, code: e.code });
  }
  const store  = getStorageAdapter();
  const cdnKey = getProvider() !== 'local' ? `uploads/server-gifs/${req.file.filename}` : null;
  let result;
  try {
    result = await store.uploadFile(req.file.path, cdnKey ?? req.file.filename, { contentType: req.file.mimetype });
  } catch (error) {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    throw error;
  }
  await recordUploadOrRollback(gifAuthUser.id, cdnKey ?? `uploads/server-gifs/${req.file.filename}`, req.file.originalname, req.file.mimetype, store, result.provider);
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
  const key = normalizeUploadKey(req.query.key);
  if (!key) {
    return res.status(400).json({ error: 'Geçersiz CDN key' });
  }

  const authedUser = castAuthed(req).user as { id: string };
  const userId = authedUser.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  // ── Sahiplik Kontrolü ─────────────────────────────────────────────────────
  // Admin kullanıcılar doğrudan silebilir.
  const isAdmin = await isDatabaseAdmin(userId);

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

  // Ownership is necessary but not sufficient: a file can be referenced by
  // messages/GDM/DM/GIF/emoji/soundboard/voice rows after upload. Physical
  // deletion must fail closed while any canonical live reference remains.
  if (await hasLiveUploadReference(db._pool, key)) {
    return res.status(409).json({ error: 'Dosya hâlâ kullanımda', code: 'UPLOAD_IN_USE' });
  }

  // Root-level `uploads/<file>` objects are protected attachments and live in
  // the independent private storage boundary. Public subdirectory assets keep
  // using the public CDN adapter.
  const protectedObject = /^uploads\/[^/]+$/.test(key);
  const provider = protectedObject ? getPrivateStorageProvider() : getProvider();
  const cdnAdapter = protectedObject ? getPrivateStorageAdapter() : getStorageAdapter();
  await cdnAdapter.deleteFile(storageDeleteKey(key, provider));

  // The object is gone; retire its ownership metadata too. Do this after the
  // physical delete so a transient storage failure does not make a retry lose
  // authorization. Metadata cleanup failure is non-destructive and observable.
  try {
    const { default: loaderDb } = await import('../db/loader');
    const uploads = (loaderDb as unknown as { uploads?: { remove?: (q: Record<string, unknown>) => Promise<unknown>; delete?: (q: Record<string, unknown>) => Promise<unknown> } }).uploads;
    if (uploads?.remove) await uploads.remove({ key });
    else if (uploads?.delete) await uploads.delete({ key });
  } catch (error) {
    logger.warn({ err: error, key, event: 'upload.ownership_delete_failed' },
      'Physical upload deleted but ownership metadata cleanup failed');
  }
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
