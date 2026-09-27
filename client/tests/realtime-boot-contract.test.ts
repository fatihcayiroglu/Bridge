// client/tests/realtime-boot-contract.test.ts
//
// GERÇEK ZAMANLI ÖNYÜKLEME SÖZLEŞMESİ
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR (P0) — SOKET HİÇ BAĞLANMIYORDU
// ════════════════════════════════════════════════════════════════════════════
// `js/app.ts` içinde şu satır vardı:
//
//     import { socket } from './core/socket-svelte.ts';
//
// `socket` bu dosyada HİÇBİR YERDE kullanılmıyordu. TypeScript'in "import
// elision" kuralı, bir import deyiminin TÜM bağlantıları kullanılmıyorsa
// (tip-only olabileceği için) DEYİMİN TAMAMINI siler; esbuild de bunu uygular.
//
// Sonuç: `socket-svelte.ts` derlemeye HİÇ girmedi. Kendini mount eden yan
// etkisi çalışmadı, `SocketManager` hiç kurulmadı ve `io()` HİÇ çağrılmadı.
//
// ÖLÇÜLEN ETKİ (yayın derlemesi, Playwright):
//   · `page.on('websocket')` → SIFIR olay
//   · `/socket.io/?EIO=4` isteği → SIFIR
//   · gönderilen mesaj `data-delivery-state="queued"` durumunda 8 sn+ ASILI
//   · ACK gelmediği için hiçbir mesaj gerçekten gönderilmedi
//
// Yani teslimat, varlık, "yazıyor", ses sinyalleşmesi — gerçek zamanlı HER ŞEY
// sessizce ölüydü. Hiçbir test bunu yakalamıyordu, çünkü testler mesajı ya
// doğrudan soketten (Node tarafı) yolluyor ya da yalnızca iyimser BALONUN
// çizildiğini doğruluyordu; balon kuyruktayken de çizilir.
//
// ── BU PAKETİN KİLİTLEDİĞİ SÖZLEŞME ───────────────────────────────────────
// Yan etkisi için alınan modül YAN ETKİ IMPORT'U ile alınır. Böylece elision
// mümkün değildir.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const CLIENT = join(__dirname, '..');
const APP = readFileSync(join(CLIENT, 'js', 'app.ts'), 'utf8');

describe('soket önyüklemesi derlemeye GİRER', () => {
  it('`socket-svelte` YAN ETKİ import\'u ile alınır', () => {
    // Yan etki import'u elision'a uğramaz.
    expect(APP).toMatch(/^import '\.\/core\/socket-svelte\.ts';$/m);
  });

  it('kullanılmayan ADLI import geri getirilmemiştir', () => {
    // Asıl kusur buydu: `{ socket }` alınıp hiç kullanılmıyordu.
    const named = APP.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/core\/socket-svelte\.ts'/);
    if (!named) return;                       // adlı import yok — istenen durum
    for (const binding of named[1].split(',').map(s => s.trim()).filter(Boolean)) {
      // Adlı import KALACAKSA gerçekten KULLANILMALIDIR.
      const uses = APP.split(new RegExp(`\\b${binding}\\b`)).length - 1;
      expect(uses, `'${binding}' alınıyor ama kullanılmıyor → elision riski`)
        .toBeGreaterThan(1);
    }
  });

  it('soket modülü kendini mount eder — çağıran beklenmez', () => {
    const shim = readFileSync(join(CLIENT, 'js', 'core', 'socket-svelte.ts'), 'utf8');
    expect(shim).toMatch(/mountSocketManager\(\)/);
    expect(shim).toMatch(/DOMContentLoaded/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('boş sunucu ekranı AĞ HATASINDA duvar örmez', () => {
  const ESS = readFileSync(join(CLIENT, 'js', 'core', 'EmptyServerStart.svelte'), 'utf8');
  // Yorum satirlari CIKARILIR: aciklama metni ("...`isVisible = true` vardi")
  // aksi halde korumanin kendisini tetikler.
  const stripComments = (src: string) => src
    .split(/\r?\n/)
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const catchBlock = stripComments(
    ESS.slice(ESS.indexOf('} catch (error) {'), ESS.indexOf('} finally {')),
  );

  // KAPATILAN GERÇEK KUSUR (P1): catch bloğunda `isVisible = true` vardı.
  // `/api/servers` HERHANGİ bir sebeple başarısız olursa (uyku/uyanma, wifi
  // geçişi, anlık 5xx) kullanıcı — SUNUCULARI VARKEN — tıklamaları yutan tam
  // ekran "ilk sunucunu oluştur" duvarının arkasında kalıyordu.
  //
  // ÖLÇÜM: 1.5 sn çevrimdışı aralıktan sonra `.empty-server-backdrop`
  // sunucu rayını örttü (`document.elementFromPoint` ile doğrulandı).

  it('catch bloğu ekranı AÇMAZ', () => {
    expect(catchBlock).not.toMatch(/isVisible\s*=\s*true/);
  });

  it('ekran YALNIZCA gerçekten sıfır sunucu varken açılır', () => {
    // Tek meşru kaynak: başarılı yanıtın uzunluğu.
    expect(ESS).toMatch(/const empty = Array\.isArray\(servers\) && servers\.length === 0;/);
    // Final21 Faz 19: kendiliğinden açılış, açık bir pencere varken ERTELENİR ama karar yine
    // yalnızca `empty`dir (davranış: tests/EmptyServerStart.test.ts).
    expect(ESS).toMatch(/isVisible = empty;/);
  });

  it('geçici hata sonrası SINIRLI yeniden deneme vardır', () => {
    // Aksi halde gerçekten sunucusuz yeni kullanıcı karşılama ekranını
    // tamamen kaybederdi (`refreshEmptyState` yalnızca mount'ta çağrılıyor).
    expect(ESS).toMatch(/scheduleRetry\(\)/);
    expect(ESS).toMatch(/retriesLeft/);
  });

  it('yeniden deneme SONSUZ DÖNGÜ değildir', () => {
    expect(ESS).toMatch(/retriesLeft <= 0/);
    expect(ESS).toMatch(/retriesLeft -= 1/);
  });

  it('ağ geri geldiğinde tekrar bakılır ve dinleyici TEMİZLENİR', () => {
    expect(ESS).toMatch(/addEventListener\('online', onBackOnline\)/);
    expect(ESS).toMatch(/removeEventListener\('online', onBackOnline\)/);
  });
});
