import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

export interface ChunkMetadata {
  uploadId: string;
  chunkIndex: number;
  totalChunks: number;
  fileName: string;
  fileType: string;
}

export type ChunkMetadataResult =
  | { ok: true; value: ChunkMetadata }
  | { ok: false; status: 400 | 413 | 415; error: string };

export type FinalUploadSizeResult =
  | { ok: true }
  | { ok: false; status: 413; code: 'GLOBAL_LIMIT' | 'BOOST_LIMIT'; maxBytes: number };

/**
 * Final merged bytes are authoritative. Chunk-count bounds protect resources,
 * but they must not become a policy bypass for the smaller per-user/boost
 * upload limit enforced by the single-upload route.
 */
export function validateFinalUploadSize(
  actualBytes: number,
  globalMaxBytes: number,
  userMaxBytes: number,
): FinalUploadSizeResult {
  if (!Number.isFinite(actualBytes) || actualBytes < 0) {
    return { ok: false, status: 413, code: 'GLOBAL_LIMIT', maxBytes: globalMaxBytes };
  }
  if (actualBytes > globalMaxBytes) {
    return { ok: false, status: 413, code: 'GLOBAL_LIMIT', maxBytes: globalMaxBytes };
  }
  if (actualBytes > userMaxBytes) {
    return { ok: false, status: 413, code: 'BOOST_LIMIT', maxBytes: userMaxBytes };
  }
  return { ok: true };
}

function oneHeader(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  return value;
}

function parseCanonicalNonNegativeInt(value: string | null): number | null {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * A chunk's declared body length: one canonical, non-negative decimal header.
 * `null` for a missing (e.g. `Transfer-Encoding: chunked`), repeated or
 * malformed value.
 */
export function parseChunkContentLength(value: string | string[] | undefined): number | null {
  return parseCanonicalNonNegativeInt(oneHeader(value));
}

/**
 * Chunk metadata is intentionally strict. Silently stripping upload-id bytes or
 * accepting signed/partial integer strings can alias two sessions or create
 * impossible chunk paths.
 */
export function validateChunkMetadata(
  headers: Record<string, string | string[] | undefined>,
  allowedTypes: ReadonlySet<string>,
  maxFileSize: number,
  chunkSizeLimit: number,
): ChunkMetadataResult {
  const uploadId = oneHeader(headers['x-upload-id']);
  const indexRaw = oneHeader(headers['x-chunk-index']);
  const totalRaw = oneHeader(headers['x-total-chunks']);
  const nameRaw = oneHeader(headers['x-file-name']);
  const typeRaw = oneHeader(headers['x-file-type']);

  if (!uploadId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(uploadId)) {
    return { ok: false, status: 400, error: 'Invalid x-upload-id' };
  }
  const chunkIndex = parseCanonicalNonNegativeInt(indexRaw);
  const totalChunks = parseCanonicalNonNegativeInt(totalRaw);
  if (chunkIndex === null || totalChunks === null || totalChunks < 1 || chunkIndex >= totalChunks) {
    return { ok: false, status: 400, error: 'Invalid chunk index/total metadata' };
  }
  if (!nameRaw || nameRaw.length > 200 || /[\u0000-\u001f\u007f]/.test(nameRaw)) {
    return { ok: false, status: 400, error: 'Invalid x-file-name' };
  }
  if (!typeRaw || typeRaw.length > 100 || !allowedTypes.has(typeRaw)) {
    return { ok: false, status: 415, error: 'File type not allowed' };
  }

  const maxChunks = Math.max(1, Math.ceil(maxFileSize / chunkSizeLimit));
  if (totalChunks > maxChunks) {
    return { ok: false, status: 413, error: 'File too large' };
  }

  return {
    ok: true,
    value: {
      uploadId,
      chunkIndex,
      totalChunks,
      fileName: nameRaw,
      fileType: typeRaw,
    },
  };
}

/** A user-scoped opaque key prevents cross-account uploadId collisions. */
export function chunkSessionKey(userId: string, uploadId: string): string {
  return crypto.createHash('sha256').update(userId).update('\0').update(uploadId).digest('hex');
}


/** Canonical on-disk name for a committed chunk. */
export function chunkFileName(chunkIndex: number): string {
  return `chunk_${String(chunkIndex).padStart(6, '0')}`;
}

/**
 * Commit a fully-written temporary chunk atomically.
 *
 * `linkSync` is intentional: the temporary file lives in the same session
 * directory, so creating the canonical hard link is an atomic "create if
 * absent" operation. Concurrent retries can therefore never overwrite a
 * previously committed chunk. If the canonical path already exists, an
 * identical retry is idempotent while different bytes are rejected.
 */
export function commitChunkTempFile(
  sessionDir: string,
  chunkIndex: number,
  tempPath: string,
): 'stored' | 'duplicate' | 'conflict' {
  const canonicalPath = path.join(sessionDir, chunkFileName(chunkIndex));
  try {
    fs.linkSync(tempPath, canonicalPath);
    return 'stored';
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code !== 'EEXIST') throw error;

    const existing = fs.statSync(canonicalPath);
    const incoming = fs.statSync(tempPath);
    if (existing.size !== incoming.size) return 'conflict';

    const hash = (filePath: string): string => crypto.createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex');
    return hash(canonicalPath) === hash(tempPath) ? 'duplicate' : 'conflict';
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* session cleanup is the fallback */ }
  }
}


/**
 * Merge committed chunks in canonical order. Each chunk is piped through a
 * fresh write stream so stream failures close their descriptors deterministically.
 * A failed merge never leaves a partial final artifact behind.
 */
export async function mergeChunkFiles(
  sessionDir: string,
  totalChunks: number,
  finalPath: string,
): Promise<void> {
  try {
    for (let index = 0; index < totalChunks; index++) {
      const sourcePath = path.join(sessionDir, chunkFileName(index));
      await pipeline(
        fs.createReadStream(sourcePath),
        fs.createWriteStream(finalPath, { flags: index === 0 ? 'w' : 'a' }),
      );
    }
  } catch (error) {
    try { fs.rmSync(finalPath, { force: true }); } catch { /* caller cleanup remains a fallback */ }
    throw error;
  }
}

/** Finalization must be based on actual committed chunks, not arrival order. */
export function allChunksPresent(sessionDir: string, totalChunks: number): boolean {
  for (let index = 0; index < totalChunks; index++) {
    if (!fs.existsSync(path.join(sessionDir, chunkFileName(index)))) return false;
  }
  return true;
}

export interface ChunkFinalizationLease {
  acquired: boolean;
  release(): void;
}

const FINALIZE_LOCK = 'finalizing.lock';
const FINALIZE_LOCK_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Acquire a process-independent, filesystem-backed single-finalizer lease.
 * A very old lock is recoverable after 24h so a crashed worker cannot strand
 * an upload forever; an active large-file scan/upload is never stolen on an
 * ordinary retry window.
 */
export function tryAcquireChunkFinalization(sessionDir: string, nowMs = Date.now()): ChunkFinalizationLease {
  const lockPath = path.join(sessionDir, FINALIZE_LOCK);

  const attempt = (): ChunkFinalizationLease => {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: nowMs }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return {
        acquired: true,
        release(): void {
          if (released) return;
          released = true;
          try { fs.unlinkSync(lockPath); } catch (error) {
            const e = error as NodeJS.ErrnoException;
            if (e.code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') throw error;
      return { acquired: false, release(): void {} };
    }
  };

  let lease = attempt();
  if (lease.acquired) return lease;

  // Crash recovery. Never steal a fresh finalizer lock. Prefer the explicit
  // timestamp written into the lease so tests and filesystems with coarse or
  // surprising mtimes cannot cause a fresh lock to look stale.
  try {
    const stat = fs.statSync(lockPath);
    let startedAt = stat.mtimeMs;
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { startedAt?: unknown };
      if (typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt)) startedAt = parsed.startedAt;
    } catch { /* malformed crash residue falls back to mtime */ }
    if (nowMs - startedAt <= FINALIZE_LOCK_STALE_MS) return lease;
    fs.unlinkSync(lockPath);
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') return lease;
  }
  lease = attempt();
  return lease;
}

/**
 * Read-only: true while a finalizer holds a lease younger than the 24h
 * crash-recovery window (same rule and timestamp source as
 * `tryAcquireChunkFinalization`). Never removes or steals a lease.
 */
export function isChunkFinalizationActive(sessionDir: string, nowMs = Date.now()): boolean {
  const lockPath = path.join(sessionDir, FINALIZE_LOCK);
  let startedAt: number;
  try {
    startedAt = fs.statSync(lockPath).mtimeMs;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { startedAt?: unknown };
    if (typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt)) startedAt = parsed.startedAt;
  } catch { /* malformed crash residue falls back to mtime */ }
  return nowMs - startedAt <= FINALIZE_LOCK_STALE_MS;
}

/**
 * Most recent activity of a chunk session: the directory's own mtime (any
 * temp create/commit/unlink) and every entry's mtime (a slowly streaming
 * `.part` file). `null` when the directory does not exist.
 */
export function chunkSessionLastActivityMs(sessionDir: string): number | null {
  let latest: number;
  try {
    latest = fs.lstatSync(sessionDir).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (const name of fs.readdirSync(sessionDir)) {
    try { latest = Math.max(latest, fs.lstatSync(path.join(sessionDir, name)).mtimeMs); } catch { /* raced unlink */ }
  }
  return latest;
}

/**
 * Remove one session directory when it has been idle for at least `idleMs`
 * and no finalizer holds it. Returns true when the directory was removed.
 */
export function purgeChunkSessionIfIdle(sessionDir: string, nowMs: number, idleMs: number): boolean {
  const last = chunkSessionLastActivityMs(sessionDir);
  if (last === null || nowMs - last < idleMs) return false;
  if (isChunkFinalizationActive(sessionDir, nowMs)) return false;
  fs.rmSync(sessionDir, { recursive: true, force: true });
  return true;
}

const SESSION_DIR_RE = /^[a-f0-9]{64}$/;

/**
 * Abandoned-session reaper for the `_chunks/` root. Only canonical session
 * directories (`chunkSessionKey` digests) are considered; anything else in the
 * root is left untouched. Safe to run concurrently from several nodes against
 * a shared volume: removal is idempotent and never targets a recently touched
 * or finalizing session.
 */
export function sweepStaleChunkSessions(chunkRoot: string, nowMs: number, idleMs: number): { removed: number; kept: number } {
  let removed = 0;
  let kept = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(chunkRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed, kept };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_DIR_RE.test(entry.name)) continue;
    try {
      if (purgeChunkSessionIfIdle(path.join(chunkRoot, entry.name), nowMs, idleMs)) removed += 1;
      else kept += 1;
    } catch {
      kept += 1;
    }
  }
  return { removed, kept };
}
