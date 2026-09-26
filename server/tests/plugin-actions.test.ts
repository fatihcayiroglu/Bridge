// server/tests/plugin-actions.test.ts
// Sprint 108: plugin:sendMessage | deleteMessage | grantRole sunucu handler testleri
import { findEmitted, requireEmitted } from './helpers/socketDoubles';

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeChannel, makeMessage, makeServer, makeUser, requireDoc } from './helpers/mockDb';

/**
 * `members.roles` PostgreSQL'de JSONB'dir ve `pg` sürücüsü GERÇEK DİZİ
 * döndürür. Bu dosya eskiden `JSON.parse(member.roles as string)` yapıyordu —
 * yani ÜRETİMDE ASLA oluşmayan bir string şeklini varsayıyordu. Mock artık
 * PostgreSQL'e sadık olduğu için (helpers/mockDb.ts) okuma da sadeleştirildi.
 * Legacy string satırları da tolere edilir.
 */
function readRoles(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);

import { hooks } from '../plugins/loader';
import { registerPluginActionHandlers } from '../plugins/actions';
import { makePluginActionEnvelope, type PluginActionEvent } from '../plugins/capabilities';
import { PERMS } from '../lib/permissions';


async function emitAs<T>(event: PluginActionEvent, permission: string, payload: T, pluginId = 'test-plugin') {
  await hooks.emit(event, makePluginActionEnvelope(pluginId, [permission], payload));
}

function makeIo() {
  const emitted: { ev: string; data: unknown; _target?: string }[] = [];
  return {
    _emitted: emitted,
    to(target: string) {
      return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _target: target }); } };
    },
    emit(ev: string, data: unknown) { emitted.push({ ev, data }); },
  };
}

describe('registerPluginActionHandlers', () => {
  let io: ReturnType<typeof makeIo>;
  let user: ReturnType<typeof makeUser>;
  let server: ReturnType<typeof makeServer>;
  let channel: ReturnType<typeof makeChannel>;

  beforeAll(() => {
    io = makeIo();
    registerPluginActionHandlers(hooks, io as never);
  });

  beforeEach(async () => {
    mockDb._reset();
    io._emitted.length = 0;
    user    = makeUser();
    server  = makeServer(user._id);
    channel = makeChannel(server._id);
    await mockDb.users.insert(user);
    await mockDb.servers.insert(server);
    await mockDb.channels.insert(channel);
    await mockDb.members.insert({
      userId: user._id, serverId: server._id, roles: '[]', joinedAt: Date.now(),
    });
  });

  it('registration is idempotent on the same hook bus', async () => {
    registerPluginActionHandlers(hooks, io as never);
    registerPluginActionHandlers(hooks, io as never);

    await emitAs('plugin:sendMessage', 'messages:send', {
      channelId: channel._id, serverId: server._id, content: 'one handler only',
    });

    expect(io._emitted.filter(e => e.ev === 'message:new' && e._target === `channel:${channel._id}`)).toHaveLength(1);
    const saved = await mockDb.messages.find({ channelId: channel._id });
    expect(saved).toHaveLength(1);
  });

  it('plugin:sendMessage → message:new broadcast', async () => {
    await emitAs('plugin:sendMessage', 'messages:send', {
      channelId: channel._id,
      serverId:  server._id,
      content:   'Plugin mesajı',
      botName:   'Test Bot',
    });

    const evt = requireEmitted(io._emitted, 'message:new', { target: `channel:${channel._id}` });
    expect(evt).toBeDefined();
    expect((evt!.data as { content: string }).content).toBe('Plugin mesajı');

    const saved = await mockDb.messages.findOne({ channelId: channel._id });
    expect(saved).toBeTruthy();
  });

  it('plugin:deleteMessage → message:deleted broadcast', async () => {
    const msg = makeMessage(channel._id, server._id, user._id);
    await mockDb.messages.insert(msg);

    await emitAs('plugin:deleteMessage', 'messages:delete', {
      messageId: msg._id,
      channelId: channel._id,
      serverId:  server._id,
    });

    expect(findEmitted(io._emitted, 'message:deleted')).toBeDefined();
    expect(await mockDb.messages.findOne({ _id: msg._id })).toMatchObject({
      content: '[Mesaj silindi]', deletedBy: 'plugin:test-plugin', fileUrl: null, encryptedContent: null,
    });
  });

  it('plugin:deleteMessage — threadId ile thread cascade', async () => {
    const msg = makeMessage(channel._id, server._id, user._id, { threadId: 'th-plug' });
    await mockDb.messages.insert(msg);
    await mockDb.threads.insert({
      _id: 'th-plug', channelId: channel._id, serverId: server._id,
      messageId: msg._id, createdAt: Date.now(),
    });

    await emitAs('plugin:deleteMessage', 'messages:delete', {
      messageId: msg._id, channelId: channel._id, serverId: server._id,
    });

    expect(findEmitted(io._emitted, 'message:deleted')).toBeDefined();
    expect(await mockDb.threads.findOne({ _id: 'th-plug' })).toBeNull();
  });

  it('plugin:grantRole → üyeye aynı sunucudaki rolü ekler', async () => {
    await mockDb.roles.insert({ _id: 'role-welcome', serverId: server._id, name: 'Welcome', position: 1, permissions: 0 });
    await emitAs('plugin:grantRole', 'roles:assign', {
      userId:   user._id,
      serverId: server._id,
      roleId:   'role-welcome',
    });

    const member = await mockDb.members.findOne({ userId: user._id, serverId: server._id });
    const roles  = readRoles(member!.roles);
    expect(roles).toContain('role-welcome');
    expect(io._emitted).toContainEqual(expect.objectContaining({
      ev: 'role:granted', _target: `server:${server._id}`,
      data: expect.objectContaining({ serverId: server._id, userId: user._id, roleId: 'role-welcome' }),
    }));
    expect(io._emitted.some(e => e.ev === 'role:granted' && !e._target)).toBe(false);
  });

  it('plugin:sendMessage — channel/server locator uyuşmazlığında mesaj oluşturmaz', async () => {
    const other = makeServer(user._id);
    await mockDb.servers.insert(other);

    await emitAs('plugin:sendMessage', 'messages:send', {
      channelId: channel._id,
      serverId: other._id,
      content: 'wrong tenant',
    });

    expect(await mockDb.messages.findOne({ content: 'wrong tenant' })).toBeNull();
    expect(io._emitted.some(e => e.ev === 'message:new')).toBe(false);
  });

  it("plugin:deleteMessage — payload channel/server mesajın canonical scope'u ile uyuşmazsa reddeder", async () => {
    const msg = makeMessage(channel._id, server._id, user._id);
    await mockDb.messages.insert(msg);

    await emitAs('plugin:deleteMessage', 'messages:delete', {
      messageId: msg._id,
      channelId: 'other-channel',
      serverId: server._id,
    });

    expect(await mockDb.messages.findOne({ _id: msg._id })).toBeTruthy();
    expect(io._emitted.some(e => e.ev === 'message:deleted')).toBe(false);
  });

  it('plugin:grantRole — başka sunucuya ait roleId üyeye eklenmez', async () => {
    const other = makeServer(user._id);
    await mockDb.servers.insert(other);
    await mockDb.roles.insert({ _id: 'foreign-role', serverId: other._id, name: 'Foreign', position: 1, permissions: 0 });

    await emitAs('plugin:grantRole', 'roles:assign', {
      userId: user._id,
      serverId: server._id,
      roleId: 'foreign-role',
    });

    const member = await mockDb.members.findOne({ userId: user._id, serverId: server._id });
    const roles = readRoles(member!.roles);
    expect(roles).not.toContain('foreign-role');
  });


  it('raw/unattributed privileged action payload is denied by default', async () => {
    await hooks.emit('plugin:sendMessage', {
      channelId: channel._id, serverId: server._id, content: 'forged',
    });
    expect(await mockDb.messages.findOne({ content: 'forged' })).toBeNull();
  });

  it('wrong capability cannot invoke a different privileged action', async () => {
    await hooks.emit('plugin:grantRole', makePluginActionEnvelope('weak-plugin', ['messages:send'], {
      userId: user._id, serverId: server._id, roleId: 'role-welcome',
    }));
    const member = await mockDb.members.findOne({ userId: user._id, serverId: server._id });
    expect(readRoles(member!.roles)).not.toContain('role-welcome');
  });

  it('plugin role grant preserves PostgreSQL JSONB array roles', async () => {
    await mockDb.members.update({ userId: user._id, serverId: server._id }, { $set: { roles: ['existing-role'] } });
    await mockDb.roles.insert({ _id: 'role-welcome', serverId: server._id, name: 'Welcome', position: 1, permissions: 0 });
    await emitAs('plugin:grantRole', 'roles:assign', {
      userId: user._id, serverId: server._id, roleId: 'role-welcome',
    });
    const member = await mockDb.members.findOne({ userId: user._id, serverId: server._id });
    expect(readRoles(member!.roles)).toEqual(expect.arrayContaining(['existing-role', 'role-welcome']));
  });

  it('plugin cannot auto-assign an authority-delegating role', async () => {
    await mockDb.roles.insert({
      _id: 'role-admin', serverId: server._id, name: 'Admin', position: 1,
      permissions: PERMS.ADMINISTRATOR,
    });
    await emitAs('plugin:grantRole', 'roles:assign', {
      userId: user._id, serverId: server._id, roleId: 'role-admin',
    }, 'auto-role');
    const member = await mockDb.members.findOne({ userId: user._id, serverId: server._id });
    expect(readRoles(member!.roles)).not.toContain('role-admin');
  });

  it('plugin cannot auto-assign moderation or mention-everyone authority', async () => {
    await mockDb.roles.insert({
      _id: 'role-moderator', serverId: server._id, name: 'Moderator', position: 1,
      permissions: PERMS.BAN_MEMBERS | PERMS.MANAGE_MESSAGES | PERMS.MENTION_EVERYONE,
    });
    await emitAs('plugin:grantRole', 'roles:assign', {
      userId: user._id, serverId: server._id, roleId: 'role-moderator',
    }, 'auto-role');
    const member = await mockDb.members.findOne({ userId: user._id, serverId: server._id });
    expect(readRoles(member!.roles)).not.toContain('role-moderator');
  });

  it('plugin may auto-assign a bounded ordinary member role', async () => {
    await mockDb.roles.insert({
      _id: 'role-member', serverId: server._id, name: 'Member', position: 1,
      permissions: PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES | PERMS.ADD_REACTIONS,
    });
    await emitAs('plugin:grantRole', 'roles:assign', {
      userId: user._id, serverId: server._id, roleId: 'role-member',
    }, 'auto-role');
    const member = await mockDb.members.findOne({ userId: user._id, serverId: server._id });
    expect(readRoles(member!.roles)).toContain('role-member');
  });

  it('plugin message action enforces production message length bound', async () => {
    await emitAs('plugin:sendMessage', 'messages:send', {
      channelId: channel._id, serverId: server._id, content: 'x'.repeat(2001),
    });
    expect(await mockDb.messages.findOne({ channelId: channel._id })).toBeNull();
  });

});
