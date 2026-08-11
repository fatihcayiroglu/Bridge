import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth';
import { redisRateLimiter, cache, redisClient, isRedisAvailable } from '../lib/redisAdapter';
import { scanFile } from '../lib/contentScanner';
import { sanitizeSvgFile } from '../lib/svgSanitizer';
import { getStorageAdapter, getProvider } from '../lib/storageAdapter';
import { db } from '../db/postgres';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '../uploads');
const CHUNK_DIR = path.join(UPLOAD_DIR, '_chunks-secure');
const CHUNK_SIZE_LIMIT = 10 * 1024 * 1024;
const MAX_FILE_SIZE = Math.min(parseInt(process.env.MAX_FILE_SIZE_MB || '5120', 10) * 1024 * 1024, 2 * 1024 * 1024 * 1024);
const MAX_CHUNKS = Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE_LIMIT);
const SESSION_TTL = 60 * 60;
const ORPHAN_TTL_MS = SESSION_TTL * 1000 * 2;

const ALLOWED_TYPES = new Set([
  'image/jpeg','image/png','image/gif','image/webp','image/svg+xml','image/tiff','image/bmp',
  'application/pdf','text/plain','text/markdown','text/csv','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation','application/zip',
  'application/x-rar-compressed','application/x-7z-compressed','application/x-tar','application/gzip',
  'application/json','text/xml','application/xml','audio/mpeg','audio/ogg','audio/wav','audio/flac',
  'audio/aac','audio/webm','audio/mp4','video/mp4','video/webm','video/ogg','video/quicktime','video/x-msvideo',
]);

const BOOST_LIMITS: Record<number, number> = { 0: 25, 1: 25, 2: 50, 3: 100 };
const localLocks = new Map<string, Promise<void>>();

function safeUploadId(value: unknown): string {
  return String(value || '').replace(/[^a-z0-9-]/gi, '').slice(0, 64);
}

function sessionKey(userId: string, uploadId: string): string {
  return `secure-upload:${userId}:${uploadId}`;
}

function sessionDir(userId: string, uploadId: string): string {
  const digest = crypto.createHash('sha256').update(`${userId}:${uploadId}`).digest('hex');
  return path.join(CHUNK_DIR, digest);
}

async function getUserLimitBytes(userId: string): Promise<number> {
  try {
    const result = await db._pool.query<{ boostTier: number }>(
      `SELECT COALESCE(MAX(s."boostTier"), 0) AS "boostTier"
       FROM members m JOIN servers s ON s._id = m."serverId" WHERE m."userId" = $1`,
      [userId],
    );
    const tier = result.rows[0]?.boostTier ?? 0;
    return Math.min(MAX_FILE_SIZE, (BOOST_LIMITS[tier] ?? 25) * 1024 * 1024);
  } catch {
    return Math.min(MAX_FILE_SIZE, 25 * 1024 * 1024);
  }
}

async function acquireLock(key: string): Promise<() => Promise<void>> {
  const token = crypto.randomBytes(16).toString('hex');
  const lockKey = `secure-upload-lock:${key}`;
  if (isRedisAvailable()) {
    const client = redisClient() as unknown as { set: (k: string, v: string, o: { NX: boolean; EX: number }) => Promise<string | null> };
    for (let i = 0; i < 30; i++) {
      const acquired = await client.set(lockKey, token, { NX: true, EX: 30 });
      if (acquired) break;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (i === 29) throw Object.assign(new Error('Upload finalization is busy'), { statusCode: 409 });
    }
    return async () => {
      const script = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
      await cache.luaEval(script, [lockKey], [token]).catch(() => {});
    };
  }

  const previous = localLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  localLocks.set(key, previous.then(() => current));
  await previous;
  return async () => {
    release();
    if (localLocks.get(key) === current) localLocks.delete(key);
  };
}

async function writeChunk(req: express.Request, target: string): Promise<number> {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > CHUNK_SIZE_LIMIT) {
    throw Object.assign(new Error('Invalid or oversized chunk'), { statusCode: 413 });
  }

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomBytes(8).toString('hex')}.part`;
  const out = fs.createWriteStream(temp, { flags: 'wx' });
  let bytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (err: unknown) => { req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAborted); out.destroy(); reject(err); };
      const onData = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > CHUNK_SIZE_LIMIT) fail(Object.assign(new Error('Chunk too large'), { statusCode: 413 }));
        else if (!out.write(chunk)) req.pause();
      };
      const onEnd = () => { out.end(); };
      const onAborted = () => fail(Object.assign(new Error('Upload aborted'), { statusCode: 400 }));
      out.on('drain', () => req.resume());
      out.once('finish', resolve);
      out.once('error', reject);
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('aborted', onAborted);
    });

    if (bytes !== contentLength) throw Object.assign(new Error('Chunk length mismatch'), { statusCode: 400 });
    await fs.promises.rename(temp, target);
    return bytes;
  } catch (err) {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

async function allChunksPresent(dir: string, totalChunks: number): Promise<boolean> {
  for (let i = 0; i < totalChunks; i++) {
    const p = path.join(dir, `chunk_${String(i).padStart(6, '0')}`);
    try { await fs.promises.access(p, fs.constants.R_OK); } catch { return false; }
  }
  return true;
}

async function mergeChunks(dir: string, totalChunks: number, finalPath: string, expectedMax: number): Promise<number> {
  const out = fs.createWriteStream(finalPath, { flags: 'wx' });
  let total = 0;
  try {
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(dir, `chunk_${String(i).padStart(6, '0')}`);
      const stat = await fs.promises.stat(chunkPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > CHUNK_SIZE_LIMIT) throw new Error('Invalid chunk');
      total += stat.size;
      if (total > expectedMax) throw Object.assign(new Error('File too large'), { statusCode: 413 });
      await new Promise<void>((resolve, reject) => {
        const input = fs.createReadStream(chunkPath);
        input.on('error', reject);
        input.on('end', resolve);
        input.pipe(out, { end: false });
      });
    }
    await new Promise<void>((resolve, reject) => { out.once('finish', resolve); out.once('error', reject); out.end(); });
    return total;
  } catch (err) {
    out.destroy();
    await fs.promises.rm(finalPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function cleanupOrphans(): Promise<void> {
  try {
    const entries = await fs.promises.readdir(CHUNK_DIR, { withFileTypes: true });
    const cutoff = Date.now() - ORPHAN_TTL_MS;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(CHUNK_DIR, entry.name);
      const stat = await fs.promises.stat(dir).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch { /* best effort cleanup */ }
}

void fs.promises.mkdir(CHUNK_DIR, { recursive: true }).then(cleanupOrphans).catch(() => {});
const cleanupTimer = setInterval(() => { void cleanupOrphans(); }, 10 * 60 * 1000);
cleanupTimer.unref?.();

router.post('/chunk', authMiddleware, redisRateLimiter({ windowMs: 60_000, max: 30, keyPrefix: 'upload-chunk' }), async (req, res) => {
  const userId = castAuthed(req).user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const uploadId = safeUploadId(req.headers['x-upload-id']);
  const chunkIndex = Number(req.headers['x-chunk-index']);
  const totalChunks = Number(req.headers['x-total-chunks']);
  const fileName = String(req.headers['x-file-name'] || 'file').slice(0, 200);
  const fileType = String(req.headers['x-file-type'] || '').slice(0, 100);

  if (!uploadId || !Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks)) return res.status(400).json({ error: 'Invalid chunk metadata' });
  if (chunkIndex < 0 || totalChunks < 1 || chunkIndex >= totalChunks || totalChunks > MAX_CHUNKS) return res.status(400).json({ error: 'Invalid chunk range' });
  if (!ALLOWED_TYPES.has(fileType)) return res.status(415).json({ error: 'File type not allowed' });
  if (!path.basename(fileName) || fileName.includes('\0')) return res.status(400).json({ error: 'Invalid file name' });

  const limitBytes = await getUserLimitBytes(userId);
  const declaredMax = Math.min(limitBytes, MAX_FILE_SIZE);
  if (totalChunks * CHUNK_SIZE_LIMIT > declaredMax + CHUNK_SIZE_LIMIT) return res.status(413).json({ error: 'File exceeds your upload limit' });

  const key = sessionKey(userId, uploadId);
  const dir = sessionDir(userId, uploadId);
  const session = await cache.get<{ userId: string; fileName: string; fileType: string; totalChunks: number; maxBytes: number }>(key);
  const metadata = { userId, fileName, fileType, totalChunks, maxBytes: declaredMax };

  if (session && (session.userId !== userId || session.fileName !== fileName || session.fileType !== fileType || session.totalChunks !== totalChunks || session.maxBytes !== declaredMax)) {
    return res.status(409).json({ error: 'Upload session metadata cannot be changed' });
  }
  if (!session) await cache.set(key, metadata, SESSION_TTL);

  await fs.promises.mkdir(dir, { recursive: true });
  const chunkPath = path.join(dir, `chunk_${String(chunkIndex).padStart(6, '0')}`);

  try {
    const existing = await fs.promises.stat(chunkPath).catch(() => null);
    if (existing) {
      const contentLength = Number(req.headers['content-length'] || 0);
      if (existing.size !== contentLength) return res.status(409).json({ error: 'Chunk already exists with different size' });
    } else {
      await writeChunk(req, chunkPath);
    }

    if (!(await allChunksPresent(dir, totalChunks))) return res.json({ done: false, received: chunkIndex });

    const release = await acquireLock(key);
    try {
      if (!(await allChunksPresent(dir, totalChunks))) return res.json({ done: false, received: chunkIndex });

      const finalName = `${uuidv4()}${path.extname(fileName).slice(0, 10).toLowerCase()}`;
      const finalPath = path.join(UPLOAD_DIR, finalName);
      const size = await mergeChunks(dir, totalChunks, finalPath, declaredMax);

      if (size > declaredMax || size > MAX_FILE_SIZE) {
        await fs.promises.rm(finalPath, { force: true });
        return res.status(413).json({ error: 'File too large' });
      }

      const { checkMagicBytes } = await import('./upload');
      if (!checkMagicBytes(finalPath, fileType)) {
        await fs.promises.rm(finalPath, { force: true });
        return res.status(400).json({ error: 'File content does not match its declared type' });
      }

      try {
        await scanFile(finalPath, { userId, username: req.user?.username, filename: fileName, mimetype: fileType, fileSize: size });
        if (fileType === 'image/svg+xml') {
          const svgResult = await sanitizeSvgFile(finalPath);
          if (!svgResult.safe) throw Object.assign(new Error('SVG contains dangerous content'), { statusCode: 422 });
        }
      } catch (scanErr: unknown) {
        await fs.promises.rm(finalPath, { force: true });
        const e = scanErr as { statusCode?: number; message?: string; code?: string };
        return res.status(e.statusCode || 422).json({ error: e.message, code: e.code });
      }

      const adapter = getStorageAdapter();
      const cdnKey = getProvider() !== 'local' ? `uploads/${finalName}` : finalName;
      const result = await adapter.uploadFile(finalPath, cdnKey);
      const { default: uploadDb } = await import('../db/loader');
      await (uploadDb as unknown as { uploads: { insert(doc: Record<string, unknown>): Promise<unknown> } }).uploads.insert({
        _id: uuidv4(), userId, key: getProvider() !== 'local' ? `uploads/${finalName}` : `uploads/${finalName}`,
        originalName: path.basename(fileName).replace(/[^\w.-]/g, '_').slice(0, 200), mimeType: fileType, createdAt: Date.now(),
      });

      await fs.promises.rm(finalPath, { force: true }).catch(() => {});
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      await cache.del(key);
      return res.json({ done: true, url: result.url, fileName: path.basename(fileName), fileType, size, ...(result.provider !== 'local' && { cdn: result.provider, key: result.key }) });
    } finally {
      await release();
    }
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string };
    return res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Chunk upload failed' });
  }
});

export default router;
