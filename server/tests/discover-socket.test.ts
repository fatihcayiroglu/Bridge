// server/tests/discover-socket.test.ts
// Branch coverage için discover socket handler testleri
// Hedef: pushMemberCount try/catch, onlineCount hesabı, boş üye listesi

process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

// ── Bağımlılık mock'ları ─────────────────────────────────────────────────────

jest.mock('../../db/repositories', () => ({
  Members: {
    findByServer: jest.fn(),
  },
}));

jest.mock('../../lib/presenceCache', () => ({
  isUserOnline: jest.fn(),
}));

jest.mock('../routes/discover', () => ({
  invalidateMemberCount: jest.fn().mockResolvedValue(undefined),
}));

import { Members } from '../../db/repositories';
import { isUserOnline } from '../../lib/presenceCache';
import { invalidateMemberCount } from '../routes/discover';
import { registerDiscoverHandlers, pushMemberCount } from '../socket/handlers/discover';
import type { Server as IOServer, Socket } from 'socket.io';

// ── Mock IO & Socket ─────────────────────────────────────────────────────────

function makeMockSocket(): Socket & { _trigger: (event: string) => void } {
  const handlers: Record<string, () => void> = {};
  return {
    on:    jest.fn((event: string, cb: () => void) => { handlers[event] = cb; }),
    join:  jest.fn(),
    leave: jest.fn(),
    emit:  jest.fn(),
    _trigger: (event: string) => handlers[event]?.(),
  } as unknown as Socket & { _trigger: (event: string) => void };
}

function makeMockIo(): IOServer & {
  _room: { emit: jest.Mock };
  _emitted: Array<{ event: string; payload: unknown }>;
} {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const room = {
    emit: jest.fn((event: string, payload: unknown) => emitted.push({ event, payload })),
  };
  return {
    to:       jest.fn(() => room),
    _room:    room,
    _emitted: emitted,
  } as unknown as IOServer & {
    _room: { emit: jest.Mock };
    _emitted: Array<{ event: string; payload: unknown }>;
  };
}

// ── registerDiscoverHandlers ─────────────────────────────────────────────────

describe('registerDiscoverHandlers', () => {
  it('discover:subscribe → socket.join("discover:live")', () => {
    const io     = makeMockIo();
    const socket = makeMockSocket();
    registerDiscoverHandlers(io, socket);
    socket._trigger('discover:subscribe');
    expect(socket.join).toHaveBeenCalledWith('discover:live');
  });

  it('discover:unsubscribe → socket.leave("discover:live")', () => {
    const io     = makeMockIo();
    const socket = makeMockSocket();
    registerDiscoverHandlers(io, socket);
    socket._trigger('discover:unsubscribe');
    expect(socket.leave).toHaveBeenCalledWith('discover:live');
  });
});

// ── pushMemberCount ──────────────────────────────────────────────────────────

describe('pushMemberCount', () => {
  const serverId = 'server-abc';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits correct counts when all members are online', async () => {
    const members = [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }];
    (Members.findByServer as jest.Mock).mockResolvedValue(members);
    (isUserOnline as jest.Mock).mockResolvedValue(true);

    const io = makeMockIo();
    await pushMemberCount(io, serverId);

    expect(io.to).toHaveBeenCalledWith('discover:live');
    expect(io._room.emit).toHaveBeenCalledWith(
      'discover:memberCount',
      expect.objectContaining({ serverId, memberCount: 3, onlineCount: 3 })
    );
  });

  it('emits correct onlineCount when only some members are online', async () => {
    const members = [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }];
    (Members.findByServer as jest.Mock).mockResolvedValue(members);
    // u1 online, u2 offline, u3 online
    (isUserOnline as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const io = makeMockIo();
    await pushMemberCount(io, serverId);

    expect(io._room.emit).toHaveBeenCalledWith(
      'discover:memberCount',
      expect.objectContaining({ memberCount: 3, onlineCount: 2 })
    );
  });

  it('emits zero counts when server has no members', async () => {
    (Members.findByServer as jest.Mock).mockResolvedValue([]);
    (isUserOnline as jest.Mock).mockResolvedValue(false);

    const io = makeMockIo();
    await pushMemberCount(io, serverId);

    expect(io._room.emit).toHaveBeenCalledWith(
      'discover:memberCount',
      expect.objectContaining({ memberCount: 0, onlineCount: 0 })
    );
  });

  it('calls invalidateMemberCount before querying DB', async () => {
    (Members.findByServer as jest.Mock).mockResolvedValue([]);
    const io = makeMockIo();
    await pushMemberCount(io, serverId);

    expect(invalidateMemberCount).toHaveBeenCalledWith(serverId);
    // invalidate önce çağrılmalı
    const invalidateOrder = (invalidateMemberCount as jest.Mock).mock.invocationCallOrder[0];
    const findOrder       = (Members.findByServer as jest.Mock).mock.invocationCallOrder[0];
    expect(invalidateOrder).toBeLessThan(findOrder);
  });

  it('does NOT throw when Members.findByServer rejects — catch branch', async () => {
    (Members.findByServer as jest.Mock).mockRejectedValue(new Error('DB down'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const io = makeMockIo();
    await expect(pushMemberCount(io, serverId)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[discover-socket]'),
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  it('does NOT throw when isUserOnline rejects — catch branch via Promise.all', async () => {
    (Members.findByServer as jest.Mock).mockResolvedValue([{ userId: 'u1' }]);
    (isUserOnline as jest.Mock).mockRejectedValue(new Error('presence down'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const io = makeMockIo();
    await expect(pushMemberCount(io, serverId)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('emitted payload contains a ts timestamp', async () => {
    (Members.findByServer as jest.Mock).mockResolvedValue([]);
    const before = Date.now();
    const io = makeMockIo();
    await pushMemberCount(io, serverId);
    const after = Date.now();

    const payload = io._emitted[0]?.payload as { ts: number };
    expect(payload.ts).toBeGreaterThanOrEqual(before);
    expect(payload.ts).toBeLessThanOrEqual(after);
  });
});
