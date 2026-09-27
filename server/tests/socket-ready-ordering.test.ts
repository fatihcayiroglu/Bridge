// server/tests/socket-ready-ordering.test.ts
//
// HAZIR SİNYALİ SIRALAMA SÖZLEŞMESİ + ODA TABANLI TESLİMAT
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR (iki yarım, tek ölçüm):
//
// 1) `socket.emit('userAuthenticated')` — istemcinin "artık olay alabilirim"
//    olarak yorumladığı sinyal — kişisel `user:<id>` odasına KATILMADAN ÖNCE
//    yayılıyordu. Arada iki `await` vardı (durum güncelleme + üyelik kurulumu,
//    ikisi de DB'ye gider), yani pencere gerçekti ve yük altında genişliyordu.
//
// 2) `dm.ts` teslimatı süreç-yerel `socketUsers` haritasından soket kimliği
//    toplayıp `io.to(sid)` ile yayın yapıyordu. Diğer örneğe bağlı kullanıcı o
//    haritada YOKTUR.
//
// SONUÇ: DM'ler, gelen aramalar ve kapanma bildirimleri SESSİZCE KAYBOLUYORDU.
// İki örnekli ölçümde (A:3000 / B:3010, ortak Redis) B'den yayılan
// `dm:call:incoming`, A'daki istemci sinyali alır almaz arama başlattığında
// hiç ulaşmıyordu.
//
// ── BU TEST NEDEN KAYNAK OKUYOR ──────────────────────────────────────────
// Değişmez olan şey İFADELERİN SIRASI ve TESLİMAT BİÇİMİ. Çalışma zamanında
// kanıtlamak tüm `setupSocket` ağacını (mediasoup, Redis adapter, IP ban)
// ayağa kaldırmayı gerektirir; test ağır ve kırılgan olurdu. Davranışsal
// kanıt başka yerde ZATEN var:
//   · e2e/multi-instance-check.mjs → R-1 (iki gerçek örnek, ortak Redis)
//   · e2e/tests/dm-call.spec.ts    → tam el sıkışma
// Buradaki ucuz koruma, o pahalı kanıtın sessizce geri alınmasını önler.

'use strict';

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'socket', 'index.ts'), 'utf8');
const DM  = readFileSync(join(__dirname, '..', 'socket', 'handlers', 'dm.ts'), 'utf8');

/** Yalnızca ÇALIŞAN kodda arar; yorum satırlarını atlar. */
function executableLines(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

function indexOfStatement(needle: string): number {
  const lines = SRC.split('\n');
  let offset = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('//') && !t.startsWith('*') && line.includes(needle)) return offset;
    offset += line.length + 1;
  }
  return -1;
}

describe('bağlantı kurulumu — hazır sinyali sıralaması', () => {
  const joinAt  = indexOfStatement('socket.join(`user:${user._id}`)');
  const readyAt = indexOfStatement("socket.emit('userAuthenticated'");

  it('her iki ifade de bağlantı kurulumunda mevcut', () => {
    expect(joinAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(-1);
  });

  it('kişisel oda, hazır sinyalinden ÖNCE katılınır', () => {
    // Ters sıra ALMAYI bozar: istemci "hazırım" der, sunucu ona hiçbir
    // DM/arama olayı TESLİM EDEMEZ.
    expect(joinAt).toBeLessThan(readyAt);
  });

  it('özellik dinleyicileri, hazır sinyalinden ÖNCE kaydedilir', () => {
    // Ters sıra GÖNDERMEYİ bozar — ve bu daha sinsidir: Socket.IO,
    // dinleyicisi olmayan olayı SESSİZCE ATAR. Hata yok, log yok, istemciye
    // geri bildirim yok. Ölçümde her soketin YAYDIĞI İLK OLAY düşüyordu:
    // `dm:call:start` arayana `dm:call:outgoing` bile döndürmüyordu.
    //
    // Son kaydedilen handler'ı çıpa alırız; bundan sonrası hazır demektir.
    const lastHandlerAt = indexOfStatement('registerInfraHandlers(');
    expect(lastHandlerAt).toBeGreaterThan(-1);
    expect(lastHandlerAt).toBeLessThan(readyAt);
  });

  it('hazır sinyali TEK kez yayılır', () => {
    // İki yayın olursa biri eski (erken) konumdan kalmış demektir ve kusur
    // sessizce geri gelir.
    const emits = executableLines(SRC).match(/socket\.emit\('userAuthenticated'/g) ?? [];
    expect(emits).toHaveLength(1);
  });
});

describe('DM teslimatı — süreç-yerel soket hedefleme geri gelmemeli', () => {
  it('kaldırılan süreç-yerel yardımcı geri eklenmemiş', () => {
    expect(DM).not.toMatch(/function findSocketsForUser/);
  });

  it('oda tabanlı yayıcı mevcut', () => {
    expect(DM).toMatch(/io\.to\(`user:\$\{userId\}`\)\.emit\(/);
  });

  it('hiçbir yayın soket kimliği listesi üzerinden yapılmıyor', () => {
    // `io.to(sid)` biçimindeki her çağrı, süreç-yerel hedeflemenin izidir.
    expect(executableLines(DM)).not.toMatch(/io\.to\(sid\)/);
  });
});
