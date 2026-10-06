import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearLocalFirstHistoryChannel,
  replaceLocalFirstHistory,
  resetLocalFirstHistoryRuntimeForTests,
  tombstoneLocalFirstHistory,
} from '../js/core/local-first/history-runtime.ts';
import {
  localFirstSearchContext,
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
