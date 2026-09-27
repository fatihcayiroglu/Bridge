const mockFindIdsByServer = jest.fn();
const mockFindById = jest.fn();

jest.mock('../db/repositories', () => ({
  Channels: { findIdsByServer: (...args: unknown[]) => mockFindIdsByServer(...args) },
  Threads: { findById: (...args: unknown[]) => mockFindById(...args) },
}));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { error: jest.fn(), info: jest.fn() } }));

const mockCanViewChannel = jest.fn();
jest.mock('../lib/permissions', () => ({
  canViewChannel: (...args: unknown[]) => mockCanViewChannel(...args),
}));

import {
  evictSocketsWithoutChannelAccess,
  evictSocketsWithoutChannelAccessBestEffort,
  evictUserFromServerRooms,
  evictUserFromServerRoomsBestEffort,
  roomBelongsToServer,
} from '../lib/liveMembership';
import logger from '../lib/logger';

describe('live membership revocation', () => {
  beforeEach(() => {
    mockFindIdsByServer.mockReset();
    mockFindById.mockReset();
    mockFindIdsByServer.mockResolvedValue(['c1', 'c2']);
    mockFindById.mockImplementation(async (threadId: string) => threadId === 't1' ? { _id: 't1', serverId: 's1', channelId: 'c1' } : null);
  });

  it('classifies only server-owned realtime rooms', () => {
    const channels = new Set(['c1']);
    const threads = new Set(['t1']);
    expect(roomBelongsToServer('server:s1', 's1', channels, threads)).toBe(true);
    expect(roomBelongsToServer('channel:c1', 's1', channels, threads)).toBe(true);
    expect(roomBelongsToServer('voice:c1', 's1', channels, threads)).toBe(true);
    // Faz 15'in `watch:<channelId>` odalari Faz 16'ya kadar bu sinifta DEGILDI:
    // atilan uye, goremedigi kanallarin `channel:activity` sinyalini almaya devam
    // ediyordu. Icerik tasimasa da 'bu kanal hareketli' bilgisini sizdiriyordu.
    expect(roomBelongsToServer('watch:c1', 's1', channels, threads)).toBe(true);
    expect(roomBelongsToServer('watch:baska-sunucunun-kanali', 's1', channels, threads)).toBe(false);
    expect(roomBelongsToServer('thread:t1', 's1', channels, threads)).toBe(true);
    expect(roomBelongsToServer('user:u1', 's1', channels, threads)).toBe(false);
    expect(roomBelongsToServer('dm:d1', 's1', channels, threads)).toBe(false);
    expect(roomBelongsToServer('gdm:g1', 's1', channels, threads)).toBe(false);
  });

  it('evicts all target-user server rooms without touching DM/GDM/user rooms', async () => {
    const leaves: string[] = [];
    const emits: Array<[string, unknown]> = [];
    const socket = {
      rooms: new Set([
        'socket-1', 'user:u1', 'server:s1', 'channel:c1', 'voice:c1', 'stage:c2',
        'canvas:c1', 'draw:c2', 'video-grid:c2', 'watch:c1', 'watch:c2', 'thread:t1', 'dm:d1', 'gdm:g1',
      ]),
      currentChannel: 'c1',
      currentVoiceChannel: 'c2',
      currentVoiceServer: 's1',
      leave: jest.fn(async (room: string) => { socket.rooms.delete(room); leaves.push(room); }),
      emit: jest.fn((event: string, payload: unknown) => { emits.push([event, payload]); }),
    };
    const io = { in: jest.fn(() => ({ fetchSockets: async () => [socket] })) } as never;

    await evictUserFromServerRooms(io, 'u1', 's1');

    expect(leaves).toEqual(expect.arrayContaining([
      'server:s1', 'channel:c1', 'voice:c1', 'stage:c2', 'canvas:c1',
      'draw:c2', 'video-grid:c2', 'watch:c1', 'watch:c2', 'thread:t1',
    ]));
    expect(socket.rooms.has('user:u1')).toBe(true);
    expect(socket.rooms.has('dm:d1')).toBe(true);
    expect(socket.rooms.has('gdm:g1')).toBe(true);
    expect(socket.currentChannel).toBeUndefined();
    expect(socket.currentVoiceChannel).toBeUndefined();
    expect(socket.currentVoiceServer).toBeUndefined();
    expect(emits).toContainEqual(['membership:revoked', { serverId: 's1' }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FAZ 16 — YETKİ İPTALİ AÇIK SOKETE DE ULAŞMALI
// ════════════════════════════════════════════════════════════════════════════
// ÖLÇÜLEN SIZINTI (`p16-perm-revocation-probe`, gerçek sunucu, iki hesap):
// bir kanalda VIEW_CHANNELS reddedildikten sonra HTTP okuması 403 dönüyordu,
// ama ZATEN AÇIK soket `message:new` almaya devam ediyordu — mesajın içeriğiyle
// birlikte. `invalidatePerms` yalnızca ÖNBELLEĞİ temizliyor; odalara dokunmuyordu.
describe('FAZ 16 — yetki iptalinde kanal odalarından çıkarma', () => {
  const socketFactory = (rooms: string[]) => {
    const socket = {
      id: 'sock-1',
      rooms: new Set(rooms),
      data: { userId: 'u1' },
      currentChannel: 'c1',
      currentVoiceChannel: 'c1',
      currentVoiceServer: 's1',
      leaves: [] as string[],
      emits: [] as Array<[string, unknown]>,
      leave: jest.fn(async (room: string) => { socket.rooms.delete(room); socket.leaves.push(room); }),
      emit: jest.fn((event: string, payload: unknown) => { socket.emits.push([event, payload]); }),
    };
    return socket;
  };
  const ioWith = (socket: unknown) =>
    ({ in: jest.fn(() => ({ fetchSockets: async () => [socket] })) }) as never;

  beforeEach(() => {
    mockCanViewChannel.mockReset();
    mockFindIdsByServer.mockReset();
    mockFindById.mockReset();
    mockFindIdsByServer.mockResolvedValue(['c1', 'c2']);
    mockFindById.mockResolvedValue(null);
  });

  it('görünürlüğü kalmayan kanalın TÜM canlı odalarından çıkarır', async () => {
    mockCanViewChannel.mockResolvedValue(false);
    const socket = socketFactory(['sock-1', 'user:u1', 'server:s1', 'channel:c1', 'watch:c1', 'voice:c1']);

    const leaves = await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', 'c1');

    expect(leaves).toBe(3);
    expect(socket.leaves.sort()).toEqual(['channel:c1', 'voice:c1', 'watch:c1']);
    expect(socket.currentChannel).toBeUndefined();
    expect(socket.currentVoiceChannel).toBeUndefined();
    expect(socket.emits).toContainEqual(['channel:access-revoked', { serverId: 's1', channelId: 'c1' }]);
  });

  it('POZİTİF KONTROL: görünürlüğü SÜREN kanala dokunmaz', async () => {
    mockCanViewChannel.mockResolvedValue(true);
    const socket = socketFactory(['sock-1', 'user:u1', 'server:s1', 'channel:c1', 'watch:c1']);

    const leaves = await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', 'c1');

    expect(leaves).toBe(0);
    expect(socket.leaves).toEqual([]);
    expect(socket.rooms.has('channel:c1')).toBe(true);
    expect(socket.currentChannel).toBe('c1');
    expect(socket.emits).toEqual([]);
  });

  it('yalnız ETKİLENEN kanalı çıkarır; diğer kanalın odaları kalır', async () => {
    mockCanViewChannel.mockImplementation(async (_u: string, _s: string, cid: string) => cid !== 'c1');
    const socket = socketFactory(['sock-1', 'user:u1', 'server:s1', 'channel:c1', 'watch:c1', 'watch:c2']);

    await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', null);

    expect(socket.rooms.has('watch:c2')).toBe(true);
    expect(socket.rooms.has('channel:c1')).toBe(false);
    expect(socket.rooms.has('watch:c1')).toBe(false);
  });

  it('kullanıcıya ait olmayan odalara (user/dm/gdm) asla dokunmaz', async () => {
    mockCanViewChannel.mockResolvedValue(false);
    const socket = socketFactory(['sock-1', 'user:u1', 'server:s1', 'channel:c1', 'dm:d1', 'gdm:g1']);

    await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', 'c1');

    expect(socket.rooms.has('user:u1')).toBe(true);
    expect(socket.rooms.has('dm:d1')).toBe(true);
    expect(socket.rooms.has('gdm:g1')).toBe(true);
    expect(socket.rooms.has('server:s1')).toBe(true);
  });

  it('kanalın thread odası da çıkarılır (aynı kanala ait)', async () => {
    mockCanViewChannel.mockResolvedValue(false);
    mockFindById.mockImplementation(async (id: string) =>
      id === 't1' ? { _id: 't1', serverId: 's1', channelId: 'c1' } : null);
    const socket = socketFactory(['sock-1', 'user:u1', 'server:s1', 'channel:c1', 'thread:t1']);

    await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', 'c1');

    expect(socket.rooms.has('thread:t1')).toBe(false);
  });

  it('kimliği çözülemeyen sokette yetki sorgusu YAPILMAZ', async () => {
    mockCanViewChannel.mockResolvedValue(false);
    const socket = socketFactory(['sock-1', 'server:s1', 'channel:c1']);
    socket.data = { userId: '' } as { userId: string };

    const leaves = await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', 'c1');

    expect(leaves).toBe(0);
    expect(mockCanViewChannel).not.toHaveBeenCalled();
  });

  it('io veya serverId yoksa sessizce 0 döner', async () => {
    expect(await evictSocketsWithoutChannelAccess(null, 's1', 'c1')).toBe(0);
    expect(await evictSocketsWithoutChannelAccess(ioWith(socketFactory([])), '', 'c1')).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Final21 Phase 17 — the eviction paths nothing exercised.
//
// The routes do not call the eviction directly: they call the BEST-EFFORT wrappers, which
// were untested in both directions. The rest below are the cases a real server produces and
// a happy-path test never does: a socket whose id lives only in its own user room, a server
// with no channels left, and thread rooms that belong somewhere else.
// ════════════════════════════════════════════════════════════════════════════
describe('Final21 Phase 17 — eviction edge paths', () => {
  const socketFactory = (rooms: string[], userId: string | null = 'u1') => {
    const socket = {
      id: 'sock-1',
      rooms: new Set(rooms),
      data: userId === null ? {} : { userId },
      leaves: [] as string[],
      emits: [] as Array<[string, unknown]>,
      leave: jest.fn(async (room: string) => { socket.rooms.delete(room); socket.leaves.push(room); }),
      emit: jest.fn((event: string, payload: unknown) => { socket.emits.push([event, payload]); }),
    };
    return socket;
  };
  const ioWith = (socket: unknown) =>
    ({ in: jest.fn(() => ({ fetchSockets: async () => [socket] })) }) as never;

  beforeEach(() => {
    mockCanViewChannel.mockReset();
    mockFindIdsByServer.mockReset();
    mockFindById.mockReset();
    mockFindIdsByServer.mockResolvedValue(['c1', 'c2']);
    mockFindById.mockResolvedValue(null);
    (logger.error as jest.Mock).mockClear();
  });

  it('a socket identified only by its user room is still evicted', async () => {
    // `socket.data.userId` is set at authentication time. A socket restored by the Redis
    // adapter from another node does not carry it, and skipping those would leave exactly the
    // sockets a multi-node deployment has.
    mockCanViewChannel.mockResolvedValue(false);
    const socket = socketFactory(['sock-1', 'user:u9', 'server:s1', 'channel:c1'], null);

    const leaves = await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', 'c1');

    expect(leaves).toBe(1);
    expect(mockCanViewChannel).toHaveBeenCalledWith('u9', 's1', 'c1');
  });

  it('a socket with no identity at all is skipped without a permission query', async () => {
    mockCanViewChannel.mockResolvedValue(false);
    const socket = socketFactory(['sock-1', 'server:s1', 'channel:c1'], null);

    expect(await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', 'c1')).toBe(0);
    expect(mockCanViewChannel).not.toHaveBeenCalled();
  });

  it('a server with no channels evicts nothing and does not even look at sockets', async () => {
    mockFindIdsByServer.mockResolvedValue([]);
    const io = ioWith(socketFactory(['sock-1', 'server:s1', 'channel:c1'])) as unknown as { in: jest.Mock };

    expect(await evictSocketsWithoutChannelAccess(io as never, 's1', null)).toBe(0);
    expect(io.in).not.toHaveBeenCalled();
  });

  it('a socket holding nothing from the affected channel is left alone', async () => {
    mockCanViewChannel.mockResolvedValue(false);
    const socket = socketFactory(['sock-1', 'user:u1', 'server:s1', 'channel:c2']);

    expect(await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', 'c1')).toBe(0);
    // No rooms of the affected channel, so not even a permission query is worth making.
    expect(mockCanViewChannel).not.toHaveBeenCalled();
    expect(socket.rooms.has('channel:c2')).toBe(true);
  });

  it.each([
    ['belongs to another server', { _id: 't1', serverId: 'other-server', channelId: 'c1' }],
    ['hangs off a channel that is not affected', { _id: 't1', serverId: 's1', channelId: 'c2' }],
    ['has no parent channel recorded', { _id: 't1', serverId: 's1', channelId: null }],
  ])('a thread room that %s is not evicted', async (_label, thread) => {
    mockCanViewChannel.mockResolvedValue(false);
    mockFindById.mockResolvedValue(thread);
    const socket = socketFactory(['sock-1', 'user:u1', 'server:s1', 'thread:t1']);

    await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', 'c1');

    expect(socket.rooms.has('thread:t1')).toBe(true);
  });

  it('a channel room and its thread room leave together', async () => {
    mockCanViewChannel.mockResolvedValue(false);
    mockFindById.mockResolvedValue({ _id: 't1', serverId: 's1', channelId: 'c1' });
    const socket = socketFactory(['sock-1', 'user:u1', 'server:s1', 'channel:c1', 'thread:t1']);

    const leaves = await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', 'c1');

    expect(leaves).toBe(2);
    expect(socket.leaves.sort()).toEqual(['channel:c1', 'thread:t1']);
    // One announcement per channel, not one per room.
    expect(socket.emits.filter(([event]) => event === 'channel:access-revoked')).toHaveLength(1);
  });

  it('the best-effort wrappers do the work, and swallow a failure instead of undoing the permission write', async () => {
    mockCanViewChannel.mockResolvedValue(false);
    const socket = socketFactory(['sock-1', 'user:u1', 'server:s1', 'channel:c1']);
    await evictSocketsWithoutChannelAccessBestEffort(ioWith(socket), 's1', 'c1');
    expect(socket.rooms.has('channel:c1')).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();

    // A socket server that cannot list sockets (adapter outage) must not turn a completed
    // permission change into a 500: the write already happened, so the failure is logged.
    const brokenIo = { in: () => ({ fetchSockets: async () => { throw new Error('adapter down'); } }) } as never;
    await expect(evictSocketsWithoutChannelAccessBestEffort(brokenIo, 's1', 'c1')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'socket.channel_access_evict.failed' }), expect.any(String));
  });

  it('the membership wrapper behaves the same way', async () => {
    const socket = socketFactory(['sock-1', 'user:u1', 'server:s1', 'channel:c1']);
    await evictUserFromServerRoomsBestEffort(ioWith(socket), 'u1', 's1');
    expect(socket.rooms.has('channel:c1')).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();

    const brokenIo = { in: () => ({ fetchSockets: async () => { throw new Error('adapter down'); } }) } as never;
    await expect(evictUserFromServerRoomsBestEffort(brokenIo, 'u1', 's1')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'socket.membership_evict.failed' }), expect.any(String));
  });

  it('a socket carrying its id as a plain property (older shape) is still evicted', async () => {
    mockCanViewChannel.mockResolvedValue(false);
    const socket = socketFactory(['sock-1', 'server:s1', 'channel:c1'], null) as ReturnType<typeof socketFactory> & { userId?: string };
    socket.userId = 'u7';

    expect(await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', 'c1')).toBe(1);
    expect(mockCanViewChannel).toHaveBeenCalledWith('u7', 's1', 'c1');
  });

  it('a socket holding ONLY a thread room of the affected channel is evicted from it', async () => {
    // The parent channel room is not held here, so the thread room is the first (and only)
    // room recorded for that channel — a person reading a thread in a side panel.
    mockCanViewChannel.mockResolvedValue(false);
    mockFindById.mockResolvedValue({ _id: 't1', serverId: 's1', channelId: 'c1' });
    const socket = socketFactory(['sock-1', 'user:u1', 'server:s1', 'thread:t1']);

    const leaves = await evictSocketsWithoutChannelAccess(ioWith(socket), 's1', 'c1');

    expect(leaves).toBe(1);
    expect(socket.rooms.has('thread:t1')).toBe(false);
    expect(socket.emits).toContainEqual(['channel:access-revoked', { serverId: 's1', channelId: 'c1' }]);
  });
  it('nothing to evict when io, userId or serverId is missing', async () => {
    expect(await evictUserFromServerRooms(null, 'u1', 's1')).toBe(0);
    expect(await evictUserFromServerRooms(ioWith(socketFactory([])), '', 's1')).toBe(0);
    expect(await evictUserFromServerRooms(ioWith(socketFactory([])), 'u1', '')).toBe(0);
  });
});
