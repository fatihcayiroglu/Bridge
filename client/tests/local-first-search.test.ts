import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearLocalFirstHistoryChannel,
  replaceLocalFirstHistory,
  resetLocalFirstHistoryRuntimeForTests,
  tombstoneLocalFirstHistory,
} from '../js/core/local-first/history-runtime.ts';
import {
  localFirstSearchContext,
  localContextFromSnapshots,
  searchHistorySnapshots,
  searchLocalFirstHistory,
} from '../js/core/local-first/local-search.ts';
import type { LocalHistorySnapshot } from '../js/core/local-first/history.ts';

beforeEach(() => {
  resetLocalFirstHistoryRuntimeForTests();
});

afterEach(() => {
  resetLocalFirstHistoryRuntimeForTests();
});

describe('P7 A6 local-first search', () => {
  it('never crosses account boundaries', async () => {
    await replaceLocalFirstHistory('search-user-a', 'channel-a', [{
      _id: 'a1',
      channelId: 'channel-a',
      userId: 'alice',
      displayName: 'Alice',
      content: 'private alpha phrase',
      contentFormat: 1,
      createdAt: 100,
    }]);
    await replaceLocalFirstHistory('search-user-b', 'channel-b', [{
      _id: 'b1',
      channelId: 'channel-b',
      userId: 'bob',
      displayName: 'Bob',
      content: 'private beta phrase',
      contentFormat: 1,
      createdAt: 200,
    }]);

    await expect(searchLocalFirstHistory('search-user-a', 'beta')).resolves.toEqual({
      hits: [],
      hasMore: false,
    });
    const own = await searchLocalFirstHistory('search-user-a', 'alpha');
    expect(own.hits.map(hit => hit.id)).toEqual(['a1']);
  });

  it('removes tombstoned and revoked channel content from local results', async () => {
    const userId = 'search-delete-user';
    await replaceLocalFirstHistory(userId, 'channel-a', [{
      _id: 'gone',
      channelId: 'channel-a',
      content: 'delete me locally',
      contentFormat: 1,
      createdAt: 100,
    }]);

    expect((await searchLocalFirstHistory(userId, 'delete')).hits).toHaveLength(1);

    await tombstoneLocalFirstHistory(userId, 'channel-a', 'gone');
    expect((await searchLocalFirstHistory(userId, 'delete')).hits).toEqual([]);

    await replaceLocalFirstHistory(userId, 'channel-a', [{
      _id: 'revoked',
      channelId: 'channel-a',
      content: 'revoked cache text',
      contentFormat: 1,
      createdAt: 200,
    }]);
    expect((await searchLocalFirstHistory(userId, 'revoked')).hits).toHaveLength(1);

    await clearLocalFirstHistoryChannel(userId, 'channel-a');
    expect((await searchLocalFirstHistory(userId, 'revoked')).hits).toEqual([]);
  });

  it('searches only legitimately rendered plaintext for raw and legacy channel rows', () => {
    const snapshots: LocalHistorySnapshot[] = [{
      v: 1,
      channelId: 'channel-a',
      savedAt: 300,
      tombstones: [],
      messages: [
        {
          _id: 'legacy',
          channelId: 'channel-a',
          content: 'A &lt; B',
          contentFormat: 0,
          createdAt: 100,
        },
        {
          _id: 'raw',
          channelId: 'channel-a',
          content: 'C &lt; D',
          contentFormat: 1,
          createdAt: 200,
        },
      ],
    }];

    expect(searchHistorySnapshots(snapshots, 'a < b').hits.map(hit => hit.id)).toEqual(['legacy']);
    expect(searchHistorySnapshots(snapshots, 'c < d').hits).toEqual([]);
    expect(searchHistorySnapshots(snapshots, '&lt;').hits.map(hit => hit.id)).toEqual(['raw']);
  });

  it('applies bounded filters, deterministic ordering and pagination', () => {
    const snapshots: LocalHistorySnapshot[] = [{
      v: 1,
      channelId: 'channel-a',
      savedAt: 500,
      tombstones: [],
      messages: [
        {
          _id: 'older',
          channelId: 'channel-a',
          channelName: 'general',
          userId: 'u-alice',
          displayName: 'Alice',
          content: 'bridge offline link https://example.com',
          contentFormat: 1,
          createdAt: Date.parse('2026-01-02T00:00:00Z'),
        },
        {
          _id: 'newer',
          channelId: 'channel-a',
          channelName: 'general',
          userId: 'u-alice',
          displayName: 'Alice',
          content: 'bridge offline attachment',
          contentFormat: 1,
          fileUrl: '/uploads/proof.png',
          fileType: 'image/png',
          createdAt: Date.parse('2026-01-03T00:00:00Z'),
        },
        {
          _id: 'other',
          channelId: 'channel-a',
          channelName: 'general',
          userId: 'u-bob',
          displayName: 'Bob',
          content: 'bridge offline phrase',
          contentFormat: 1,
          createdAt: Date.parse('2026-01-04T00:00:00Z'),
        },
      ],
    }];

    const alice = searchHistorySnapshots(snapshots, 'bridge offline', {
      filters: { from: 'alice', channelId: 'channel-a' },
      limit: 1,
    });
    expect(alice.hits.map(hit => hit.id)).toEqual(['newer']);
    expect(alice.hasMore).toBe(true);

    const page2 = searchHistorySnapshots(snapshots, 'bridge offline', {
      filters: { from: 'alice', channelId: 'channel-a' },
      limit: 1,
      offset: 1,
    });
    expect(page2.hits.map(hit => hit.id)).toEqual(['older']);
    expect(page2.hasMore).toBe(false);

    expect(searchHistorySnapshots(snapshots, 'bridge', {
      filters: { has: 'image' },
    }).hits.map(hit => hit.id)).toEqual(['newer']);

    expect(searchHistorySnapshots(snapshots, 'bridge', {
      filters: { has: 'link' },
    }).hits.map(hit => hit.id)).toEqual(['older']);

    expect(searchHistorySnapshots(snapshots, 'bridge', {
      filters: { after: '2026-01-03T12:00:00Z' },
    }).hits.map(hit => hit.id)).toEqual(['other']);
  });

  it('covers empty-query, invalid-date and strict local-filter boundaries', () => {
    const snapshots: LocalHistorySnapshot[] = [{
      v: 1,
      channelId: 'channel-a',
      savedAt: 100,
      tombstones: [],
      messages: [
        {
          _id: 'm1',
          channelId: 'channel-a',
          channelName: 'general',
          userId: 'u1',
          username: 'alice',
          displayName: 'Alice Example',
          content: 'needle text',
          contentFormat: 1,
          createdAt: 50,
        },
      ],
    }];

    expect(searchHistorySnapshots(snapshots, ' ')).toEqual({ hits: [], hasMore: false });
    expect(searchHistorySnapshots(snapshots, 'n')).toEqual({ hits: [], hasMore: false });
    expect(searchHistorySnapshots(snapshots, 'needle', {
      filters: { channelId: 'other' },
    }).hits).toEqual([]);
    expect(searchHistorySnapshots(snapshots, 'needle', {
      filters: { from: 'nobody' },
    }).hits).toEqual([]);
    expect(searchHistorySnapshots(snapshots, 'needle', {
      filters: { in: 'missing-name' },
    }).hits).toEqual([]);
    expect(searchHistorySnapshots(snapshots, 'needle', {
      filters: { has: 'file' },
    }).hits).toEqual([]);
    expect(searchHistorySnapshots(snapshots, 'needle', {
      filters: { after: 'not-a-date' },
    }).hits).toEqual([]);
    expect(searchHistorySnapshots(snapshots, 'needle', {
      filters: { before: '1970-01-01T00:00:00.001Z' },
    }).hits).toEqual([]);
  });

  it('clamps pagination and context radius without leaking another channel', () => {
    const snapshots: LocalHistorySnapshot[] = [{
      v: 1,
      channelId: 'channel-a',
      savedAt: 100,
      tombstones: [],
      messages: [
        { _id: 'm1', channelId: 'channel-a', content: 'needle one', contentFormat: 1, createdAt: 1 },
        { _id: 'm2', channelId: 'channel-a', content: 'needle two', contentFormat: 1, createdAt: 2 },
      ],
    }];

    expect(searchHistorySnapshots(snapshots, 'needle', { limit: 0, offset: -10 }).hits).toHaveLength(2);
    expect(searchHistorySnapshots(snapshots, 'needle', { limit: 999 }).hits).toHaveLength(2);
    expect(searchHistorySnapshots(snapshots, 'needle', { offset: 999 }).hits).toEqual([]);
  });

  it('builds context only from the same cached channel window', async () => {
    const userId = 'search-context-user';
    await replaceLocalFirstHistory(userId, 'channel-a', [
      { _id: 'm1', channelId: 'channel-a', userId: 'u1', content: 'one', contentFormat: 1, createdAt: 1 },
      { _id: 'm2', channelId: 'channel-a', userId: 'u2', content: 'two', contentFormat: 1, createdAt: 2 },
      { _id: 'm3', channelId: 'channel-a', userId: 'u3', content: 'three', contentFormat: 1, createdAt: 3 },
    ]);
    await replaceLocalFirstHistory(userId, 'channel-b', [
      { _id: 'b1', channelId: 'channel-b', content: 'other channel', contentFormat: 1, createdAt: 4 },
    ]);

    const context = await localFirstSearchContext(userId, 'channel-a', 'm2', 1);
    expect(context.map(item => item._id)).toEqual(['m1', 'm2', 'm3']);
    expect(context.filter(item => item.isAnchor).map(item => item._id)).toEqual(['m2']);
    expect(context.some(item => item._id === 'b1')).toBe(false);
  });
});


describe('P7 A6 local search boundary coverage', () => {
  const snapshot: LocalHistorySnapshot = {
    v: 1,
    channelId: 'c1',
    savedAt: 100,
    tombstones: [],
    messages: [
      {
        _id: 'rich',
        channelId: 'c1',
        channelName: 'General',
        serverId: 's1',
        threadId: 't1',
        userId: 'alice-id',
        username: 'alice',
        displayName: 'Alice A',
        content: 'needle needle https://example.com',
        contentFormat: 1,
        fileUrl: '/uploads/photo.PNG?x=1',
        fileType: 'application/octet-stream',
        createdAt: 20,
      },
      {
        _id: 'plain',
        channelId: 'c1',
        userId: 'bob-id',
        username: 'bob',
        content: 'needle other',
        contentFormat: 1,
        createdAt: 10,
      },
      {
        _id: 'empty',
        channelId: 'c1',
        content: '',
        contentFormat: 1,
        createdAt: 30,
      },
    ],
  };

  it('fails closed for short queries, invalid filters and channel mismatches', () => {
    expect(searchHistorySnapshots([snapshot], '')).toEqual({ hits: [], hasMore: false });
    expect(searchHistorySnapshots([snapshot], 'x')).toEqual({ hits: [], hasMore: false });
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { channelId: 'other' } }).hits).toEqual([]);
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { from: '   ' } }).hits).toEqual([]);
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { from: 'nobody' } }).hits).toEqual([]);
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { in: 'missing' } }).hits).toEqual([]);
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { after: 'not-a-date' } }).hits).toEqual([]);
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { before: 'not-a-date' } }).hits).toEqual([]);
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { before: '1970-01-01T00:00:00.005Z' } }).hits).toEqual([]);
    expect(searchHistorySnapshots([snapshot], 'needle absent-term').hits).toEqual([]);
  });

  it('covers username/channel/attachment branches and bounded page inputs', () => {
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { from: 'ali' } }).hits.map(h => h.id)).toEqual(['rich']);
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { in: '#gen' } }).hits.map(h => h.id)).toEqual(['rich']);
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { has: 'file' } }).hits.map(h => h.id)).toEqual(['rich']);
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { has: 'image' } }).hits.map(h => h.id)).toEqual(['rich']);
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { has: 'link' } }).hits.map(h => h.id)).toEqual(['rich']);
    expect(searchHistorySnapshots([snapshot], 'needle', { filters: { has: 'unknown' } }).hits).toEqual([]);

    const clamped = searchHistorySnapshots([snapshot], 'needle', {
      limit: 999,
      offset: -5,
    });
    expect(clamped.hits.map(h => h.id)).toEqual(['rich', 'plain']);
    expect(clamped.hits[0]).toMatchObject({
      channelId: 'c1',
      channelName: 'General',
      serverId: 's1',
      threadId: 't1',
      authorName: 'Alice A',
    });

    const minimum = searchHistorySnapshots([snapshot], 'needle', { limit: 0, offset: Number.NaN });
    expect(minimum.hits).toHaveLength(2);
  });

  it('covers context cache misses and radius clamps without crossing channels', () => {
    expect(localContextFromSnapshots([snapshot], 'missing', 'rich', 2)).toEqual([]);
    expect(localContextFromSnapshots([snapshot], 'c1', 'missing', 2)).toEqual([]);

    const zero = localContextFromSnapshots([snapshot], 'c1', 'plain', -10);
    expect(zero.map(row => row._id)).toEqual(['plain']);
    expect(zero[0]?.displayName).toBe('bob');

    const wide = localContextFromSnapshots([snapshot], 'c1', 'plain', 99);
    expect(wide.map(row => row._id)).toEqual(['rich', 'plain', 'empty']);
    expect(wide.find(row => row._id === 'plain')?.isAnchor).toBe(true);
  });
});
