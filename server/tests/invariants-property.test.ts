// server/tests/invariants-property.test.ts
//
// BİÇİMSEL DEĞİŞMEZLER — ÜRETİLMİŞ DURUM ÜZERİNDE GERÇEK ÜRETİM MANTIĞI
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR
// ════════════════════════════════════════════════════════════════════════════
// Senaryo testleri DÜŞÜNDÜĞÜMÜZ durumları kontrol eder. Değişmez testleri
// DÜŞÜNMEDİĞİMİZ durumları da kapsar: durum üretilir, GERÇEK çözümleyici
// çalıştırılır ve kural her kombinasyonda doğrulanır.
//
// ── KURAL: İKİNCİ BİR UYGULAMA YAZILMAZ ─────────────────────────────────────
// Test içinde izin sisteminin kopyasını yazmak, kopyanın kendisini doğrulardı.
// Bu dosya `lib/permissions.ts` içindeki GERÇEK `canViewChannel`,
// `resolvePermissions`, `validateBitmask` ve `jobs/cleanupUploads.ts`
// içindeki GERÇEK `isReapable` fonksiyonlarını çağırır.
//
// ── TOHUMLU VE TEKRARLANABİLİR ──────────────────────────────────────────────
// Üretim deterministik bir LCG ile yapılır; bir ihlal bulunursa tohum
// yazdırılır ve aynen tekrar üretilebilir.

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import db from '../db/loader';
import { v4 as uuidv4 } from 'uuid';
import { canViewChannel, validateBitmask, hasPermission, PERMS } from '../lib/permissions';
import { isReapable } from '../jobs/cleanupUploads';

// ── Deterministik üreteç ────────────────────────────────────────────────────
let _seed = 0;
function srand(seed: number) { _seed = seed >>> 0; }
function rnd(): number {
  // Sayisal Tarifler LCG — deterministik ve tekrarlanabilir.
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 0x100000000;
}
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const chance = (p: number) => rnd() < p;

const mockDb = db as unknown as {
  users: { insert: (d: unknown) => Promise<unknown> };
  servers: { insert: (d: unknown) => Promise<unknown> };
  channels: { insert: (d: unknown) => Promise<unknown> };
  members: { insert: (d: unknown) => Promise<unknown> };
  _reset?: () => void;
};

// ════════════════════════════════════════════════════════════════════════════
// DEĞİŞMEZ A — YETKİSİZ KAPSAM GÖZLEMLENEMEZ
// ════════════════════════════════════════════════════════════════════════════
describe('DEĞİŞMEZ A: kullanıcı yetkisiz kapsamı göremez', () => {
  it('120 üretilmiş durumun HİÇBİRİNDE üye olmayan kanalı göremez', async () => {
    const ihlaller: object[] = [];

    for (let i = 0; i < 120; i++) {
      srand(1000 + i);
      mockDb._reset?.();

      const sahip   = uuidv4();
      const uye     = uuidv4();
      const yabanci = uuidv4();
      const serverId = uuidv4();
      const channelId = uuidv4();

      await mockDb.users.insert({ _id: sahip, username: 's' + i, tokenVersion: 0 });
      await mockDb.users.insert({ _id: uye, username: 'u' + i, tokenVersion: 0 });
      await mockDb.users.insert({ _id: yabanci, username: 'y' + i, tokenVersion: 0 });
      await mockDb.servers.insert({ _id: serverId, ownerId: sahip, name: 'srv' });
      await mockDb.channels.insert({
        _id: channelId, serverId, name: 'ch', type: pick(['text', 'voice'] as const),
      });
      // ÜYE eklenir; YABANCI KASITLI olarak eklenmez.
      await mockDb.members.insert({
        userId: uye, serverId, joinedAt: Date.now(),
        roles: chance(0.5) ? '[]' : JSON.stringify([uuidv4()]),
      });

      const yabanciGorur = await canViewChannel(yabanci, serverId, channelId);
      if (yabanciGorur) {
        ihlaller.push({ tohum: 1000 + i, aciklama: 'uye olmayan kanali gorebildi' });
      }
    }

    expect({ ihlaller }).toEqual({ ihlaller: [] });
  });

  it('eksik/boş kimlikler ASLA erişim vermez', async () => {
    // Bos dize gibi degerler "her sey" gibi yorumlanmamali.
    const kombinasyonlar: Array<[string, string, string]> = [
      ['', 's', 'c'], ['u', '', 'c'], ['u', 's', ''],
      ['', '', ''], [' ', 's', 'c'],
    ];
    const izinliler: object[] = [];
    for (const [u, s, c] of kombinasyonlar) {
      if (await canViewChannel(u, s, c)) izinliler.push({ u, s, c });
    }
    expect({ izinliler }).toEqual({ izinliler: [] });
  });

  // ── POZİTİF KONTROL ───────────────────────────────────────────────────────
  it('POZİTİF KONTROL: GERÇEK üye kanalı GÖREBİLİR', async () => {
    // Bu olmadan yukaridaki testler "her zaman false don" gibi bozuk bir
    // cozumleyicide de yesil kalirdi — ve urun tamamen erisilemez olurdu.
    mockDb._reset?.();
    const sahip = uuidv4(), serverId = uuidv4(), channelId = uuidv4();
    await mockDb.users.insert({ _id: sahip, username: 'sahip', tokenVersion: 0 });
    await mockDb.servers.insert({ _id: serverId, ownerId: sahip, name: 'srv' });
    await mockDb.channels.insert({ _id: channelId, serverId, name: 'ch', type: 'text' });
    await mockDb.members.insert({ userId: sahip, serverId, joinedAt: Date.now(), roles: '[]' });

    expect(await canViewChannel(sahip, serverId, channelId)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DEĞİŞMEZ B — YETKİ BİTMASKESİ TUTARLILIĞI
// ════════════════════════════════════════════════════════════════════════════
describe('DEĞİŞMEZ B: bitmaske çelişkili yetki üretemez', () => {
  it('AYNI bit hem allow hem deny olamaz — 400 üretilmiş çift', () => {
    srand(4242);
    const ihlaller: object[] = [];
    for (let i = 0; i < 400; i++) {
      const allow = Math.floor(rnd() * 0xffff);
      const deny  = Math.floor(rnd() * 0xffff);
      const r = validateBitmask(allow, deny);
      // Cakisma VARSA kabul EDILMEMELI.
      if ((allow & deny) !== 0 && r.ok) {
        ihlaller.push({ allow, deny, sonuc: 'KABUL EDILDI' });
      }
    }
    expect({ ihlaller }).toEqual({ ihlaller: [] });
  });

  it('GEÇERSİZ bitler reddedilir', () => {
    // Bilinmeyen bit = gelecekte anlam kazanabilecek yetki. Sessizce kabul
    // etmek, bugun anlamsiz olanin yarin ayricalik olmasi demektir.
    const r = validateBitmask(0x80000000, 0);
    expect(r.ok).toBe(false);
  });

  it('negatif / tamsayı olmayan değerler reddedilir', () => {
    expect({
      negatif:  validateBitmask(-1, 0).ok,
      ondalik:  validateBitmask(1.5, 0).ok,
      negDeny:  validateBitmask(0, -1).ok,
    }).toEqual({ negatif: false, ondalik: false, negDeny: false });
  });

  it('POZİTİF KONTROL: çakışmayan geçerli maske KABUL edilir', () => {
    expect(validateBitmask(PERMS.VIEW_CHANNELS, PERMS.MANAGE_CHANNELS).ok).toBe(true);
  });

  it('hasPermission ÜRETİLMİŞ maskelerde tutarlı', () => {
    srand(7);
    const ihlaller: object[] = [];
    const bayraklar = Object.values(PERMS).filter(v => typeof v === 'number') as number[];
    for (let i = 0; i < 300; i++) {
      const bayrak = pick(bayraklar);
      const maske  = chance(0.5) ? bayrak : 0;
      const beklenen = (maske & bayrak) === bayrak && bayrak !== 0;
      if (hasPermission(maske, bayrak) !== beklenen) {
        ihlaller.push({ maske, bayrak, beklenen });
      }
    }
    expect({ ihlaller }).toEqual({ ihlaller: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DEĞİŞMEZ F — DEPOLAMA TEMİZLİĞİ SAHİPLİ KAPSAMDAN ÇIKAMAZ
// ════════════════════════════════════════════════════════════════════════════
describe('DEĞİŞMEZ F: reaper sahipli kapsamdan çıkamaz', () => {
  it('YOL AYIRICI içeren hiçbir anahtar 2000 üretimde reapable değil', () => {
    // `server/uploads/stickers` ASLA silinmemeli. Kural yapisaldir: kok
    // disindaki hicbir anahtar kapsamda degildir.
    srand(999);
    const parcalar = ['stickers', 'avatars', 'banners', 'icons', 'a', 'x1', 'up'];
    const ihlaller: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const derinlik = 1 + Math.floor(rnd() * 3);
      const ayirici  = chance(0.5) ? '/' : '\\';
      const key = Array.from({ length: derinlik }, () => pick(parcalar)).join(ayirici)
        + ayirici + 'dosya' + i + '.png';
      if (isReapable(key)) ihlaller.push(key);
    }
    expect({ ihlaller }).toEqual({ ihlaller: [] });
  });

  it('gizli/dahili önekler 500 üretimde reapable değil', () => {
    srand(31337);
    const ihlaller: string[] = [];
    for (let i = 0; i < 500; i++) {
      const onek = chance(0.5) ? '.' : '_';
      const key = onek + Math.floor(rnd() * 1e9).toString(36) + '.dat';
      if (isReapable(key)) ihlaller.push(key);
    }
    expect({ ihlaller }).toEqual({ ihlaller: [] });
  });

  it('POZİTİF KONTROL: sıradan kök anahtar reapable', () => {
    // Bu olmadan yukaridaki testler "her seye false don" ile de gecerdi —
    // ve temizlik isi tamamen olu olurdu.
    expect({
      basit: isReapable('abc.png'),
      uzun:  isReapable('0123456789abcdef.webp'),
    }).toEqual({ basit: true, uzun: true });
  });
});
