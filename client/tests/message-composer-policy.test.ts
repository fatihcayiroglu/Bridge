import {
  draftContextKey,
  draftKindOf,
  isTextChannel,
  optimisticOutboxMessage,
  outboxPayload,
} from '../js/core/message-composer-policy.ts';
import type { OutboxEntry } from '../js/core/outbox-store.ts';

const entry: OutboxEntry = {
  ackId: 'a1', userId: 'u1', channelId: 'c1', serverId: 's1', draftKind: 'channel',
  messageType: 'text', content: 'hello', createdAt: 1, state: 'queued', attempts: 0,
};

describe('message composer pure policy', () => {
  it('builds retry-safe socket payloads from durable outbox entries', () => {
    expect(outboxPayload(entry)).toMatchObject({ channelId: 'c1', serverId: 's1', content: 'hello', ackId: 'a1', _tmpId: 'a1' });
  });

  it('builds stable optimistic render identity without mutating the entry', () => {
    const message = optimisticOutboxMessage(entry, { _id: 'u1', displayName: 'Alice' });
    expect(message).toMatchObject({ _id: 'pending:a1', _key: 'pending:a1', queued: true, pending: true, userId: 'u1' });
    expect(entry.state).toBe('queued');
  });

  it('centralizes conversation kind and text-channel policy', () => {
    expect(draftKindOf({ type: 'group_dm' })).toBe('gdm');
    expect(draftKindOf({ type: 'dm' })).toBe('dm');
    expect(draftKindOf({ type: 'text' })).toBe('channel');
    expect(draftContextKey('u1', 'c1', 'channel', 's1')).toBe('u1:channel:s1:c1');
    expect(isTextChannel({ type: 'voice' })).toBe(false);
    expect(isTextChannel({ type: 'text' })).toBe(true);
  });
});
