import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendLocalFirstHistory,
  clearLocalFirstHistoryChannel,
  closeLocalFirstHistoryRuntime,
  listLocalFirstHistory,
  localFirstHistoryStorageStatus,
  mergeOlderLocalFirstHistory,
  readLocalFirstHistory,
  replaceLocalFirstHistory,
  resetLocalFirstHistoryRuntimeForTests,
  tombstoneLocalFirstHistory,
  updateLocalFirstHistory,
} from '../js/core/local-first/history-runtime.ts';

beforeEach(() => {
  resetLocalFirstHistoryRuntimeForTests();
});

afterEach(() => {
  resetLocalFirstHistoryRuntimeForTests();
  vi.unstubAllGlobals();
});

describe('P7 history runtime lifecycle coverage', () => {
  it('rejects blank users and lets blank close remain a no-op', async () => {
    expect(() => replaceLocalFirstHistory('', 'c1', [])).toThrow('History userId is required');
    await expect(readLocalFirstHistory('', 'c1')).rejects.toThrow('History userId is required');
    await expect(listLocalFirstHistory('')).rejects.toThrow('History userId is required');
    expect(() => closeLocalFirstHistoryRuntime('')).not.toThrow();
  });

  it('serializes writes and waits for pending channel chains before listing', async () => {
    const first = replaceLocalFirstHistory('u-history', 'c1', [
      { _id: 'm2', channelId: 'c1', content: 'two', createdAt: 2 },
    ]);
    const second = appendLocalFirstHistory('u-history', 'c1', {
      _id: 'm3', channelId: 'c1', content: 'three', createdAt: 3,
    });
    const listing = listLocalFirstHistory('u-history');

    await Promise.all([first, second]);
    await expect(listing).resolves.toMatchObject([
      { channelId: 'c1', messages: [{ _id: 'm2' }, { _id: 'm3' }] },
    ]);

    await mergeOlderLocalFirstHistory('u-history', 'c1', [
      { _id: 'm1', channelId: 'c1', content: 'one', createdAt: 1 },
    ]);
    await updateLocalFirstHistory('u-history', 'c1', {
      _id: 'm2', channelId: 'c1', content: 'two edited', createdAt: 2,
    });
    await tombstoneLocalFirstHistory('u-history', 'c1', 'm3');

    await expect(readLocalFirstHistory('u-history', 'c1')).resolves.toMatchObject({
      messages: [
        { _id: 'm1' },
        { _id: 'm2', content: 'two edited' },
      ],
      tombstones: [{ id: 'm3' }],
    });

    await clearLocalFirstHistoryChannel('u-history', 'c1');
    await expect(readLocalFirstHistory('u-history', 'c1')).resolves.toBeNull();
  });

  it('reports intentional memory fallback status and releases account runtime', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await replaceLocalFirstHistory('memory-history', 'c1', [
      { _id: 'm1', channelId: 'c1', content: 'memory only', createdAt: 1 },
    ]);

    await expect(localFirstHistoryStorageStatus('memory-history')).resolves.toMatchObject({
      userId: 'memory-history',
      durable: false,
      backend: 'memory',
      reason: 'IndexedDB unavailable',
    });

    closeLocalFirstHistoryRuntime('memory-history');
    await expect(readLocalFirstHistory('memory-history', 'c1')).resolves.toBeNull();
  });
});
