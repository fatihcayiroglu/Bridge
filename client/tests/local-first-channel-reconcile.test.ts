import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OutboxEntry } from '../js/core/outbox-store.ts';
import type { LocalHistorySnapshot } from '../js/core/local-first/history.ts';
import {
  reconcileLocalChannels,
  staleLocalChannels,
} from '../js/core/local-first/channel-reconcile.ts';
import {
  listLocalFirstHistory,
  replaceLocalFirstHistory,
  resetLocalFirstHistoryRuntimeForTests,
  clearLocalFirstHistoryChannel,
} from '../js/core/local-first/history-runtime.ts';

const snapshot = (channelId: string, serverId?: string): LocalHistorySnapshot => ({
  v: 1,
  channelId,
  savedAt: 1,
  messages: serverId ? [{ _id: channelId + '-m', channelId, serverId, content: 'secret', createdAt: 1 }] : [],
  tombstones: [],
});
const queued = (ackId: string, channelId: string, serverId: string, draftKind: OutboxEntry['draftKind'] = 'channel') =>
  ({ ackId, channelId, serverId, draftKind }) as OutboxEntry;

describe('P7 D2 staleLocalChannels', () => {
  it('selects only this server\'s cached channels that the authorized list dropped', () => {
    const stale = staleLocalChannels('s1', ['live'], [
      snapshot('live', 's1'),
      snapshot('expired', 's1'),
      snapshot('other-server', 's2'),
      snapshot('empty'),
    ], [
      queued('a1', 'expired', 's1'),
      queued('a2', 'live', 's1'),
      queued('a3', 'other-server', 's2'),
      queued('a4', 'dm-channel', 's1', 'dm'),
    ]);
    expect(stale).toEqual({ history: ['expired'], outbox: ['a1'] });
  });

  it('does nothing without a server id', () => {
    expect(staleLocalChannels('', [], [snapshot('x', 's1')], [queued('a', 'x', 's1')])).toEqual({ history: [], outbox: [] });
  });
});

describe('P7 D2 reconcileLocalChannels against the encrypted history runtime', () => {
  beforeEach(() => resetLocalFirstHistoryRuntimeForTests());
  afterEach(() => resetLocalFirstHistoryRuntimeForTests());

  it('purges an expired channel\'s history and queued sends, keeping live and foreign copies', async () => {
    const user = 'u-reconcile';
    await replaceLocalFirstHistory(user, 'live', [{ _id: 'm1', channelId: 'live', serverId: 's1', content: 'keep', createdAt: 1 }]);
    await replaceLocalFirstHistory(user, 'gone', [{ _id: 'm2', channelId: 'gone', serverId: 's1', content: 'expired secret', createdAt: 2 }]);
    await replaceLocalFirstHistory(user, 'elsewhere', [{ _id: 'm3', channelId: 'elsewhere', serverId: 's2', content: 'other', createdAt: 3 }]);
    let outbox = [queued('q-gone', 'gone', 's1'), queued('q-live', 'live', 's1')];
    const removed: string[] = [];

    const result = await reconcileLocalChannels(user, 's1', ['live'], {
      listHistory: listLocalFirstHistory,
      clearHistory: clearLocalFirstHistoryChannel,
      readOutbox: () => outbox,
      removeOutbox: (_user, ackId) => { removed.push(ackId); outbox = outbox.filter(e => e.ackId !== ackId); },
    });

    expect(result).toEqual({ history: ['gone'], outbox: ['q-gone'] });
    expect(removed).toEqual(['q-gone']);
    const left = (await listLocalFirstHistory(user)).map(s => s.channelId).sort();
    expect(left).toEqual(['elsewhere', 'live']);
    expect(JSON.stringify(await listLocalFirstHistory(user))).not.toContain('expired secret');
  });
});
