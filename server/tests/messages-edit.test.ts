// server/tests/messages-edit.test.ts
// Sprint 107: messages-edit.ts birim testleri
// Kapsam: message:pin, message:delete, message:edit, message:react

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser, makeServer, makeChannel, makeMessage } from './helpers/mockDb';

const mockDb = createMockDb();
const mockValidateSocketPayload = jest.fn();
const mockGetCachedPerms = jest.fn();
const mockHasPermission = jest.fn();

jest.mock('../db/loader', () => mockDb);

jest.mock('../middleware/validate', () => ({
  validateSocketPayload: (...args: unknown[]) => mockValidateSocketPayload(...args),
  socketSchemas: {
    pinMessage: {}, deleteMessage: {}, editMessage: {}, reactMessage: {},
  },
}));

jest.mock('../routes/roles', () => ({
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
  resolvePermissions: jest.fn(),
  PERMS: { SEND_MESSAGES: 0x10, MANAGE_MESSAGES: 0x20 },
}));

jest.mock('../lib/permCache', () => ({
  getCachedPerms: (...args: unknown[]) => mockGetCachedPerms(...args),
}));

jest.mock('../lib/redisAdapter', () => ({
  cache: { del: jest.fn().mockResolvedValue(undefined) },
}));

import { registerEditHandlers } from '../socket/handlers/messages-edit';

// ── Yardımcılar ────────────────────────────────────────────────

function makeSocket(id = 'sock-edit-1') {
  const handlers: Record<string, (data: unknown) => void | Promise<void>> = {};
  const emitted: { ev: string; data: unknown; _room?: string }[] = [];

  const socket = {
    id,
    on(event: string, fn: (data: unknown) => void | Promise<void>) { handlers[event] = fn; },
    emit(ev: string, data?: unknown) { emitted.push({ ev, data }); },
    to(room: string) {
      return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _room: room }); } };
    },
    _handlers: handlers,
    _emitted: emitted,
    async _trigger(event: string, data: unknown) {
      if (handlers[event]) await handlers[event](data);
    },
  };
  return socket;
}

function makeIo() {
  const emitted: { ev: string; data: unknown; _target?: string }[] = [];
  return {
    _emitted: emitted,
    to(target: string) {
      return {
        emit(ev: string, data: unknown) { emitted.push({ ev, data, _target: target }); },
      };
    },
  };
}

// ════════════════════════════════════════════════════════════════
// registerEditHandlers
// ════════════════════════════════════════════════════════════════

describe('registerEditHandlers', () => {
  let owner: ReturnType<typeof makeUser>;
  let other: ReturnType<typeof makeUser>;
  let server: ReturnType<typeof makeServer>;
  let channel: ReturnType<typeof makeChannel>;
  let socket: ReturnType<typeof makeSocket>;
  let io: ReturnType<typeof makeIo>;

  beforeEach(async () => {
    mockDb._reset();
    jest.clearAllMocks();

    mockValidateSocketPayload.mockReturnValue({ valid: true });
    mockGetCachedPerms.mockResolvedValue(0xffffffff);
    mockHasPermission.mockImplementation((_perms: number, flag: number) => {
      // MANAGE_MESSAGES = 0x20
      if (flag === 0x20) return true;
      return true;
    });

    owner   = makeUser({ username: 'owner' });
    other   = makeUser({ username: 'other' });
    server  = makeServer(owner._id);
    channel = makeChannel(server._id);

    await mockDb.users.insert(owner);
    await mockDb.users.insert(other);
    await mockDb.servers.insert(server);
    await mockDb.channels.insert(channel);
    await mockDb.members.insert({
      userId: owner._id, serverId: server._id, joinedAt: Date.now(), roles: '[]',
    });
    await mockDb.members.insert({
      userId: other._id, serverId: server._id, joinedAt: Date.now(), roles: '[]',
    });

    socket = makeSocket();
    io     = makeIo();
    registerEditHandlers(socket as never, io as never, owner, new Map());
  });

  // ── message:pin ───────────────────────────────────────────

  describe('message:pin', () => {
    it('MANAGE_MESSAGES ile pin toggle → message:pinned broadcast', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id, { pinned: false });
      await mockDb.messages.insert(msg);

      await socket._trigger('message:pin', {
        messageId: msg._id, channelId: channel._id, serverId: server._id,
      });

      const evt = io._emitted.find(e => e.ev === 'message:pinned');
      expect(evt).toBeDefined();
      expect(evt!.data).toEqual({ messageId: msg._id, pinned: true });

      const updated = await mockDb.messages.findOne({ _id: msg._id });
      expect(updated!.pinned).toBe(true);
    });

    it('MANAGE_MESSAGES izni yok → işlem yapılmaz', async () => {
      mockHasPermission.mockReturnValue(false);
      const msg = makeMessage(channel._id, server._id, owner._id);
      await mockDb.messages.insert(msg);

      await socket._trigger('message:pin', {
        messageId: msg._id, channelId: channel._id, serverId: server._id,
      });

      expect(io._emitted).toHaveLength(0);
    });
  });

  // ── message:delete ─────────────────────────────────────────

  describe('message:delete', () => {
    it('sahip kendi mesajını siler → message:deleted broadcast', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id);
      await mockDb.messages.insert(msg);

      await socket._trigger('message:delete', { messageId: msg._id, channelId: channel._id });

      const evt = io._emitted.find(e => e.ev === 'message:deleted');
      expect(evt).toBeDefined();
      expect(evt!.data).toEqual({ id: msg._id });

      const gone = await mockDb.messages.findOne({ _id: msg._id });
      expect(gone).toBeNull();
    });

    it('başkasının mesajı — MANAGE_MESSAGES olmadan silinemez', async () => {
      mockHasPermission.mockReturnValue(false);
      const msg = makeMessage(channel._id, server._id, other._id);
      await mockDb.messages.insert(msg);

      await socket._trigger('message:delete', { messageId: msg._id, channelId: channel._id });

      expect(io._emitted).toHaveLength(0);
      const still = await mockDb.messages.findOne({ _id: msg._id });
      expect(still).toBeTruthy();
    });

    it('başkasının mesajı — MANAGE_MESSAGES ile silinebilir', async () => {
      mockHasPermission.mockImplementation((_p: number, flag: number) => flag === 0x20);
      const msg = makeMessage(channel._id, server._id, other._id);
      await mockDb.messages.insert(msg);

      await socket._trigger('message:delete', { messageId: msg._id, channelId: channel._id });

      expect(io._emitted.find(e => e.ev === 'message:deleted')).toBeDefined();
    });

    it('threadId ile silme — mesaj + thread cascade (mock repo yolu)', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id, { threadId: 'thread-1' });
      await mockDb.messages.insert(msg);
      await mockDb.threads.insert({
        _id: 'thread-1', channelId: channel._id, serverId: server._id,
        messageId: msg._id, createdAt: Date.now(),
      });

      await socket._trigger('message:delete', { messageId: msg._id, channelId: channel._id });

      expect(io._emitted.find(e => e.ev === 'message:deleted')).toBeDefined();
      expect(await mockDb.messages.findOne({ _id: msg._id })).toBeNull();
      expect(await mockDb.threads.findOne({ _id: 'thread-1' })).toBeNull();
    });
  });

  // ── message:edit ──────────────────────────────────────────

  describe('message:edit', () => {
    it('sahip mesajı düzenler → message:edited + editHistory', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id, { content: 'eski içerik' });
      await mockDb.messages.insert(msg);

      await socket._trigger('message:edit', {
        messageId: msg._id, channelId: channel._id, content: 'yeni içerik',
      });

      const evt = io._emitted.find(e => e.ev === 'message:edited');
      expect(evt).toBeDefined();
      expect((evt!.data as { content: string }).content).toBe('yeni içerik');

      const updated = await mockDb.messages.findOne({ _id: msg._id });
      expect(updated!.editHistory).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: 'eski içerik' })]),
      );
    });

    it('başkasının mesajı düzenlenemez', async () => {
      const msg = makeMessage(channel._id, server._id, other._id, { content: 'korunan' });
      await mockDb.messages.insert(msg);

      await socket._trigger('message:edit', {
        messageId: msg._id, channelId: channel._id, content: 'hack',
      });

      expect(io._emitted).toHaveLength(0);
    });

    it('boş içerik → düzenleme yapılmaz', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id);
      await mockDb.messages.insert(msg);

      await socket._trigger('message:edit', {
        messageId: msg._id, channelId: channel._id, content: '   ',
      });

      expect(io._emitted).toHaveLength(0);
    });

    it('2000+ karakter → düzenleme yapılmaz', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id);
      await mockDb.messages.insert(msg);

      await socket._trigger('message:edit', {
        messageId: msg._id, channelId: channel._id, content: 'x'.repeat(2001),
      });

      expect(io._emitted).toHaveLength(0);
    });
  });

  // ── message:react ─────────────────────────────────────────

  describe('message:react', () => {
    it('reaksiyon ekler → message:reaction broadcast', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id, { reactions: {} });
      await mockDb.messages.insert(msg);

      await socket._trigger('message:react', {
        messageId: msg._id, channelId: channel._id, emoji: '👍',
      });

      const evt = io._emitted.find(e => e.ev === 'message:reaction');
      expect(evt).toBeDefined();
      expect((evt!.data as { reactions: Record<string, string[]> }).reactions['👍']).toContain(owner._id);
    });

    it('aynı emoji tekrar → toggle (kaldırır)', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id, {
        reactions: { '👍': [owner._id] },
      });
      await mockDb.messages.insert(msg);

      await socket._trigger('message:react', {
        messageId: msg._id, channelId: channel._id, emoji: '👍',
      });

      const evt = io._emitted.find(e => e.ev === 'message:reaction');
      expect((evt!.data as { reactions: Record<string, string[]> }).reactions['👍']).toBeUndefined();
    });

    it('geçersiz emoji (11+ karakter) → işlem yapılmaz', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id);
      await mockDb.messages.insert(msg);

      await socket._trigger('message:react', {
        messageId: msg._id, channelId: channel._id, emoji: 'x'.repeat(11),
      });

      expect(io._emitted).toHaveLength(0);
    });

    it('reaction-role — emoji ile rol verilir', async () => {
      await mockDb.reactionRoles.insert({
        _id: 'rr-1', serverId: server._id, channelId: channel._id,
        messageId: 'msg-rr', emoji: '🎭', roleId: 'role-party',
      });
      const msg = makeMessage(channel._id, server._id, owner._id, {
        _id: 'msg-rr', reactions: {},
      });
      await mockDb.messages.insert(msg);

      await socket._trigger('message:react', {
        messageId: 'msg-rr', channelId: channel._id, emoji: '🎭',
      });

      const member = await mockDb.members.findOne({ userId: owner._id, serverId: server._id });
      const roles = JSON.parse((member!.roles as string) || '[]');
      expect(roles).toContain('role-party');
    });

    it('üye olmayan kullanıcı reaksiyon ekleyemez', async () => {
      const outsider = makeUser({ username: 'outsider' });
      await mockDb.users.insert(outsider);

      const outsiderSocket = makeSocket('sock-out');
      registerEditHandlers(outsiderSocket as never, io as never, outsider, new Map());

      const msg = makeMessage(channel._id, server._id, owner._id);
      await mockDb.messages.insert(msg);

      const before = io._emitted.length;
      await outsiderSocket._trigger('message:react', {
        messageId: msg._id, channelId: channel._id, emoji: '❤️',
      });

      expect(io._emitted.length).toBe(before);
    });
  });
});
