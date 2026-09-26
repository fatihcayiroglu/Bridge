// client/tests/voice-echo-report.test.ts
//
// YANKI TEŞHİS RAPORU — ölçüleni yazar, ölçülemeyeni UYDURMAZ.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// Yankı bildirimi geldiğinde Q1–Q5 formu gönderildi ve BOŞ döndü — tüm alanlar
// köşeli parantezli şablon olarak kaldı. Teşhis edilemedi.
//
// Formun yarısı zaten makineyle doldurulabilir: `getSettings()` çıktısı, çıkış
// cihazının varsayılan olup olmadığı, tarayıcı ve işletim sistemi. Bu modül
// onları doldurur, kulakla verilecek kararları boş bırakır.
//
// ── KİLİTLENEN KARARLAR ───────────────────────────────────────────────────
//   1. Ölçüm YOKSA "false" yazılmaz — `unknown` yazılır. "Ölçemedim" ile
//      "kapalı" aynı şey değildir ve bu ayrım tam olarak yankı teşhisinin
//      düğüm noktasıdır.
//   2. Kulakla verilen kararlar BOŞ kalır; tahmin edilirse rapor değersizdir.
//   3. Rapor AĞ ADRESİ, ICE adayı, kimlik bilgisi veya jeton İÇERMEZ —
//      panelin kendi gizlilik sözü budur.

import { describe, it, expect } from 'vitest';
import {
  buildEchoReport, browserName, osName, outputIsDefault,
} from '../js/core/voice-echo-report.ts';

const snap = (over: Record<string, unknown> = {}) => ({
  rtcAvailable: true,
  mediaApiAvailable: true,
  microphonePermission: 'granted',
  microphoneDetected: true,
  microphoneTrackLive: true,
  outputDetected: true,
  inputDeviceLabel: 'Varsayılan mikrofon',
  outputDeviceLabel: 'Varsayılan çıkış',
  selectedInputUnavailable: false,
  selectedOutputUnavailable: false,
  inVoice: true,
  signalingConnected: true,
  peerCount: 1,
  appliedAudio: {
    supported: true,
    trackLive: true,
    microphone: { deviceId: 'default', label: 'Varsayılan mikrofon' },
    audio: {
      sampleRate: 48000, sampleSize: 16, channelCount: 1,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    },
  },
  connectionQuality: { quality: 'good' },
  ...over,
}) as never;

const UA_CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0';
const UA_SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15';

// ════════════════════════════════════════════════════════════════════════════
describe('ölçülen değerler rapora GİRER', () => {
  it('uygulanan ses bayrakları yazılır', () => {
    const out = buildEchoReport({ snapshot: snap(), userAgent: UA_CHROME_WIN });
    expect(out).toMatch(/Q4 echoCancellation: true/);
    expect(out).toMatch(/Q4 noiseSuppression: true/);
    expect(out).toMatch(/Q4 autoGainControl : true/);
  });

  it('KAPALI yankı giderme açıkça "false" yazılır', () => {
    // Teşhisin aradığı tek satır bu.
    const s = snap();
    (s as never as { appliedAudio: { audio: { echoCancellation: unknown } } })
      .appliedAudio.audio.echoCancellation = false;
    expect(buildEchoReport({ snapshot: s, userAgent: UA_CHROME_WIN }))
      .toMatch(/Q4 echoCancellation: false/);
  });

  it('örnekleme hızı ve kanal sayısı yazılır', () => {
    const out = buildEchoReport({ snapshot: snap(), userAgent: UA_CHROME_WIN });
    expect(out).toMatch(/sampleRate\s*:\s*48000/);
    expect(out).toMatch(/channelCount\s*:\s*1/);
  });

  it('eş sayısı ve kanal durumu yazılır', () => {
    const out = buildEchoReport({ snapshot: snap(), userAgent: UA_CHROME_WIN });
    expect(out).toMatch(/ses kanalında\s*:\s*evet/);
    expect(out).toMatch(/eş sayısı\s*:\s*1/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ÖLÇÜLEMEYEN değer uydurulmaz', () => {
  it('canlı track yokken "unknown" yazılır, "false" DEĞİL', () => {
    // Bu ayrım kritik: arama DIŞINDA rapor alan bir kullanıcı "false" görüp
    // yankı gidermenin kapalı olduğu sonucuna varırdı.
    const out = buildEchoReport({
      snapshot: snap({
        appliedAudio: {
          supported: true, trackLive: false,
          microphone: { deviceId: null, label: null },
          audio: {
            sampleRate: null, sampleSize: null, channelCount: null,
            echoCancellation: 'unknown', noiseSuppression: 'unknown', autoGainControl: 'unknown',
          },
        },
      }),
      userAgent: UA_CHROME_WIN,
    });
    expect(out).toMatch(/Q4 echoCancellation: unknown/);
    expect(out).not.toMatch(/Q4 echoCancellation: false/);
  });

  it('track yokken kullanıcıya NE YAPACAĞI söylenir', () => {
    const out = buildEchoReport({
      snapshot: snap({
        appliedAudio: {
          supported: true, trackLive: false,
          microphone: { deviceId: null, label: null },
          audio: {
            sampleRate: null, sampleSize: null, channelCount: null,
            echoCancellation: 'unknown', noiseSuppression: 'unknown', autoGainControl: 'unknown',
          },
        },
      }),
      userAgent: UA_CHROME_WIN,
    });
    // Yonlendirme DEGISTI: artik iki kisilik bir arama gerekmiyor. Mikrofon
    // testi ayni kisitlarla track alir, dolayisiyla Q4 TEK KISIYLE yanitlanir.
    expect(out).toMatch(/Mikrofon testi/);
  });

  it('anlık görüntü YOKKEN çökmez', () => {
    const out = buildEchoReport({ snapshot: null, userAgent: UA_CHROME_WIN });
    expect(out).toMatch(/unknown/);
    expect(out).toMatch(/BRIDGE YANKI TEŞHİSİ/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kulakla verilen kararlar BOŞ kalır', () => {
  it('Q1–Q3 ve sonuç satırları şablon olarak durur', () => {
    const out = buildEchoReport({ snapshot: snap(), userAgent: UA_CHROME_WIN });
    for (const marker of [
      'Q1 yankı tipi', 'Q2 ekran paylaşımı sesi', 'Q3 kulaklık',
      'A -> B ses', 'yankı           : [TEMİZ / HÂLÂ YANKILI]',
    ]) {
      expect(out).toContain(marker);
    }
  });

  it('sonuç satırları TAHMİN EDİLMEZ', () => {
    // Otomatik "PASS" yazmak raporu değersiz kılardı.
    const out = buildEchoReport({ snapshot: snap(), userAgent: UA_CHROME_WIN });
    expect(out).not.toMatch(/yankı\s*:\s*TEMİZ$/m);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('tarayıcı ve işletim sistemi', () => {
  it('tarayıcı adı ve ANA sürüm çıkarılır', () => {
    expect(browserName(UA_CHROME_WIN)).toBe('Chrome 120');
    expect(browserName(UA_FIREFOX_MAC)).toBe('Firefox 121');
    expect(browserName(UA_SAFARI_MAC)).toBe('Safari 17');
  });

  it('Edge, Chrome ile karıştırılmaz', () => {
    // Edge userAgent'ı `Chrome/` de içerir; sıra yanlışsa Edge hep Chrome görünür.
    expect(browserName(`${UA_CHROME_WIN} Edg/120.0.0.0`)).toBe('Edge 120');
  });

  it('bilinmeyen tarayıcı uydurulmaz', () => {
    expect(browserName('')).toBe('unknown');
    expect(browserName('SomeRobot/1.0')).toBe('unknown');
  });

  it('işletim sistemi ailesi çıkarılır', () => {
    expect(osName(UA_CHROME_WIN)).toBe('Windows');
    expect(osName(UA_FIREFOX_MAC)).toBe('macOS');
    expect(osName('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux');
    expect(osName('')).toBe('unknown');
  });

  it('TAM userAgent kopyalanmaz', () => {
    // Parmak izi yüzeyini gereksiz genişletir; teşhis için motor+sürüm yeter.
    const out = buildEchoReport({ snapshot: snap(), userAgent: UA_CHROME_WIN });
    expect(out).not.toContain('AppleWebKit/537.36');
    expect(out).not.toContain(UA_CHROME_WIN);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('Q5 — çıkış cihazı', () => {
  it('varsayılan cihaz "system default" olarak raporlanır', () => {
    expect(outputIsDefault(snap())).toBe('system default');
  });

  it('varsayılan DIŞI cihaz işaretlenir ve adı verilir', () => {
    // Q5'in tüm amacı bu: `setSinkId` ile başka cihaza yönlendirilen ses,
    // Chrome'un yankı gidericisi tarafından iptal EDİLEMEZ.
    expect(outputIsDefault(snap({ outputDeviceLabel: 'Kulaklık (Bluetooth)' })))
      .toBe('other (Kulaklık (Bluetooth))');
  });

  it('seçili cihaz bulunamıyorsa bu AYRICA belirtilir', () => {
    expect(outputIsDefault(snap({ selectedOutputUnavailable: true })))
      .toMatch(/other \(seçili cihaz bulunamadı\)/);
  });

  it('etiket yoksa uydurulmaz', () => {
    expect(outputIsDefault(snap({ outputDeviceLabel: undefined }))).toBe('unknown');
    expect(outputIsDefault(null)).toBe('unknown');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('GİZLİLİK — rapor ağ kimliği taşımaz', () => {
  it('IP, ICE ve kimlik bilgisi alanları YOK', () => {
    const out = buildEchoReport({ snapshot: snap(), userAgent: UA_CHROME_WIN });
    for (const forbidden of [
      'candidate', 'srflx', 'relay', 'turn:', 'stun:', 'password', 'credential',
      'token', 'Bearer',
    ]) {
      expect(out.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('IPv4 benzeri bir dizi içermez', () => {
    const out = buildEchoReport({ snapshot: snap(), userAgent: UA_CHROME_WIN });
    expect(out).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it('raporun dışarı GÖNDERİLMEDİĞİ açıkça yazar', () => {
    const out = buildEchoReport({ snapshot: snap(), userAgent: UA_CHROME_WIN });
    expect(out).toMatch(/hiçbir yere gönderilmez/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ölçüm KAYNAĞI raporlanır', () => {
  it('canlı arama track kaynağı kesin olarak işaretlenir', () => {
    const out = buildEchoReport({
      snapshot: snap({ appliedAudioSource: 'call' }), userAgent: UA_CHROME_WIN,
    });
    expect(out).toMatch(/ölçüm kaynağı\s*:\s*canlı arama/);
  });

  it('mikrofon testi VEKİL olarak işaretlenir', () => {
    // Bu satır olmadan tek kişilik bir ölçüm, iki kişilik bir aramanın
    // kanıtı gibi okunurdu.
    const out = buildEchoReport({
      snapshot: snap({ appliedAudioSource: 'mic-test' }), userAgent: UA_CHROME_WIN,
    });
    expect(out).toMatch(/VEKİL ölçüm/);
  });

  it('ölçüm yoksa öyle yazar', () => {
    const out = buildEchoReport({
      snapshot: snap({ appliedAudioSource: 'none' }), userAgent: UA_CHROME_WIN,
    });
    expect(out).toMatch(/ölçüm kaynağı\s*:\s*ölçüm yok/);
  });
});
