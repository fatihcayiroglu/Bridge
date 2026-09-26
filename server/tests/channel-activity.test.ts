// server/tests/channel-activity.test.ts
//
// Final21 Phase 15 — unread channel state and message publication.
//
// Measured first (tools/p15-capability-probe.mjs, tools/p15-unread-api.mjs): three plain
// messages in a channel the viewer was not looking at left no unread trace, live or after a
// reload. Five message creators also skipped history-cache invalidation, and incoming
// webhook posts were never broadcast at all (tools/p15-webhook-live-probe.mjs).

process.env.NODE_ENV = 'test';

const mockRepos = {
  Members: { findOne: jest.fn() },
  Channels: { findByServer: jest.fn() },
};
const mockCanView = jest.fn();
const mockInvalidate = jest.fn();

jest.mock('../db/repositories', () => mockRepos);
jest.mock('../lib/permissions', () => ({ canViewChannel: (...args: unknown[]) => mockCanView(...args) }));
jest.mock('../lib/messageCache', () => ({ invalidateChannelMessages: (...args: unknown[]) => mockInvalidate(...args) }));

import {
  announceChannelActivity,
  broadcastPersistedMessage,
  publishPersistedMessage,
  watchRoom,
  watchServerChannels,
} from '../lib/channelActivity';
import { memoizeInRequest } from '../lib/requestContext';

function recordingIo() {
  const events: Array<{ room: string; event: string; payload: any }> = [];
  const order: string[] = [];
  return {
    events,
    order,
    to(room: string) {
      return { emit(event: string, payload: unknown) { events.push({ room, event, payload }); order.push(`emit:${event}`); } };
    },
  };
}

const message = {
  _id: 'm1', channelId: 'c1', serverId: 's1', userId: 'u2', createdAt: 1_800_000_000_000,
  content: 'secret launch plan', username: 'bob', fileUrl: '/uploads/x.png',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockInvalidate.mockResolvedValue(undefined);
});

describe('channel:activity carries no message content', () => {
  it('emits only identifiers and time to the channel watch room', () => {
    const io = recordingIo();
    announceChannelActivity(io, message);
    expect(io.events).toEqual([{
      room: 'watch:c1', event: 'channel:activity',
      payload: { channelId: 'c1', serverId: 's1', messageId: 'm1', userId: 'u2', createdAt: 1_800_000_000_000 },
    }]);
    expect(JSON.stringify(io.events)).not.toMatch(/secret|bob|uploads/);
  });

  it.each([
    ['no io', null, message],
    ['no channel', recordingIo(), { ...message, channelId: undefined }],
    ['no server', recordingIo(), { ...message, serverId: 42 }],
    ['no message id', recordingIo(), { ...message, _id: '' }],
  ])('does nothing with %s', (_label, io, row) => {
    announceChannelActivity(io as never, row as never);
    if (io) expect((io as ReturnType<typeof recordingIo>).events).toEqual([]);
  });
});

describe('publishing a persisted message', () => {
  it('broadcast: the full message to the channel room, the content-free signal to watchers', () => {
    const io = recordingIo();
    broadcastPersistedMessage(io, message);
    expect(io.events.map((e) => [e.room, e.event])).toEqual([['channel:c1', 'message:new'], ['watch:c1', 'channel:activity']]);
    expect(io.events[0]!.payload).toBe(message);
  });

  it('publish: invalidates the history page BEFORE anyone can re-read it', async () => {
    const io = recordingIo();
    mockInvalidate.mockImplementation(async () => { io.order.push('invalidate'); });
    await publishPersistedMessage(io, message);
    expect(mockInvalidate).toHaveBeenCalledWith('c1');
    expect(io.order).toEqual(['invalidate', 'emit:message:new', 'emit:channel:activity']);
  });

  it('publish without a socket server still invalidates (jobs that start before io)', async () => {
    await publishPersistedMessage(null, message);
    expect(mockInvalidate).toHaveBeenCalledWith('c1');
  });

  it('publish of a row without a channel does nothing', async () => {
    const io = recordingIo();
    await publishPersistedMessage(io, { _id: 'm1' });
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(io.events).toEqual([]);
  });
});

describe('watchServerChannels', () => {
  function fakeSocket(rooms: string[]) {
    const set = new Set(rooms);
    return { id: 'sock-1', rooms: set, join: jest.fn((r: string) => { set.add(r); }), leave: jest.fn((r: string) => { set.delete(r); }) };
  }

  it('joins only message channels the member can view, and drops watch rooms of the previous server', async () => {
    mockRepos.Members.findOne.mockResolvedValue({ userId: 'u1', serverId: 's1' });
    mockRepos.Channels.findByServer.mockResolvedValue([
      { _id: 'text-open', type: 'text' },
      { _id: 'text-private', type: 'text' },
      { _id: 'news', type: 'announcement' },
      { _id: 'voice', type: 'voice' },
      { _id: 'stage', type: 'stage' },
      { _id: 'legacy-untyped' },
    ]);
    mockCanView.mockImplementation(async (_u: string, _s: string, channelId: string) => channelId !== 'text-private');
    const socket = fakeSocket(['sock-1', 'server:s1', 'channel:text-open', 'watch:old-server-channel']);

    const watched = await watchServerChannels(socket, 'u1', 's1');

    expect(watched).toEqual(['text-open', 'news', 'legacy-untyped']);
    expect([...socket.rooms].sort()).toEqual(
      ['channel:text-open', 'server:s1', 'sock-1', watchRoom('legacy-untyped'), watchRoom('news'), watchRoom('text-open')].sort(),
    );
    // Visibility was asked only for message channels.
    expect(mockCanView.mock.calls.map((call) => call[2])).toEqual(['text-open', 'text-private', 'news', 'legacy-untyped']);
  });

  it('a non-member watches nothing and leaves every watch room, other rooms untouched', async () => {
    mockRepos.Members.findOne.mockResolvedValue(null);
    const socket = fakeSocket(['sock-1', 'server:s9', 'watch:a', 'watch:b']);
    await expect(watchServerChannels(socket, 'u1', 's1')).resolves.toEqual([]);
    expect([...socket.rooms].sort()).toEqual(['server:s9', 'sock-1']);
    expect(mockRepos.Channels.findByServer).not.toHaveBeenCalled();
  });

  it('runs visibility checks inside one memo scope (server/membership/roles read once)', async () => {
    mockRepos.Members.findOne.mockResolvedValue({ userId: 'u1', serverId: 's1' });
    mockRepos.Channels.findByServer.mockResolvedValue([{ _id: 'a', type: 'text' }, { _id: 'b', type: 'text' }]);
    const loads = jest.fn(async () => 'server-row');
    mockCanView.mockImplementation(async () => { await memoizeInRequest('perm:server:s1', loads); return true; });
    await watchServerChannels(fakeSocket([]), 'u1', 's1');
    expect(loads).toHaveBeenCalledTimes(1);
  });
});


// ════════════════════════════════════════════════════════════════════════════
// Final21 Phase 17 — the defensive paths of the activity signal.
//
// These branches existed but nothing exercised them. They matter: the signal carries an id
// that every client turns into an unread badge and a jump target. A half-built row (a write
// that failed halfway, a plugin-made object, a legacy row without serverId) must produce NO
// signal at all rather than one pointing at nothing.
// ════════════════════════════════════════════════════════════════════════════
describe('channel activity — malformed rows are not announced', () => {
  const emit = jest.fn();
  const io = { to: jest.fn(() => ({ emit })) };
  beforeEach(() => { emit.mockClear(); io.to.mockClear(); });

  it.each([
    ['no _id at all', { channelId: 'c1', serverId: 's1' }],
    ['a non-string _id', { _id: 123, channelId: 'c1', serverId: 's1' }],
    ['no serverId (a DM row)', { _id: 'm1', channelId: 'c1' }],
    ['no channelId', { _id: 'm1', serverId: 's1' }],
    ['nothing at all', null],
  ])('announces nothing for %s', (_label, message) => {
    announceChannelActivity(io, message as never);
    expect(io.to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('announces nothing when there is no io (a caller without a socket server)', () => {
    expect(() => announceChannelActivity(null, { _id: 'm1', channelId: 'c1', serverId: 's1' })).not.toThrow();
  });

  it('a row with an unusable author or timestamp still announces, with honest values', () => {
    const before = Date.now();
    announceChannelActivity(io, { _id: 'm1', channelId: 'c1', serverId: 's1', userId: { id: 'u1' }, createdAt: 'yesterday' });
    expect(io.to).toHaveBeenCalledWith('watch:c1');
    const payload = emit.mock.calls[0][1] as { userId: unknown; createdAt: number };
    // Not the object, and not NaN: a NaN timestamp sorts nowhere and breaks every client list.
    expect(payload.userId).toBeNull();
    expect(Number.isFinite(payload.createdAt)).toBe(true);
    expect(payload.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('broadcastPersistedMessage stays silent for a row with no channel', () => {
    broadcastPersistedMessage(io, { _id: 'm1', serverId: 's1' } as never);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('re-exports the unread limits callers import from here', async () => {
    const mod = await import('../lib/channelActivity');
    expect(typeof mod.MAX_WATCHED_CHANNELS).toBe('number');
    expect(typeof mod.MAX_UNREAD_CHANNELS).toBe('number');
    expect(Array.isArray(mod.MESSAGE_CHANNEL_TYPES)).toBe(true);
  });
});
