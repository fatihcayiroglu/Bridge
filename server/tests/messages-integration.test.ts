// server/tests/messages-integration.test.ts
// Sprint 107/108: send → edit → delete socket akışı (entegrasyon)

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';

const mockDb = createMockDb();
const mockValidateSocketPayload = jest.fn();
const mockGetCachedPerms = jest.fn();
const mockHasPermission = jest.fn();
const mockCheckSpamAsync = jest.fn();

jest.mock('../db/loader', () => mockDb);

jest.mock('../middleware/validate', () => ({
  validateSocketPayload: (...args: unknown[]) => mockValidateSocketPayload(...args),
  socketSchemas: {
    sendMessage: {}, fileSend: {}, pinMessage: {}, deleteMessage: {}, editMessage: {}, reactMessage: {},
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

jest.mock('../lib/security', () => ({
  checkSpamAsync: (...args: unknown[]) => mockCheckSpamAsync(...args),
  sanitizeMessage: (s: string) => s,
}));

jest.mock('../lib/channelE2EE', () => ({
  isChannelE2EEEnabled: jest.fn().mockResolvedValue(false),
}));

jest.mock('../lib/deliveryAck', () => ({
  getAckRecord: jest.fn().mockResolvedValue(null),
  setAckRecord: jest.fn().mockResolvedValue(undefined),
  sendAck: jest.fn(),
  sendTmpAck: jest.fn(),
}));

jest.mock('../lib/redisAdapter', () => ({
  cache: { del: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../lib/notifications', () => ({
  processNotifications: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/linkPreview', () => ({
  extractUrls: jest.fn(() => []),
  fetchLinkPreview: jest.fn(),
}));

jest.mock('../routes/outgoingWebhooks', () => ({
  dispatchEvent: jest.fn().mockResolvedValue(undefined),
}));

import { registerMessageHandlers } from '../socket/handlers/messages';

function makeSocket(id = 'sock-int-1') {
  const handlers: Record<string, (data: unknown) => void | Promise<void>> = {};
  const emitted: { ev: string; data: unknown; _room?: string }[] = [];

  return {
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
}

function makeIo() {
  const emitted: { ev: string; data: unknown; _target?: string }[] = [];
  return {
    _emitted: emitted,
    to(target: string) {
      return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _target: target }); } };
    },
  };
}

describe('messages socket integration', () => {
  let user: ReturnType<typeof makeUser>;
  let server: ReturnType<typeof makeServer>;
  let channel: ReturnType<typeof makeChannel>;
  let socket: ReturnType<typeof makeSocket>;
  let io: ReturnType<typeof makeIo>;

  beforeEach(async () => {
    mockDb._reset();
    jest.clearAllMocks();
    mockValidateSocketPayload.mockReturnValue({ valid: true });
    mockGetCachedPerms.mockResolvedValue(0xffffffff);
    mockHasPermission.mockReturnValue(true);
    mockCheckSpamAsync.mockResolvedValue({ blocked: false });

    user    = makeUser();
    server  = makeServer(user._id);
    channel = makeChannel(server._id);

    await mockDb.users.insert(user);
    await mockDb.servers.insert(server);
    await mockDb.channels.insert(channel);
    await mockDb.members.insert({
      userId: user._id, serverId: server._id, roles: '[]', joinedAt: Date.now(),
    });

    socket = makeSocket();
    io     = makeIo();
    registerMessageHandlers(socket as never, io as never, user, new Map());
  });

  it('message:send → message:edit → message:delete tam akış', async () => {
    await socket._trigger('message:send', {
      channelId: channel._id,
      serverId:  server._id,
      content:   'entegrasyon mesajı',
    });

    const created = io._emitted.find(e => e.ev === 'message:new');
    expect(created).toBeDefined();
    const messageId = (created!.data as { _id: string })._id;

    await socket._trigger('message:edit', {
      messageId,
      channelId: channel._id,
      content:   'düzenlenmiş içerik',
    });

    const edited = io._emitted.find(e => e.ev === 'message:edited');
    expect(edited).toBeDefined();
    expect((edited!.data as { content: string }).content).toBe('düzenlenmiş içerik');

    await socket._trigger('message:delete', { messageId, channelId: channel._id });

    const deleted = io._emitted.find(e => e.ev === 'message:deleted');
    expect(deleted).toBeDefined();
    expect(await mockDb.messages.findOne({ _id: messageId })).toBeNull();
  });

  it('message:send → message:react → pin toggle', async () => {
    await socket._trigger('message:send', {
      channelId: channel._id,
      serverId:  server._id,
      content:   'reaksiyon testi',
    });

    const messageId = (io._emitted.find(e => e.ev === 'message:new')!.data as { _id: string })._id;

    await socket._trigger('message:react', {
      messageId,
      channelId: channel._id,
      emoji:     '👍',
    });

    expect(io._emitted.some(e => e.ev === 'message:reaction')).toBe(true);

    await socket._trigger('message:pin', { messageId, channelId: channel._id, serverId: server._id });
    expect(io._emitted.some(e => e.ev === 'message:pinned')).toBe(true);
  });
});
