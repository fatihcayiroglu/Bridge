// server/tests/messages-integration.test.ts
// Sprint 107/108: send → edit → delete socket akışı (entegrasyon)
import { findEmitted, requireEmitted } from './helpers/socketDoubles';

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeChannel, makeServer, makeUser, requireDoc } from './helpers/mockDb';

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
  cache: {
    // Gercek adaptorde MEVCUT (lib/redisAdapter.ts) — mock'ta eksikti ve
    // `invalidateChannelMessages` her cagrida sessizce TypeError firlatiyordu.
    invalidatePattern: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) },
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

function makeSocket(id: string = 'sock-int-1') {
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

    const created = requireEmitted(io._emitted, 'message:new');
    expect(created).toBeDefined();
    const messageId = (created!.data as { _id: string })._id;

    await socket._trigger('message:edit', {
      messageId,
      channelId: channel._id,
      content:   'düzenlenmiş içerik',
    });

    const edited = requireEmitted(io._emitted, 'message:edited');
    expect(edited).toBeDefined();
    expect((edited!.data as { content: string }).content).toBe('düzenlenmiş içerik');

    await socket._trigger('message:delete', { messageId, channelId: channel._id });

    const deleted = requireEmitted(io._emitted, 'message:deleted');
    expect(deleted).toBeDefined();
    expect(await mockDb.messages.findOne({ _id: messageId })).toMatchObject({ content: '[Mesaj silindi]', deletedBy: user._id });
  });

  it('message:send → message:react → pin toggle', async () => {
    await socket._trigger('message:send', {
      channelId: channel._id,
      serverId:  server._id,
      content:   'reaksiyon testi',
    });

    const messageId = (findEmitted(io._emitted, 'message:new')!.data as { _id: string })._id;

    await socket._trigger('message:react', {
      messageId,
      channelId: channel._id,
      emoji:     '👍',
    });

    expect(io._emitted.some(e => e.ev === 'message:reaction')).toBe(true);

    await socket._trigger('message:pin', { messageId, channelId: channel._id, serverId: server._id });
    expect(io._emitted.some(e => e.ev === 'message:pinned')).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CANLI URUNDE YAKALANAN KUSUR — DOSYA GONDERIMI HIC CALISMIYORDU.
  //
  // `file:send` mesaji olustururken `createdAt` (ve `reactions`) alanlarini
  // ATLIYORDU. `messages.createdAt` semada NOT NULL oldugu icin her dosya
  // gonderimi veritabani kisitini ihlal edip dusuyordu; hata `isolate()`
  // tarafindan yakalandigi icin istemciye yalnizca genel bir mesaj donuyordu.
  //
  // OLCUM: ayni sokette `message:send` calisirken `file:send` HER SEFERINDE
  // `error:message` donduruyordu. Bu test alanlarin varligini dogrular.
  it('file:send KANONIK alanlarla mesaj olusturur (createdAt DAHIL)', async () => {
    // GUVENLIK SOZLESMESI: dosya basvurusu KAYITLI olmali ve cagirana ait
    // olmali. Onceden yalnizca yol SEKLI dogrulaniyordu; hic yuklenmemis
    // (ya da BASKASININ) dosyasina isaret eden mesaj olusturulabiliyordu.
    await mockDb.uploads.insert({
      _id: 'up-rapor', userId: user._id,
      key: 'uploads/abc-123.pdf',
      originalName: 'rapor.pdf', mimeType: 'application/pdf', createdAt: Date.now(),
    });

    await socket._trigger('file:send', {
      channelId: channel._id,
      serverId:  server._id,
      fileName:  'rapor.pdf',
      fileUrl:   '/uploads/abc-123.pdf',
      fileType:  'application/pdf',
    });

    const created = (await mockDb.messages.find({ channelId: channel._id }))
      .filter((m: Record<string, unknown>) => m.type === 'file');

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'file', fileName: 'rapor.pdf',
      fileUrl: '/uploads/abc-123.pdf', fileType: 'application/pdf',
    });
    // REGRESYON KAPISI: bu alan olmadan uretimde NOT NULL ihlali olusuyordu.
    expect(typeof created[0].createdAt).toBe('number');
    expect(created[0].createdAt).toBeGreaterThan(0);
    expect(created[0].reactions).toBeDefined();

    expect(io._emitted.some(e => e.ev === 'message:new' && e._target === `channel:${channel._id}`)).toBe(true);
  });

  it('file:send /uploads/ disindaki yolu REDDEDER (path traversal)', async () => {
    await socket._trigger('file:send', {
      channelId: channel._id, serverId: server._id,
      fileName: 'gizli', fileUrl: '/etc/passwd', fileType: 'text/plain',
    });

    const files = (await mockDb.messages.find({ channelId: channel._id }))
      .filter((m: Record<string, unknown>) => m.type === 'file');
    expect(files).toHaveLength(0);
  });

});
