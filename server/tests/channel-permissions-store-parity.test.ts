// server/tests/channel-permissions-store-parity.test.ts
// FAZ J — İKİ AYRI İZİN DEPOSU ARASINDAKİ KOPUKLUK.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR (yalnızca GERÇEK dağıtım çalıştırılınca ortaya çıktı)
// ════════════════════════════════════════════════════════════════════════════
// Ürünün izin YAZMA ucu:
//     PUT /api/servers/:sid/channels/:cid/permissions/:roleId
// kayıtları `channel_permissions` tablosuna yazar.
//
// Yetkilendirme çözümleyicisi `resolvePermissions` ise YALNIZCA
// `channel_overrides` tablosunu okuyordu.
//
// İki tablo tamamen ayrıdır. Sonuç: ürünün KENDİ izin arayüzü/ucu ile yapılan
// TÜM kanal kısıtlamaları yetkilendirmede HİÇ dikkate alınmıyordu. Yöneticinin
// "özel" sandığı bir kanal, sunucunun HER üyesi tarafından okunabiliyordu —
// mesajlar, sabitlenmişler ve AI özeti dâhil.
//
// NEDEN HİÇBİR TEST YAKALAMADI:
// Mevcut tüm görünürlük testleri fikstürü DOĞRUDAN `channel_overrides`e
// (çözümleyicinin okuduğu tabloya) yazıyordu. Yani hepsi çözümleyiciyi doğru
// ölçüyordu ama ÜRÜN YOLUNU hiç çalıştırmıyordu. Bu paket tam da o boşluğu
// kapatır: fikstür `channel_permissions`e — ürünün gerçekten yazdığı yere —
// yazılır.

process.env.NODE_ENV = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));

import { resolvePermissions, canViewChannel } from '../lib/permissions';

const VIEW_CHANNELS = 1 << 0;

const OWNER  = 'sahip-P';
const MEMBER = 'uye-P';
const SRV    = 'srv-P2';
const PUBLIC_CH  = 'pch-acik';
const PRIVATE_CH = 'pch-gizli';

beforeEach(async () => {
  for (const c of ['users','servers','members','channels','channelOverrides','channelPermissions','roles']) {
    // Koleksiyonlar `MockDb` uzerinde ADLARIYLA bildirili; dizge indeksleme
    // yerine anahtar tipi kullanilir — cast gerekmez.
    const col = mockDb[c as keyof typeof mockDb];
    if (col && typeof col === 'object' && 'remove' in col && typeof col.remove === 'function') {
      await col.remove({});
    }
  }
  await mockDb.users.insert({ _id: OWNER,  username: OWNER,  displayName: 'Sahip' });
  await mockDb.users.insert({ _id: MEMBER, username: MEMBER, displayName: 'Uye' });
  await mockDb.servers.insert({ _id: SRV, name: 'P2', ownerId: OWNER, createdAt: 1 });
  await mockDb.members.insert({ userId: MEMBER, serverId: SRV, roles: [], joinedAt: 1 });
  await mockDb.channels.insert({ _id: PUBLIC_CH,  serverId: SRV, name: 'genel', type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: PRIVATE_CH, serverId: SRV, name: 'gizli', type: 'text', createdAt: 1 });
});

describe('kanal izinleri — ürünün yazdığı depo ÇÖZÜMLEYİCİDE de geçerlidir', () => {
  it('POZİTİF KONTROL: kısıtlama yokken üye kanalı GÖREBİLİR', async () => {
    // Bu kontrol olmadan aşağıdaki red testi, çözümleyici her şeyi reddetse
    // de geçerdi.
    await expect(canViewChannel(MEMBER, SRV, PUBLIC_CH)).resolves.toBe(true);
  });

  it('channel_permissions üzerinden @everyone REDDİ UYGULANIR (asıl kusur)', async () => {
    // Ürün ucu tam olarak bunu yazar: roleId === serverId → @everyone.
    await mockDb.channelPermissions.insert({
      _id: 'cp-1', channelId: PRIVATE_CH, roleId: SRV, serverId: SRV,
      allow: 0, deny: VIEW_CHANNELS, createdAt: 1,
    });

    await expect(canViewChannel(MEMBER, SRV, PRIVATE_CH)).resolves.toBe(false);
  });

  it('kısıtlama YALNIZ ilgili kanalı etkiler', async () => {
    await mockDb.channelPermissions.insert({
      _id: 'cp-2', channelId: PRIVATE_CH, roleId: SRV, serverId: SRV,
      allow: 0, deny: VIEW_CHANNELS, createdAt: 1,
    });

    await expect(canViewChannel(MEMBER, SRV, PRIVATE_CH)).resolves.toBe(false);
    await expect(canViewChannel(MEMBER, SRV, PUBLIC_CH)).resolves.toBe(true);
  });

  it('SUNUCU SAHİBİ kısıtlamadan etkilenmez', async () => {
    await mockDb.channelPermissions.insert({
      _id: 'cp-3', channelId: PRIVATE_CH, roleId: SRV, serverId: SRV,
      allow: 0, deny: VIEW_CHANNELS, createdAt: 1,
    });

    await expect(canViewChannel(OWNER, SRV, PRIVATE_CH)).resolves.toBe(true);
  });

  it('ROL bazlı redde yalnız o role sahip üye takılır', async () => {
    await mockDb.roles.insert({ _id: 'rol-1', serverId: SRV, name: 'kisitli', permissions: 0, position: 1 });
    await mockDb.members.remove({ userId: MEMBER, serverId: SRV });
    await mockDb.members.insert({ userId: MEMBER, serverId: SRV, roles: ['rol-1'], joinedAt: 1 });
    await mockDb.channelPermissions.insert({
      _id: 'cp-4', channelId: PRIVATE_CH, roleId: 'rol-1', serverId: SRV,
      allow: 0, deny: VIEW_CHANNELS, createdAt: 1,
    });

    await expect(canViewChannel(MEMBER, SRV, PRIVATE_CH)).resolves.toBe(false);
  });

  it('ESKİ channel_overrides yolu BOZULMADAN çalışmaya devam eder', async () => {
    // Geriye dönük uyumluluk: iki depo da onurlandırılır.
    await mockDb.channelOverrides.insert({
      _id: 'ovr-1', channelId: PRIVATE_CH, targetType: 'everyone', targetId: SRV,
      allow: 0, deny: VIEW_CHANNELS, position: 0,
    });

    await expect(canViewChannel(MEMBER, SRV, PRIVATE_CH)).resolves.toBe(false);
  });

  it('allow biti reddi geri açabilir (öncelik sırası korunur)', async () => {
    await mockDb.channelPermissions.insert({
      _id: 'cp-5', channelId: PRIVATE_CH, roleId: SRV, serverId: SRV,
      allow: VIEW_CHANNELS, deny: 0, createdAt: 1,
    });

    const perms = await resolvePermissions(MEMBER, SRV, PRIVATE_CH);
    expect((perms & VIEW_CHANNELS) !== 0).toBe(true);
  });
});
