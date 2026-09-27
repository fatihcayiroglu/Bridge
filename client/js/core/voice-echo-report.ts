// client/js/core/voice-echo-report.ts
//
// YANKI TEŞHİS RAPORU — makine doldurabileceği her alanı doldurur.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// Yankı bildirimi geldiğinde sorulan Q1–Q5 formunun yarısı ELLE doldurulamaz
// bilgidir: `getSettings()` çıktısı, çıkış cihazının varsayılan olup olmadığı,
// tarayıcı ve işletim sistemi. Bunları kullanıcıdan istemek hem zahmetli hem
// de hataya açıktır — ve form boş döndüğünde teşhis hiç başlamaz.
//
// Bu modül ÖLÇÜLEBİLİR olanı ölçer, ölçülemeyeni (kulakla verilen kararlar)
// boş bırakır. Kullanıcıya kalan iş: dinlemek ve üç satır işaretlemek.
//
// ── GİZLİLİK ──────────────────────────────────────────────────────────────
// Rapor DIŞARI GÖNDERİLMEZ; yalnızca panoya kopyalanır ve kullanıcı nereye
// yapıştıracağına kendi karar verir. İçeriğe ASLA girmeyenler:
//   · IP adresi, ICE adayı, aday tipi, sunucu adresi
//   · TURN/STUN kimlik bilgileri
//   · oturum jetonu, kullanıcı kimliği, kanal kimliği
//   · mesaj içeriği
// Cihaz ETİKETİ dahil edilir (ör. "MacBook Pro Mikrofonu") çünkü yankı
// teşhisinde donanım belirleyicidir; bu etiket zaten kullanıcının kendi
// ekranında görünür ve ağ üzerinden hiçbir yere gitmez.

'use strict';

import type { VoiceDiagnosticsSnapshot } from './voice-diagnostics.js';

export interface EchoReportInput {
  snapshot: VoiceDiagnosticsSnapshot | null;
  /** `navigator.userAgent` — test edilebilirlik için dışarıdan verilir. */
  userAgent?: string;
  /** `navigator.platform` benzeri; yoksa userAgent'tan çıkarılır. */
  platform?: string;
}

/** Üç durumlu değeri form diline çevirir. Uydurmaz. */
function triState(value: boolean | 'unknown' | null | undefined): string {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return 'unknown';
}

/**
 * Tarayıcı adı ve ana sürüm.
 *
 * Tam `userAgent` KOPYALANMAZ: parmak izi yüzeyini gereksiz genişletir ve
 * teşhis için yalnızca motor + sürüm gerekir.
 */
export function browserName(ua: string): string {
  if (!ua) return 'unknown';
  const patterns: [RegExp, string][] = [
    [/Edg\/(\d+)/,                'Edge'],
    [/OPR\/(\d+)/,                'Opera'],
    [/Firefox\/(\d+)/,            'Firefox'],
    [/Chrome\/(\d+)/,             'Chrome'],
    [/Version\/(\d+).*Safari/,    'Safari'],
  ];
  for (const [re, name] of patterns) {
    const m = ua.match(re);
    if (m) return `${name} ${m[1]}`;
  }
  return 'unknown';
}

/** İşletim sistemi ailesi. Sürüm ayrıntısı teşhis için gerekmez. */
export function osName(ua: string, platform?: string): string {
  const src = `${ua} ${platform ?? ''}`;
  // ── MOBİL ÖNCE SINANIR ────────────────────────────────────────────────────
  // iOS user-agent'ı "like Mac OS X" içerir ve Android'inki "Linux" içerir.
  // Masaüstü desenleri önce sınanırsa her iPhone macOS, her Android Linux
  // olarak raporlanır. Yankı teşhisinde bu ayrım BELİRLEYİCİDİR: mobil
  // platformlarda donanım yankı gidericisi devrededir ve tarayıcı tarafındaki
  // `echoCancellation` kısıtı farklı davranır.
  if (/iPhone|iPad|iPod|iOS/.test(src))                      return 'iOS';
  if (/Android/.test(src))                                   return 'Android';
  // `navigator.platform` en yaygın Windows değeri olarak "Win32" döndürür
  // (64-bit'te bile) ve macOS'ta "MacIntel" döndürür; ikisi de eşleşmeliydi.
  if (/Windows|Win32|Win64|WinCE/.test(src))                 return 'Windows';
  if (/Mac OS X|Macintosh|MacIntel|MacPPC/.test(src))        return 'macOS';
  if (/Linux|X11/.test(src))                                  return 'Linux';
  return 'unknown';
}

/**
 * Çıkış cihazı SİSTEM VARSAYILANI mı?
 *
 * Q5'in konusu budur: varsayılan dışında bir cihaz seçiliyse tarayıcı
 * `setSinkId` ile yönlendirir ve Chrome'un yankı gidericisi VARSAYILAN render
 * akışını referans aldığı için o sesi iptal edemez.
 */
export function outputIsDefault(snapshot: VoiceDiagnosticsSnapshot | null): string {
  if (!snapshot) return 'unknown';
  if (snapshot.selectedOutputUnavailable) return 'other (seçili cihaz bulunamadı)';
  const label = snapshot.outputDeviceLabel;
  if (!label) return 'unknown';
  return /varsayılan|default/i.test(label) ? 'system default' : `other (${label})`;
}

/**
 * Q1–Q5 formunu ÖLÇÜLEBİLİR alanları doldurulmuş halde üretir.
 *
 * Kulakla verilecek kararlar (Q1, Q2, Q3 ve PASS/FAIL satırları) BİLEREK boş
 * bırakılır — onları tahmin etmek raporu değersiz kılardı.
 */
export function buildEchoReport(input: EchoReportInput): string {
  const { snapshot } = input;
  const ua = input.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const platform = input.platform
    ?? (typeof navigator !== 'undefined' ? (navigator as { platform?: string }).platform : undefined);

  const audio = snapshot?.appliedAudio.audio;
  const trackLive = snapshot?.appliedAudio.trackLive === true;

  // Track yoksa `getSettings()` hiçbir şey söylemez. "false" yazmak YANLIŞ
  // olurdu: ölçüm yapılamadı demek, kapalı demek değildir.
  const measured = trackLive && snapshot?.appliedAudio.supported === true;

  // ── ÖLÇÜM KAYNAĞI ────────────────────────────────────────────────────────
  // Mikrofon testi track'i, aramanın KENDİSİ değildir — aynı kısıtlarla
  // alınır ama ayrı bir yakalamadır. Raporun bunu söylemesi şart: aksi halde
  // tek kişilik bir ölçüm, iki kişilik bir aramanın kanıtı gibi okunur.
  const SOURCE_LABEL: Record<string, string> = {
    'call':     "canlı arama track'i (kesin)",
    'mic-test': "mikrofon testi track'i — arama kısıtlarıyla alındı, VEKİL ölçüm",
    'none':     'ölçüm yok',
  };
  const sourceLabel = SOURCE_LABEL[snapshot?.appliedAudioSource ?? 'none'] ?? 'ölçüm yok';

  const lines = [
    '=== BRIDGE YANKI TEŞHİSİ ===',
    `zaman: ${new Date().toISOString()}`,
    '',
    '--- ELLE (kulakla) ---',
    'Q1 yankı tipi   : [kendi sesim geri geliyor / karşı taraf çift duyuluyor / yankı yok]',
    'Q2 ekran paylaşımı sesi: [KAPALI / AÇIK]',
    'Q3 kulaklık — ben: [EVET/HAYIR]   karşı taraf: [EVET/HAYIR]',
    '   kulaklıkla yankı: [EVET/HAYIR]',
    '',
    '--- OTOMATİK (bu cihaz) ---',
    `ölçüm kaynağı      : ${sourceLabel}`,
    `Q4 echoCancellation: ${measured ? triState(audio?.echoCancellation) : 'unknown (canlı ses track\'i yok — önce "Mikrofon testi"ne basın)'}`,
    `Q4 noiseSuppression: ${measured ? triState(audio?.noiseSuppression) : 'unknown'}`,
    `Q4 autoGainControl : ${measured ? triState(audio?.autoGainControl) : 'unknown'}`,
    `Q4 sampleRate      : ${audio?.sampleRate ?? 'unknown'}`,
    `Q4 channelCount    : ${audio?.channelCount ?? 'unknown'}`,
    `Q5 çıkış cihazı    : ${outputIsDefault(snapshot)}`,
    `   giriş cihazı    : ${snapshot?.inputDeviceLabel ?? 'unknown'}`,
    `tarayıcı           : ${browserName(ua)}`,
    `işletim sistemi    : ${osName(ua, platform)}`,
    `ses kanalında      : ${snapshot?.inVoice === true ? 'evet' : 'hayır'}`,
    `eş sayısı          : ${snapshot?.peerCount ?? 'unknown'}`,
    '',
    '--- SONUÇ (kulakla) ---',
    'A -> B ses      : [PASS/FAIL]',
    'B -> A ses      : [PASS/FAIL]',
    'yankı           : [TEMİZ / HÂLÂ YANKILI]',
    'mute/deafen     : [PASS/FAIL]',
    'cihaz değiştirme: [PASS/FAIL]',
    'çık/tekrar katıl: [PASS/FAIL]',
    'ekran paylaşımı : [PASS/FAIL]',
    '',
    'NOT: bu rapor ağ üzerinden hiçbir yere gönderilmez; IP, ICE adayı,',
    'kimlik bilgisi veya mesaj içeriği İÇERMEZ.',
  ];

  return lines.join('\n');
}
