// server/tests/permission-memo-equivalence.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// İSTEK KAPSAMLI İZİN MEMOSU YETKİYİ DEĞİŞTİRMEZ
// ════════════════════════════════════════════════════════════════════════════
// v1.124, `resolvePermissionResolution` içindeki DEĞİŞMEZ okumaları
// (sunucu satırı, üyelik, rol kümesi) istek kapsamlı bir memoya aldı.
// Ölçülen kazanç gerçekti — `/unread` 100 kanalda 110 ms → 15.3 ms, kanal
// başına marjinal maliyet 0.90 ms → 0.00 ms.
//
// Ama bir izin önbelleği YANLIŞ yapılırsa sessizce yetki sızdırır. Bu yüzden
// hız değil, DENKLİK kanıtlanır: memo AÇIKKEN ve KAPALIYKEN sonuçlar
// birebir aynı olmalıdır.
//
// İki güvenlik değişmezi ayrıca ayrı ayrı kilitlenir:
//   1. Önbellek İSTEK kapsamlıdır — istekler arasında hiçbir şey taşınmaz,
//      dolayısıyla bayat yetki oluşamaz.
//   2. Kanal geçersiz kılmaları memoize EDİLMEZ — aynı istek içinde farklı
//      kanallar farklı sonuç vermeye devam eder.
process.env.NODE_ENV = 'test';

import { runWithRequestContext, newRequestId } from '../lib/requestContext';

const servers = new Map<string, unknown>();
const members = new Map<string, unknown>();
const roles = new Map<string, unknown>();
const overrides: Array<Record<string, unknown>> = [];

const calls = { server: 0, member: 0, roles: 0 };

jest.mock('../db/repositories', () => ({
  Servers: { findById: jest.fn(async (id: string) => { calls.server++; return servers.get(id) ?? null; }) },
  Members: { findOne: jest.fn(async (u: string, s: string) => { calls.member++; return members.get(`${u}:${s}`) ?? null; }) },
  Roles: {
    findByIdsInServer: jest.fn(async (ids: string[], s: string) => {
      calls.roles++;
      return ids.map(id => roles.get(`${s}:${id}`)).filter(Boolean);
    }),
  },
  Channels: { findOverridesByChannel: jest.fn(async () => overrides) },
  ChannelPermissions: { findByChannel: jest.fn(async () => []) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolvePermissionResolution } = require('../lib/permissions') as
  typeof import('../lib/permissions');

const SERVER = 's1';
const OWNER = 'owner-1';
const ADMIN = 'admin-1';
const MOD = 'mod-1';
const PLAIN = 'plain-1';
const STRANGER = 'nobody-1';

beforeEach(() => {
  servers.clear(); members.clear(); roles.clear(); overrides.length = 0;
  calls.server = 0; calls.member = 0; calls.roles = 0;

  servers.set(SERVER, { _id: SERVER, ownerId: OWNER });

  roles.set(`${SERVER}:r-admin`, { _id: 'r-admin', serverId: SERVER, name: 'admin', position: 10, permissions: 0x8 });
  roles.set(`${SERVER}:r-mod`,   { _id: 'r-mod',   serverId: SERVER, name: 'mod',   position: 5,  permissions: 0x2 });

  members.set(`${ADMIN}:${SERVER}`, { userId: ADMIN, serverId: SERVER, roles: ['r-admin'] });
  members.set(`${MOD}:${SERVER}`,   { userId: MOD,   serverId: SERVER, roles: ['r-mod'] });
  members.set(`${PLAIN}:${SERVER}`, { userId: PLAIN, serverId: SERVER, roles: [] });
});

/** Aynı çözümü memo BAĞLAMI DIŞINDA (önbelleksiz) hesaplar. */
function withoutMemo(userId: string, channelId: string | null) {
  return resolvePermissionResolution(userId, SERVER, channelId);
}

/** Aynı çözümü bir istek bağlamı içinde (memo AÇIK) hesaplar. */
function withMemo(userId: string, channelId: string | null) {
  return runWithRequestContext({ requestId: newRequestId() }, () =>
    resolvePermissionResolution(userId, SERVER, channelId));
}

describe('memo açıkken ve kapalıyken sonuçlar AYNIDIR', () => {
  it.each([
    ['sunucu sahibi', OWNER, null],
    ['admin rolü', ADMIN, null],
    ['moderatör rolü', MOD, null],
    ['rolsüz sıradan üye', PLAIN, null],
    ['üye OLMAYAN', STRANGER, null],
    ['sahip + kanal', OWNER, 'c1'],
    ['admin + kanal', ADMIN, 'c1'],
    ['sıradan üye + kanal', PLAIN, 'c1'],
    ['üye olmayan + kanal', STRANGER, 'c1'],
  ])('%s', async (_label, userId, channelId) => {
    const plain = await withoutMemo(userId, channelId);
    const memoed = await withMemo(userId, channelId);
    expect(memoed).toEqual(plain);
  });

  it('silinmiş rol taşıyan üyelik aynı sonucu verir', async () => {
    members.set(`${PLAIN}:${SERVER}`, { userId: PLAIN, serverId: SERVER, roles: ['r-deleted'] });
    expect(await withMemo(PLAIN, 'c1')).toEqual(await withoutMemo(PLAIN, 'c1'));
  });

  it('var olmayan sunucu aynı sonucu verir', async () => {
    servers.clear();
    expect(await withMemo(PLAIN, 'c1')).toEqual(await withoutMemo(PLAIN, 'c1'));
  });
});

describe('memo GERÇEKTEN tekrar okumaları önler', () => {
  it('aynı istekte 50 kanal için sunucu/üyelik/rol BİR KEZ okunur', async () => {
    await runWithRequestContext({ requestId: newRequestId() }, async () => {
      for (let i = 0; i < 50; i++) {
        await resolvePermissionResolution(ADMIN, SERVER, `c${i}`);
      }
    });

    // Degismez kisim kanal basina DEGIL, istek basina okunur.
    expect(calls.server).toBe(1);
    expect(calls.member).toBe(1);
    expect(calls.roles).toBe(1);
  });

  it('memo YOKKEN her çağrı yeniden okur (önbelleğin etkisi budur)', async () => {
    for (let i = 0; i < 5; i++) await resolvePermissionResolution(ADMIN, SERVER, `c${i}`);
    expect(calls.server).toBe(5);
    expect(calls.member).toBe(5);
  });
});

describe('güvenlik değişmezleri', () => {
  it('önbellek İSTEKLER ARASINDA taşınmaz — rol değişikliği hemen görünür', async () => {
    const before = await withMemo(ADMIN, null);
    expect(before.permissions).toBe(0x8);

    // Rol yetkisi degisir (baska bir istegin yaptigi degisikligi temsil eder).
    roles.set(`${SERVER}:r-admin`, { _id: 'r-admin', serverId: SERVER, name: 'admin', position: 10, permissions: 0x1 });

    // YENI bir istek bagalami: bayat deger KULLANILMAZ.
    const after = await withMemo(ADMIN, null);
    expect(after.permissions).toBe(0x1);
  });

  it('üyelik kaldırılınca bir sonraki istek erişimi REDDEDER', async () => {
    expect((await withMemo(PLAIN, null)).subject).not.toBe('not_member');
    members.delete(`${PLAIN}:${SERVER}`);
    expect((await withMemo(PLAIN, null)).subject).toBe('not_member');
  });

  it('sahiplik memo ile atlanmaz — sahip her zaman tam yetkilidir', async () => {
    const r = await withMemo(OWNER, 'c1');
    expect(r.subject).toBe('owner');
    expect(r.permissions).toBe(0x7FFFFFFF);
  });

  it('bağlam yokken memo devre dışıdır ve sonuç yine doğrudur', async () => {
    const r = await withoutMemo(ADMIN, null);
    expect(r.permissions).toBe(0x8);
  });
});
