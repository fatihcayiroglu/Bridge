// server/tests/chunk-session-sweeper.test.ts
//
// Abandoned chunk sessions are reclaimed from disk. Before this sweeper,
// `_chunks/` was outside every cleanup path: `jobs/cleanupUploads.ts` only
// reaps root-level objects (`isReapable` rejects `_`-prefixed and nested keys),
// so a session whose last chunk never arrived stayed until the disk filled.

import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-chunk-sweep-'));
process.env.NODE_ENV = 'test';
process.env.BRIDGE_UPLOAD_ROOT = ROOT;
delete process.env.REDIS_URL;

const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: (...a: unknown[]) => mockLoggerInfo(...a), warn: jest.fn(), error: (...a: unknown[]) => mockLoggerError(...a), debug: jest.fn() },
}));

import {
  chunkSessionLastActivityMs,
  isChunkFinalizationActive,
  parseChunkContentLength,
  purgeChunkSessionIfIdle,
  sweepStaleChunkSessions,
  tryAcquireChunkFinalization,
} from '../lib/chunkUploadSafety';

const HOUR = 60 * 60_000;
const NOW = Date.now();
const digest = (label: string) => crypto.createHash('sha256').update(label).digest('hex');

function backdate(p: string, ms: number): void {
  const t = new Date(ms);
  fs.utimesSync(p, t, t);
}

/** A session directory whose every entry and the directory itself are `ageMs` old. */
function makeSession(root: string, label: string, ageMs: number, files: Record<string, string> = { 'chunk_000000': 'x', 'manifest.json': '{}' }): string {
  const dir = path.join(root, digest(label));
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
    backdate(path.join(dir, name), NOW - ageMs);
  }
  backdate(dir, NOW - ageMs);
  return dir;
}

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('sweepStaleChunkSessions', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(ROOT, 'root-'));
  });

  it('removes idle sessions and keeps recently active ones', () => {
    const idle = makeSession(root, 'idle', 2 * HOUR);
    const fresh = makeSession(root, 'fresh', 5 * 60_000);
    expect(sweepStaleChunkSessions(root, NOW, HOUR)).toEqual({ removed: 1, kept: 1 });
    expect(fs.existsSync(idle)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('a slowly streaming part file keeps an otherwise idle session alive', () => {
    const dir = makeSession(root, 'streaming', 2 * HOUR);
    fs.writeFileSync(path.join(dir, 'chunk_000001.part_x'), 'still arriving');
    backdate(dir, NOW - 2 * HOUR); // creating the part touched the directory
    expect(sweepStaleChunkSessions(root, NOW, HOUR)).toEqual({ removed: 0, kept: 1 });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('never removes a session whose finalizer still holds a fresh lease', () => {
    const dir = makeSession(root, 'finalizing', 3 * HOUR);
    const lease = tryAcquireChunkFinalization(dir, NOW - 2 * HOUR);
    expect(lease.acquired).toBe(true);
    // Lock file and directory look old, but the lease is within its 24h window.
    backdate(path.join(dir, 'finalizing.lock'), NOW - 2 * HOUR);
    backdate(dir, NOW - 2 * HOUR);
    expect(sweepStaleChunkSessions(root, NOW, HOUR)).toEqual({ removed: 0, kept: 1 });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('a crashed finalizer lease older than the recovery window does not pin the session forever', () => {
    const dir = makeSession(root, 'crashed', 30 * HOUR, {
      'chunk_000000': 'x',
      'finalizing.lock': JSON.stringify({ pid: 1, startedAt: NOW - 25 * HOUR }),
    });
    expect(sweepStaleChunkSessions(root, NOW, HOUR)).toEqual({ removed: 1, kept: 0 });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('ignores anything that is not a canonical session directory', () => {
    const keepers = [
      path.join(root, 'not-a-digest'),
      path.join(root, digest('upper').toUpperCase()),
    ];
    for (const dir of keepers) {
      fs.mkdirSync(dir);
      backdate(dir, NOW - 48 * HOUR);
    }
    const file = path.join(root, digest('plain-file'));
    fs.writeFileSync(file, 'x');
    backdate(file, NOW - 48 * HOUR);
    expect(sweepStaleChunkSessions(root, NOW, HOUR)).toEqual({ removed: 0, kept: 0 });
    for (const p of [...keepers, file]) expect(fs.existsSync(p)).toBe(true);
  });

  it('a missing root is an empty sweep; other read errors surface', () => {
    expect(sweepStaleChunkSessions(path.join(root, 'absent'), NOW, HOUR)).toEqual({ removed: 0, kept: 0 });
    const notDir = path.join(root, 'file-root');
    fs.writeFileSync(notDir, 'x');
    expect(() => sweepStaleChunkSessions(notDir, NOW, HOUR)).toThrow();
  });

  it('a session that errors while being inspected is kept, not half-deleted', () => {
    const dir = makeSession(root, 'unreadable', 2 * HOUR);
    const realReaddir = fs.readdirSync;
    const spy = jest.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === dir) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return (realReaddir as (...args: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readdirSync);
    try {
      expect(sweepStaleChunkSessions(root, NOW, HOUR)).toEqual({ removed: 0, kept: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('session activity and finalization helpers', () => {
  it('last activity is null for a missing session and the newest entry otherwise', () => {
    const root = fs.mkdtempSync(path.join(ROOT, 'activity-'));
    expect(chunkSessionLastActivityMs(path.join(root, digest('none')))).toBeNull();
    const dir = makeSession(root, 'activity', 3 * HOUR);
    const newest = path.join(dir, 'chunk_000002');
    fs.writeFileSync(newest, 'y');
    backdate(newest, NOW - HOUR);
    backdate(dir, NOW - 3 * HOUR);
    expect(Math.round(chunkSessionLastActivityMs(dir)!)).toBe(Math.round(NOW - HOUR));
  });

  it('last activity surfaces non-ENOENT stat failures', () => {
    const spy = jest.spyOn(fs, 'lstatSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    try {
      expect(() => chunkSessionLastActivityMs('/does/not/matter')).toThrow('EIO');
    } finally {
      spy.mockRestore();
    }
  });

  it('purgeChunkSessionIfIdle only removes an idle, unlocked, existing session', () => {
    const root = fs.mkdtempSync(path.join(ROOT, 'purge-'));
    expect(purgeChunkSessionIfIdle(path.join(root, digest('none')), NOW, HOUR)).toBe(false);
    const fresh = makeSession(root, 'fresh', 60_000);
    expect(purgeChunkSessionIfIdle(fresh, NOW, HOUR)).toBe(false);
    const idle = makeSession(root, 'idle', 2 * HOUR);
    expect(purgeChunkSessionIfIdle(idle, NOW, HOUR)).toBe(true);
    expect(fs.existsSync(idle)).toBe(false);
  });

  it('isChunkFinalizationActive follows the lease timestamp and is read-only', () => {
    const root = fs.mkdtempSync(path.join(ROOT, 'lease-'));
    const dir = makeSession(root, 'lease', HOUR);
    expect(isChunkFinalizationActive(dir, NOW)).toBe(false);

    const lock = path.join(dir, 'finalizing.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: NOW - 23 * HOUR }));
    expect(isChunkFinalizationActive(dir, NOW)).toBe(true);
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: NOW - 25 * HOUR }));
    expect(isChunkFinalizationActive(dir, NOW)).toBe(false);
    expect(fs.existsSync(lock)).toBe(true); // never removes the lease itself

    // Malformed crash residue falls back to the lock file's mtime.
    fs.writeFileSync(lock, 'not json');
    backdate(lock, NOW - 2 * HOUR);
    expect(isChunkFinalizationActive(dir, NOW)).toBe(true);
    backdate(lock, NOW - 30 * HOUR);
    expect(isChunkFinalizationActive(dir, NOW)).toBe(false);
  });

  it('an unreadable lease is treated as active (never steal on doubt)', () => {
    const spy = jest.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    try {
      expect(isChunkFinalizationActive('/any/session', NOW)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('parseChunkContentLength', () => {
  it.each([['0', 0], ['1', 1], ['10485760', 10 * 1024 * 1024]])('accepts canonical %p', (raw, value) => {
    expect(parseChunkContentLength(raw)).toBe(value);
  });

  it.each([[undefined], [''], ['-1'], ['01'], ['1e3'], [' 5'], ['5 '], ['0x10'], ['1.0'], [['5', '5']], ['99999999999999999999']])(
    'rejects %p', (raw) => {
      expect(parseChunkContentLength(raw as string | string[] | undefined)).toBeNull();
    });
});

describe('chunkSessionSweeper job', () => {
  type SweeperModule = typeof import('../jobs/chunkSessionSweeper');
  const load = (): SweeperModule => {
    let mod!: SweeperModule;
    jest.isolateModules(() => { mod = require('../jobs/chunkSessionSweeper'); });
    return mod;
  };

  beforeEach(() => {
    mockLoggerInfo.mockClear();
    mockLoggerError.mockClear();
  });

  it('sweeps the runtime _chunks root with the quota session TTL', () => {
    const { runChunkSessionSweep } = load();
    const chunkRoot = path.join(ROOT, '_chunks');
    fs.mkdirSync(chunkRoot, { recursive: true });
    const idle = makeSession(chunkRoot, 'job-idle', 61 * 60_000); // default TTL: 60 min
    const active = makeSession(chunkRoot, 'job-active', 59 * 60_000);
    expect(runChunkSessionSweep(NOW)).toEqual({ removed: 1, kept: 1 });
    expect(fs.existsSync(idle)).toBe(false);
    expect(fs.existsSync(active)).toBe(true);
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.objectContaining({ event: 'upload.chunk_sessions_swept', removed: 1 }), expect.any(String));

    mockLoggerInfo.mockClear();
    expect(runChunkSessionSweep(NOW)).toEqual({ removed: 0, kept: 1 });
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it('start is idempotent, runs on schedule, logs failures, and stop clears both timers', () => {
    jest.useFakeTimers();
    try {
      const sweep = jest.fn(() => { throw new Error('disk gone'); });
      let mod!: SweeperModule;
      jest.isolateModules(() => {
        jest.doMock('../lib/chunkUploadSafety', () => ({ sweepStaleChunkSessions: sweep }));
        mod = require('../jobs/chunkSessionSweeper');
      });
      jest.dontMock('../lib/chunkUploadSafety');
      // Module loading may register unrelated timers; count only ours.
      const baseline = jest.getTimerCount();
      try {
        mod.startChunkSessionSweeper();
        mod.startChunkSessionSweeper();
        expect(jest.getTimerCount() - baseline).toBe(2);
        jest.advanceTimersByTime(60_000);
        expect(mockLoggerError).toHaveBeenCalledTimes(1);
        expect(mockLoggerError).toHaveBeenCalledWith(expect.objectContaining({ event: 'upload.chunk_sweep_failed' }), expect.any(String));
        expect(jest.getTimerCount() - baseline).toBe(1);
        jest.advanceTimersByTime(10 * 60_000);
        expect(mockLoggerError).toHaveBeenCalledTimes(2);
        mod.stopChunkSessionSweeper();
        expect(jest.getTimerCount() - baseline).toBe(0);
        mod.startChunkSessionSweeper();
        mod.stopChunkSessionSweeper();
        mod.stopChunkSessionSweeper();
        expect(jest.getTimerCount() - baseline).toBe(0);
        expect(sweep).toHaveBeenCalledTimes(2);
      } finally {
        mod.stopChunkSessionSweeper();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('negative control: the pre-existing upload reaper can never reclaim chunk sessions', () => {
    let isReapable!: (key: string) => boolean;
    jest.isolateModules(() => {
      jest.doMock('../lib/storageAdapter', () => ({ getPrivateStorageAdapter: jest.fn(), getPrivateStorageProvider: jest.fn() }));
      jest.doMock('../db/repositories', () => ({ Messages: {}, Dms: {} }));
      jest.doMock('../db/loader', () => ({ __esModule: true, default: {} }));
      ({ isReapable } = require('../jobs/cleanupUploads'));
    });
    for (const mod of ['../lib/storageAdapter', '../db/repositories', '../db/loader']) jest.dontMock(mod);
    const session = digest('abandoned');
    expect(isReapable(`_chunks/${session}/chunk_000000`)).toBe(false);
    expect(isReapable(`uploads/_chunks/${session}/chunk_000000`)).toBe(false);
    expect(isReapable('_chunks')).toBe(false);
  });
});
