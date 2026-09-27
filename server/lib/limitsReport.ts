// server/lib/limitsReport.ts
//
// KATMANLI SINIRLARIN OPERATÖR TARAFINDAN GÖRÜLEBİLİRLİĞİ
//
// ════════════════════════════════════════════════════════════════════════════
// BU DOSYA NEDEN VAR — ÖLÇÜMDE ORTAYA ÇIKAN GERÇEK SORUN
// ════════════════════════════════════════════════════════════════════════════
// Yük ölçümü sırasında "100 eşzamanlı istemci" hedefine ulaşmak ÜÇ AYRI ve
// BİRBİRİNDEN BAĞIMSIZ kontrolün anlaşılmasını gerektirdi:
//
//   MAX_WS_PER_IP      = 10    → bağlı soket sayısı 10'da sabitlendi
//   RL_REGISTER_MAX    = 5/dk  → fikstür kullanıcıları üretilemedi
//   MAX_REG_PER_HOUR   = 3/sa  → AYRI bir kota; hız sınırını yükseltmek
//                                bunu AÇMIYORDU
//
// Korumaların hiçbiri YANLIŞ değildi — hepsi savunulabilir varsayılanlardır
// ve DEĞİŞTİRİLMEDİ. Sorun KEŞFEDİLEBİLİRLİKTİ: her sınır ayrı bir dosyada
// yaşıyor, hiçbiri açılışta görünmüyor ve devreye girdiğinde dönen mesaj
// HANGİ katmanın reddettiğini söylemiyordu. Bir operatör için bu, "sunucu
// bazen 429 veriyor" gibi görünür.
//
// Burada hiçbir sınır GEVŞETİLMEZ. Yalnızca yürürlükteki değerler, kaynağı
// ve varsayılandan sapıp sapmadığı açılışta TEK BİR YERDE raporlanır.

import logger from './logger';
import { RL_GLOBAL_MAX_DEFAULT } from './rateLimitDefaults';

interface LimitRow {
  /** Operatörün göreceği ad. */
  name: string;
  env: string;
  value: number;
  fallback: number;
  unit: string;
  /** Hangi katman uygular — 429 görüldüğünde nereye bakılacağı. */
  layer: string;
}

function num(env: string, fallback: number): number {
  const raw = process.env[env];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Aynı isteği reddedebilecek TÜM bağımsız katmanlar.
 *
 * Kasıtlı olarak tek bir listedir: bunların ayrı dosyalarda yaşaması, ölçüm
 * sırasında üç ayrı yeniden başlatmaya mal olan tam olarak bu dağınıklıktı.
 */
export function collectLimits(): LimitRow[] {
  return [
    { name: 'WS / IP',            env: 'MAX_WS_PER_IP',      value: num('MAX_WS_PER_IP', 10),
      fallback: 10,  unit: 'eşzamanlı soket', layer: 'socket/middleware/wsConnectionLimit' },
    { name: 'WS / kullanıcı',     env: 'MAX_WS_PER_USER',    value: num('MAX_WS_PER_USER', 5),
      fallback: 5,   unit: 'eşzamanlı soket', layer: 'socket/middleware/wsConnectionLimit' },
    { name: 'WS / kimliksiz IP',  env: 'MAX_UNAUTH_WS_PER_IP', value: num('MAX_UNAUTH_WS_PER_IP', 3),
      fallback: 3,   unit: 'eşzamanlı soket', layer: 'socket/middleware/wsConnectionLimit' },
    { name: 'Kayıt hızı',         env: 'RL_REGISTER_MAX',    value: num('RL_REGISTER_MAX', 5),
      fallback: 5,   unit: 'istek/dk',        layer: 'middleware/rateLimit' },
    { name: 'Kayıt kotası',       env: 'MAX_REG_PER_HOUR',   value: num('MAX_REG_PER_HOUR', 3),
      fallback: 3,   unit: 'hesap/saat/IP',   layer: 'lib/captcha (AYRI katman)' },
    { name: 'Giriş hızı',         env: 'RL_LOGIN_MAX',       value: num('RL_LOGIN_MAX', 10),
      fallback: 10,  unit: 'istek/dk',        layer: 'middleware/rateLimit' },
    { name: 'Başarısız giriş',    env: 'MAX_FAILED_LOGINS',  value: num('MAX_FAILED_LOGINS', 5),
      fallback: 5,   unit: 'deneme',          layer: 'lib/captcha (kilit)' },
    { name: 'Genel istek',        env: 'RL_GLOBAL_MAX',      value: num('RL_GLOBAL_MAX', RL_GLOBAL_MAX_DEFAULT),
      fallback: RL_GLOBAL_MAX_DEFAULT, unit: 'istek/dk',        layer: 'middleware/rateLimit' },
    { name: 'Paylaşılan IP çarpanı', env: 'RL_SHARED_IP_FACTOR', value: num('RL_SHARED_IP_FACTOR', 20),
      fallback: 20,  unit: '× kullanıcı kotası', layer: 'middleware/rateLimit (IP tavanı)' },
    // Parçalı yükleme: hız sınırı ile disk kotası AYRI katmanlardır; biri
    // yükseltilince diğeri açılmaz (429 CHUNK_SESSION_LIMIT / CHUNK_QUOTA_EXCEEDED).
    { name: 'Parça yükleme hızı', env: 'RL_UPLOAD_CHUNK_MAX', value: num('RL_UPLOAD_CHUNK_MAX', 120),
      fallback: 120, unit: 'istek/dk',        layer: 'middleware/rateLimit (uploadChunk)' },
    { name: 'Parçalı oturum',     env: 'CHUNK_UPLOAD_MAX_SESSIONS', value: num('CHUNK_UPLOAD_MAX_SESSIONS', 4),
      fallback: 4,   unit: 'eşzamanlı oturum/kullanıcı', layer: 'lib/chunkUploadQuota (AYRI katman)' },
    { name: 'Parçalı geçici alan', env: 'CHUNK_UPLOAD_MAX_TEMP_MB', value: num('CHUNK_UPLOAD_MAX_TEMP_MB', 400),
      fallback: 400, unit: 'MB/kullanıcı',    layer: 'lib/chunkUploadQuota (AYRI katman)' },
  ];
}

/**
 * Açılışta yürürlükteki sınırları raporlar.
 *
 * Varsayılandan SAPAN her satır ayrıca işaretlenir: üretimde beklenmedik bir
 * gevşetme (ör. bir ölçüm ortam değişkeninin yanlışlıkla taşınması) o anda
 * göze çarpar.
 */
export function reportLimits(): void {
  const rows = collectLimits();
  const overridden = rows.filter(r => r.value !== r.fallback);

  logger.info(
    {
      event: 'limits.effective',
      limits: rows.map(r => ({
        name: r.name, env: r.env, value: r.value,
        unit: r.unit, layer: r.layer,
        overridden: r.value !== r.fallback,
      })),
      overriddenCount: overridden.length,
    },
    '[Limits] Yürürlükteki katmanlı sınırlar — 429/bağlantı reddi görülürse '
    + 'bu katmanlara bakın.',
  );

  if (overridden.length > 0) {
    logger.warn(
      {
        event: 'limits.overridden',
        overridden: overridden.map(r => `${r.env}=${r.value} (varsayılan ${r.fallback})`),
      },
      '[Limits] DİKKAT: bazı koruma sınırları varsayılandan farklı. '
      + 'Üretimde bu kasıtlı olmalıdır.',
    );
  }
}
