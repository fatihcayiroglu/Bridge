// server/tests/permissions-core.test.ts
// lib/permissions.ts — GERÇEK yetkilendirme çekirdeğinin sözleşme testleri.
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — LIVE_SERVER_AUTHZ_UNCOVERED KAPATMA
// ════════════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: `hasPermission`, `hasAnyPermission`, `hasAllPermissions` ve
// `resolvePermissions` sunucudaki HER testte mock'lanıyordu:
//
//   automod.test.ts:50            perms.hasPermission.mockImplementation(...)
//   channelPerms.test.ts:66       perms.hasPermission.mockReturnValue(true)
//   channelPerms.test.ts:23       resolvePermissions: jest.fn().mockResolvedValue(2)
//   channelPermsAdvanced.test.ts  ·  channelPermsIntegration.test.ts
//   bots.test.ts · messages-edit.test.ts · activities.server.test.ts
//
// Yani rota testleri yetkilendirmenin SONUCUNU varsayıyor, KENDİSİNİ hiç
// çalıştırmıyordu. ADMINISTRATOR atlatması, sunucu sahibi kısa devresi ve
// override öncelik sırası — sistemin en kritik güvenlik dalları — 0 kapsamdı.
//
// Bu dosya bu boşluğu kapatır: izin fonksiyonları GERÇEK olarak çalıştırılır,
// yalnızca DB sınırı (`../db/repositories`) mock'lanır. Kural kopyası YOKTUR.
//
// KAPSAM SINIRI: yalnız emekliye ayrılan `client/tests/permissions-sprint82.test.ts`
// dosyasının ifade ettiği sözleşmeler + onların gerçek üretim karşılıkları.
// `canActOn` / `logAudit` bu turun kapsamı DIŞINDADIR (ayrı, kayıtlı boşluk).
//
// Üretim kodu bu turda DEĞİŞTİRİLMEMİŞTİR.

const mockServers  = { findById: jest.fn() };
const mockMembers  = { findOne: jest.fn() };
const mockRoles    = { findByIdsInServer: jest.fn(), findWhere: jest.fn() };
const mockChannels = { findOverridesByChannel: jest.fn() };
const mockChannelPermissions = { findByChannel: jest.fn() };
const mockAuth     = { insertAuditLog: jest.fn() };

jest.mock('../db/repositories', () => ({
  Servers:  mockServers,
  Members:  mockMembers,
  Roles:    mockRoles,
  Channels: mockChannels,
  ChannelPermissions: mockChannelPermissions,
  Auth:     mockAuth,
}));

import {
  PERMS,
  DEFAULT_PERMISSIONS,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  resolvePermissions,
  resolvePermissionResolution,
  explainResolvedPermission,
  canActOn,
} from '../lib/permissions';

const OWNER_ALL = 0x7FFFFFFF;

beforeEach(() => {
  jest.clearAllMocks();
  // Varsayılan: sunucu var, kullanıcı üye değil → en kısıtlı hâl.
  mockServers.findById.mockResolvedValue({ _id: 's1', ownerId: 'owner-1' });
  mockMembers.findOne.mockResolvedValue(null);
  mockRoles.findByIdsInServer.mockResolvedValue([]);
  mockChannels.findOverridesByChannel.mockResolvedValue([]);
  mockChannelPermissions.findByChannel.mockResolvedValue([]);
});

// ════════════════════════════════════════════════════════════════════════════
// hasPermission — GERÇEK uygulama (permissions.ts:64)
// ════════════════════════════════════════════════════════════════════════════
describe('hasPermission — gerçek uygulama', () => {
  test('eşleşen tek bit için true döner', () => {
    expect(hasPermission(PERMS.SEND_MESSAGES, PERMS.SEND_MESSAGES)).toBe(true);
  });

  test('eşleşmeyen bit için false döner', () => {
    expect(hasPermission(PERMS.VIEW_CHANNELS, PERMS.BAN_MEMBERS)).toBe(false);
  });

  test('0 izinde her bayrak reddedilir', () => {
    expect(hasPermission(0, PERMS.VIEW_CHANNELS)).toBe(false);
  });

  test('birleşik bitmask içindeki hedef bayrağı bulur', () => {
    const combined = PERMS.SEND_MESSAGES | PERMS.READ_HISTORY | PERMS.ATTACH_FILES;

    expect(hasPermission(combined, PERMS.ATTACH_FILES)).toBe(true);
    expect(hasPermission(combined, PERMS.BAN_MEMBERS)).toBe(false);
  });

  test('GÜVENLİK: ADMINISTRATOR biti TÜM bayrakları atlatır', () => {
    // permissions.ts:65 — sistemin en geniş yetki dalı. Rota testleri bunu
    // mock'ladığı için buraya kadar hiç çalıştırılmamıştı.
    for (const flag of Object.values(PERMS)) {
      expect(hasPermission(PERMS.ADMINISTRATOR, flag)).toBe(true);
    }
  });

  test('GÜVENLİK: ADMINISTRATOR olmadan yükseltme olmaz', () => {
    expect(hasPermission(DEFAULT_PERMISSIONS, PERMS.ADMINISTRATOR)).toBe(false);
    expect(hasPermission(DEFAULT_PERMISSIONS, PERMS.BAN_MEMBERS)).toBe(false);
    expect(hasPermission(DEFAULT_PERMISSIONS, PERMS.MANAGE_SERVER)).toBe(false);
  });

  test('DEFAULT_PERMISSIONS sıradan üyenin taban kümesidir', () => {
    // Verilenler (permissions.ts:38-41) — ses dahil.
    for (const flag of [
      PERMS.VIEW_CHANNELS, PERMS.SEND_MESSAGES, PERMS.READ_HISTORY,
      PERMS.EMBED_LINKS, PERMS.ATTACH_FILES, PERMS.ADD_REACTIONS,
      PERMS.CONNECT, PERMS.SPEAK,
    ]) {
      expect(hasPermission(DEFAULT_PERMISSIONS, flag)).toBe(true);
    }

    // Verilmeyenler — moderasyon/yönetim bitleri taban kümede OLMAMALIDIR.
    for (const flag of [
      PERMS.KICK_MEMBERS, PERMS.MANAGE_CHANNELS, PERMS.MANAGE_ROLES,
      PERMS.MENTION_EVERYONE, PERMS.MANAGE_MESSAGES, PERMS.TIMEOUT_MEMBERS,
    ]) {
      expect(hasPermission(DEFAULT_PERMISSIONS, flag)).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// hasAnyPermission / hasAllPermissions — GERÇEK (permissions.ts:69, :73)
// ════════════════════════════════════════════════════════════════════════════
describe('hasAnyPermission / hasAllPermissions — gerçek uygulama', () => {
  test('any: en az bir bayrak eşleşirse true', () => {
    const perms = PERMS.SEND_MESSAGES | PERMS.READ_HISTORY;

    expect(hasAnyPermission(perms, PERMS.BAN_MEMBERS, PERMS.SEND_MESSAGES)).toBe(true);
  });

  test('any: hiçbir bayrak eşleşmezse false', () => {
    expect(hasAnyPermission(PERMS.SEND_MESSAGES, PERMS.BAN_MEMBERS, PERMS.KICK_MEMBERS)).toBe(false);
  });

  test('all: bayrakların tamamı varsa true', () => {
    const perms = PERMS.SEND_MESSAGES | PERMS.READ_HISTORY | PERMS.ATTACH_FILES;

    expect(hasAllPermissions(perms, PERMS.SEND_MESSAGES, PERMS.READ_HISTORY)).toBe(true);
  });

  test('all: tek bir bayrak eksikse false', () => {
    const perms = PERMS.SEND_MESSAGES | PERMS.READ_HISTORY;

    expect(hasAllPermissions(perms, PERMS.SEND_MESSAGES, PERMS.BAN_MEMBERS)).toBe(false);
  });

  test('GÜVENLİK: ADMINISTRATOR any/all\'da da atlatır', () => {
    expect(hasAnyPermission(PERMS.ADMINISTRATOR, PERMS.BAN_MEMBERS)).toBe(true);
    expect(hasAllPermissions(
      PERMS.ADMINISTRATOR,
      PERMS.BAN_MEMBERS, PERMS.KICK_MEMBERS, PERMS.MANAGE_SERVER,
    )).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// resolvePermissions — GERÇEK çözümleme (permissions.ts:78)
// ════════════════════════════════════════════════════════════════════════════
describe('resolvePermissions — gerçek çözümleme', () => {
  test('sunucu yoksa 0 (fail-closed)', async () => {
    mockServers.findById.mockResolvedValue(null);

    expect(await resolvePermissions('u1', 'yok')).toBe(0);
  });

  test('GÜVENLİK: üye olmayan 0 alır', async () => {
    mockMembers.findOne.mockResolvedValue(null);

    expect(await resolvePermissions('yabanci', 's1')).toBe(0);
  });

  test('sunucu sahibi tam yetki alır (kısa devre)', async () => {
    const result = await resolvePermissions('owner-1', 's1');

    expect(result).toBe(OWNER_ALL);
    // Sahip kısa devresi üyelik sorgusuna hiç gitmez.
    expect(mockMembers.findOne).not.toHaveBeenCalled();
  });

  test('rolsüz üye DEFAULT_PERMISSIONS alır', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: [] });

    expect(await resolvePermissions('u1', 's1')).toBe(DEFAULT_PERMISSIONS);
  });

  test('birden fazla rol OR ile birleştirilir', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: ['r1', 'r2'] });
    mockRoles.findByIdsInServer.mockResolvedValue([
      { _id: 'r1', serverId: 's1', permissions: PERMS.SEND_MESSAGES },
      { _id: 'r2', serverId: 's1', permissions: PERMS.BAN_MEMBERS },
    ]);

    const result = await resolvePermissions('u1', 's1');

    expect(hasPermission(result, PERMS.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(result, PERMS.BAN_MEMBERS)).toBe(true);
    expect(hasPermission(result, PERMS.MANAGE_SERVER)).toBe(false);
  });

  test('GÜVENLİK: rol ADMINISTRATOR taşıyorsa tam yetkiye yükselir', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: ['admin-role'] });
    mockRoles.findByIdsInServer.mockResolvedValue([
      { _id: 'admin-role', serverId: 's1', permissions: PERMS.ADMINISTRATOR },
    ]);

    const result = await resolvePermissions('u1', 's1', 'c1');

    expect(result).toBe(OWNER_ALL);
    // Admin kısa devresi override sorgusunu atlar (permissions.ts:101).
    expect(mockChannels.findOverridesByChannel).not.toHaveBeenCalled();
  });

  test('channelId yoksa override uygulanmaz', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: [] });

    expect(await resolvePermissions('u1', 's1', null)).toBe(DEFAULT_PERMISSIONS);
    expect(mockChannels.findOverridesByChannel).not.toHaveBeenCalled();
  });

  test('everyone override DENY tabandan bit düşürür', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: [] });
    mockChannels.findOverridesByChannel.mockResolvedValue([
      { targetType: 'everyone', targetId: 's1', allow: 0, deny: PERMS.SEND_MESSAGES },
    ]);

    const result = await resolvePermissions('u1', 's1', 'c1');

    expect(hasPermission(result, PERMS.SEND_MESSAGES)).toBe(false);
    expect(hasPermission(result, PERMS.VIEW_CHANNELS)).toBe(true);
  });

  test('override ALLOW tabanda olmayan bir izni verebilir', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: [] });
    mockChannels.findOverridesByChannel.mockResolvedValue([
      { targetType: 'everyone', targetId: 's1', allow: PERMS.MENTION_EVERYONE, deny: 0 },
    ]);

    const result = await resolvePermissions('u1', 's1', 'c1');

    expect(hasPermission(result, PERMS.MENTION_EVERYONE)).toBe(true);
  });

  test('GÜVENLİK: ALLOW, DENY\'i yener — (base & ~deny) | allow', async () => {
    // permissions.ts:118. Kullanıcı düzeyi allow, everyone düzeyi deny'i geçersiz
    // kılar. Bu sıralama yanlış kurulursa kanal kısıtlamaları sessizce delinir.
    mockMembers.findOne.mockResolvedValue({ roles: [] });
    mockChannels.findOverridesByChannel.mockResolvedValue([
      { targetType: 'everyone', targetId: 's1', allow: 0, deny: PERMS.SEND_MESSAGES },
      { targetType: 'user', targetId: 'u1', allow: PERMS.SEND_MESSAGES, deny: 0 },
    ]);

    const result = await resolvePermissions('u1', 's1', 'c1');

    expect(hasPermission(result, PERMS.SEND_MESSAGES)).toBe(true);
  });


  test('GÜVENLİK: canonical __everyone__ channel_permissions DENY gerçekten uygulanır', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: [] });
    mockChannelPermissions.findByChannel.mockResolvedValue([
      { roleId: '__everyone__', allow: 0, deny: PERMS.SEND_MESSAGES },
    ]);

    const result = await resolvePermissions('u1', 's1', 'c1');

    expect(hasPermission(result, PERMS.SEND_MESSAGES)).toBe(false);
  });

  test('GÜVENLİK: member DENY, role ALLOW üzerinde daha yüksek precedence taşır', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: ['r1'] });
    mockRoles.findByIdsInServer.mockResolvedValue([
      { _id: 'r1', serverId: 's1', permissions: DEFAULT_PERMISSIONS },
    ]);
    mockChannels.findOverridesByChannel.mockResolvedValue([
      { targetType: 'user', targetId: 'u1', allow: 0, deny: PERMS.SEND_MESSAGES },
    ]);
    mockChannelPermissions.findByChannel.mockResolvedValue([
      { roleId: 'r1', allow: PERMS.SEND_MESSAGES, deny: 0 },
    ]);

    const result = await resolvePermissions('u1', 's1', 'c1');

    expect(hasPermission(result, PERMS.SEND_MESSAGES)).toBe(false);
  });

  test('member ALLOW, role DENY üzerinde daha yüksek precedence taşır', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: ['r1'] });
    mockRoles.findByIdsInServer.mockResolvedValue([
      { _id: 'r1', serverId: 's1', permissions: DEFAULT_PERMISSIONS },
    ]);
    mockChannels.findOverridesByChannel.mockResolvedValue([
      { targetType: 'user', targetId: 'u1', allow: PERMS.SEND_MESSAGES, deny: 0 },
    ]);
    mockChannelPermissions.findByChannel.mockResolvedValue([
      { roleId: 'r1', allow: 0, deny: PERMS.SEND_MESSAGES },
    ]);

    const result = await resolvePermissions('u1', 's1', 'c1');

    expect(hasPermission(result, PERMS.SEND_MESSAGES)).toBe(true);
  });

  test('role ALLOW, everyone DENY üzerinde daha yüksek precedence taşır', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: ['r1'] });
    mockRoles.findByIdsInServer.mockResolvedValue([
      { _id: 'r1', serverId: 's1', permissions: DEFAULT_PERMISSIONS },
    ]);
    mockChannelPermissions.findByChannel.mockResolvedValue([
      { roleId: '__everyone__', allow: 0, deny: PERMS.SEND_MESSAGES },
      { roleId: 'r1', allow: PERMS.SEND_MESSAGES, deny: 0 },
    ]);

    const result = await resolvePermissions('u1', 's1', 'c1');

    expect(hasPermission(result, PERMS.SEND_MESSAGES)).toBe(true);
  });

  test('GÜVENLİK: channel_permissions okuma hatası DENY satırlarını yok sayıp fail-open olmaz', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: [] });
    mockChannelPermissions.findByChannel.mockRejectedValue(new Error('permission store unavailable'));

    await expect(resolvePermissions('u1', 's1', 'c1')).rejects.toThrow('permission store unavailable');
  });

  test('yalnız kullanıcının SAHİP OLDUĞU rollerin override\'ları uygulanır', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: ['r1'] });
    mockRoles.findByIdsInServer.mockResolvedValue([
      { _id: 'r1', serverId: 's1', permissions: DEFAULT_PERMISSIONS },
    ]);
    mockChannels.findOverridesByChannel.mockResolvedValue([
      { targetType: 'role', targetId: 'r1',      allow: PERMS.MANAGE_MESSAGES, deny: 0, position: 1 },
      { targetType: 'role', targetId: 'baska-r', allow: PERMS.BAN_MEMBERS,     deny: 0, position: 2 },
    ]);

    const result = await resolvePermissions('u1', 's1', 'c1');

    expect(hasPermission(result, PERMS.MANAGE_MESSAGES)).toBe(true);
    // Kullanıcıya ait olmayan rolün override'ı SIZMAMALIDIR.
    expect(hasPermission(result, PERMS.BAN_MEMBERS)).toBe(false);
  });

  test('açıklama AYNI kanonik sonuçtan kanal reddini güvenli metne dönüştürür', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: ['developer'] });
    mockRoles.findByIdsInServer.mockResolvedValue([
      { _id: 'developer', serverId: 's1', name: 'Developer', permissions: DEFAULT_PERMISSIONS },
    ]);
    mockChannelPermissions.findByChannel.mockResolvedValue([
      { roleId: 'developer', allow: 0, deny: PERMS.SEND_MESSAGES },
    ]);

    const resolution = await resolvePermissionResolution('u1', 's1', 'c1');
    const explanation = explainResolvedPermission(
      resolution,
      PERMS.SEND_MESSAGES,
      'Bu kanala mesaj gönderme yetkiniz yok.',
    );

    expect(hasPermission(resolution.permissions, PERMS.SEND_MESSAGES)).toBe(false);
    expect(explanation).toMatchObject({
      allowed: false,
      effective: 'denied',
      reasonCode: 'CHANNEL_OVERRIDE_DENY',
      base: { state: 'allowed', sources: ['Rol: Developer'] },
      overrides: [{ scope: 'role', label: 'Developer', state: 'denied' }],
    });
    expect(explanation.message).toMatch(/mesaj gönderme yetkiniz yok/i);
    expect(JSON.stringify(explanation)).not.toMatch(/"allow"|"deny"|1073741824/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// canActOn — GERÇEK rol hiyerarşisi (permissions.ts:121)
// ════════════════════════════════════════════════════════════════════════════
//
// FAZ 12 — canActOn COVERAGE GAP KAPATMA.
// Bu fonksiyon moderasyon eylemlerinin (kick/ban/timeout) yetki kapısıdır ve
// üretimde CANLI olmasına rağmen hiçbir testte gerçek olarak çalıştırılmıyordu:
// `moderation.test.ts:27` onu `async () => true` ile MOCK'luyor, bu dosyanın
// başlığı da kapsam dışı bıraktığını kaydediyordu. Artık gerçek uygulama
// çalıştırılır; yalnız depo (DB) sınırı mock'lanır.
describe('canActOn — gerçek rol hiyerarşisi', () => {
  const SERVER = 's1';

  /** Rol konumlarını verilen kimliklere göre çözer. */
  function withRoles(map: Record<string, number>): void {
    mockRoles.findWhere.mockImplementation(async (q: { _id?: { $in?: string[] } }) => {
      const ids = q?._id?.$in ?? [];
      return ids.map((id: string) => ({ _id: id, serverId: SERVER, position: map[id] ?? 0 }));
    });
  }

  test('sunucu yoksa false (fail-closed)', async () => {
    mockServers.findById.mockResolvedValue(null);

    expect(await canActOn('actor', 'target', SERVER)).toBe(false);
  });

  test('GÜVENLİK: sunucu sahibi herkese işlem yapabilir', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });

    expect(await canActOn('owner', 'anyone', SERVER)).toBe(true);
  });

  test('GÜVENLİK: sunucu sahibi HEDEF olamaz (sahip koruması)', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });

    // Sahip olmayan bir yönetici bile sahibi hedefleyemez.
    expect(await canActOn('admin', 'owner', SERVER)).toBe(false);
  });

  test('GÜVENLİK: üye olmayan AKTÖR işlem yapamaz', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });
    mockMembers.findOne.mockImplementation(async (uid: string) =>
      (uid === 'target' ? { roles: [] } : null));

    expect(await canActOn('outsider', 'target', SERVER)).toBe(false);
  });

  test('GÜVENLİK: üye olmayan HEDEF işleme konu olamaz', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });
    mockMembers.findOne.mockImplementation(async (uid: string) =>
      (uid === 'actor' ? { roles: [] } : null));

    expect(await canActOn('actor', 'outsider', SERVER)).toBe(false);
  });

  test('daha YÜKSEK rolü olan aktör işlem yapabilir', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });
    mockMembers.findOne.mockImplementation(async (uid: string) =>
      (uid === 'actor' ? { roles: ['r-high'] } : { roles: ['r-low'] }));
    withRoles({ 'r-high': 10, 'r-low': 3 });

    expect(await canActOn('actor', 'target', SERVER)).toBe(true);
  });

  test('GÜVENLİK: daha DÜŞÜK rolü olan aktör işlem yapamaz', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });
    mockMembers.findOne.mockImplementation(async (uid: string) =>
      (uid === 'actor' ? { roles: ['r-low'] } : { roles: ['r-high'] }));
    withRoles({ 'r-high': 10, 'r-low': 3 });

    expect(await canActOn('actor', 'target', SERVER)).toBe(false);
  });

  test('GÜVENLİK: EŞİT rol konumunda işlem yapılamaz (kesin büyüklük gerekir)', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });
    mockMembers.findOne.mockResolvedValue({ roles: ['r-same'] });
    withRoles({ 'r-same': 5 });

    expect(await canActOn('actor', 'target', SERVER)).toBe(false);
  });

  test('GÜVENLİK: kendine işlem yapılamaz (aynı hiyerarşi)', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });
    mockMembers.findOne.mockResolvedValue({ roles: ['r-x'] });
    withRoles({ 'r-x': 7 });

    expect(await canActOn('same-user', 'same-user', SERVER)).toBe(false);
  });

  test('rolsüz üyeler 0 konumundadır — rolsüz rolsüzü etkileyemez', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });
    mockMembers.findOne.mockResolvedValue({ roles: [] });

    expect(await canActOn('actor', 'target', SERVER)).toBe(false);
  });

  test('rolsüz hedefe karşı rollü aktör işlem yapabilir', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });
    mockMembers.findOne.mockImplementation(async (uid: string) =>
      (uid === 'actor' ? { roles: ['r-mod'] } : { roles: [] }));
    withRoles({ 'r-mod': 4 });

    expect(await canActOn('actor', 'target', SERVER)).toBe(true);
  });

  test('legacy JSON-string rol listeleri de aynı hiyerarşiyle değerlendirilir', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });
    mockMembers.findOne.mockImplementation(async (uid: string) =>
      (uid === 'actor' ? { roles: JSON.stringify(['r-high']) } : { roles: JSON.stringify(['r-low']) }));
    withRoles({ 'r-high': 10, 'r-low': 3 });

    expect(await canActOn('actor', 'target', SERVER)).toBe(true);
  });

  test('birden fazla rolde EN YÜKSEK konum belirleyicidir', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });
    mockMembers.findOne.mockImplementation(async (uid: string) =>
      (uid === 'actor' ? { roles: ['r-a', 'r-b'] } : { roles: ['r-c'] }));
    withRoles({ 'r-a': 2, 'r-b': 9, 'r-c': 5 });   // aktörün en yükseği 9 > 5

    expect(await canActOn('actor', 'target', SERVER)).toBe(true);
  });

  test('rol sorgusu sunucu kapsamıyla yapılır', async () => {
    mockServers.findById.mockResolvedValue({ _id: SERVER, ownerId: 'owner' });
    mockMembers.findOne.mockResolvedValue({ roles: ['r-1'] });
    withRoles({ 'r-1': 1 });

    await canActOn('actor', 'target', SERVER);

    expect(mockRoles.findWhere).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: SERVER }),
    );
  });
});
