// server/tests/jobs-cleanupUploads.test.ts
// cleanupUploads job — unit tests (filesystem & DB mocked)
process.env.NODE_ENV = 'test';

import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ── fs mock ───────────────────────────────────────────────────────
const _fsMock = {
  existsSync:  jest.fn(() => true),
  readdirSync: jest.fn(() => []),
  statSync:    jest.fn(() => ({ mtimeMs: 0 })),
  unlinkSync:  jest.fn(),
};
jest.mock('fs', () => _fsMock);

// ── DB mock ───────────────────────────────────────────────────────
let _messages = [];
let _dms      = [];

jest.mock('../db/repositories', () => ({
  Messages: {
    findWhere: (q) => Promise.resolve(_messages.filter(m => m.type === 'file')),
    findProjected: (_q, _projection) => Promise.resolve(_messages.filter(m => m.type === 'file')),
  },
  Dms: {
    findMessagesWhere: (q) => Promise.resolve(_dms),
  },
}));

jest.mock('../db/loader', () => ({ __esModule: true, default: { _pool: null } }));

import { runCleanup, startCleanupJob, stopCleanupJob } from '../jobs/cleanupUploads';

// ── helpers ──────────────────────────────────────────────────────
const OLD_TS = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago → past grace period

function setupDir(files, oldFiles = []) {
  _fsMock.existsSync.mockReturnValue(true);
  _fsMock.readdirSync.mockReturnValue([...files, ...oldFiles]);
  _fsMock.statSync.mockImplementation((fp) => {
    const name = path.basename(fp);
    return { mtimeMs: oldFiles.includes(name) ? OLD_TS : Date.now() };
  });
  _fsMock.unlinkSync.mockClear();
}

// ── Tests ─────────────────────────────────────────────────────────

describe('runCleanup — upload dir does not exist', () => {
  beforeEach(() => {
    _messages = []; _dms = [];
    _fsMock.existsSync.mockReturnValue(false);
    _fsMock.readdirSync.mockClear();
    _fsMock.unlinkSync.mockClear();
  });

  it('returns early when upload dir does not exist', async () => {
    await runCleanup();
    expect(_fsMock.readdirSync).not.toHaveBeenCalled();
    expect(_fsMock.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('runCleanup — empty dir', () => {
  beforeEach(() => {
    _messages = []; _dms = [];
    _fsMock.existsSync.mockReturnValue(true);
    _fsMock.readdirSync.mockReturnValue([]);
    _fsMock.unlinkSync.mockClear();
  });

  it('does nothing when no files present', async () => {
    await runCleanup();
    expect(_fsMock.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('runCleanup — referenced files', () => {
  beforeEach(() => _fsMock.unlinkSync.mockClear());

  it('does NOT delete files that are referenced by a message', async () => {
    _messages = [{ _id: uuidv4(), type: 'file', fileUrl: 'http://cdn.example/uploads/image.png' }];
    _dms      = [];
    setupDir([], ['image.png']); // image.png is old but referenced

    await runCleanup();

    expect(_fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('does NOT delete files referenced by DM messages', async () => {
    _messages = [];
    _dms      = [{ _id: uuidv4(), fileUrl: 'http://cdn.example/uploads/doc.pdf' }];
    setupDir([], ['doc.pdf']);

    await runCleanup();

    expect(_fsMock.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('runCleanup — orphaned files', () => {
  beforeEach(() => {
    _messages = [];
    _dms      = [];
    _fsMock.unlinkSync.mockClear();
  });

  it('deletes old unreferenced files', async () => {
    setupDir([], ['orphan1.png', 'orphan2.mp4']);

    await runCleanup();

    expect(_fsMock.unlinkSync).toHaveBeenCalledTimes(2);
  });

  it('does NOT delete new files even if unreferenced (grace period)', async () => {
    // New files have mtimeMs = Date.now() → within 1h grace period
    _fsMock.existsSync.mockReturnValue(true);
    _fsMock.readdirSync.mockReturnValue(['new-upload.png']);
    _fsMock.statSync.mockReturnValue({ mtimeMs: Date.now() - 30_000 }); // 30s old
    _fsMock.unlinkSync.mockClear();

    await runCleanup();

    expect(_fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('deletes only orphaned old files, preserving referenced ones', async () => {
    _messages = [{ _id: uuidv4(), type: 'file', fileUrl: 'http://cdn.example/uploads/keep.png' }];
    _fsMock.existsSync.mockReturnValue(true);
    _fsMock.readdirSync.mockReturnValue(['keep.png', 'orphan.png']);
    _fsMock.statSync.mockReturnValue({ mtimeMs: OLD_TS });
    _fsMock.unlinkSync.mockClear();

    await runCleanup();

    const deleted = _fsMock.unlinkSync.mock.calls.map(([fp]) => path.basename(fp));
    expect(deleted).toContain('orphan.png');
    expect(deleted).not.toContain('keep.png');
  });
});

describe('runCleanup — error resilience', () => {
  beforeEach(() => _fsMock.unlinkSync.mockClear());

  it('handles readdirSync errors gracefully', async () => {
    _messages = []; _dms = [];
    _fsMock.existsSync.mockReturnValue(true);
    _fsMock.readdirSync.mockImplementation(() => { throw new Error('EPERM'); });

    await expect(runCleanup()).resolves.toBeUndefined();
  });

  it('continues when unlinkSync fails for one file', async () => {
    _messages = []; _dms = [];
    _fsMock.existsSync.mockReturnValue(true);
    _fsMock.readdirSync.mockReturnValue(['a.png', 'b.png']);
    _fsMock.statSync.mockReturnValue({ mtimeMs: OLD_TS });
    _fsMock.unlinkSync
      .mockImplementationOnce(() => { throw new Error('EBUSY'); })
      .mockImplementation(() => {});

    await expect(runCleanup()).resolves.toBeUndefined();
    // Should still attempt to delete the second file
    expect(_fsMock.unlinkSync).toHaveBeenCalledTimes(2);
  });
});

describe('startCleanupJob', () => {
  afterEach(() => {
    stopCleanupJob();
    jest.useRealTimers();
  });
  it('registers timers without throwing', () => {
    jest.useFakeTimers();
    expect(() => startCleanupJob()).not.toThrow();
  });
});
