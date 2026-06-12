// server/tests/plugin-actions.test.ts
// Sprint 108: plugin:sendMessage | deleteMessage | grantRole sunucu handler testleri

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser, makeServer, makeChannel, makeMessage } from './helpers/mockDb';

const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);

import { hooks } from '../plugins/loader';
import { registerPluginActionHandlers } from '../plugins/actions';

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

  it('plugin:sendMessage → message:new broadcast', async () => {
    await hooks.emit('plugin:sendMessage', {
      channelId: channel._id,
      serverId:  server._id,
      content:   'Plugin mesajı',
      botName:   'Test Bot',
    });

    const evt = io._emitted.find(e => e.ev === 'message:new' && e._target === `channel:${channel._id}`);
    expect(evt).toBeDefined();
    expect((evt!.data as { content: string }).content).toBe('Plugin mesajı');

    const saved = await mockDb.messages.findOne({ channelId: channel._id });
    expect(saved).toBeTruthy();
  });

  it('plugin:deleteMessage → message:deleted broadcast', async () => {
    const msg = makeMessage(channel._id, server._id, user._id);
    await mockDb.messages.insert(msg);

    await hooks.emit('plugin:deleteMessage', {
      messageId: msg._id,
      channelId: channel._id,
      serverId:  server._id,
    });

    expect(io._emitted.find(e => e.ev === 'message:deleted')).toBeDefined();
    expect(await mockDb.messages.findOne({ _id: msg._id })).toBeNull();
  });

  it('plugin:deleteMessage — threadId ile thread cascade', async () => {
    const msg = makeMessage(channel._id, server._id, user._id, { threadId: 'th-plug' });
    await mockDb.messages.insert(msg);
    await mockDb.threads.insert({
      _id: 'th-plug', channelId: channel._id, serverId: server._id,
      messageId: msg._id, createdAt: Date.now(),
    });

    await hooks.emit('plugin:deleteMessage', {
      messageId: msg._id, channelId: channel._id, serverId: server._id,
    });

    expect(io._emitted.find(e => e.ev === 'message:deleted')).toBeDefined();
    expect(await mockDb.threads.findOne({ _id: 'th-plug' })).toBeNull();
  });

  it('plugin:grantRole → üyeye rol ekler', async () => {
    await hooks.emit('plugin:grantRole', {
      userId:   user._id,
      serverId: server._id,
      roleId:   'role-welcome',
    });

    const member = await mockDb.members.findOne({ userId: user._id, serverId: server._id });
    const roles  = JSON.parse((member!.roles as string) || '[]');
    expect(roles).toContain('role-welcome');
  });
});
