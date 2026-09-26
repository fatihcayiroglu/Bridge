// server/tests/notification-mute.test.ts
//
// SESSİZE ALMA — SÜRE GERÇEKTEN DOLAR, ROZET DE SUSAR
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN İKİ GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
//
// 1. `muteUntil` HİÇ KARŞILAŞTIRILMIYORDU.
//    Kullanıcı "bugün 15:00'e kadar sustur" diyebiliyor, değer
//    `notification_prefs.muteUntil` alanına yazılıyor ve API yanıtında geri
//    dönüyordu — ama uygulama tarafında HİÇBİR YERDE okunmuyordu. Enforcement
//    yalnızca `level === 'mute'` bakıyordu.
//
//    Sonuç: GEÇİCİ sessizlik KALICI oluyordu. Kullanıcı birkaç saatliğine
//    susturduğu kanaldan bir daha hiç haber almıyordu.
//
// 2. OKUNMAMIŞ ROZETLERİ SESSİZE ALMAYI YOK SAYIYORDU.
//    Sessizlik dört yerde tutarlı uygulanıyordu (bildirim kaydı, push, yanıt
//    dikkati, mention olayı) ama `GET /api/notification-prefs/unread` bunu
//    dikkate almıyordu. Kullanıcı kanalı susturuyor, bildirim kesiliyor, ama
//    rozet dikkat istemeye devam ediyordu — sistemin kendi kuralından sapan
//    tek nokta.
//
// Karar artık TEK SAHİPTEDİR: `lib/notificationMute.ts`.

process.env.NODE_ENV = 'test';

import { isMuted, isMuteExpired, normalizeNotificationLevel } from '../lib/notificationMute';

const NOW = 1_700_000_000_000;

// ════════════════════════════════════════════════════════════════════════════
describe('isMuted — temel', () => {
  it('tercih YOKSA sessiz değildir', () => {
    expect(isMuted(null, NOW)).toBe(false);
    expect(isMuted(undefined, NOW)).toBe(false);
  });

  it('seviye "mute" DEĞİLSE sessiz değildir', () => {
    expect(isMuted({ level: 'all' }, NOW)).toBe(false);
    expect(isMuted({ level: 'mentions' }, NOW)).toBe(false);
    expect(isMuted({ level: 'default' }, NOW)).toBe(false);
  });

  it('süresiz sessizlik SESSİZDİR', () => {
    // `null` = kullanıcı "kalıcı sustur" seçti.
    expect(isMuted({ level: 'mute', muteUntil: null }, NOW)).toBe(true);
    expect(isMuted({ level: 'mute' }, NOW)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('isMuted — SÜRE gerçekten dolar', () => {
  it('gelecekteki süre boyunca SESSİZDİR', () => {
    expect(isMuted({ level: 'mute', muteUntil: NOW + 60_000 }, NOW)).toBe(true);
  });

  it('süre DOLDUĞUNDA artık sessiz DEĞİLDİR', () => {
    // Kusurun ta kendisi: bu satır önceden `true` dönerdi ve geçici
    // sessizlik kalıcı olurdu.
    expect(isMuted({ level: 'mute', muteUntil: NOW - 1 }, NOW)).toBe(false);
  });

  it('tam sınırda süre DOLMUŞ sayılır', () => {
    expect(isMuted({ level: 'mute', muteUntil: NOW }, NOW)).toBe(false);
  });

  it('`isMuteExpired` yalnızca SÜRESİ DOLMUŞ sessizliği bildirir', () => {
    expect(isMuteExpired({ level: 'mute', muteUntil: NOW - 1 }, NOW)).toBe(true);
    expect(isMuteExpired({ level: 'mute', muteUntil: NOW + 1 }, NOW)).toBe(false);
    expect(isMuteExpired({ level: 'mute', muteUntil: null }, NOW)).toBe(false);
    expect(isMuteExpired({ level: 'all' }, NOW)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('isMuted — bozuk veri KULLANICI LEHİNE yorumlanır', () => {
  it('sayı olmayan süre SÜRESİZ sayılır', () => {
    // Kullanıcı açıkça "sustur" dedi. Bozuk bir alan yüzünden o isteği
    // GÖRMEZDEN GELMEK, yanlış yönde hata yapmak olurdu: istemediği
    // bildirimi alırdı.
    expect(isMuted({ level: 'mute', muteUntil: 'yarın' as unknown as number }, NOW)).toBe(true);
    expect(isMuted({ level: 'mute', muteUntil: NaN }, NOW)).toBe(true);
  });

  it('bozuk süre "dolmuş" sayılmaz', () => {
    expect(isMuteExpired({ level: 'mute', muteUntil: NaN }, NOW)).toBe(false);
  });


  it('alan dışı persisted seviye fail-closed olarak sessiz yorumlanır', () => {
    expect(normalizeNotificationLevel('tamamen-bilinmeyen', true)).toBe('mute');
    expect(normalizeNotificationLevel(undefined, true)).toBe('mute');
    expect(normalizeNotificationLevel(undefined, false)).toBe('all');
    expect(isMuted({ level: 'tamamen-bilinmeyen' }, NOW)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kural TEK YERDE tanımlıdır', () => {
  const { readFileSync, readdirSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'tests') continue;
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f, out);
      else if (f.endsWith('.ts')) out.push(f);
    }
    return out;
  }

  it('elle yazılmış `level === \'mute\'` denetimi KALMADI', () => {
    // Karar beş ayrı yerde tekrarlanıyordu ve biri (unread) sapmıştı.
    // Yeniden elle yazılırsa `muteUntil` yine unutulur.
    const SERVER = join(__dirname, '..');
    const offenders: string[] = [];
    for (const file of walk(SERVER)) {
      if (file.includes('notificationMute.ts')) continue;      // sahibin kendisi
      // YAZMA yolu: `PUT /api/notification-prefs` tercihi KAYDEDERKEN
      // `muteUntil` alaninin saklanip saklanmayacagina karar verir. Bu bir
      // ENFORCEMENT denetimi degildir; sessizlige UYULUP uyulmayacagini
      // sormaz, tercihi yazar. Bilerek haric tutulur.
      if (file.endsWith(join('routes', 'notificationPrefs.ts'))) continue;
      const src = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); })
        .join('\n');
      if (/level\s*(===|!==)\s*'mute'/.test(src)) {
        offenders.push(file.replace(SERVER, '').replace(/\\/g, '/'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
