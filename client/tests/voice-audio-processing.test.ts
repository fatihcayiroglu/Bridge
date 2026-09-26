// client/tests/voice-audio-processing.test.ts
//
// SES İŞLEME KISITLARI — YANKI GİDERME BAĞIMSIZDIR VE GERÇEKTEN UYGULANIR
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN İKİ GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Kullanıcı iki kişilik gerçek bir aramada "ses belirgin şekilde yankılı"
// bildirdi. İlk düzeltme (uzak video kutucukları hem `<video>` hem özel
// `<audio>` üzerinden ÇİFT çalıyordu) gerçek bir kusurdu ama yankıyı
// bitirmedi. Kaynağa tekrar bakıldığında iki ayrı kusur daha çıktı:
//
// 1. TEK ANAHTAR ÜÇ İŞLEMCİYİ BİRDEN YÖNETİYORDU
//        echoCancellation: nsEnabled
//        noiseSuppression: nsEnabled
//        autoGainControl:  nsEnabled
//    Yani GÜRÜLTÜ BASTIRMA kapatıldığında YANKI GİDERME de sessizce
//    kapanıyordu. Bunlar farklı işlemcilerdir; yankının gürültüyle ilgisi yok.
//
// 2. AYAR CANLI OTURUMA HİÇ ULAŞMIYORDU
//    Ayarlar → Cihazlar ekranında ayrı bir "Eko giderme" anahtarı var,
//    localStorage'a ve sunucuya yazılıyor. `voice:applyDeviceSettings`
//    isleyicisi ise payload'dan YALNIZCA `micDeviceId` okuyup gerisini
//    atıyordu. Dahası `if (!micId) return;` satırı, kullanıcı belirli bir
//    mikrofon seçmemişse (sistem varsayılanı — en yaygın durum) hiçbir şey
//    uygulanmadan çıkıyordu.
//
// Bu paket kaynağı okur: `webrtc.ts` bir `RTCPeerConnection` ve gerçek
// `getUserMedia` ister; jsdom'da tam kurulumu ayağa kaldırmak testi ağır ve
// kırılgan yapardı. Sınanan şey SÖZLEŞMEDİR ve sözleşme statiktir. Davranışsal
// kanıt insan doğrulamasındadır (docs/VOICE_HUMAN_VERIFICATION.md, V-11).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'js', 'webrtc.ts'), 'utf8');

/**
 * Yalnızca çalışan kod; yorum satırları elenir.
 *
 * Bu şart: kusurların ADI onları açıklayan yorumlarda geçiyor. Yorumları
 * elemezsek test kendi belgelendirmesini kusur sanar.
 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const CODE = stripComments(SRC);

// ════════════════════════════════════════════════════════════════════════════
describe('yankı giderme BAĞIMSIZ bir anahtardır', () => {
  it('üç işlemci TEK bir değişkene bağlanmaz', () => {
    // Kusurun tam imzası: `echoCancellation: nsEnabled`.
    expect(CODE).not.toMatch(/echoCancellation:\s*nsEnabled/);
    expect(CODE).not.toMatch(/noiseSuppression:\s*nsEnabled/);
    expect(CODE).not.toMatch(/autoGainControl:\s*nsEnabled/);
  });

  it('her işlemcinin KENDİ alanı vardır', () => {
    expect(CODE).toMatch(/echoCancellation\s*=\s*true/);
    expect(CODE).toMatch(/noiseSuppression\s*=\s*true/);
    expect(CODE).toMatch(/autoGainControl\s*=\s*true/);
  });

  it('yankı giderme VARSAYILAN OLARAK AÇIKTIR', () => {
    // Hoparlörle konuşan iki kişi için tek koruma budur; varsayılanı
    // kapalı yapmak yankıyı garanti eder.
    expect(CODE).toMatch(/echoCancellation\s*=\s*true/);
  });

  it('depolanan değer yalnızca AÇIK "false" ile kapatır', () => {
    // `=== 'true'` yazılsaydı, anahtar hiç yazılmamışken (ilk kullanım)
    // yankı giderme KAPALI başlardı.
    expect(CODE).toMatch(/bridge:device:echo'\)\s*!==\s*'false'/);
    expect(CODE).toMatch(/bridge:device:noise'\)\s*!==\s*'false'/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kısıtlar TEK kaynaktan üretilir', () => {
  it('`audioProcessingConstraints` vardır', () => {
    expect(CODE).toMatch(/audioProcessingConstraints\(\)\s*:\s*MediaTrackConstraints/);
  });

  it('katılma ve mikrofon değiştirme AYNI üreticiyi kullanır', () => {
    // Önceden iki ayrı yerde elle yazılıyordu ve ikisi de aynı tek-anahtar
    // kusurunu taşıyordu; biri düzeltilip diğeri unutulabilirdi.
    const uses = CODE.match(/audioProcessingConstraints\(\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it('`getUserMedia` çağrılarında elle yazılmış ses kısıtı KALMADI', () => {
    // `echoCancellation: <sabit>` biçimi, üreticiyi atlayan bir yol demektir.
    //
    // TEK MEŞRU İSTİSNA `getDisplayMedia`dır: ekran paylaşımının sesi SİSTEM
    // sesidir — dijital bir kopya, mikrofon değil. Orada yankı gidermek sesi
    // bozar ve akustik bir yol da yoktur. Bu yüzden kontrol yalnızca
    // MİKROFON yolunu kapsar.
    const micPath = CODE.split('getDisplayMedia')[0]
      + CODE.split('});').slice(-1)[0];
    const inlined = micPath.match(/echoCancellation:\s*(true|false|nsEnabled)/g) ?? [];
    expect(inlined).toEqual([]);
  });

  it('ekran paylaşımı sesi AYRI ele alınır (sistem sesi, mikrofon değil)', () => {
    const display = CODE.slice(CODE.indexOf('getDisplayMedia'));
    expect(display.slice(0, 400)).toMatch(/echoCancellation:\s*false/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ayar CANLI oturuma ulaşır', () => {
  it('`setAudioProcessing` vardır', () => {
    expect(CODE).toMatch(/async setAudioProcessing\(/);
  });

  it('isleyici yankı ve gürültü değerlerini OKUR', () => {
    expect(CODE).toMatch(/p\.echoCancellation === 'boolean'/);
    expect(CODE).toMatch(/p\.noiseSuppression === 'boolean'/);
  });

  it('mikrofon SEÇİLMEMİŞKEN de ayar uygulanır', () => {
    // Kusur buradaydı: `if (!micId) return;` sistem varsayılanı kullanan
    // kullanıcıda isleyiciyi bastan çıkarıyordu.
    expect(CODE).not.toMatch(/const micId = String\(p\.micDeviceId \?\? ''\);\s*if \(!micId\) return;/);
    expect(CODE).toMatch(/setAudioProcessing\(processing\)/);
  });

  it('track YENİDEN alınır — `applyConstraints` ile yetinilmez', () => {
    // Tarayıcılar `echoCancellation`ı yakalama anında bağlar; canlı track
    // üzerinde güvenilir biçimde değiştirilemez.
    const fn = CODE.slice(CODE.indexOf('async setAudioProcessing('));
    const body = fn.slice(0, fn.indexOf('async setMicDevice('));
    expect(body).toMatch(/getUserMedia/);
    expect(body).toMatch(/replaceTrack/);
  });

  it('yeni track TÜM gönderenlere takılır', () => {
    const fn = CODE.slice(CODE.indexOf('async setAudioProcessing('));
    const body = fn.slice(0, fn.indexOf('async setMicDevice('));
    expect(body).toMatch(/for \(const pc of this\.peers\.values\(\)\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('UYGULANMADIĞINDA sessiz kalınmaz', () => {
  it('istenen yankı giderme uygulanmazsa UYARI verilir', () => {
    // Kısıt yalnızca İSTEKTİR. Tarayıcı düşürdüğünde bunun hiçbir izi
    // olmazsa, "yankı giderme açık" iddiası ölçülemez hale gelir — bu
    // dosyadaki tüm kusurların ortak kökü de buydu.
    expect(CODE).toMatch(/aec_not_applied/);
    expect(CODE).toMatch(/getSettings\?\.\(\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('uzak ses YALNIZCA tek yoldan çalar', () => {
  const PANEL_RAW = readFileSync(
    join(__dirname, '..', 'js', 'core', 'VoicePanel.svelte'), 'utf8',
  );
  // Kusurun ADI, onu açıklayan yorumda geçiyor. Yorumları elemezsek test
  // kendi belgelendirmesini kusur sanır.
  const PANEL = stripComments(PANEL_RAW.replace(/<!--[\s\S]*?-->/g, ''));

  it('video kutucukları HER ZAMAN muted', () => {
    // İlk yankı kusuru: `muted={tile.isLocal}` yüzünden uzak kutucuk sesi
    // hem `<video>` hem özel `<audio>` üzerinden çalıyordu (çift çalma).
    expect(PANEL).not.toMatch(/muted=\{tile\.isLocal\}/);
  });

  it('ekran paylaşımı videosu muted', () => {
    const block = PANEL_RAW.slice(PANEL_RAW.indexOf('id="remote-screen-video"'));
    expect(block.slice(0, 200)).toMatch(/\bmuted\b/);
  });

  it('ses YALNIZCA `.remote-audio` elemanlarından çalar', () => {
    expect(PANEL).toMatch(/class="remote-audio"/);
  });
});
