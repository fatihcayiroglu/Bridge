// server/tests/messages-edit.test.ts
// Sprint 107: messages-edit.ts birim testleri
// Kapsam: message:pin, message:delete, message:edit, message:react
import { EmittedLog, SocketDouble, findEmitted, requireEmitted } from './helpers/socketDoubles';

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeChannel, makeMessage, makeServer, makeUser, requireDoc } from './helpers/mockDb';

const mockDb = createMockDb();
const mockValidateSocketPayload = jest.fn();
const mockGetCachedPerms = jest.fn();
const mockHasPermission = jest.fn();
const mockCacheIncrement = jest.fn();
const mockInvalidatePerms = jest.fn();

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
  PERMS: { VIEW_CHANNELS: 0x01, SEND_MESSAGES: 0x10, MANAGE_MESSAGES: 0x20, ADD_REACTIONS: 0x1000 },
}));

// Final21 Phase 16: edit/delete authority is decided in lib/messageMutations.ts, which reads
// lib/permissions directly. The same mock drives it, so these cases keep their meaning.
jest.mock('../lib/permissions', () => ({
  ...jest.requireActual('../lib/permissions'),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
}));

jest.mock('../lib/permCache', () => ({
  getCachedPerms: (...args: unknown[]) => mockGetCachedPerms(...args),
  invalidatePerms: (...args: unknown[]) => mockInvalidatePerms(...args),
}));

jest.mock('../lib/redisAdapter', () => ({
  cache: {
    // Gercek adaptorde MEVCUT (lib/redisAdapter.ts) — mock'ta eksikti ve
    // `invalidateChannelMessages` her cagrida sessizce TypeError firlatiyordu.
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    increment: (...args: unknown[]) => mockCacheIncrement(...args),
  },
}));

import { registerEditHandlers } from '../socket/handlers/messages-edit';

/**
 * `members.roles` PostgreSQL'de JSONB'dir; `pg` GERÇEK DİZİ döndürür. Bu dosya
 * `JSON.parse(member.roles as string)` yapıyordu — üretimde ASLA oluşmayan bir
 * şekil. Mock artık PostgreSQL'e sadık (helpers/mockDb.ts); okuma da öyle.
 */
function readRoles(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

// ── Yardımcılar ────────────────────────────────────────────────

function makeSocket(id: string = 'sock-edit-1') {
  const handlers: Record<string, unknown> = {};
  const emitted: EmittedLog = [];
  const rooms = new Set<string>();

  const socket = {
    id,
    on(event, fn) { handlers[event] = fn; },
    emit(ev, ...args) { emitted.push({ ev, data: args[0] }); },
    to(room) {
      return { emit(ev, ...args) { emitted.push({ ev, data: args[0], _room: room }); } };
    },
    rooms,
    join(room)  { rooms.add(room); },
    leave(room) { rooms.delete(room); },
    _handlers: handlers,
    _emitted: emitted,
    async _trigger(event: string, data?: unknown) {
      const handler = handlers[event];
      if (typeof handler === 'function') await handler(data);
    },
  } satisfies SocketDouble;
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
    mockCacheIncrement.mockResolvedValue(1);
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

      const evt = requireEmitted(io._emitted, 'message:pinned');
      expect(evt).toBeDefined();
      expect(evt!.data).toEqual({ messageId: msg._id, pinned: true });

      const updated = await mockDb.messages.findOne({ _id: msg._id });
      expect(updated!.pinned).toBe(true);
      expect(mockGetCachedPerms).toHaveBeenCalledWith(
        owner._id, server._id, expect.any(Function), channel._id,
      );
    });

    it('repository rejection listener promiseini kaçırmaz; process-safe hata döner', async () => {
      const findSpy = jest.spyOn(mockDb.messages, 'findOne').mockRejectedValueOnce(new Error('db unavailable'));

      await expect(socket._trigger('message:pin', {
        messageId: 'm-fail', channelId: channel._id, serverId: server._id,
      })).resolves.toBeUndefined();

      expect(findEmitted(socket._emitted, 'error:message')).toMatchObject({
        data: { event: 'message:pin' },
      });
      findSpy.mockRestore();
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

      const evt = requireEmitted(io._emitted, 'message:deleted');
      expect(evt).toBeDefined();
      expect(evt!.data).toEqual({ id: msg._id });

      const gone = await mockDb.messages.findOne({ _id: msg._id });
      expect(gone).toMatchObject({ content: '[Mesaj silindi]', deletedBy: owner._id, fileUrl: null });
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
      // 0x20 is this file's fake routes/roles table (pin/react); since Final21 Phase 16 delete is
      // decided in lib/messageMutations.ts with the REAL PERMS bit. Only MANAGE_MESSAGES is granted.
      const REAL = jest.requireActual('../lib/permissions') as typeof import('../lib/permissions');
      mockHasPermission.mockImplementation((_p: number, flag: number) => flag === 0x20 || flag === REAL.PERMS.MANAGE_MESSAGES);
      const msg = makeMessage(channel._id, server._id, other._id);
      await mockDb.messages.insert(msg);

      await socket._trigger('message:delete', { messageId: msg._id, channelId: channel._id });

      expect(findEmitted(io._emitted, 'message:deleted')).toBeDefined();
    });

    it('threadId ile silme — mesaj + thread cascade (mock repo yolu)', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id, { threadId: 'thread-1' });
      await mockDb.messages.insert(msg);
      await mockDb.threads.insert({
        _id: 'thread-1', channelId: channel._id, serverId: server._id,
        messageId: msg._id, createdAt: Date.now(),
      });

      await socket._trigger('message:delete', { messageId: msg._id, channelId: channel._id });

      expect(findEmitted(io._emitted, 'message:deleted')).toBeDefined();
      expect(await mockDb.messages.findOne({ _id: msg._id })).toMatchObject({ content: '[Mesaj silindi]', deletedBy: owner._id });
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

      const evt = requireEmitted(io._emitted, 'message:edited');
      expect(evt).toBeDefined();
      expect((evt!.data as { content: string }).content).toBe('yeni içerik');

      const updated = await mockDb.messages.findOne({ _id: msg._id });
      expect(updated!.editHistory).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: 'eski içerik' })]),
      );
    });

    it('AutoMod delete kuralı edit bypassını kapatır ve eski geçerli içeriği korur', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id, { content: 'temiz içerik' });
      await mockDb.messages.insert(msg);
      await mockDb.automodRules.insert({
        _id: 'am-edit-block', serverId: server._id, type: 'blocked_words', enabled: true,
        config: { words: ['forbidden'], action: 'delete' }, createdBy: owner._id, createdAt: Date.now(),
      });

      await socket._trigger('message:edit', {
        messageId: msg._id,
        channelId: channel._id,
        content: 'now FORBIDDEN',
        clientNonce: 'edit-automod-blocked',
        baseVersion: Number(msg.createdAt ?? 0),
      });

      expect(await mockDb.messages.findOne({ _id: msg._id })).toMatchObject({ content: 'temiz içerik' });
      expect(findEmitted(io._emitted, 'message:edited')).toBeUndefined();
      expect(findEmitted(socket._emitted, 'error:message')).toMatchObject({
        data: {
          event: 'message:edit',
          code: 'AUTOMOD_BLOCKED',
          clientNonce: 'edit-automod-blocked',
        },
      });
    });

    it('AutoMod timeout-only editte timeoutu kalıcı uygular ve düzenlemeye izin verir', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id, { content: 'before' });
      await mockDb.messages.insert(msg);
      await mockDb.automodRules.insert({
        _id: 'am-edit-timeout', serverId: server._id, type: 'blocked_words', enabled: true,
        config: { words: ['timeoutme'], action: 'timeout', timeoutMs: 120000 }, createdBy: owner._id, createdAt: Date.now(),
      });
      const before = Date.now();

      await socket._trigger('message:edit', {
        messageId: msg._id, channelId: channel._id, content: 'timeoutme edited',
      });

      const member = await mockDb.members.findOne({ userId: owner._id, serverId: server._id });
      const updated = await mockDb.messages.findOne({ _id: msg._id });
      expect(member!.timeoutUntil).toBeGreaterThanOrEqual(before + 120000);
      expect(updated!.content).toBe('timeoutme edited');
      expect(findEmitted(io._emitted, 'message:edited')).toBeDefined();
    });

    it('spam_messages editte sayılmaz ve mevcut mesajı engellemez', async () => {
      mockCacheIncrement.mockResolvedValue(999);
      const msg = makeMessage(channel._id, server._id, owner._id, { content: 'before' });
      await mockDb.messages.insert(msg);
      await mockDb.automodRules.insert({
        _id: 'am-edit-spam', serverId: server._id, type: 'spam_messages', enabled: true,
        config: { maxMessages: 2, windowSecs: 7 }, createdBy: owner._id, createdAt: Date.now(),
      });

      await socket._trigger('message:edit', {
        messageId: msg._id, channelId: channel._id, content: 'ordinary edit',
      });

      expect(mockCacheIncrement).not.toHaveBeenCalled();
      expect((await mockDb.messages.findOne({ _id: msg._id }))!.content).toBe('ordinary edit');
    });

    it('AutoMod store/evaluation arızasında fail-closed: edit uygulanmaz', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id, { content: 'stable' });
      await mockDb.messages.insert(msg);
      // `find()` SENKRON bir zincir doner (`FindChain`), Promise degil;
      // `mockRejectedValueOnce` bu yuzden uymuyordu. Reddi zincirin
      // `then`inden vermek urunun GERCEK kullanimina uyar.
      const findSpy = jest.spyOn(mockDb.automodRules, 'find').mockImplementationOnce(() => {
        throw new Error('automod db down');
      });

      await socket._trigger('message:edit', {
        messageId: msg._id,
        channelId: channel._id,
        content: 'should not persist',
        clientNonce: 'edit-automod-unavailable',
        baseVersion: Number(msg.createdAt ?? 0),
      });

      expect((await mockDb.messages.findOne({ _id: msg._id }))!.content).toBe('stable');
      expect(findEmitted(socket._emitted, 'error:message')).toMatchObject({
        data: {
          event: 'message:edit',
          code: 'AUTOMOD_UNAVAILABLE',
          clientNonce: 'edit-automod-unavailable',
        },
      });
      findSpy.mockRestore();
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

      const evt = requireEmitted(io._emitted, 'message:reaction');
      expect(evt).toBeDefined();
      expect((evt!.data as { reactions: Record<string, string[]> }).reactions['👍']).toContain(owner._id);
    });

    it('desired-state replay aynı nonce ile idempotent kalır ve nonce başarı eventinde echo edilir', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id, { reactions: {} });
      await mockDb.messages.insert(msg);

      const payload = {
        messageId: msg._id,
        channelId: channel._id,
        emoji: '👍',
        active: true,
        clientNonce: 'reaction-op-1',
      };
      await socket._trigger('message:react', payload);
      await socket._trigger('message:react', payload);

      const current = await mockDb.messages.findOne({ _id: msg._id });
      expect((current!.reactions as Record<string, string[]>)['👍']).toEqual([owner._id]);

      const broadcasts = io._emitted.filter(entry => entry.ev === 'message:reaction');
      expect(broadcasts).toHaveLength(2);
      expect(broadcasts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            messageId: msg._id,
            clientNonce: 'reaction-op-1',
          }),
        }),
      ]));
    });

    it('nonce-correlated desired reaction yetki reddinde terminal mutation reject döndürür', async () => {
      mockHasPermission.mockImplementation((_perms: number, flag: number) => flag !== 0x1000);
      const msg = makeMessage(channel._id, server._id, owner._id, { reactions: {} });
      await mockDb.messages.insert(msg);

      await socket._trigger('message:react', {
        messageId: msg._id,
        channelId: channel._id,
        emoji: '👍',
        active: true,
        clientNonce: 'reaction-op-denied',
      });

      expect(findEmitted(io._emitted, 'message:reaction')).toBeUndefined();
      expect(findEmitted(socket._emitted, 'error:message')).toMatchObject({
        data: {
          event: 'message:react',
          code: 'MUTATION_REJECTED',
          clientNonce: 'reaction-op-denied',
        },
      });
      const current = await mockDb.messages.findOne({ _id: msg._id });
      expect(current!.reactions ?? {}).toEqual({});
    });

    it('aynı emoji tekrar → toggle (kaldırır)', async () => {
      const msg = makeMessage(channel._id, server._id, owner._id, {
        reactions: { '👍': [owner._id] },
      });
      await mockDb.messages.insert(msg);

      await socket._trigger('message:react', {
        messageId: msg._id, channelId: channel._id, emoji: '👍',
      });

      const evt = requireEmitted(io._emitted, 'message:reaction');
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

    it('reaction-role — yetkili creator kuralı ile rol verilir', async () => {
      await mockDb.roles.insert({
        _id: 'role-party', serverId: server._id, name: 'Party', permissions: 0, position: 5,
      });
      await mockDb.reactionRoles.insert({
        _id: 'rr-1', serverId: server._id, channelId: channel._id,
        messageId: 'msg-rr', emoji: '🎭', roleId: 'role-party', createdBy: owner._id,
      });
      const msg = makeMessage(channel._id, server._id, owner._id, {
        _id: 'msg-rr', reactions: {},
      });
      await mockDb.messages.insert(msg);

      await socket._trigger('message:react', {
        messageId: 'msg-rr', channelId: channel._id, emoji: '🎭',
      });

      const member = await mockDb.members.findOne({ userId: owner._id, serverId: server._id });
      const roles = readRoles(member!.roles);
      expect(roles).toContain('role-party');
    });

    it('reaction-role toggle off removes the role, invalidates permissions and notifies active sessions', async () => {
      await mockDb.roles.insert({
        _id: 'role-party', serverId: server._id, name: 'Party', permissions: 0, position: 5,
      });
      await mockDb.members.update(
        { userId: owner._id, serverId: server._id },
        { $set: { roles: ['role-party'] } },
      );
      await mockDb.reactionRoles.insert({
        _id: 'rr-remove', serverId: server._id, channelId: channel._id,
        messageId: 'msg-remove', emoji: '🎭', roleId: 'role-party', createdBy: owner._id,
      });
      await mockDb.messages.insert(makeMessage(channel._id, server._id, owner._id, {
        _id: 'msg-remove', reactions: { '🎭': [owner._id] },
      }));

      socket = makeSocket();
      registerEditHandlers(
        socket as never,
        io as never,
        owner,
        new Map([['owner-session', { _id: owner._id }]]) as never,
      );

      await socket._trigger('message:react', {
        messageId: 'msg-remove', channelId: channel._id, emoji: '🎭',
      });

      const member = await mockDb.members.findOne({ userId: owner._id, serverId: server._id });
      expect(readRoles(member!.roles)).not.toContain('role-party');
      expect(mockInvalidatePerms).toHaveBeenCalledWith(server._id, owner._id);
      expect(io._emitted).toContainEqual({
        ev: 'role:revoked',
        data: { serverId: server._id, roleId: 'role-party', emoji: '🎭' },
        _target: `user:${owner._id}`,
      });
    });

    it('GÜVENLİK: legacy kural createdBy taşımıyorsa fail-closed, rol verilmez', async () => {
      await mockDb.roles.insert({
        _id: 'role-legacy-target', serverId: server._id, name: 'Legacy target', permissions: 0, position: 5,
      });
      await mockDb.reactionRoles.insert({
        _id: 'rr-legacy', serverId: server._id, channelId: channel._id,
        messageId: 'msg-legacy', emoji: '🧨', roleId: 'role-legacy-target',
      });
      await mockDb.messages.insert(makeMessage(channel._id, server._id, owner._id, { _id: 'msg-legacy', reactions: {} }));

      await socket._trigger('message:react', {
        messageId: 'msg-legacy', channelId: channel._id, emoji: '🧨',
      });

      const member = await mockDb.members.findOne({ userId: owner._id, serverId: server._id });
      const roles = readRoles(member!.roles);
      expect(roles).not.toContain('role-legacy-target');
    });

    it('GÜVENLİK: rule creator sonradan hedef rolün altına düşerse kural artık rol veremez', async () => {
      await mockDb.roles.insert({ _id: 'creator-low', serverId: server._id, name: 'Low', permissions: 0, position: 1 });
      await mockDb.roles.insert({ _id: 'role-high-target', serverId: server._id, name: 'High', permissions: 0, position: 10 });
      await mockDb.members.update(
        { userId: other._id, serverId: server._id },
        { $set: { roles: JSON.stringify(['creator-low']) } },
      );
      await mockDb.reactionRoles.insert({
        _id: 'rr-demoted', serverId: server._id, channelId: channel._id,
        messageId: 'msg-demoted', emoji: '⬆️', roleId: 'role-high-target', createdBy: other._id,
      });
      await mockDb.messages.insert(makeMessage(channel._id, server._id, owner._id, { _id: 'msg-demoted', reactions: {} }));

      await socket._trigger('message:react', {
        messageId: 'msg-demoted', channelId: channel._id, emoji: '⬆️',
      });

      const member = await mockDb.members.findOne({ userId: owner._id, serverId: server._id });
      const roles = readRoles(member!.roles);
      expect(roles).not.toContain('role-high-target');
    });

    it('ADD_REACTIONS izni yoksa state ve broadcast değişmez', async () => {
      mockHasPermission.mockImplementation((_perms: number, flag: number) => flag !== 0x1000);
      const msg = makeMessage(channel._id, server._id, owner._id, { reactions: {} });
      await mockDb.messages.insert(msg);

      await socket._trigger('message:react', {
        messageId: msg._id, channelId: channel._id, emoji: '🚫',
      });

      expect(findEmitted(io._emitted, 'message:reaction')).toBeUndefined();
      const unchanged = await mockDb.messages.findOne({ _id: msg._id });
      expect(unchanged!.reactions ?? {}).toEqual({});
    });

    it('20 unique emoji doluyken yeni emoji eklenmez, mevcut emoji toggle edilebilir', async () => {
      const reactions: Record<string, string[]> = {};
      for (let i = 0; i < 20; i++) reactions[`e${i}`] = [other._id];
      const msg = makeMessage(channel._id, server._id, owner._id, { reactions });
      await mockDb.messages.insert(msg);

      await socket._trigger('message:react', {
        messageId: msg._id, channelId: channel._id, emoji: 'NEW',
      });
      expect(findEmitted(io._emitted, 'message:reaction')).toBeUndefined();
      let current = await mockDb.messages.findOne({ _id: msg._id });
      expect(Object.keys(current!.reactions as Record<string, string[]>)).toHaveLength(20);

      await socket._trigger('message:react', {
        messageId: msg._id, channelId: channel._id, emoji: 'e0',
      });
      current = await mockDb.messages.findOne({ _id: msg._id });
      expect((current!.reactions as Record<string, string[]>)['e0']).toEqual(expect.arrayContaining([other._id, owner._id]));
      expect(findEmitted(io._emitted, 'message:reaction')).toBeDefined();
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
