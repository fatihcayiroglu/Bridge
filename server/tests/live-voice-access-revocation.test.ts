// server/tests/live-voice-access-revocation.test.ts
//
// P2 media lab (real browsers, real mediasoup, two nodes): revoking CONNECT or
// SPEAK on a voice channel, or timing a member out, while the member was in an
// established call left the media flowing — the SFU checks those permissions
// only when an operation starts, and the live re-check only knew VIEW. The
// re-check now also enforces voice access for sockets in a voice room.

const mockFindIdsByServer = jest.fn();
const mockFindMember = jest.fn();
jest.mock('../db/repositories', () => ({
  Channels: { findIdsByServer: (...args: unknown[]) => mockFindIdsByServer(...args) },
  Threads: { findById: jest.fn(async () => null) },
  Members: { findOne: (...args: unknown[]) => mockFindMember(...args) },
}));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() } }));
const mockCanView = jest.fn();
const mockResolve = jest.fn();
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return {
    ...actual,
    canViewChannel: (...args: unknown[]) => mockCanView(...args),
    resolvePermissions: (...args: unknown[]) => mockResolve(...args),
  };
});

import {
  bindVoiceEvictionClusterControl,
  evictSocketsWithoutChannelAccess,
  registerLocalVoiceEvictor,
  registerLocalVoicePublishRevoker,
  revokeVoicePublishingEverywhere,
} from '../lib/liveMembership';
import { PERMS } from '../lib/permissions';

const VOICE = PERMS.VIEW_CHANNELS | PERMS.CONNECT | PERMS.SPEAK;

function socket(id: string, rooms: string[]) {
  const s = {
    id,
    rooms: new Set(rooms),
    data: { userId: 'u1' },
    currentVoiceChannel: 'vc1' as string | undefined,
    currentVoiceServer: 's1' as string | undefined,
    leave: jest.fn(async (room: string) => { s.rooms.delete(room); }),
    emit: jest.fn(),
  };
  return s;
}

function io(sockets: unknown[]) {
  const cluster = new Map<string, (p: unknown) => unknown>();
  const serverSide: Array<{ event: string; payload: unknown }> = [];
  return {
    cluster, serverSide,
    on(event: string, fn: (p: unknown) => unknown) { cluster.set(event, fn); },
    serverSideEmit(event: string, payload: unknown) { serverSide.push({ event, payload }); },
    in: jest.fn(() => ({ fetchSockets: async () => sockets })),
  };
}

const evictor = jest.fn(async () => undefined);
const revoker = jest.fn(async () => undefined);

beforeEach(() => {
  jest.clearAllMocks();
  mockFindIdsByServer.mockResolvedValue(['vc1', 'tc1']);
  mockCanView.mockResolvedValue(true);
  mockFindMember.mockResolvedValue({ timeoutUntil: null });
  mockResolve.mockResolvedValue(VOICE);
  registerLocalVoiceEvictor(evictor);
  registerLocalVoicePublishRevoker(revoker);
});
afterEach(() => {
  registerLocalVoiceEvictor(null);
  registerLocalVoicePublishRevoker(null);
  delete process.env.REDIS_URL;
});

describe('live voice access re-check (VIEW kept)', () => {
  it('CONNECT revoked: the voice session is evicted, the text channel room is kept', async () => {
    mockResolve.mockResolvedValue(PERMS.VIEW_CHANNELS | PERMS.SPEAK);
    const s = socket('sock-1', ['server:s1', 'channel:vc1', 'voice:vc1']);
    await evictSocketsWithoutChannelAccess(io([s]) as never, 's1', 'vc1');
    expect(evictor).toHaveBeenCalledWith(expect.anything(), 'u1', ['vc1']);
    expect(s.rooms.has('voice:vc1')).toBe(false);
    expect(s.rooms.has('channel:vc1')).toBe(true);
    expect(s.currentVoiceChannel).toBeUndefined();
    expect(revoker).not.toHaveBeenCalled();
  });

  it('member timed out: the voice session is evicted', async () => {
    mockFindMember.mockResolvedValue({ timeoutUntil: Date.now() + 60_000 });
    const s = socket('sock-1', ['server:s1', 'voice:vc1']);
    await evictSocketsWithoutChannelAccess(io([s]) as never, 's1', null);
    expect(evictor).toHaveBeenCalledWith(expect.anything(), 'u1', ['vc1']);
    expect(s.rooms.has('voice:vc1')).toBe(false);
  });

  it('SPEAK revoked: publishing is revoked everywhere, listening stays', async () => {
    process.env.REDIS_URL = 'redis://cluster.test:6379';
    mockResolve.mockResolvedValue(PERMS.VIEW_CHANNELS | PERMS.CONNECT);
    const s = socket('sock-1', ['server:s1', 'voice:vc1']);
    const bus = io([s]);
    await evictSocketsWithoutChannelAccess(bus as never, 's1', 'vc1');
    expect(revoker).toHaveBeenCalledWith(bus, 'u1', 'vc1');
    expect(bus.serverSide).toEqual([{ event: 'membership:voice-publish-revoke', payload: { userId: 'u1', channelId: 'vc1' } }]);
    expect(evictor).not.toHaveBeenCalled();
    expect(s.rooms.has('voice:vc1')).toBe(true);
  });

  it('two sockets of one user (app + dedicated SFU socket) trigger one eviction', async () => {
    mockResolve.mockResolvedValue(PERMS.VIEW_CHANNELS);
    const a = socket('sock-app', ['server:s1', 'voice:vc1']);
    const b = socket('sock-sfu', ['server:s1', 'voice:vc1']);
    await evictSocketsWithoutChannelAccess(io([a, b]) as never, 's1', 'vc1');
    expect(evictor).toHaveBeenCalledTimes(1);
    expect(a.rooms.has('voice:vc1')).toBe(false);
    expect(b.rooms.has('voice:vc1')).toBe(false);
  });

  it('negative control: full voice access changes nothing', async () => {
    const s = socket('sock-1', ['server:s1', 'channel:vc1', 'voice:vc1']);
    const leaves = await evictSocketsWithoutChannelAccess(io([s]) as never, 's1', 'vc1');
    expect(leaves).toBe(0);
    expect(evictor).not.toHaveBeenCalled();
    expect(revoker).not.toHaveBeenCalled();
    expect(s.rooms.has('voice:vc1')).toBe(true);
  });

  it('negative control: a socket that is not in the voice room is never checked for voice access', async () => {
    mockResolve.mockResolvedValue(PERMS.VIEW_CHANNELS);
    const s = socket('sock-1', ['server:s1', 'channel:vc1']);
    await evictSocketsWithoutChannelAccess(io([s]) as never, 's1', 'vc1');
    expect(mockResolve).not.toHaveBeenCalled();
    expect(evictor).not.toHaveBeenCalled();
  });
});

describe('publish revocation reaches the room owner', () => {
  it('single-node deployments revoke locally and broadcast nothing', async () => {
    const bus = io([]);
    await revokeVoicePublishingEverywhere(bus as never, 'u1', 'vc1');
    expect(revoker).toHaveBeenCalledWith(bus, 'u1', 'vc1');
    expect(bus.serverSide).toEqual([]);
  });

  it('the cluster listener runs the local revoker only for well-formed payloads', async () => {
    const bus = io([]);
    bindVoiceEvictionClusterControl(bus as never);
    const listener = bus.cluster.get('membership:voice-publish-revoke')!;
    for (const bad of [null, [], 'x', { userId: 'u1' }, { channelId: 'vc1' }, { userId: 7, channelId: 'vc1' }, { userId: 'u1', channelId: '' }]) {
      listener(bad);
    }
    await new Promise(r => setImmediate(r));
    expect(revoker).not.toHaveBeenCalled();
    listener({ userId: 'u1', channelId: 'vc1' });
    await new Promise(r => setImmediate(r));
    expect(revoker).toHaveBeenCalledWith(bus, 'u1', 'vc1');
  });
});
