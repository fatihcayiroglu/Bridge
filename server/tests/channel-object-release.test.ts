/**
 * P7 D2: unit coverage of the expired-channel object releaser's location rules
 * and the release phase's state machine. Real PostgreSQL + real local and S3
 * storage are proven in tests/pg-integration/channel-object-release*.pgtest.ts.
 */
const mockHasRef = jest.fn();
const mockBatchRef = jest.fn();
const mockPrivateDelete = jest.fn();
const mockRelease = jest.fn();
jest.mock('../lib/uploadReferenceSafety', () => ({
  ...jest.requireActual('../lib/uploadReferenceSafety'),
  hasLiveUploadReference: (...a: unknown[]) => mockHasRef(...a),
  liveUploadReferenceKeys: (...a: unknown[]) => mockBatchRef(...a),
}));
jest.mock('../lib/storageAdapter', () => ({
  getPrivateStorageAdapter: () => ({ deleteFile: (...a: unknown[]) => mockPrivateDelete(...a) }),
  getPrivateStorageProvider: () => 's3',
}));
jest.mock('../lib/uploadRelease', () => ({
  locateAsset: (url: string) => (url.startsWith('/uploads/recordings/') ? { kind: 'local' } : null),
  releaseUnreferencedUploads: (...a: unknown[]) => mockRelease(...a),
}));

import { createChannelObjectReleaser } from '../lib/channelObjectRelease';
import {
  OBJECT_RELEASE_MAX_ATTEMPTS, objectReleaseBackoffMs, releaseChannelObjects, type ObjectReleaser,
} from '../lib/channelExpiryWorker';

const pool = { query: jest.fn(async () => ({ rows: [] })) };
beforeEach(() => { jest.clearAllMocks(); mockHasRef.mockResolvedValue(false); });

describe('createChannelObjectReleaser', () => {
  const r = () => createChannelObjectReleaser(pool as never);

  it('deletes an unreferenced root attachment from private storage with the provider key', async () => {
    await expect(r().release('/uploads/a.png')).resolves.toBe('released');
    expect(mockHasRef).toHaveBeenCalledWith(pool, 'uploads/a.png');
    expect(mockPrivateDelete).toHaveBeenCalledWith('uploads/a.png');
    expect(pool.query).toHaveBeenCalledWith('DELETE FROM uploads WHERE key = $1', ['uploads/a.png']);
  });

  it('keeps a root attachment another row still references', async () => {
    mockHasRef.mockResolvedValue(true);
    await expect(r().release('/uploads/a.png')).resolves.toBe('still_referenced');
    expect(mockPrivateDelete).not.toHaveBeenCalled();
  });

  it('fails closed when the reference check cannot run', async () => {
    mockHasRef.mockRejectedValue(new Error('no pool'));
    await expect(r().release('/uploads/a.png')).rejects.toThrow('no pool');
    expect(mockPrivateDelete).not.toHaveBeenCalled();
  });

  it.each([
    'https://cdn.example.com/a.png', '/uploads/../etc/passwd', '/uploads/sub/dir.png', '/uploads/.hidden',
    'uploads/a.png', '/uploads/a..png', '',
  ])('never deletes an unrecognised location: %s', async (url) => {
    await expect(r().release(url)).resolves.toBe('unrecognized');
    expect(mockPrivateDelete).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('releases recognised persistent assets through uploadRelease and maps its result', async () => {
    mockRelease.mockResolvedValueOnce({ removed: 1, alreadyAbsent: 0, stillReferenced: 0, failed: 0 });
    await expect(r().release('/uploads/recordings/ep.mp3')).resolves.toBe('released');
    mockRelease.mockResolvedValueOnce({ removed: 0, alreadyAbsent: 1, stillReferenced: 0, failed: 0 });
    await expect(r().release('/uploads/recordings/ep.mp3')).resolves.toBe('absent');
    mockRelease.mockResolvedValueOnce({ removed: 0, alreadyAbsent: 0, stillReferenced: 1, failed: 0 });
    await expect(r().release('/uploads/recordings/ep.mp3')).resolves.toBe('still_referenced');
    mockRelease.mockImplementationOnce(async (_p: unknown, _u: unknown, onError: (u: string, e: unknown) => void) => {
      onError('/uploads/recordings/ep.mp3', new Error('EACCES'));
      return { removed: 0, alreadyAbsent: 0, stillReferenced: 0, failed: 1 };
    });
    await expect(r().release('/uploads/recordings/ep.mp3')).rejects.toThrow('EACCES');
  });
});

describe('batch-scoped releaser', () => {
  it('answers root attachments of the batch from one batched query, others one by one', async () => {
    mockBatchRef.mockResolvedValue(new Set(['uploads/kept.png']));
    const batch = await createChannelObjectReleaser(pool as never).forBatch!([
      '/uploads/kept.png', '/uploads/gone.png', '/uploads/recordings/r.mp3', 'https://x/y.png',
    ]);
    expect(mockBatchRef).toHaveBeenCalledWith(pool, ['uploads/kept.png', 'uploads/gone.png']);
    await expect(batch.release('/uploads/kept.png')).resolves.toBe('still_referenced');
    await expect(batch.release('/uploads/gone.png')).resolves.toBe('released');
    expect(mockHasRef).not.toHaveBeenCalled();
    // Outside the batch: the single-key check still runs.
    await expect(batch.release('/uploads/other.png')).resolves.toBe('released');
    expect(mockHasRef).toHaveBeenCalledWith(pool, 'uploads/other.png');
  });

  it('falls back to per-object checks when the batched query fails', async () => {
    mockBatchRef.mockRejectedValue(new Error('statement timeout'));
    const leased = [{ channelId: 'c', url: '/uploads/a.png', attempts: 1 }];
    const client = {
      query: jest.fn(async (sql: string) => ({ rows: /RETURNING o\."channelId"/.test(sql) ? leased : [], rowCount: 1 })),
      release: jest.fn(),
    };
    const report = await releaseChannelObjects({ connect: async () => client } as never,
      createChannelObjectReleaser(pool as never), 10);
    expect(report).toEqual({ released: 1, retained: 0, retried: 0, failed: 0, superseded: 0 });
    expect(mockHasRef).toHaveBeenCalledWith(pool, 'uploads/a.png');
  });
});

describe('releaseChannelObjects state machine', () => {
  function fakePool(leased: Array<{ channelId: string; url: string; attempts: number }>) {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: /RETURNING o\."channelId"/.test(sql) ? leased : [], rowCount: 1 };
      }),
      release: jest.fn(),
    };
    return { pool: { connect: async () => client }, client, calls };
  }
  const finishes = (calls: Array<{ sql: string; params?: unknown[] }>) =>
    calls.filter(c => /SET state = \$3/.test(c.sql)).map(c => c.params);

  it('records released, absent, retained and unrecognised outcomes', async () => {
    const { pool: p, calls, client } = fakePool([
      { channelId: 'c', url: 'a', attempts: 1 }, { channelId: 'c', url: 'b', attempts: 1 },
      { channelId: 'c', url: 'c', attempts: 1 }, { channelId: 'c', url: 'd', attempts: 1 },
    ]);
    const outcomes: Record<string, string> = { a: 'released', b: 'absent', c: 'still_referenced', d: 'unrecognized' };
    const releaser: ObjectReleaser = { release: async (url) => outcomes[url] as never };
    await expect(releaseChannelObjects(p as never, releaser, 10)).resolves.toEqual({ released: 2, retained: 2, retried: 0, failed: 0, superseded: 0 });
    expect(finishes(calls)).toEqual([
      ['c', 'a', 'released', null, 1], ['c', 'b', 'released', 'already_absent', 1],
      ['c', 'c', 'retained', 'still_referenced', 1], ['c', 'd', 'retained', 'unrecognized', 1],
    ]);
    expect(calls.some(c => /DELETE FROM channel_object_release_outbox/.test(c.sql))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it('retries with backoff below the budget and fails terminally at it', async () => {
    const { pool: p, calls } = fakePool([
      { channelId: 'c', url: 'x', attempts: 2 }, { channelId: 'c', url: 'y', attempts: OBJECT_RELEASE_MAX_ATTEMPTS },
    ]);
    const releaser: ObjectReleaser = { release: async () => { throw new Error('boom'.repeat(200)); } };
    await expect(releaseChannelObjects(p as never, releaser, 10)).resolves.toEqual({ released: 0, retained: 0, retried: 1, failed: 1, superseded: 0 });
    const retry = calls.find(c => /SET "nextAttemptAt"/.test(c.sql) && c.params?.[1] === 'x' && /lastError/.test(c.sql));
    expect(retry?.params?.[2]).toBe(objectReleaseBackoffMs(2));
    expect(String(retry?.params?.[3]).length).toBe(500);
    expect(finishes(calls)).toEqual([['c', 'y', 'failed', 'boom'.repeat(200).slice(0, 500), OBJECT_RELEASE_MAX_ATTEMPTS]]);
  });

  it('rejects an invalid limit and caps the backoff', async () => {
    await expect(releaseChannelObjects(fakePool([]).pool as never, { release: jest.fn() }, 0)).rejects.toThrow(RangeError);
    expect(objectReleaseBackoffMs(1)).toBe(30_000);
    expect(objectReleaseBackoffMs(3)).toBe(120_000);
    expect(objectReleaseBackoffMs(40)).toBe(6 * 60 * 60_000);
  });

  it('does not start storage work when a queued item no longer owns its lease', async () => {
    const { pool: p, client } = fakePool([{ channelId: 'c', url: 'a', attempts: 1 }]);
    client.query.mockImplementation(async (sql) => ({
      rows: /RETURNING o\."channelId"/.test(sql) ? [{ channelId: 'c', url: 'a', attempts: 1 }] : [],
      rowCount: /AND attempts = \$3/.test(sql) ? 0 : 1,
    }));
    const release = jest.fn();
    await expect(releaseChannelObjects(p as never, { release }, 10)).resolves.toEqual({
      released: 0, retained: 0, retried: 0, failed: 0, superseded: 1,
    });
    expect(release).not.toHaveBeenCalled();
  });

  it('does not report success when a newer lease rejects its completion', async () => {
    const { pool: p, client } = fakePool([{ channelId: 'c', url: 'a', attempts: 1 }]);
    client.query.mockImplementation(async (sql) => ({
      rows: /RETURNING o\."channelId"/.test(sql) ? [{ channelId: 'c', url: 'a', attempts: 1 }] : [],
      rowCount: /AND attempts = \$5/.test(sql) ? 0 : 1,
    }));
    await expect(releaseChannelObjects(p as never, { release: async () => 'released' }, 10)).resolves.toEqual({
      released: 0, retained: 0, retried: 0, failed: 0, superseded: 1,
    });
  });
});
