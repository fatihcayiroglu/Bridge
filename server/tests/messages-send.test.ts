// server/tests/messages-send.test.ts
// Sprint 107: messages-send.ts birim testleri
// Kapsam: sendChannelMessage, registerSendHandlers (message:send, file:send, typing)

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser, makeServer, makeChannel, makeMessage } from './helpers/mockDb';

const mockDb = createMockDb();
const mockGetAckRecord = jest.fn();
const mockSetAckRecord = jest.fn();
const mockSendAck = jest.fn();
const mockSendTmpAck = jest.fn();
const mockCheckSpamAsync = jest.fn();
const mockValidateSocketPayload = jest.fn();
const mockGetCachedPerms = jest.fn();
const mockHasPermission = jest.fn();
const mockIsChannelE2EEEnabled = jest.fn();

jest.mock('../db/loader', () => mockDb);

jest.mock('../middleware/validate', () => ({
  validateSocketPayload: (...args: unknown[]) => mockValidateSocketPayload(...args),
  socketSchemas: {
    sendMessage: {},
    fileSend: {},
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
  isChannelE2EEEnabled: (...args: unknown[]) => mockIsChannelE2EEEnabled(...args),
}));

jest.mock('../lib/deliveryAck', () => ({
  getAckRecord: (...args: unknown[]) => mockGetAckRecord(...args),
  setAckRecord: (...args: unknown[]) => mockSetAckRecord(...args),
  sendAck: (...args: unknown[]) => mockSendAck(...args),
  sendTmpAck: (...args: unknown[]) => mockSendTmpAck(...args),
}));

jest.mock('../lib/redisAdapter', () => ({
  cache: { del: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../lib/notifications', () => ({
  processNotifications: jest.fn().mockResolvedValue(undefined),
}));

const mockExtractUrls = jest.fn(() => [] as string[]);
const mockFetchLinkPreview = jest.fn();
const mockDispatchEvent = jest.fn().mockResolvedValue(undefined);
const mockPluginEmit = jest.fn().mockResolvedValue(undefined);

jest.mock('../lib/linkPreview', () => ({
  extractUrls: (...args: unknown[]) => mockExtractUrls(...args),
  fetchLinkPreview: (...args: unknown[]) => mockFetchLinkPreview(...args),
}));

jest.mock('../lib/_optional-require', () => ({
  tryRequire: (moduleId: string) => {
    if (moduleId.includes('outgoingWebhooks')) {
      return { dispatchEvent: (...args: unknown[]) => mockDispatchEvent(...args) };
    }
    if (moduleId.includes('plugins/loader')) {
      return { hooks: { emit: (...args: unknown[]) => mockPluginEmit(...args) } };
    }
    return null;
  },
}));

import { sendChannelMessage, registerSendHandlers } from '../socket/handlers/messages-send';

// ── Yardımcılar ────────────────────────────────────────────────

function makeSocket(id = 'sock-1') {
  const handlers: Record<string, (data: unknown) => void> = {};
  const emitted: { ev: string; data: unknown }[] = [];

  const socket = {
    id,
    on(event: string, fn: (data: unknown) => void) { handlers[event] = fn; },
    emit(ev: string, data?: unknown) { emitted.push({ ev, data }); },
    to(room: string) {
      return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _room: room }); } };
    },
    _handlers: handlers,
    _emitted: emitted,
    _trigger(event: string, data: unknown) {
      if (handlers[event]) return handlers[event](data);
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
// sendChannelMessage
// ════════════════════════════════════════════════════════════════

describe('sendChannelMessage', () => {
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
    mockGetAckRecord.mockResolvedValue(null);
    mockIsChannelE2EEEnabled.mockResolvedValue(true);

    user    = makeUser();
    server  = makeServer(user._id);
    channel = makeChannel(server._id);

    await mockDb.users.insert(user);
    await mockDb.servers.insert(server);
    await mockDb.channels.insert(channel);
    await mockDb.members.insert({
      userId: user._id, serverId: server._id, joinedAt: Date.now(), roles: '[]',
    });

    socket = makeSocket();
    io     = makeIo();
  });

  it('geçerli mesaj → message:new broadcast + DB kaydı', async () => {
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'Merhaba dünya' },
      socket as never, io as never, user, new Map(),
    );

    const broadcast = io._emitted.find(e => e.ev === 'message:new');
    expect(broadcast).toBeDefined();
    expect(broadcast!._target).toBe(`channel:${channel._id}`);
    expect(broadcast!.data).toMatchObject({ content: 'Merhaba dünya', channelId: channel._id });

    const saved = await mockDb.messages.findOne({ channelId: channel._id });
    expect(saved).toBeTruthy();
  });

  it('boş içerik (normal tip) → mesaj oluşturulmaz', async () => {
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: '   ' },
      socket as never, io as never, user, new Map(),
    );
    expect(io._emitted).toHaveLength(0);
  });

  it('2000+ karakter → mesaj oluşturulmaz', async () => {
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'x'.repeat(2001) },
      socket as never, io as never, user, new Map(),
    );
    expect(io._emitted).toHaveLength(0);
  });

  it('validation başarısız → erken çıkış', async () => {
    mockValidateSocketPayload.mockReturnValue({ valid: false });
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'test' },
      socket as never, io as never, user, new Map(),
    );
    expect(io._emitted).toHaveLength(0);
  });

  it('üyelik yok → mesaj oluşturulmaz', async () => {
    await mockDb.members.remove({ userId: user._id });
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'test' },
      socket as never, io as never, user, new Map(),
    );
    expect(io._emitted).toHaveLength(0);
  });

  it('timeout cezası → error:timeout emit', async () => {
    await mockDb.members.update(
      { userId: user._id, serverId: server._id },
      { $set: { timeoutUntil: Date.now() + 60_000 } },
    );
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'test' },
      socket as never, io as never, user, new Map(),
    );
    const err = socket._emitted.find(e => e.ev === 'error:timeout');
    expect(err).toBeDefined();
    expect((err!.data as { remaining: number }).remaining).toBeGreaterThan(0);
  });

  it('SEND_MESSAGES izni yok → mesaj oluşturulmaz', async () => {
    mockHasPermission.mockReturnValue(false);
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'test' },
      socket as never, io as never, user, new Map(),
    );
    expect(io._emitted).toHaveLength(0);
  });

  it('spam engeli → error:spam emit', async () => {
    mockCheckSpamAsync.mockResolvedValue({ blocked: true, reason: 'flood', remainingMs: 15000 });
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'spam test' },
      socket as never, io as never, user, new Map(),
    );
    const err = socket._emitted.find(e => e.ev === 'error:spam');
    expect(err).toBeDefined();
    expect(io._emitted).toHaveLength(0);
  });

  it('E2EE — encryptedContent eksik → error:e2ee', async () => {
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, type: 'e2ee', iv: 'iv123' },
      socket as never, io as never, user, new Map(),
    );
    expect(socket._emitted.find(e => e.ev === 'error:e2ee')).toBeDefined();
  });

  it('E2EE — kanal E2EE kapalı → error:e2ee', async () => {
    mockIsChannelE2EEEnabled.mockResolvedValue(false);
    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id, type: 'e2ee',
        encryptedContent: 'enc', iv: 'iv',
      },
      socket as never, io as never, user, new Map(),
    );
    expect(socket._emitted.find(e => e.ev === 'error:e2ee')).toBeDefined();
  });

  it('ackId dedup — mevcut ACK varsa yeniden mesaj oluşturulmaz', async () => {
    const existing = { messageId: 'msg-existing', channelId: channel._id, userId: user._id, ts: Date.now() };
    mockGetAckRecord.mockResolvedValue(existing);

    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id, content: 'dup',
        ackId: 'ack-dup-1',
      },
      socket as never, io as never, user, new Map(),
    );

    expect(mockSendAck).toHaveBeenCalledWith(socket, 'ack-dup-1', existing);
    expect(io._emitted).toHaveLength(0);
  });

  it('ackId yeni — setAckRecord + sendAck çağrılır', async () => {
    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id, content: 'ack test',
        ackId: 'ack-new-1', _tmpId: 'tmp-1',
      },
      socket as never, io as never, user, new Map(),
    );

    expect(mockSetAckRecord).toHaveBeenCalledWith('ack-new-1', expect.objectContaining({
      channelId: channel._id, userId: user._id, tmpId: 'tmp-1',
    }));
    expect(mockSendAck).toHaveBeenCalled();
  });

  it('yalnızca _tmpId — sendTmpAck çağrılır', async () => {
    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id, content: 'tmp ack',
        _tmpId: 'tmp-only-1',
      },
      socket as never, io as never, user, new Map(),
    );

    expect(mockSendTmpAck).toHaveBeenCalledWith(
      socket, 'tmp-only-1', expect.any(String), channel._id,
    );
  });

  it('bridge forwarding — hedef kanala message:new', async () => {
    const targetServer = makeServer(user._id);
    const targetChannel = makeChannel(targetServer._id, { name: 'target' });
    await mockDb.servers.insert(targetServer);
    await mockDb.channels.insert(targetChannel);
    await mockDb.channelBridges.insert({
      _id: 'br-1', sourceChannelId: channel._id, targetChannelId: targetChannel._id,
      targetServerId: targetServer._id, active: true, label: 'TestBridge',
    });

    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'köprü mesajı' },
      socket as never, io as never, user, new Map(),
    );

    const bridgeEvt = io._emitted.find(
      e => e.ev === 'message:new' && e._target === `channel:${targetChannel._id}`,
    );
    expect(bridgeEvt).toBeDefined();
    expect((bridgeEvt!.data as { content: string }).content).toContain('TestBridge');
  });

  it('mention — socketUsers üzerinden mention:received', async () => {
    const mentioned = makeUser({ username: 'mentioned' });
    await mockDb.users.insert(mentioned);

    const socketUsers = new Map();
    const mentionedSocket = makeSocket('sock-mentioned');
    socketUsers.set('sock-mentioned', { _id: mentioned._id, displayName: mentioned.displayName });

    const mentionIo = makeIo();
    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id,
        content: `selam <@${mentioned._id}>`,
      },
      socket as never, mentionIo as never, user, socketUsers,
    );

    const mentionEvt = mentionIo._emitted.find(
      e => e.ev === 'mention:received' && e._target === 'sock-mentioned',
    );
    expect(mentionEvt).toBeDefined();
    expect((mentionEvt!.data as { messageId: string }).messageId).toBeDefined();
  });

  it('replyToId — replyTo meta eklenir', async () => {
    const parent = makeMessage(channel._id, server._id, user._id, { content: 'orijinal yanıt' });
    await mockDb.messages.insert(parent);

    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id, content: 'yanıt',
        replyToId: parent._id,
      },
      socket as never, io as never, user, new Map(),
    );

    const broadcast = io._emitted.find(e => e.ev === 'message:new');
    expect((broadcast!.data as { replyTo: { _id: string } }).replyTo._id).toBe(parent._id);
  });

  it('outgoing webhook — dispatchEvent message:new', async () => {
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'webhook test' },
      socket as never, io as never, user, new Map(),
    );

    expect(mockDispatchEvent).toHaveBeenCalledWith(
      server._id,
      'message:new',
      expect.objectContaining({
        channelId: channel._id,
        content: expect.stringContaining('webhook'),
      }),
    );
  });

  it('plugin hook — message:created emit', async () => {
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'plugin hook' },
      socket as never, io as never, user, new Map(),
    );

    expect(mockPluginEmit).toHaveBeenCalledWith(
      'message:created',
      expect.objectContaining({
        channelId: channel._id,
        serverId:  server._id,
        userId:    user._id,
      }),
    );
  });

  it('link önizleme — fetchLinkPreview + message:embedUpdate', async () => {
    mockExtractUrls.mockReturnValue(['https://example.com/page']);
    mockFetchLinkPreview.mockResolvedValue({
      url: 'https://example.com/page', title: 'Example', description: 'desc',
    });

    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'bak https://example.com/page' },
      socket as never, io as never, user, new Map(),
    );

    await new Promise<void>(resolve => { setImmediate(resolve); });

    expect(mockExtractUrls).toHaveBeenCalled();
    expect(mockFetchLinkPreview).toHaveBeenCalledWith('https://example.com/page');

    const embedEvt = io._emitted.find(e => e.ev === 'message:embedUpdate');
    expect(embedEvt).toBeDefined();
    expect((embedEvt!.data as { embeds: unknown[] }).embeds.length).toBeGreaterThan(0);
  });

  it('link önizleme — URL yoksa embedUpdate yok', async () => {
    mockExtractUrls.mockReturnValue([]);
    io._emitted.length = 0;

    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'düz metin' },
      socket as never, io as never, user, new Map(),
    );

    await new Promise<void>(resolve => { setImmediate(resolve); });

    expect(mockFetchLinkPreview).not.toHaveBeenCalled();
    expect(io._emitted.find(e => e.ev === 'message:embedUpdate')).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// registerSendHandlers
// ════════════════════════════════════════════════════════════════

describe('registerSendHandlers', () => {
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
      userId: user._id, serverId: server._id, joinedAt: Date.now(), roles: '[]',
    });

    socket = makeSocket();
    io     = makeIo();
    registerSendHandlers(socket as never, io as never, user, new Map());
  });

  it('message:send handler kayıtlı', () => {
    expect(socket._handlers['message:send']).toBeDefined();
  });

  it('file:send — geçerli upload URL → message:new', async () => {
    await socket._trigger('file:send', {
      channelId: channel._id,
      serverId: server._id,
      fileName: 'doc.pdf',
      fileUrl:  '/uploads/abc/doc.pdf',
      fileType: 'application/pdf',
    });

    const broadcast = io._emitted.find(e => e.ev === 'message:new');
    expect(broadcast).toBeDefined();
    expect((broadcast!.data as { type: string }).type).toBe('file');
  });

  it('file:send — geçersiz URL reddedilir', async () => {
    await socket._trigger('file:send', {
      channelId: channel._id,
      serverId: server._id,
      fileName: 'evil.exe',
      fileUrl:  'https://evil.com/malware',
      fileType: 'application/octet-stream',
    });
    expect(io._emitted).toHaveLength(0);
  });

  it('typing:start — typing:update broadcast (typing: true)', () => {
    socket._trigger('typing:start', { channelId: channel._id });
    const evt = socket._emitted.find(e => e.ev === 'typing:update' && e._room === `channel:${channel._id}`);
    expect(evt).toBeDefined();
    expect((evt!.data as { typing: boolean }).typing).toBe(true);
  });

  it('typing:stop — typing:update broadcast (typing: false)', () => {
    socket._trigger('typing:stop', { channelId: channel._id });
    const evt = socket._emitted.find(e => e.ev === 'typing:update');
    expect((evt!.data as { typing: boolean }).typing).toBe(false);
  });
});
