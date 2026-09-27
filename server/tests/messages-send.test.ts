// server/tests/messages-send.test.ts
// Sprint 107: messages-send.ts birim testleri
// Kapsam: sendChannelMessage, registerSendHandlers (message:send, file:send, typing)
import { EmittedLog, SocketDouble, findEmitted, requireEmitted, dataOf } from './helpers/socketDoubles';

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
const mockProcessNotifications = jest.fn().mockResolvedValue(undefined);
const mockIncrementUnread = jest.fn().mockResolvedValue(undefined);

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
  PERMS: { VIEW_CHANNELS: 0x01, SEND_MESSAGES: 0x10, MANAGE_MESSAGES: 0x20, ATTACH_FILES: 0x800 },
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

// KOR NOKTA DUZELTILDI: mock `invalidatePattern` TASIMIYORDU.
// `invalidateChannelMessages` her mesaj gonderiminde onu cagirir ve
// TypeError firlatiyordu. Uretim kodu bunu KASITLI olarak yutar (onbellek
// dusurulemezse mesaj yine kalicidir), bu yuzden testler YESIL kaliyordu —
// ama kanal onbellek gecersizlestirmesi HICBIR testte dogrulanmiyordu.
// Gercek adaptorde metot MEVCUT (lib/redisAdapter.ts:228); eksik olan mock'ti.
const mockInvalidatePattern = jest.fn().mockResolvedValue(undefined);
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockCacheIncrement = jest.fn();
const mockCacheClaimCooldown = jest.fn();
const mockRedisCache: Record<string, unknown> = {
  del:               jest.fn().mockResolvedValue(undefined),
  get:               (...args: unknown[]) => mockCacheGet(...args),
  set:               (...args: unknown[]) => mockCacheSet(...args),
  increment:         (...args: unknown[]) => mockCacheIncrement(...args),
  claimCooldown:     (...args: unknown[]) => mockCacheClaimCooldown(...args),
  invalidatePattern: (...args: unknown[]) => mockInvalidatePattern(...args),
};
jest.mock('../lib/redisAdapter', () => ({
  cache: mockRedisCache,
}));

jest.mock('../lib/notifications', () => ({
  processNotifications: (...args: unknown[]) => mockProcessNotifications(...args),
  incrementUnread: (...args: unknown[]) => mockIncrementUnread(...args),
}));

const mockExtractUrls = jest.fn((..._args: unknown[]) => [] as string[]);
const mockFetchLinkPreview = jest.fn();
const mockDispatchEvent = jest.fn().mockResolvedValue(undefined);
const mockPluginEmit = jest.fn().mockResolvedValue(undefined);
const mockMusicHandle = jest.fn().mockResolvedValue(false);

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
    if (moduleId === './music') {
      return { handleMusicCommand: (...args: unknown[]) => mockMusicHandle(...args) };
    }
    return null;
  },
}));

import { sendChannelMessage, registerSendHandlers } from '../socket/handlers/messages-send';
import { Bridges, Channels, Messages, Notifications } from '../db/repositories';
import { requireDoc } from './helpers/mockDb';

// ── Yardımcılar ────────────────────────────────────────────────

function makeSocket(id: string = 'sock-1') {
  const handlers: Record<string, unknown> = {};
  const emitted: EmittedLog = [];
  const rooms = new Set<string>();

  const socket = {
    id,
    rooms,
    on(event, fn) { handlers[event] = fn; },
    emit(ev, ...args) { emitted.push({ ev, data: args[0] }); },
    to(room) {
      return { emit(ev, ...args) { emitted.push({ ev, data: args[0], _room: room }); } };
    },
    join(room)  { rooms.add(room); },
    leave(room) { rooms.delete(room); },
    _handlers: handlers,
    _emitted: emitted,
    _trigger(event: string, data?: unknown) {
      const handler = handlers[event];
      if (typeof handler === 'function') return handler(data);
      return undefined;
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
    mockMusicHandle.mockResolvedValue(false);
    mockGetCachedPerms.mockResolvedValue(0xffffffff);
    mockHasPermission.mockReturnValue(true);
    mockCheckSpamAsync.mockResolvedValue({ blocked: false });
    mockGetAckRecord.mockResolvedValue(null);
    mockCacheGet.mockRejectedValue(new Error('redis unavailable'));
    mockCacheSet.mockRejectedValue(new Error('redis unavailable'));
    mockCacheIncrement.mockResolvedValue(1);
    mockCacheClaimCooldown.mockResolvedValue(0);
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

  // ══════════════════════════════════════════════════════════════════════════
  // KANAL ÖNBELLEK GEÇERSİZLEŞTİRME — daha önce HİÇ doğrulanmamıştı
  // ══════════════════════════════════════════════════════════════════════════
  // Bu suitteki mock `invalidatePattern` TAŞIMIYORDU, dolayısıyla
  // `invalidateChannelMessages` her gönderimde TypeError fırlatıyordu. Üretim
  // kodu bunu KASITLI olarak yutar (önbellek düşürülemezse mesaj yine
  // kalıcıdır), bu yüzden testler yeşil kalıyor ama davranış hiç
  // doğrulanmıyordu. Gerçek adaptörde metot MEVCUT — eksik olan mock'tu.
  it('mesaj gönderimi kanal önbelleğini DÜŞÜRÜR', async () => {
    mockInvalidatePattern.mockClear();
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'onbellek testi' },
      socket as never, io as never, user, new Map(),
    );
    expect(mockInvalidatePattern).toHaveBeenCalled();
    // Desen O KANALA ait olmali: cok genis bir desen tum kanallari dusururdu,
    // yanlis bir desen ise bayat mesaj listesi birakirdi.
    expect(String(mockInvalidatePattern.mock.calls[0][0])).toContain(channel._id);
  });

  it('geçerli mesaj → message:new broadcast + DB kaydı', async () => {
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'Merhaba dünya' },
      socket as never, io as never, user, new Map(),
    );

    const broadcast = requireEmitted(io._emitted, 'message:new');
    expect(broadcast).toBeDefined();
    expect(broadcast!._target).toBe(`channel:${channel._id}`);
    expect(broadcast!.data).toMatchObject({ content: 'Merhaba dünya', channelId: channel._id });
    expect(broadcast!.data).not.toHaveProperty('ackId');

    const saved = await mockDb.messages.findOne({ channelId: channel._id });
    expect(saved).toBeTruthy();
    expect(mockGetCachedPerms).toHaveBeenCalledWith(
      user._id, server._id, expect.any(Function), channel._id,
    );
  });

  // P1 multi-node harness PG-06r: the INSERT committed but its reply was lost.
  // The ack resolved to the durable row, yet no one broadcast the message.
  describe('ambiguous INSERT outcome (commit reached PostgreSQL, reply lost)', () => {
    const realInsert = mockDb.messages.insert.bind(mockDb.messages);
    afterEach(() => { mockDb.messages.insert = realInsert; });

    it('this request\'s row is durable → broadcast exactly once and ack that row', async () => {
      mockDb.messages.insert = (async (doc: Record<string, unknown>) => {
        await realInsert(doc);
        throw new Error('Connection terminated unexpectedly');
      }) as typeof mockDb.messages.insert;
      await sendChannelMessage(
        { channelId: channel._id, serverId: server._id, content: 'committed but reply lost', ackId: 'ack-ambiguous' },
        socket as never, io as never, user, new Map(),
      );
      const broadcasts = io._emitted.filter((e) => e.ev === 'message:new');
      expect(broadcasts).toHaveLength(1);
      const row = await mockDb.messages.findOne({ ackId: 'ack-ambiguous' });
      expect(dataOf(broadcasts[0]!)).toMatchObject({ _id: row!._id, content: 'committed but reply lost' });
      expect(mockSendAck).toHaveBeenCalledWith(socket, 'ack-ambiguous', expect.objectContaining({ messageId: String(row!._id) }));
    });

    it('negative control: a concurrent duplicate won (different row) → ack the canonical row, no second broadcast', async () => {
      await mockDb.messages.insert(makeMessage(channel._id, server._id, user._id, { ackId: 'ack-race', content: 'winner' }) as never);
      const winner = await mockDb.messages.findOne({ ackId: 'ack-race' });
      mockDb.messages.insert = (async () => { throw new Error('duplicate key value violates unique constraint'); }) as typeof mockDb.messages.insert;
      await sendChannelMessage(
        { channelId: channel._id, serverId: server._id, content: 'loser', ackId: 'ack-race' },
        socket as never, io as never, user, new Map(),
      ).catch(() => undefined);
      expect(io._emitted.filter((e) => e.ev === 'message:new')).toHaveLength(0);
      expect(mockSendAck).toHaveBeenCalledWith(socket, 'ack-race', expect.objectContaining({ messageId: String(winner!._id) }));
    });

    it('a genuine failure (nothing durable) still surfaces the original error', async () => {
      mockDb.messages.insert = (async () => { throw new Error('insert refused'); }) as typeof mockDb.messages.insert;
      await expect(sendChannelMessage(
        { channelId: channel._id, serverId: server._id, content: 'not stored', ackId: 'ack-failed' },
        socket as never, io as never, user, new Map(),
      )).rejects.toThrow('insert refused');
      expect(io._emitted.filter((e) => e.ev === 'message:new')).toHaveLength(0);
    });
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

  it('message:send file — kalıcı outbox güvenli upload başvurusunu kabul eder', async () => {
    // GUVENLIK SOZLESMESI: dosya basvurusu artik KAYITLI olmali ve cagirana
    // ait olmali. Onceden yalnizca yol SEKLI dogrulaniyordu; `/uploads/` ile
    // baslayan her yol kabul ediliyor, hic yuklenmemis (ya da BASKASININ)
    // dosyasina isaret eden mesaj olusturulabiliyordu.
    await mockDb.uploads.insert({
      _id: 'up-report', userId: user._id,
      key: 'uploads/retained/report.pdf',
      originalName: 'report.pdf', mimeType: 'application/pdf', createdAt: Date.now(),
    });

    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id, type: 'file', content: '',
        fileUrl: '/uploads/retained/report.pdf', fileName: 'report.pdf', fileType: 'application/pdf',
        ackId: 'ack-file-safe',
      },
      socket as never, io as never, user, new Map(),
    );

    expect(findEmitted(io._emitted, 'message:new')?.data).toMatchObject({
      type: 'file', fileUrl: '/uploads/retained/report.pdf', fileName: 'report.pdf',
    });
    expect(mockSendAck).toHaveBeenCalledWith(socket, 'ack-file-safe', expect.any(Object));
  });

  it('message:send file — harici/path traversal başvurusunu korele hatayla reddeder', async () => {
    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id, type: 'file', content: '',
        fileUrl: '/uploads/%2e%2e/secret.txt', fileName: 'secret.txt', fileType: 'text/plain',
        ackId: 'ack-file-unsafe', _tmpId: 'tmp-file-unsafe',
      },
      socket as never, io as never, user, new Map(),
    );

    expect(findEmitted(socket._emitted, 'error:message')?.data).toMatchObject({
      code: 'INVALID_FILE_REFERENCE', ackId: 'ack-file-unsafe', tmpId: 'tmp-file-unsafe',
    });
    expect(io._emitted).toHaveLength(0);
    expect(await mockDb.messages.count({ ackId: 'ack-file-unsafe' })).toBe(0);
  });

  it('message:send file rejects malformed percent-encoding without throwing the socket handler', async () => {
    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id, type: 'file', content: '',
        fileUrl: '/uploads/%', fileName: 'broken.txt', fileType: 'text/plain',
      },
      socket as never, io as never, user, new Map(),
    );
    expect(findEmitted(socket._emitted, 'error:message')?.data).toMatchObject({ code:'INVALID_FILE_REFERENCE' });
    expect(await mockDb.messages.count({ channelId:channel._id })).toBe(0);
  });

  it('validation başarısız → erken çıkış', async () => {
    mockValidateSocketPayload.mockReturnValue({ valid: false });
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'test' },
      socket as never, io as never, user, new Map(),
    );
    expect(io._emitted).toHaveLength(0);
  });

  it('invalid correlation tokens are never reflected into rejection payloads', async () => {
    await sendChannelMessage(
      {
        channelId:channel._id,serverId:server._id,content:'   ',
        ackId:'a'.repeat(65),_tmpId:{attacker:'controlled'} as never,
      },
      socket as never,io as never,user,new Map(),
    );
    const rejection=requireEmitted(socket._emitted, 'error:message')?.data as Record<string,unknown>;
    expect(rejection).toMatchObject({code:'EMPTY_MESSAGE'});
    expect(rejection).not.toHaveProperty('ackId'); expect(rejection).not.toHaveProperty('tmpId');
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
      { channelId: channel._id, serverId: server._id, content: 'test', ackId: 'ack-timeout-1' },
      socket as never, io as never, user, new Map(),
    );
    const err = requireEmitted(socket._emitted, 'error:timeout');
    expect(err!.data).toMatchObject({ ackId: 'ack-timeout-1' });
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

  it('SEND_MESSAGES denial is evaluated after visibility and never trusts a contradictory allowed explanation', async () => {
    // The cached mask is the enforcement decision. A later diagnostic
    // resolution may say the owner is allowed; that contradiction must not
    // turn a denial into authorization or leak an old ACK.
    mockHasPermission.mockImplementation((_perms: unknown, flag: unknown) => flag === 0x01);
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'must be denied', ackId:'ack-denied', _tmpId:'tmp-denied' },
      socket as never, io as never, user, new Map(),
    );
    expect(findEmitted(socket._emitted, 'error:message')?.data).toMatchObject({
      code:'MISSING_PERMISSION', ackId:'ack-denied', tmpId:'tmp-denied',
    });
    expect(mockGetAckRecord).not.toHaveBeenCalled();
    expect(await mockDb.messages.count({ channelId:channel._id })).toBe(0);
  });

  it('SEND_MESSAGES denial returns the canonical denied reason for a non-owner member', async () => {
    await mockDb.servers.update({_id:server._id},{$set:{ownerId:'different-owner'}});
    mockHasPermission.mockImplementation((_perms: unknown, flag: unknown) => flag === 0x01);
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'denied member' },
      socket as never, io as never, user, new Map(),
    );
    expect(findEmitted(socket._emitted, 'error:message')?.data).toMatchObject({ code:'MISSING_PERMISSION' });
    expect(await mockDb.messages.count({ channelId:channel._id })).toBe(0);
  });

  it('VIEW_CHANNELS izni yok → bilinen kanal id ile mesaj yazılamaz', async () => {
    mockHasPermission.mockImplementation((_perms: unknown, flag: unknown) => flag !== 0x01);
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'gizli kanala yazma denemesi' },
      socket as never, io as never, user, new Map(),
    );
    expect(findEmitted(io._emitted, 'message:new')).toBeUndefined();
    expect(findEmitted(socket._emitted, 'error:message')).toMatchObject({
      data: { code: 'MISSING_PERMISSION' },
    });
  });

  it('type=file için ATTACH_FILES yoksa sahip olunan upload bile gönderilemez', async () => {
    await mockDb.uploads.insert({
      _id: 'up-no-attach', userId: user._id, key: 'uploads/no-attach.pdf',
      originalName: 'no-attach.pdf', mimeType: 'application/pdf', createdAt: Date.now(),
    });
    mockHasPermission.mockImplementation((_perms: unknown, flag: unknown) => flag !== 0x800);
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, type: 'file', content: '',
        fileName: 'no-attach.pdf', fileUrl: '/uploads/no-attach.pdf', fileType: 'application/pdf' },
      socket as never, io as never, user, new Map(),
    );
    expect(findEmitted(io._emitted, 'message:new')).toBeUndefined();
    expect(findEmitted(socket._emitted, 'error:message')).toMatchObject({
      data: { code: 'MISSING_PERMISSION' },
    });
  });

  describe('persisted realtime AutoMod enforcement', () => {
    it('delete action blocks before persistence and returns a correlated AutoMod error', async () => {
      await mockDb.automodRules.insert({
        _id: 'am-block', serverId: server._id, type: 'blocked_words', enabled: true,
        config: { words: ['forbidden'], action: 'delete' }, createdBy: user._id, createdAt: Date.now(),
      });
      await sendChannelMessage(
        { channelId: channel._id, serverId: server._id, content: 'this is FORBIDDEN', ackId: 'am-ack', _tmpId: 'am-tmp' },
        socket as never, io as never, user, new Map(),
      );
      expect(await mockDb.messages.count({ channelId: channel._id, userId: user._id })).toBe(0);
      expect(findEmitted(socket._emitted, 'error:message')).toMatchObject({
        data: { code: 'AUTOMOD_BLOCKED', ackId: 'am-ack', tmpId: 'am-tmp' },
      });
    });

    it('timeout-only action durably times out the member but allows the triggering message', async () => {
      await mockDb.automodRules.insert({
        _id: 'am-timeout', serverId: server._id, type: 'blocked_words', enabled: true,
        config: { words: ['timeoutme'], action: 'timeout', timeoutMs: 120000 }, createdBy: user._id, createdAt: Date.now(),
      });
      const before = Date.now();
      await sendChannelMessage(
        { channelId: channel._id, serverId: server._id, content: 'timeoutme please' },
        socket as never, io as never, user, new Map(),
      );
      const member = await requireDoc(mockDb.members, { userId: user._id, serverId: server._id });
      expect(member.timeoutUntil).toBeGreaterThanOrEqual(before + 120000);
      expect(await mockDb.messages.count({ channelId: channel._id, userId: user._id })).toBe(1);
    });

    it('exempt role bypasses only the configured rule', async () => {
      await mockDb.members.update({ userId: user._id, serverId: server._id }, { $set: { roles: JSON.stringify(['trusted-role']) } });
      await mockDb.automodRules.insert({
        _id: 'am-exempt', serverId: server._id, type: 'blocked_words', enabled: true,
        config: { words: ['forbidden'], exemptRoles: ['trusted-role'] }, createdBy: user._id, createdAt: Date.now(),
      });
      await sendChannelMessage(
        { channelId: channel._id, serverId: server._id, content: 'forbidden but exempt' },
        socket as never, io as never, user, new Map(),
      );
      expect(await mockDb.messages.count({ channelId: channel._id, userId: user._id })).toBe(1);
    });

    it('spam rule uses the Redis/cache atomic increment contract', async () => {
      mockCacheIncrement.mockResolvedValue(3);
      await mockDb.automodRules.insert({
        _id: 'am-spam', serverId: server._id, type: 'spam_messages', enabled: true,
        config: { maxMessages: 2, windowSecs: 7 }, createdBy: user._id, createdAt: Date.now(),
      });
      await sendChannelMessage(
        { channelId: channel._id, serverId: server._id, content: 'third message' },
        socket as never, io as never, user, new Map(),
      );
      expect(mockCacheIncrement).toHaveBeenCalledWith(`automod:spam:${server._id}:am-spam:${user._id}`, 7);
      expect(await mockDb.messages.count({ channelId: channel._id, userId: user._id })).toBe(0);
    });

    it('writes a system audit message only to a still-valid same-server log channel', async () => {
      const logChannel = makeChannel(server._id, { _id: 'automod-log', name: 'automod-log', type: 'text' });
      await mockDb.channels.insert(logChannel);
      await mockDb.automodRules.insert({
        _id: 'am-log', serverId: server._id, type: 'blocked_words', enabled: true,
        config: { words: ['logged'], logChannelId: logChannel._id }, createdBy: user._id, createdAt: Date.now(),
      });
      await sendChannelMessage(
        { channelId: channel._id, serverId: server._id, content: 'logged content' },
        socket as never, io as never, user, new Map(),
      );
      const logMessage = await mockDb.messages.findOne({ channelId: logChannel._id, userId: 'system' });
      expect(logMessage).toMatchObject({ username: 'AutoMod', autoModAlert: true });
      expect(io._emitted.find(e => e._target === `channel:${logChannel._id}` && e.ev === 'message:new')).toBeDefined();
    });
  });

  it('spam engeli → error:spam emit', async () => {
    mockCheckSpamAsync.mockResolvedValue({ blocked: true, reason: 'flood', remainingMs: 15000 });
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'spam test' },
      socket as never, io as never, user, new Map(),
    );
    const err = requireEmitted(socket._emitted, 'error:spam');
    expect(err).toBeDefined();
    expect(io._emitted).toHaveLength(0);
  });

  // Final21 UX (U-11): ret, bekleyen gönderimle eşleşmeli; yoksa istemci 10 sn ACK bekler ve
  // gerçek neden ("çok hızlı") yerine "sunucu onayı zaman aşımı" gösterir.
  it('spam engeli ackId ve tmpId değerini yankılar', async () => {
    mockCheckSpamAsync.mockResolvedValue({ blocked: true, reason: 'spam_rate', remainingMs: 30000 });
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'hızlı', ackId: 'ack-spam-1', _tmpId: 'tmp-spam-1' },
      socket as never, io as never, user, new Map(),
    );
    const err = requireEmitted(socket._emitted, 'error:spam');
    expect(err!.data).toMatchObject({ reason: 'spam_rate', remainingMs: 30000, ackId: 'ack-spam-1', tmpId: 'tmp-spam-1' });
    expect(findEmitted(io._emitted, 'message:new')).toBeUndefined();
  });

  it('spam uyarısı teslim edilen mesajın ackId değerini taşır', async () => {
    mockCheckSpamAsync.mockResolvedValue({ blocked: false, warning: true });
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'uyarı', ackId: 'ack-warn-1' },
      socket as never, io as never, user, new Map(),
    );
    expect(requireEmitted(socket._emitted, 'warn:spam')!.data).toMatchObject({ ackId: 'ack-warn-1' });
  });

  it('geçersiz ackId yankılanmaz (sınır korunur)', async () => {
    mockCheckSpamAsync.mockResolvedValue({ blocked: true, reason: 'spam_rate', remainingMs: 30000 });
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'hızlı', ackId: 'x'.repeat(65) },
      socket as never, io as never, user, new Map(),
    );
    expect(requireEmitted(socket._emitted, 'error:spam')!.data).not.toHaveProperty('ackId');
  });

  it('E2EE — encryptedContent eksik → error:e2ee', async () => {
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, type: 'e2ee', iv: 'iv123' },
      socket as never, io as never, user, new Map(),
    );
    expect(findEmitted(socket._emitted, 'error:e2ee')).toBeDefined();
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
    expect(findEmitted(socket._emitted, 'error:e2ee')).toBeDefined();
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
    expect(mockGetAckRecord).toHaveBeenCalledWith('ack-dup-1', user._id);
    expect(io._emitted).toHaveLength(0);
  });

  it('backend restart — cache boşken kalıcı ackId aynı kanonik mesajı döndürür', async () => {
    const durable = makeMessage(channel._id, server._id, user._id, {
      _id: 'msg-durable', ackId: 'ack-after-restart', content: 'already committed',
    });
    await mockDb.messages.insert(durable);

    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id, content: 'replayed payload',
        ackId: 'ack-after-restart', _tmpId: 'tmp-after-restart',
      },
      socket as never, io as never, user, new Map(),
    );

    expect(await mockDb.messages.count({ ackId: 'ack-after-restart', userId: user._id })).toBe(1);
    expect(io._emitted.filter(event => event.ev === 'message:new')).toHaveLength(0);
    expect(mockSetAckRecord).toHaveBeenCalledWith('ack-after-restart', expect.objectContaining({
      messageId: 'msg-durable', channelId: channel._id, userId: user._id,
    }));
    expect(mockSendAck).toHaveBeenCalledWith(socket, 'ack-after-restart', expect.objectContaining({
      messageId: 'msg-durable',
    }));
  });

  it('ACK-lost durable replay policy side-effectlerini ikinci kez çalıştırmaz', async () => {
    await mockDb.messages.insert(makeMessage(channel._id, server._id, user._id, {
      _id: 'msg-idempotent-policy', ackId: 'ack-idempotent-policy', content: 'already committed',
    }));
    await mockDb.channels.update({ _id: channel._id }, { $set: { slowmode: 60 } });
    await mockDb.automodRules.insert({
      _id: 'am-retry-timeout', serverId: server._id, type: 'spam_messages', enabled: true,
      config: { maxMessages: 2, windowSecs: 7, action: 'timeout', timeoutMs: 120000 },
      createdBy: user._id, createdAt: Date.now(),
    });
    mockCacheIncrement.mockResolvedValue(999);

    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id, content: 'retry payload',
        ackId: 'ack-idempotent-policy', _tmpId: 'tmp-idempotent-policy',
      },
      socket as never, io as never, user, new Map(),
    );

    const member = await requireDoc(mockDb.members, { userId: user._id, serverId: server._id });
    expect(member.timeoutUntil).toBeUndefined();
    expect(mockCacheIncrement).not.toHaveBeenCalled();
    expect(mockCheckSpamAsync).not.toHaveBeenCalled();
    expect(mockMusicHandle).not.toHaveBeenCalled();
    expect(await mockDb.messages.count({ ackId: 'ack-idempotent-policy', userId: user._id })).toBe(1);
    expect(mockSendAck).toHaveBeenCalledWith(socket, 'ack-idempotent-policy', expect.objectContaining({
      messageId: 'msg-idempotent-policy', tmpId: 'tmp-idempotent-policy',
    }));
  });

  it('aynı ackId farklı kullanıcılarda çakışmaz', async () => {
    const otherUser = makeUser({ _id: 'other-outbox-user' });
    await mockDb.messages.insert(makeMessage(channel._id, server._id, otherUser._id, {
      ackId: 'shared-ack', content: 'other user message',
    }));

    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'my message', ackId: 'shared-ack' },
      socket as never, io as never, user, new Map(),
    );

    expect(await mockDb.messages.count({ ackId: 'shared-ack' })).toBe(2);
    expect(io._emitted.filter(event => event.ev === 'message:new')).toHaveLength(1);
  });

  it('izin yeniden bağlanmadan önce kaldırılırsa cache/durable ACK kontrolünden önce reddeder', async () => {
    const cached = { messageId: 'should-not-leak', channelId: channel._id, userId: user._id, ts: Date.now() };
    mockGetAckRecord.mockResolvedValue(cached);
    mockHasPermission.mockReturnValue(false);

    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id, content: 'offline replay',
        ackId: 'ack-revoked', _tmpId: 'tmp-revoked',
      },
      socket as never, io as never, user, new Map(),
    );

    expect(findEmitted(socket._emitted, 'error:message')?.data).toMatchObject({
      code: 'MISSING_PERMISSION', ackId: 'ack-revoked', tmpId: 'tmp-revoked',
    });
    expect(mockGetAckRecord).not.toHaveBeenCalled();
    expect(mockSendAck).not.toHaveBeenCalled();
    expect(await mockDb.messages.count({ ackId: 'ack-revoked' })).toBe(0);
  });

  it('eşzamanlı unique-index yarışı kaybedeni winner mesajına ACK eder', async () => {
    const originalInsert = mockDb.messages.insert.bind(mockDb.messages);
    mockDb.messages.insert = async (doc) => {
      await originalInsert({ ...doc, _id: 'msg-race-winner' });
      throw new Error('duplicate key value violates unique constraint');
    };

    try {
      await sendChannelMessage(
        {
          channelId: channel._id, serverId: server._id, content: 'concurrent',
          ackId: 'ack-race', _tmpId: 'tmp-race',
        },
        socket as never, io as never, user, new Map(),
      );
    } finally {
      mockDb.messages.insert = originalInsert;
    }

    expect(await mockDb.messages.count({ ackId: 'ack-race', userId: user._id })).toBe(1);
    expect(io._emitted.filter(event => event.ev === 'message:new')).toHaveLength(0);
    expect(mockSendAck).toHaveBeenCalledWith(socket, 'ack-race', expect.objectContaining({
      messageId: 'msg-race-winner', userId: user._id,
    }));
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
    // ── EKSİK ALAN: `sourceServerId` ──────────────────────────────────────
    // Köprü satırı ARTIK tek başına yetki değildir: iletim öncesi kaynak
    // kiracı kimliği de doğrulanır (messages-send.ts:509). Alan olmadan
    // `String(undefined) !== serverId` olur ve iletim `bridge.integrity.
    // source_mismatch` ile ATLANIR. Fixture kanonik satırı üretir.
    await mockDb.channelBridges.insert({
      _id: 'br-1', sourceChannelId: channel._id, sourceServerId: server._id,
      targetChannelId: targetChannel._id, targetServerId: targetServer._id,
      active: true, label: 'TestBridge',
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

  it('bridge uses a safe default label and never forwards file references across tenants', async () => {
    const targetServer=makeServer('bridge-target-owner'); const targetChannel=makeChannel(targetServer._id,{name:'target'});
    await mockDb.servers.insert(targetServer); await mockDb.channels.insert(targetChannel);
    await mockDb.channelBridges.insert({
      _id:'br-default',sourceChannelId:channel._id,sourceServerId:server._id,
      targetChannelId:targetChannel._id,targetServerId:targetServer._id,active:true,label:null,
    });

    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:'default label'},
      socket as never,io as never,user,new Map(),
    );
    expect(io._emitted.find(e=>e._target===`channel:${targetChannel._id}`&&e.ev==='message:new')?.data)
      .toMatchObject({content:expect.stringContaining('**[Bridge]**')});

    io._emitted.length=0;
    await mockDb.uploads.insert({_id:'bridge-file',userId:user._id,key:'uploads/bridge-file.pdf',originalName:'bridge-file.pdf',mimeType:'application/pdf',createdAt:Date.now()});
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,type:'file',content:'',fileUrl:'/uploads/bridge-file.pdf',fileName:'bridge-file.pdf',fileType:'application/pdf'},
      socket as never,io as never,user,new Map(),
    );
    expect(io._emitted.find(e=>e._target===`channel:${channel._id}`&&e.ev==='message:new')).toBeDefined();
    expect(io._emitted.find(e=>e._target===`channel:${targetChannel._id}`&&e.ev==='message:new')).toBeUndefined();
    expect(await mockDb.messages.count({channelId:targetChannel._id})).toBe(1);
  });

  it('GÜVENLİK: kaynak kiracısı UYUŞMAYAN köprü satırı iletmez', async () => {
    // Bozuk/legacy bir köprü satırı, rastgele kimlikleri eşleyerek kiracı
    // sınırını AŞAMAMALIDIR. Bu koruma yalnızca dolaylı ölçülüyordu; açıkça
    // ölçülmezse kaldırıldığında hiçbir test kırmızıya dönmezdi.
    const foreignServer = makeServer(user._id);
    const targetServer2 = makeServer(user._id);
    const targetChannel2 = makeChannel(targetServer2._id, { name: 'target2' });
    await mockDb.servers.insert(foreignServer);
    await mockDb.servers.insert(targetServer2);
    await mockDb.channels.insert(targetChannel2);
    await mockDb.channelBridges.insert({
      _id: 'br-evil', sourceChannelId: channel._id,
      sourceServerId: foreignServer._id,           // ← BAŞKA sunucu iddia ediyor
      targetChannelId: targetChannel2._id, targetServerId: targetServer2._id,
      active: true, label: 'Evil',
    });

    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'sizmasin' },
      socket as never, io as never, user, new Map(),
    );

    expect(io._emitted.find(
      e => e.ev === 'message:new' && e._target === `channel:${targetChannel2._id}`,
    )).toBeUndefined();
  });

  it('mention — cluster-wide user room üzerinden mention:received; local socketUsers gerekmez', async () => {
    const mentioned = makeUser({ username: 'mentioned' });
    await mockDb.users.insert(mentioned);
    // ── EKSİK FIXTURE: ÜYELİK ──────────────────────────────────────────────
    // Mention bildirimi artık `canViewChannel(uid, serverId, channelId)`
    // koşuluna bağlı (messages-send.ts:560): kanalı GÖREMEYEN birine mention
    // gönderilemez. Bu bir gizlilik/spam koruması; üye olmayan alıcı için
    // olay HİÇ üretilmez. Test meşru bir alıcı kurar.
    await mockDb.members.insert({ userId: mentioned._id, serverId: server._id, roles: [], joinedAt: Date.now() });

    const socketUsers = new Map();

    const mentionIo = makeIo();
    await sendChannelMessage(
      {
        channelId: channel._id, serverId: server._id,
        content: `selam <@${mentioned._id}>`,
      },
      socket as never, mentionIo as never, user, socketUsers,
    );

    const mentionEvt = mentionIo._emitted.find(
      e => e.ev === 'mention:received' && e._target === `user:${mentioned._id}`,
    );
    expect(mentionEvt).toBeDefined();
    expect((mentionEvt!.data as { messageId: string }).messageId).toBeDefined();
  });

  it('legacy username mentions resolve to the canonical user and remain channel-visibility scoped', async () => {
    const mentioned = makeUser({ username: 'legacy_mention' });
    await mockDb.users.insert(mentioned);
    await mockDb.members.insert({ userId: mentioned._id, serverId: server._id, roles: [], joinedAt: Date.now() });
    const mentionIo = makeIo();
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'selam @legacy_mention' },
      socket as never, mentionIo as never, user, new Map(),
    );
    expect(mentionIo._emitted.find(
      e => e.ev === 'mention:received' && e._target === `user:${mentioned._id}`,
    )).toBeDefined();
  });

  it('GİZLİLİK: kanalı GÖREMEYEN kullanıcıya mention GÖNDERİLMEZ', async () => {
    // Aksi hâlde mention, üyesi olmadığınız bir sunucudaki özel bir kanaldan
    // size bildirim gönderebilen bir spam/keşif kanalı olurdu.
    const outsider = makeUser({ username: 'outsider' });
    await mockDb.users.insert(outsider);          // ÜYELİK YOK — kasıtlı

    const socketUsers = new Map();
    socketUsers.set('sock-outsider', { _id: outsider._id, displayName: outsider.displayName });

    const outIo = makeIo();
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: `selam <@${outsider._id}>` },
      socket as never, outIo as never, user, socketUsers,
    );

    expect(outIo._emitted.find(
      e => e.ev === 'mention:received' && e._target === `user:${outsider._id}`,
    )).toBeUndefined();
  });

  it('self, duplicate and muted mentions do not create duplicate or unwanted realtime attention', async () => {
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:`self <@${user._id}>`},
      socket as never,io as never,user,new Map(),
    );
    expect(findEmitted(io._emitted, 'mention:received', { target: `user:${user._id}` })).toBeUndefined();

    const recipient=makeUser({username:'mention_once'}); await mockDb.users.insert(recipient);
    await mockDb.members.insert({userId:recipient._id,serverId:server._id,roles:[],joinedAt:Date.now()});
    io._emitted.length=0;
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:`<@${recipient._id}> <@${recipient._id}> @mention_once`},
      socket as never,io as never,user,new Map(),
    );
    expect(io._emitted.filter(e=>e.ev==='mention:received'&&e._target===`user:${recipient._id}`)).toHaveLength(1);

    io._emitted.length=0;
    jest.spyOn(Notifications,'findPref').mockResolvedValueOnce({level:'mute',muteUntil:null} as never);
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:`muted <@${recipient._id}>`},
      socket as never,io as never,user,new Map(),
    );
    expect(findEmitted(io._emitted, 'mention:received', { target: `user:${recipient._id}` })).toBeUndefined();
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

    const broadcast = requireEmitted(io._emitted, 'message:new');
    expect((broadcast!.data as { replyTo: { _id: string } }).replyTo._id).toBe(parent._id);
  });

  it('reply metadata never crosses a channel/server boundary', async () => {
    const foreignServer=makeServer('foreign-owner'); const foreignChannel=makeChannel(foreignServer._id);
    await mockDb.servers.insert(foreignServer); await mockDb.channels.insert(foreignChannel);
    const foreignParent=makeMessage(foreignChannel._id,foreignServer._id,'foreign-user',{content:'private parent'});
    await mockDb.messages.insert(foreignParent);
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:'probe',replyToId:foreignParent._id},
      socket as never,io as never,user,new Map(),
    );
    const broadcast=requireEmitted(io._emitted, 'message:new', { target: `channel:${channel._id}` });
    expect(broadcast?.data).not.toHaveProperty('replyTo');
    expect(mockIncrementUnread).not.toHaveBeenCalled();
  });

  it('reply to self carries context but does not create self-attention', async () => {
    const parent=makeMessage(channel._id,server._id,user._id,{content:'my parent'}); await mockDb.messages.insert(parent);
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:'self reply',replyToId:parent._id},
      socket as never,io as never,user,new Map(),
    );
    expect(findEmitted(io._emitted, 'message:new')?.data).toHaveProperty('replyTo');
    expect(findEmitted(io._emitted, 'notification:reply')).toBeUndefined();
    expect(mockIncrementUnread).not.toHaveBeenCalled();
  });

  it('muted or already-recorded reply attention is suppressed without affecting persistence', async () => {
    const recipient=makeUser({username:'muted-reply'}); await mockDb.users.insert(recipient);
    await mockDb.members.insert({userId:recipient._id,serverId:server._id,roles:[],joinedAt:Date.now()});
    const parent=makeMessage(channel._id,server._id,recipient._id,{content:'target'}); await mockDb.messages.insert(parent);

    jest.spyOn(Notifications,'findPref').mockResolvedValueOnce({level:'mute',muteUntil:null} as never);
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:'muted reply',replyToId:parent._id},
      socket as never,io as never,user,new Map(),
    );
    expect(findEmitted(io._emitted, 'notification:reply')).toBeUndefined();
    expect(mockIncrementUnread).not.toHaveBeenCalled();

    io._emitted.length=0; mockIncrementUnread.mockClear();
    jest.spyOn(Notifications,'insertChannelAttention').mockResolvedValueOnce(false);
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:'deduped reply',replyToId:parent._id},
      socket as never,io as never,user,new Map(),
    );
    expect(findEmitted(io._emitted, 'notification:reply')).toBeUndefined();
    expect(mockIncrementUnread).not.toHaveBeenCalled();
    expect(await mockDb.messages.count({channelId:channel._id})).toBeGreaterThanOrEqual(3);
  });

  it('reply — alıcı için tek kalıcı inbox kimliği yazar ve mention yolundan dışlar', async () => {
    const recipient = makeUser({ username: 'reply-recipient' });
    await mockDb.users.insert(recipient);
    // Yanıt bildirimi de kanal görünürlüğüne bağlıdır (yukarıdaki nota bak).
    await mockDb.members.insert({ userId: recipient._id, serverId: server._id, roles: [], joinedAt: Date.now() });
    const parent = makeMessage(channel._id, server._id, recipient._id, { content: 'target message' });
    await mockDb.messages.insert(parent);

    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'reply body', replyToId: parent._id },
      socket as never, io as never, user, new Map(),
    );

    const broadcast = requireEmitted(io._emitted, 'message:new', { target: `channel:${channel._id}` });
    const messageId = String((broadcast!.data as { _id: string })._id);
    const attention = await mockDb.notifications.findOne({ userId: recipient._id, messageId });
    expect(attention).toEqual(expect.objectContaining({
      type: 'reply', serverId: server._id, channelId: channel._id,
      actorId: user._id, read: false,
    }));
    expect(JSON.stringify(attention)).not.toContain('reply body');
    expect(mockIncrementUnread).toHaveBeenCalledWith(recipient._id, channel._id);
    expect(io._emitted).toContainEqual(expect.objectContaining({ ev: 'inbox:changed', _target: `user:${recipient._id}` }));
    expect(mockProcessNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ _id: messageId }), io, expect.any(Map),
      expect.any(Set),
    );
    const excluded = mockProcessNotifications.mock.calls.at(-1)?.[3] as Set<string>;
    expect(excluded.has(recipient._id)).toBe(true);
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

    const embedEvt = requireEmitted(io._emitted, 'message:embedUpdate');
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
    expect(findEmitted(io._emitted, 'message:embedUpdate')).toBeUndefined();
  });

  it('link preview with no successful candidates emits no empty embed update', async () => {
    mockExtractUrls.mockReturnValue(['https://blocked.example']);
    mockFetchLinkPreview.mockRejectedValueOnce(new Error('blocked'));
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:'https://blocked.example'},
      socket as never,io as never,user,new Map(),
    );
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(findEmitted(io._emitted, 'message:embedUpdate')).toBeUndefined();
  });

  it('link preview persistence failure remains isolated from the durable message', async () => {
    mockExtractUrls.mockReturnValue(['https://preview.example']);
    mockFetchLinkPreview.mockResolvedValueOnce({title:'Preview',url:'https://preview.example'});
    jest.spyOn(Messages,'update').mockRejectedValueOnce(new Error('embed store down'));
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:'https://preview.example'},
      socket as never,io as never,user,new Map(),
    );
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(await mockDb.messages.count({channelId:channel._id})).toBe(1);
    expect(findEmitted(io._emitted, 'message:embedUpdate')).toBeUndefined();
  });

  it('slowmode atomik cooldown yolu kalan süreyi reddeder', async () => {
    await mockDb.channels.update({ _id: channel._id }, { $set: { slowmode: 10 } });
    mockHasPermission.mockImplementation((_p: unknown, flag: unknown) => flag === 0x01 || flag === 0x10);
    mockCacheClaimCooldown.mockResolvedValue(8_000);

    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'redis slowmode', ackId: 'ack-slow-1' },
      socket as never, io as never, user, new Map(),
    );

    expect(findEmitted(socket._emitted, 'error:slowmode')!.data).toMatchObject({ ackId: 'ack-slow-1' });
    expect(mockCacheClaimCooldown).toHaveBeenCalledWith(
      `slowmode:${user._id}:${channel._id}`, 10_000, 15_000, expect.any(Number),
    );
    expect(findEmitted(io._emitted, 'message:new')).toBeUndefined();
  });

  it('slowmode atomik cooldown claim kazanıldığında gönderime izin verir', async () => {
    await mockDb.channels.update({ _id: channel._id }, { $set: { slowmode: 7 } });
    mockHasPermission.mockImplementation((_p: unknown, flag: unknown) => flag === 0x01 || flag === 0x10);
    mockCacheClaimCooldown.mockResolvedValue(0);

    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'redis allowed' },
      socket as never, io as never, user, new Map(),
    );

    expect(mockCacheClaimCooldown).toHaveBeenCalledWith(
      `slowmode:${user._id}:${channel._id}`, 7_000, 12_000, expect.any(Number),
    );
    expect(findEmitted(io._emitted, 'message:new')).toBeDefined();
  });

  it('legacy adapter compatibility fallback preserves a fixed local slowmode window', async () => {
    await mockDb.channels.update({_id:channel._id},{$set:{slowmode:10}});
    mockHasPermission.mockImplementation((_p:unknown,flag:unknown)=>flag===0x01||flag===0x10);
    const canonicalClaim=mockRedisCache.claimCooldown;
    delete mockRedisCache.claimCooldown;
    const now=Date.now(); const clock=jest.spyOn(Date,'now').mockReturnValue(now);
    try {
      await sendChannelMessage(
        {channelId:channel._id,serverId:server._id,content:'fallback first'},
        socket as never,io as never,user,new Map(),
      );
      clock.mockReturnValue(now+1_000);
      await sendChannelMessage(
        {channelId:channel._id,serverId:server._id,content:'fallback second'},
        socket as never,io as never,user,new Map(),
      );
      expect(io._emitted.filter(e=>e.ev==='message:new')).toHaveLength(1);
      expect(findEmitted(socket._emitted, 'error:slowmode')?.data).toMatchObject({remaining:9,channelId:channel._id});
    } finally {
      mockRedisCache.claimCooldown=canonicalClaim;
      clock.mockRestore();
    }
  });

  it('single-node slowmode falls back locally when a compatibility adapter claim throws', async () => {
    await mockDb.channels.update({_id:channel._id},{$set:{slowmode:5}});
    mockHasPermission.mockImplementation((_p:unknown,flag:unknown)=>flag===0x01||flag===0x10);
    mockCacheClaimCooldown.mockRejectedValueOnce(new Error('compatibility cache down'));
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:'local recovery'},
      socket as never,io as never,user,new Map(),
    );
    expect(findEmitted(io._emitted, 'message:new')).toBeDefined();
  });

  it('spam warning kullanıcıya iletilir ama mesajı engellemez', async () => {
    mockCheckSpamAsync.mockResolvedValue({ blocked: false, warning: true });
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'uyarı ama geçerli' },
      socket as never, io as never, user, new Map(),
    );
    expect(findEmitted(socket._emitted, 'warn:spam')).toBeDefined();
    expect(findEmitted(io._emitted, 'message:new')).toBeDefined();
  });

  it('webhook ve plugin side-effect hataları kalıcı mesajı geri almaz', async () => {
    mockDispatchEvent.mockRejectedValueOnce(new Error('webhook down'));
    mockPluginEmit.mockRejectedValueOnce(new Error('plugin down'));
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'kalıcı mesaj' },
      socket as never, io as never, user, new Map(),
    );
    await Promise.resolve();
    expect(await mockDb.messages.count({ channelId: channel._id })).toBe(1);
    expect(findEmitted(io._emitted, 'message:new')).toBeDefined();
  });

  it('non-Error optional-side-effect failures are normalized and remain non-fatal', async () => {
    mockDispatchEvent.mockRejectedValueOnce('webhook string failure');
    mockPluginEmit.mockRejectedValueOnce({code:'PLUGIN_DOWN'});
    mockProcessNotifications.mockRejectedValueOnce('notification string failure');
    jest.spyOn(Bridges,'findActiveFromSourceChannel').mockRejectedValueOnce('bridge string failure');
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:'durable across strange providers'},
      socket as never,io as never,user,new Map(),
    );
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(await mockDb.messages.count({channelId:channel._id})).toBe(1);
    expect(findEmitted(io._emitted, 'message:new')).toBeDefined();
  });

  it('normal persistence does not require the optional bot-command capability', async () => {
    mockHasPermission.mockImplementation((_p:unknown,flag:unknown)=>flag !== undefined);
    await sendChannelMessage(
      {channelId:channel._id,serverId:server._id,content:'ordinary message'},
      socket as never,io as never,user,new Map(),
    );
    expect(await mockDb.messages.count({channelId:channel._id})).toBe(1);
    expect(findEmitted(io._emitted, 'message:new')).toBeDefined();
  });

  it('notification provider failure is isolated after durable message persistence', async () => {
    mockProcessNotifications.mockRejectedValueOnce(new Error('notification store down'));
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'durable despite notification failure' },
      socket as never, io as never, user, new Map(),
    );
    expect(await mockDb.messages.count({ channelId: channel._id })).toBe(1);
    expect(findEmitted(io._emitted, 'message:new')).toBeDefined();
  });

  it('bridge repository failure is isolated after durable source persistence', async () => {
    jest.spyOn(Bridges, 'findActiveFromSourceChannel').mockRejectedValueOnce(new Error('bridge store down'));
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'source remains' },
      socket as never, io as never, user, new Map(),
    );
    expect(await mockDb.messages.count({ channelId: channel._id })).toBe(1);
    expect(io._emitted.filter(e => e.ev === 'message:new')).toHaveLength(1);
  });

  it('link preview başarısız URLleri atlar, başarılı previewu saklar', async () => {
    mockExtractUrls.mockReturnValue(['https://bad.example', 'https://ok.example']);
    mockFetchLinkPreview
      .mockRejectedValueOnce(new Error('blocked'))
      .mockResolvedValueOnce({ title: 'OK', url: 'https://ok.example' });
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'iki link' },
      socket as never, io as never, user, new Map(),
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    const evt = requireEmitted(io._emitted, 'message:embedUpdate');
    expect(evt).toBeDefined();
    expect((evt!.data as { embeds: unknown[] }).embeds).toHaveLength(1);
  });

  it('bridge hedef tenantı yoksa kaynak mesaj kalır ve forwarding atlanır', async () => {
    await mockDb.channelBridges.insert({
      _id:'bridge-missing-target', sourceChannelId:channel._id, sourceServerId:server._id,
      targetChannelId:'missing-channel', targetServerId:'missing-server', active:true, label:'X',
    });
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'kaynak' },
      socket as never, io as never, user, new Map(),
    );
    expect(io._emitted.filter(e => e.ev === 'message:new')).toHaveLength(1);
    expect(await mockDb.messages.count({ channelId: channel._id })).toBe(1);
  });

  it('bridge target lookup outage fails closed without rolling back the source message', async () => {
    const targetServer = makeServer(user._id);
    const targetChannel = makeChannel(targetServer._id, { name: 'provider-failure-target' });
    await mockDb.servers.insert(targetServer);
    await mockDb.channels.insert(targetChannel);
    await mockDb.channelBridges.insert({
      _id:'bridge-target-provider-failure', sourceChannelId:channel._id, sourceServerId:server._id,
      targetChannelId:targetChannel._id, targetServerId:targetServer._id, active:true, label:'X',
    });
    const original = Channels.findByIdAndServer.bind(Channels);
    const lookup = jest.spyOn(Channels, 'findByIdAndServer').mockImplementation(async (channelId, serverId) => {
      if (channelId === targetChannel._id) throw new Error('channel store down');
      return original(channelId, serverId);
    });
    try {
      await sendChannelMessage(
        { channelId: channel._id, serverId: server._id, content: 'source survives target outage' },
        socket as never, io as never, user, new Map(),
      );
    } finally {
      lookup.mockRestore();
    }
    expect(await mockDb.messages.count({ channelId: channel._id })).toBe(1);
    expect(await mockDb.messages.count({ channelId: targetChannel._id })).toBe(0);
  });

  it('primary message persistence failure does not emit or continue side effects', async () => {
    jest.spyOn(Messages, 'create').mockRejectedValueOnce(new Error('message store down'));
    await expect(sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'must not broadcast' },
      socket as never, io as never, user, new Map(),
    )).rejects.toThrow('message store down');
    expect(findEmitted(io._emitted, 'message:new')).toBeUndefined();
    expect(mockProcessNotifications).not.toHaveBeenCalled();
  });

  it('kanal canonical server scope içinde bulunamazsa CHANNEL_NOT_FOUND döner', async () => {
    await mockDb.channels.remove({ _id: channel._id });
    await sendChannelMessage(
      { channelId: channel._id, serverId: server._id, content: 'yok kanal', ackId:'ack-missing', _tmpId:'tmp-missing' },
      socket as never, io as never, user, new Map(),
    );
    expect(findEmitted(socket._emitted, 'error:message')?.data).toMatchObject({
      code:'CHANNEL_NOT_FOUND', ackId:'ack-missing', tmpId:'tmp-missing',
    });
  });

  it('aşırı büyük E2EE payload açık hata ile reddedilir', async () => {
    await sendChannelMessage(
      { channelId:channel._id, serverId:server._id, type:'e2ee', encryptedContent:'x'.repeat(8193), iv:'iv' },
      socket as never, io as never, user, new Map(),
    );
    expect(findEmitted(socket._emitted, 'error:e2ee')).toBeDefined();
    expect(findEmitted(io._emitted, 'message:new')).toBeUndefined();
  });

  it('music command handled=true ise normal mesaj persistence yoluna girmez', async () => {
    mockMusicHandle.mockResolvedValueOnce(true);
    await sendChannelMessage(
      { channelId:channel._id, serverId:server._id, content:'!play test' },
      socket as never, io as never, user, new Map(),
    );
    expect(mockMusicHandle).toHaveBeenCalled();
    expect(await mockDb.messages.count({ channelId:channel._id })).toBe(0);
  });

  it('music command handled=false ise normal mesaj olarak devam eder', async () => {
    mockMusicHandle.mockResolvedValueOnce(false);
    await sendChannelMessage(
      { channelId:channel._id, serverId:server._id, content:'!unknown test' },
      socket as never, io as never, user, new Map(),
    );
    expect(mockMusicHandle).toHaveBeenCalled();
    expect(await mockDb.messages.count({ channelId:channel._id })).toBe(1);
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
    mockMusicHandle.mockResolvedValue(false);
    mockGetCachedPerms.mockResolvedValue(0xffffffff);
    mockHasPermission.mockReturnValue(true);
    mockCheckSpamAsync.mockResolvedValue({ blocked: false });
    mockCacheGet.mockRejectedValue(new Error('redis unavailable'));
    mockCacheSet.mockRejectedValue(new Error('redis unavailable'));
    mockCacheIncrement.mockResolvedValue(1);

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
    socket.rooms.add(`channel:${channel._id}`);
    registerSendHandlers(socket as never, io as never, user, new Map());
  });

  it('message:send handler kayıtlı', () => {
    expect(socket._handlers['message:send']).toBeDefined();
  });

  // Faz 7 — teslim durum makinesi: handler hata verirse istemci hangi gönderimin
  // başarısız olduğunu bilmeli. Hata olayı ackId/_tmpId'yi geri yansıtır ve
  // süreç ayakta kalır (crash isolation korunur).
  it('handler hatası → error:message ackId/tmpId ile korele edilir, süreç düşmez', async () => {
    // channels.findByIdAndServer içinden fırlatarak gerçek bir hata yolu üret
    const original = mockDb.channels.findOne;
    mockDb.channels.findOne = () => { throw new Error('DB down'); };

    await socket._trigger('message:send', {
      channelId: channel._id,
      serverId:  server._id,
      content:   'hata testi',
      ackId:     'ack-fail-1',
      _tmpId:    'tmp-fail-1',
    });

    mockDb.channels.findOne = original;

    const err = requireEmitted(socket._emitted, 'error:message');
    expect(err).toBeDefined();
    expect(err!.data).toMatchObject({
      event: 'message:send',
      ackId: 'ack-fail-1',
      tmpId: 'tmp-fail-1',
    });
    // Mesaj oluşturulmamalı
    expect(findEmitted(io._emitted, 'message:new')).toBeUndefined();
  });

  it('aynı ackId ile iki kez gönderim (retry) → tek mesaj oluşur', async () => {
    // İlk gönderim: ACK kaydı yok
    mockGetAckRecord.mockResolvedValueOnce(null);
    await socket._trigger('message:send', {
      channelId: channel._id, serverId: server._id, content: 'retry testi', ackId: 'ack-retry-1', _tmpId: 'tmp-retry-1',
    });
    const ilkYayin = io._emitted.filter(e => e.ev === 'message:new').length;
    expect(ilkYayin).toBe(1);

    // Retry: sunucu ACK kaydını görür → yeniden oluşturmaz, yalnızca ACK yollar
    const kayit = mockSetAckRecord.mock.calls[0][1];
    mockGetAckRecord.mockResolvedValueOnce(kayit);
    await socket._trigger('message:send', {
      channelId: channel._id, serverId: server._id, content: 'retry testi', ackId: 'ack-retry-1', _tmpId: 'tmp-retry-1',
    });

    expect(io._emitted.filter(e => e.ev === 'message:new')).toHaveLength(1); // duplicate YOK
    expect(mockSendAck).toHaveBeenLastCalledWith(socket, 'ack-retry-1', kayit);
  });

  // ════════════════════════════════════════════════════════════════════════
  // KAPATILAN GERCEK ACIK — SAHTE / BASKASININ DOSYA BASVURUSU
  // ════════════════════════════════════════════════════════════════════════
  // `isSafeUploadReference` YALNIZCA yol seklini dogruluyordu. Adi ve E2E
  // testi KAYIT denetimi vaat ediyordu ama boyle bir denetim YOKTU:
  // `/uploads/` ile baslayan HERHANGI bir yol kabul ediliyordu.
  //
  // Kusur E2E'de gorunmuyordu cunku mesaj listesi onbellegi bayat kaliyor,
  // test sahte mesaji hic okumuyordu. Onbellek gecersiz kilma duzeltilince
  // ortaya cikti; canli veritabaninda 28 sahte satir bulundu.

  it('GUVENLIK: file:send KAYITSIZ upload basvurusunu REDDEDER', async () => {
    await socket._trigger('file:send', {
      channelId: channel._id, serverId: server._id,
      fileName: 'uydurma.pdf',
      fileUrl:  '/uploads/hic-yuklenmedi.pdf',
      fileType: 'application/pdf',
    });

    expect(findEmitted(io._emitted, 'message:new')).toBeUndefined();
    expect(await mockDb.messages.find({ type: 'file' })).toHaveLength(0);
  });

  it('GUVENLIK: file:send BASKASININ yuklemesini REDDEDER', async () => {
    // En tehlikeli hali: saldirgan baskasinin dosya yolunu KENDI kanalinda
    // yayimlayarak, o dosyayi hic gormemesi gereken kisilere acabilirdi.
    await mockDb.uploads.insert({
      _id: 'up-baskasi', userId: 'BASKA-KULLANICI',
      key: 'uploads/gizli-rapor.pdf',
      originalName: 'gizli-rapor.pdf', mimeType: 'application/pdf', createdAt: Date.now(),
    });

    await socket._trigger('file:send', {
      channelId: channel._id, serverId: server._id,
      fileName: 'gizli-rapor.pdf',
      fileUrl:  '/uploads/gizli-rapor.pdf',
      fileType: 'application/pdf',
    });

    expect(findEmitted(io._emitted, 'message:new')).toBeUndefined();
    expect(await mockDb.messages.find({ type: 'file' })).toHaveLength(0);
  });

  it('GUVENLIK: reddedilen basvuru kullaniciya BILDIRILIR', async () => {
    // Sessizce dusurmek, kullaniciya dosyasi gitmis gibi gosterirdi.
    await socket._trigger('file:send', {
      channelId: channel._id, serverId: server._id,
      fileName: 'uydurma.pdf', fileUrl: '/uploads/yok.pdf', fileType: 'application/pdf',
    });

    const err = requireEmitted(socket._emitted, 'error:message');
    expect(dataOf(err).code).toBe('INVALID_FILE_REFERENCE');
  });

  it('GUVENLIK: file:send ATTACH_FILES izni yoksa sahip olunan uploadu REDDEDER', async () => {
    await mockDb.uploads.insert({
      _id: 'up-no-attach-legacy', userId: user._id,
      key: 'uploads/no-attach-legacy.pdf', originalName: 'no-attach-legacy.pdf',
      mimeType: 'application/pdf', createdAt: Date.now(),
    });
    mockHasPermission.mockImplementation((_perms: unknown, flag: unknown) => flag !== 0x800);

    await socket._trigger('file:send', {
      channelId: channel._id, serverId: server._id, fileName: 'no-attach-legacy.pdf',
      fileUrl: '/uploads/no-attach-legacy.pdf', fileType: 'application/pdf',
    });

    expect(findEmitted(io._emitted, 'message:new')).toBeUndefined();
    expect(findEmitted(socket._emitted, 'error:message')).toMatchObject({
      data: { code: 'MISSING_PERMISSION' },
    });
  });

  it('file:send — geçerli upload URL → message:new', async () => {
    // GUVENLIK SOZLESMESI: dosya basvurusu artik KAYITLI olmali ve cagirana
    // ait olmali. Onceden yalnizca yol SEKLI dogrulaniyordu; `/uploads/` ile
    // baslayan her yol kabul ediliyor, hic yuklenmemis (ya da BASKASININ)
    // dosyasina isaret eden mesaj olusturulabiliyordu.
    await mockDb.uploads.insert({
      _id: 'up-doc', userId: user._id,
      key: 'uploads/abc/doc.pdf',
      originalName: 'doc.pdf', mimeType: 'application/pdf', createdAt: Date.now(),
    });

    await socket._trigger('file:send', {
      channelId: channel._id,
      serverId: server._id,
      fileName: 'doc.pdf',
      fileUrl:  '/uploads/abc/doc.pdf',
      fileType: 'application/pdf',
    });

    const broadcast = requireEmitted(io._emitted, 'message:new');
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


  it('file:send invalid schema payload persistence yapmaz ve açık hata döner', async () => {
    mockValidateSocketPayload.mockReturnValueOnce({ valid:false });
    await socket._trigger('file:send', { channelId:channel._id, serverId:server._id, fileName:'x.txt', fileUrl:'/uploads/x.txt', fileType:'text/plain' });
    expect(await mockDb.messages.count({ channelId:channel._id })).toBe(0);
    expect(findEmitted(socket._emitted, 'error:message')?.data).toMatchObject({ event:'file:send', code:'INVALID_PAYLOAD' });
  });

  it('file:send owned upload olsa da üyelik kaldırılmışsa persistence yapmaz', async () => {
    await mockDb.uploads.insert({ _id:'up-member', userId:user._id, key:'uploads/member.txt', originalName:'member.txt', mimeType:'text/plain', createdAt:Date.now() });
    await mockDb.members.remove({ userId:user._id, serverId:server._id });
    await socket._trigger('file:send', { channelId:channel._id, serverId:server._id, fileName:'member.txt', fileUrl:'/uploads/member.txt', fileType:'text/plain' });
    expect(await mockDb.messages.count({ channelId:channel._id })).toBe(0);
    expect(findEmitted(socket._emitted, 'error:message')?.data).toMatchObject({ event:'file:send', code:'NOT_A_MEMBER' });
  });

  it('file:send timeout aktifse error:timeout döner', async () => {
    await mockDb.uploads.insert({ _id:'up-timeout', userId:user._id, key:'uploads/timeout.txt', originalName:'timeout.txt', mimeType:'text/plain', createdAt:Date.now() });
    await mockDb.members.update({ userId:user._id, serverId:server._id }, { $set:{ timeoutUntil:Date.now()+30000 } });
    await socket._trigger('file:send', { channelId:channel._id, serverId:server._id, fileName:'timeout.txt', fileUrl:'/uploads/timeout.txt', fileType:'text/plain' });
    expect(findEmitted(socket._emitted, 'error:timeout')).toBeDefined();
    expect(await mockDb.messages.count({ channelId:channel._id })).toBe(0);
  });

  it('file:send canonical channel bulunamazsa persistence yapmaz', async () => {
    await mockDb.uploads.insert({ _id:'up-chan', userId:user._id, key:'uploads/chan.txt', originalName:'chan.txt', mimeType:'text/plain', createdAt:Date.now() });
    await mockDb.channels.remove({ _id:channel._id });
    await socket._trigger('file:send', { channelId:channel._id, serverId:server._id, fileName:'chan.txt', fileUrl:'/uploads/chan.txt', fileType:'text/plain' });
    expect(await mockDb.messages.count({ channelId:channel._id })).toBe(0);
    expect(findEmitted(socket._emitted, 'error:message')?.data).toMatchObject({ event:'file:send', code:'CHANNEL_NOT_FOUND' });
  });

  it('file:send VIEW_CHANNELS yoksa MISSING_PERMISSION döner', async () => {
    await mockDb.uploads.insert({ _id:'up-view', userId:user._id, key:'uploads/view.txt', originalName:'view.txt', mimeType:'text/plain', createdAt:Date.now() });
    mockHasPermission.mockImplementation((_p:unknown, flag:unknown) => flag !== 0x01);
    await socket._trigger('file:send', { channelId:channel._id, serverId:server._id, fileName:'view.txt', fileUrl:'/uploads/view.txt', fileType:'text/plain' });
    expect(findEmitted(socket._emitted, 'error:message')?.data).toMatchObject({ code:'MISSING_PERMISSION' });
  });

  // TYPING — Final21 Faz 16: `typing:start`/`typing:stop` artık TEK sahipte,
  // `socket/handlers/infra.ts`. Buradaki üç test var olmayan bir handler'ı
  // sınıyordu; "kanal odasına sızamaz" testi handler olmadığı için BOŞUNA
  // geçerdi (yayın yok → sızıntı da yok). Aynı güvenceler (oda denetimi,
  // typing:true/false, görünen ad) `infra-handlers-behavior.test.ts` içinde.
});

// ════════════════════════════════════════════════════════════════
// Faz 12 — KANAL SLOW MODE ZORLAMASI (canlı sunucu sözleşmesi)
// ════════════════════════════════════════════════════════════════
//
// `checkSlowmode` (messages-send.ts:47) ÜRETİMDE CANLI ve zorlanıyor, ancak
// hiçbir testi yoktu. Faz 12'de bu boşluk tespit edildi ve burada kapatılıyor.
//
// Kaynaktan doğrulanan sözleşme:
//   interval = channel.slowmode ?? 0;  interval <= 0 → kapalı
//   anahtar  = `slowmode:${userId}:${channelId}` → kullanıcı VE kanal bağımsız
//   izin verilirse son gönderim zamanı GÜNCELLENİR
//   reddedilirse zaman damgası GÜNCELLENMEZ (ceza uzamaz)
//   ret yolu: socket.emit('error:slowmode', { remaining, channelId }) + return
//
// Bu süit gerçek adapterin atomik `claimCooldown` sözleşmesini davranışsal bir
// test double ile uygular. Zaman `Date.now` spy'ı ile kontrol edilir — gerçek
// bekleme YOKTUR ve reddedilen talepler pencereyi uzatmaz.

describe('slow mode — kanal başına gönderim aralığı', () => {
  let user: ReturnType<typeof makeUser>;
  let server: ReturnType<typeof makeServer>;
  let channel: ReturnType<typeof makeChannel>;
  let socket: ReturnType<typeof makeSocket>;
  let io: ReturnType<typeof makeIo>;
  let nowSpy: jest.SpyInstance<number, []>;
  let clock = 1_700_000_000_000;
  let cooldowns: Map<string, number>;

  const advance = (seconds: number) => { clock += seconds * 1000; };

  const send = (content: string, ch = channel, asUser = user, sock = socket) =>
    sendChannelMessage(
      { channelId: ch._id, serverId: server._id, content },
      sock as never, io as never, asUser, new Map(),
    );

  const broadcasts = () => io._emitted.filter(e => e.ev === 'message:new');
  const slowErrors = (sock = socket) => sock._emitted.filter(e => e.ev === 'error:slowmode');

  beforeEach(async () => {
    mockDb._reset();
    jest.clearAllMocks();

    mockValidateSocketPayload.mockReturnValue({ valid: true });
    mockMusicHandle.mockResolvedValue(false);
    mockGetCachedPerms.mockResolvedValue(0xffffffff);
    // ÖNEMLİ: slowmode'un ADMINISTRATOR / MANAGE_MESSAGES muafiyeti vardır
    // (messages-send.ts:132). Diğer testlerdeki `mockReturnValue(true)` bu
    // muafiyeti her zaman tetikler ve slowmode hiç çalışmaz. Burada yalnız
    // SEND_MESSAGES verilir; muafiyet ayrıca aşağıda açıkça test edilir.
    mockHasPermission.mockImplementation((_perms: unknown, flag: unknown) => flag === 0x01 || flag === 0x10);
    mockCheckSpamAsync.mockResolvedValue({ blocked: false });
    mockGetAckRecord.mockResolvedValue(null);
    mockCacheGet.mockRejectedValue(new Error('redis unavailable'));
    mockCacheSet.mockRejectedValue(new Error('redis unavailable'));
    mockCacheIncrement.mockResolvedValue(1);
    cooldowns = new Map();
    mockCacheClaimCooldown.mockImplementation(async (key: string, intervalMs: number, _ttlMs: number, now: number) => {
      const last = cooldowns.get(key);
      if (last !== undefined && now - last < intervalMs) return intervalMs - (now - last);
      cooldowns.set(key, now);
      return 0;
    });
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

    clock  = 1_700_000_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  it('MANAGE_MESSAGES yetkisi olan kullanıcı slowmode\'dan MUAFTIR', async () => {
    await mockDb.channels.update({ _id: channel._id }, { $set: { slowmode: 30 } });
    // VIEW_CHANNELS + SEND_MESSAGES + MANAGE_MESSAGES
    // NOT: `VIEW_CHANNELS` (0x01) EKSİKTİ. Kanonik gönderim yolu artık
    // VIEW_CHANNELS + SEND_MESSAGES istiyor, dolayısıyla mesaj slowmode
    // kontrolüne HİÇ ULAŞMADAN reddediliyordu ve "muafiyet" testi yanlış
    // nedenle düşüyordu.
    mockHasPermission.mockImplementation(
      (_p: unknown, flag: unknown) => flag === 0x01 || flag === 0x10 || flag === 0x20,
    );

    await send('bir');
    await send('iki');

    expect(broadcasts()).toHaveLength(2);
    expect(slowErrors()).toHaveLength(0);
  });

  afterEach(() => { nowSpy.mockRestore(); });

  it('slowmode kapalıyken (0) ardışık mesajlara izin verilir', async () => {
    await mockDb.channels.update({ _id: channel._id }, { $set: { slowmode: 0 } });

    await send('bir');
    await send('iki');

    expect(broadcasts()).toHaveLength(2);
    expect(slowErrors()).toHaveLength(0);
  });

  it('slowmode açıkken ilk mesaja izin verilir', async () => {
    await mockDb.channels.update({ _id: channel._id }, { $set: { slowmode: 10 } });

    await send('ilk');

    expect(broadcasts()).toHaveLength(1);
    expect(slowErrors()).toHaveLength(0);
  });

  it('aralık dolmadan ikinci mesaj REDDEDİLİR ve kalan süre bildirilir', async () => {
    await mockDb.channels.update({ _id: channel._id }, { $set: { slowmode: 10 } });

    await send('ilk');
    advance(3);
    await send('ikinci');

    expect(broadcasts()).toHaveLength(1);          // ikinci yayınlanmadı
    const err = slowErrors()[0];
    expect(err).toBeDefined();
    expect((err!.data as { channelId: string }).channelId).toBe(channel._id);
    expect((err!.data as { remaining: number }).remaining).toBe(7);
  });

  it('aralık dolduktan sonra tekrar izin verilir', async () => {
    await mockDb.channels.update({ _id: channel._id }, { $set: { slowmode: 10 } });

    await send('ilk');
    advance(10);
    await send('ikinci');

    expect(broadcasts()).toHaveLength(2);
    expect(slowErrors()).toHaveLength(0);
  });

  it('REDDEDİLEN gönderim cezayı UZATMAZ (zaman damgası güncellenmez)', async () => {
    await mockDb.channels.update({ _id: channel._id }, { $set: { slowmode: 10 } });

    await send('ilk');
    advance(5);
    await send('reddedilecek');       // t=5, kalan 5
    advance(5);                        // t=10 — ilk mesajdan 10sn sonra
    await send('sonunda');

    // Reddedilen deneme sayacı sıfırlasaydı bu mesaj da reddedilirdi.
    expect(broadcasts()).toHaveLength(2);
  });

  it('FARKLI KULLANICILAR bağımsız sayaçlara sahiptir', async () => {
    await mockDb.channels.update({ _id: channel._id }, { $set: { slowmode: 30 } });

    const other = makeUser();
    await mockDb.users.insert(other);
    await mockDb.members.insert({
      userId: other._id, serverId: server._id, joinedAt: Date.now(), roles: '[]',
    });
    const otherSocket = makeSocket();

    await send('a');
    await send('b', channel, other, otherSocket);

    expect(broadcasts()).toHaveLength(2);
    expect(slowErrors()).toHaveLength(0);
    expect(slowErrors(otherSocket)).toHaveLength(0);
  });

  it('FARKLI KANALLAR bağımsız sayaçlara sahiptir', async () => {
    await mockDb.channels.update({ _id: channel._id }, { $set: { slowmode: 30 } });
    const other = makeChannel(server._id);
    await mockDb.channels.insert({ ...other, slowmode: 30 });

    await send('a');
    await send('b', other);

    expect(broadcasts()).toHaveLength(2);
    expect(slowErrors()).toHaveLength(0);
  });

  it('kalan süre YUKARI yuvarlanır (Math.ceil)', async () => {
    await mockDb.channels.update({ _id: channel._id }, { $set: { slowmode: 10 } });

    await send('ilk');
    clock += 2_500;                    // 2.5sn geçti → kalan 7.5 → 8
    await send('ikinci');

    expect((slowErrors()[0]!.data as { remaining: number }).remaining).toBe(8);
  });
});
