import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  allChunksPresent,
  chunkFileName,
  chunkSessionKey,
  commitChunkTempFile,
  mergeChunkFiles,
  tryAcquireChunkFinalization,
  validateChunkMetadata,
  validateFinalUploadSize,
} from '../lib/chunkUploadSafety';

const allowed = new Set(['image/png', 'text/plain']);
const TEN_MB = 10 * 1024 * 1024;
const MAX = 25 * 1024 * 1024;

function headers(overrides: Record<string, string> = {}) {
  return {
    'x-upload-id': '8a73a9aa-8ce8-41b4-b8c8-479d7e32a1ef',
    'x-chunk-index': '0',
    'x-total-chunks': '3',
    'x-file-name': 'report.png',
    'x-file-type': 'image/png',
    ...overrides,
  };
}

describe('chunkUploadSafety', () => {
  it('accepts canonical bounded metadata', () => {
    expect(validateChunkMetadata(headers(), allowed, MAX, TEN_MB)).toEqual({
      ok: true,
      value: {
        uploadId: '8a73a9aa-8ce8-41b4-b8c8-479d7e32a1ef',
        chunkIndex: 0,
        totalChunks: 3,
        fileName: 'report.png',
        fileType: 'image/png',
      },
    });
  });

  it.each([
    [{ 'x-upload-id': '../same' }, 400],
    [{ 'x-upload-id': 'same id' }, 400],
    [{ 'x-chunk-index': '-1' }, 400],
    [{ 'x-chunk-index': '1junk' }, 400],
    [{ 'x-chunk-index': '3' }, 400],
    [{ 'x-total-chunks': '0' }, 400],
    [{ 'x-total-chunks': '4' }, 413],
    [{ 'x-file-name': 'bad\u0000name.png' }, 400],
    [{ 'x-file-type': 'text/html' }, 415],
  ])('rejects malformed or unsafe metadata %#', (override, status) => {
    expect(validateChunkMetadata(headers(override), allowed, MAX, TEN_MB)).toMatchObject({ ok: false, status });
  });

  it('enforces the final per-user/boost limit in addition to the global chunk ceiling', () => {
    const MB = 1024 * 1024;
    expect(validateFinalUploadSize(24 * MB, 2048 * MB, 25 * MB)).toEqual({ ok: true });
    expect(validateFinalUploadSize(26 * MB, 2048 * MB, 25 * MB)).toEqual({
      ok: false, status: 413, code: 'BOOST_LIMIT', maxBytes: 25 * MB,
    });
    expect(validateFinalUploadSize(2050 * MB, 2048 * MB, 4096 * MB)).toEqual({
      ok: false, status: 413, code: 'GLOBAL_LIMIT', maxBytes: 2048 * MB,
    });
  });

  it('scopes the same client upload id to the authenticated user', () => {
    const uploadId = 'same-upload-id';
    expect(chunkSessionKey('user-a', uploadId)).not.toBe(chunkSessionKey('user-b', uploadId));
    expect(chunkSessionKey('user-a', uploadId)).toBe(chunkSessionKey('user-a', uploadId));
    expect(chunkSessionKey('user-a', uploadId)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('commits complete chunk bytes atomically and makes identical retries idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-chunk-'));
    try {
      const first = path.join(dir, 'first.part');
      fs.writeFileSync(first, Buffer.from('abc'));
      expect(commitChunkTempFile(dir, 0, first)).toBe('stored');
      expect(fs.existsSync(first)).toBe(false);
      expect(fs.readFileSync(path.join(dir, chunkFileName(0)), 'utf8')).toBe('abc');

      const retry = path.join(dir, 'retry.part');
      fs.writeFileSync(retry, Buffer.from('abc'));
      expect(commitChunkTempFile(dir, 0, retry)).toBe('duplicate');
      expect(fs.existsSync(retry)).toBe(false);
      expect(fs.readFileSync(path.join(dir, chunkFileName(0)), 'utf8')).toBe('abc');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a retry that attempts to replace committed chunk bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-chunk-'));
    try {
      const first = path.join(dir, 'first.part');
      fs.writeFileSync(first, Buffer.from('abc'));
      expect(commitChunkTempFile(dir, 1, first)).toBe('stored');

      const conflicting = path.join(dir, 'conflict.part');
      fs.writeFileSync(conflicting, Buffer.from('xyz'));
      expect(commitChunkTempFile(dir, 1, conflicting)).toBe('conflict');
      expect(fs.readFileSync(path.join(dir, chunkFileName(1)), 'utf8')).toBe('abc');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects completion from committed files regardless of arrival order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-chunk-'));
    try {
      fs.writeFileSync(path.join(dir, chunkFileName(2)), 'last');
      expect(allChunksPresent(dir, 3)).toBe(false);
      fs.writeFileSync(path.join(dir, chunkFileName(0)), 'first');
      expect(allChunksPresent(dir, 3)).toBe(false);
      fs.writeFileSync(path.join(dir, chunkFileName(1)), 'middle');
      expect(allChunksPresent(dir, 3)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows only one fresh finalizer and recovers a stale crash lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-chunk-'));
    try {
      const now = 2_000_000_000_000;
      const first = tryAcquireChunkFinalization(dir, now);
      expect(first.acquired).toBe(true);
      expect(tryAcquireChunkFinalization(dir, now + 1).acquired).toBe(false);
      first.release();
      expect(tryAcquireChunkFinalization(dir, now + 2).acquired).toBe(true);

      // Clean the fresh lease then synthesize a >24h crashed lock.
      fs.rmSync(path.join(dir, 'finalizing.lock'), { force: true });
      const lock = path.join(dir, 'finalizing.lock');
      fs.writeFileSync(lock, JSON.stringify({ startedAt: now - (25 * 60 * 60 * 1000) }));
      const recovered = tryAcquireChunkFinalization(dir, now);
      expect(recovered.acquired).toBe(true);
      recovered.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges chunks in canonical order and removes a partial final file on stream failure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-chunk-'));
    const finalPath = path.join(dir, 'merged.bin');
    try {
      fs.writeFileSync(path.join(dir, chunkFileName(0)), 'first');
      fs.writeFileSync(path.join(dir, chunkFileName(1)), 'second');
      fs.writeFileSync(path.join(dir, chunkFileName(2)), 'third');
      await mergeChunkFiles(dir, 3, finalPath);
      expect(fs.readFileSync(finalPath, 'utf8')).toBe('firstsecondthird');

      fs.rmSync(finalPath, { force: true });
      fs.rmSync(path.join(dir, chunkFileName(1)), { force: true });
      await expect(mergeChunkFiles(dir, 3, finalPath)).rejects.toBeTruthy();
      expect(fs.existsSync(finalPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
