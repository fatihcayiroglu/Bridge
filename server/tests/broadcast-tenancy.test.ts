// server/tests/broadcast-tenancy.test.ts
//
// YAYIN KAYNAĞI VE KİRACI SINIRI
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK (CANLI SUNUCUDA SÖMÜRÜLDÜ)
// ════════════════════════════════════════════════════════════════════════════
// `socket/handlers/infra.ts` altı olayı istemciden alıp DOĞRUDAN yeniden
// yayınlıyordu:
//
//     socket.on('channel:deleted', ({ serverId, channelId }) =>
//       io.to(`server:${serverId}`).emit('channel:deleted', { channelId }));
//
// Yetki YOK, üyelik YOK, şema doğrulaması YOK; hedef `serverId` ve içerik
// tamamen istemci kontrolündeydi.
//
// CANLI SÖMÜRÜ (e2e/_relay-spoof.cjs): üyesi OLMAYAN bir kullanıcı, kurban
// sunucusundaki gerçek kanalı tüm üyelerin arayüzünden sildirdi, adını
// değiştirdi ve sahte kanal/kategori enjekte etti.
//
// ── İKİ AYRI DÜZELTME ─────────────────────────────────────────────────────
// 1. Röleler KALDIRILDI. Ölçüldü (e2e/_relay-legit.cjs): gerçek kanal
//    işlemleri bu olayları zaten hiç üretmiyordu; röle meşru üreticisi
//    olmayan saf saldırı yüzeyiydi.
// 2. Yayın, YETKİLİ REST rotasına taşındı (routes/servers/channels.ts) —
//    yani MANAGE_CHANNELS denetimini zaten geçmiş olan koda.
//
// Kanal CRUD'unun ikinci bir production owner'ı yoktur
// durur ama `routes/servers/index.ts` daha önce mount edildiği için GÖLGEDE
// kalır. Yayın bilinçli olarak CANLI yola bağlanmıştır.

import fs from 'fs';
import path from 'path';

const SRV = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SRV, p), 'utf8');

/**
 * Yorumlari soyar.
 *
 * Bu testler KAYNAK SOZLESMESINI denetler; aciklama amacli alintilanan
 * savunmasiz kod ornekleri GERCEK kayit sayilmamalidir. (Ilk surumde tam
 * olarak bu oldu: kaldirilan dinleyici, kendi gerekce yorumunda alintilandigi
 * icin "hala kayitli" gorundu.)
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

describe('istemci-yüzlü yayın röleleri KALDIRILDI', () => {
  const infra = codeOnly(read('socket/handlers/infra.ts'));

  // Bu olaylar istemciden ASLA kabul edilmemeli.
  const FORBIDDEN = [
    'channel:created', 'channel:deleted', 'channel:updated',
    'category:created', 'category:updated', 'category:deleted',
    'poll:created',
  ];

  it.each(FORBIDDEN)('socket.on(%s) ARTIK KAYITLI DEĞİL', (event) => {
    // Kaynak sözleşmesi: bu dinleyicilerden herhangi biri geri gelirse
    // çapraz kiracı enjeksiyonu da geri gelir.
    expect(infra).not.toContain(`socket.on('${event}'`);
  });

  it('kaldırma gerekçesi kodda YAZILI', () => {
    // Gerekçesiz bir silme, bir sonraki gelistirici tarafindan "eksik
    // ozellik" sanilip geri eklenebilir. Bu kontrol HAM kaynaga bakar.
    expect(read('socket/handlers/infra.ts'))
      .toMatch(/KAPATILAN GERCEK ACIK|CANLI SUNUCUDA DOGRULANDI/);
  });
});

describe('kanal CRUD SUNUCU GENELİNE yayın YAPMAZ (yeni politika)', () => {
  const live = read('routes/servers/channels.ts');

  // ── BU BLOK NEDEN DEĞİŞTİ ────────────────────────────────────────────────
  // Eskiden burada `broadcastToServer(sid, 'channel:created' …)` çağrılarının
  // KAYNAKTA BULUNMASI iddia ediliyordu. O yardımcı ARTIK HİÇ YOK — kaynak
  // ağacının tamamında tek bir atıf kalmadı — çünkü sunucu geneline kanal
  // metadata yayını BİLEREK KALDIRILDI:
  //
  //   routes/servers/channels.ts:118
  //   "Channel metadata is intentionally NOT broadcast to the whole
  //    `server:<id>` room. Private-channel visibility is requester/channel
  //    scoped; canonical clients reload the authorized channel list."
  //
  // Yani eski iddialar, GÜVENLİK GEREKÇESİYLE kaldırılmış bir davranışın geri
  // gelmesini talep ediyordu. Sunucu odasına yayın yapmak, ÖZEL bir kanalın
  // adını/varlığını onu göremeyen üyelere sızdırırdı.
  //
  // Bu blok artık YENİ politikayı kilitler: yayın geri eklenirse test düşer.

  it('server:<id> odasına kanal olayı yayınlanmaz', () => {
    expect(live).not.toMatch(/io\s*\.\s*to\(\s*[`'"]server:/);
    expect(live).not.toContain('broadcastToServer');
  });

  it('kaldırma GEREKÇESİ kodda YAZILI', () => {
    // Gerekçesiz bir kaldırma, bir sonraki geliştirici tarafından "eksik
    // özellik" sanılıp geri eklenebilir.
    expect(live).toMatch(/intentionally NOT broadcast|requester\/channel\s*scoped/i);
  });

  it('yayın hedefi İSTEMCİDEN türetilmez', () => {
    // Politika ileride kanal-kapsamlı yayınla geri gelirse bile hedef
    // istemcinin bildirdiği bir değerden ALINMAMALIDIR.
    expect(live).not.toMatch(/\.to\(\s*req\.body/);
    expect(live).not.toMatch(/\.to\(\s*payload/);
  });

  it('MANAGE_CHANNELS denetimi kanal oluşturmada HÂLÂ var', () => {
    // Yayın iddiaları kaldırıldı; YETKİ iddiası kaldırılmadı — asıl güvence bu.
    const createStart = live.indexOf("router.post('/'");
    const createEnd = live.indexOf('router.patch(', createStart);
    expect(createStart).toBeGreaterThan(-1);
    expect(live.slice(createStart, createEnd)).toContain('MANAGE_CHANNELS');
  });
});

describe('üyelik önbelleği — davet yolu', () => {
  const invites = read('routes/servers/invites.ts');
  const core = read('routes/servers/core.ts');
  const membershipOwner = read('lib/serverMembership.ts');

  it('davet kullanımı ÜYELİK önbelleğini geçersiz kılar', () => {
    // ── KAPATILAN GERCEK KUSUR ───────────────────────────────────────────
    // Soket, baglanirken sunucu odalarina `presence:memberships:*`
    // onbelleginden bakarak katilir (TTL 300 sn). Davet yolu yalnizca UYE
    // SAYISI onbellegini temizliyordu; UYELIK LISTESINI degil.
    //
    // Sonuc: davet baglantisiyla katilan kullanici — sunucuya katilmanin
    // ASIL yolu — 5 dakikaya kadar yeni sunucunun soket odasina hic
    // girmiyor ve sunucu duzeyindeki canli olaylarin hicbirini almiyordu.
    // Yeniden baglanmak da cozmuyordu, cunku bayat onbellek okunuyordu.
    expect(invites).toContain('afterMemberJoined');
    expect(membershipOwner).toContain('invalidateMemberships');
  });

  it('DOĞRUDAN katılma yolu da geçersiz kılar (kardeş yol korunuyor)', () => {
    // Bu kusurun sinifi "bir yolda duzeltilmis, kardesinde unutulmus"tu.
    // Iki yol da birlikte korunur.
    expect(core).toContain('invalidateMemberships');
  });

  it('geçersiz kılma, üyelik EKLENDİKTEN sonra çağrılır', () => {
    const idx = invites.indexOf('Members.insert');
    const inv = invites.indexOf('afterMemberJoined', idx);
    expect(idx).toBeGreaterThan(-1);
    expect(inv).toBeGreaterThan(idx);
  });
});
