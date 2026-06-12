// server/lib/env.ts — Ortam değişkeni doğrulama
// Sunucu başlamadan önce zorunlu ve opsiyonel değişkenleri kontrol eder.
// Eksik/hatalı değer varsa açık hata mesajı ile process.exit(1) yapar.
//
// Kullanım: server/index.js'in en başında require('./lib/env') ekle.
// Test ortamında (NODE_ENV=test) zorunluluklar gevşetilir.

const IS_TEST = process.env.NODE_ENV === 'test';
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Yardımcı fonksiyonlar ─────────────────────────────────────

function str(name: string, { required = false, min = 0, pattern = null, redact = false }: { required?: boolean; min?: number; pattern?: RegExp | null; redact?: boolean } = {}): EnvResult {
  const val = process.env[name];
  const display = redact ? '[GİZLİ]' : (val || '');

  if (!val || val.trim() === '') {
    if (required && !IS_TEST) {
      return { name, ok: false, message: `${name} zorunlu ama tanımlı değil` };
    }
    return { name, ok: true, value: val || '' };
  }

  if (min > 0 && val.length < min) {
    if (IS_TEST) return { name, ok: true, value: val };
    return {
      name, ok: false,
      message: `${name} en az ${min} karakter olmalı (mevcut: ${val.length})`,
    };
  }

  if (pattern && !pattern.test(val)) {
    return { name, ok: false, message: `${name} geçersiz format: "${display}"` };
  }

  return { name, ok: true, value: val };
}

interface EnvResult {
  name: string;
  ok: boolean;
  value?: string | number | null;
  message?: string;
}

function int(
  name: string,
  { min = null, max = null, default: def = null }: { min?: number | null; max?: number | null; default?: number | null } = {}
): EnvResult {
  const raw = process.env[name];
  if (!raw) {
    if (def !== null) return { name, ok: true, value: def };
    return { name, ok: true, value: null };
  }
  const n = parseInt(raw, 10);
  if (isNaN(n)) return { name, ok: false, message: `${name} sayısal olmalı, alındı: "${raw}"` };
  if (min !== null && n < min) return { name, ok: false, message: `${name} en az ${min} olmalı (alındı: ${n})` };
  if (max !== null && n > max) return { name, ok: false, message: `${name} en fazla ${max} olmalı (alındı: ${n})` };
  return { name, ok: true, value: n };
}

function url(
  name: string,
  { required = false, protocols = ['http', 'https'] }: { required?: boolean; protocols?: string[] } = {}
): EnvResult {
  const val = process.env[name];
  if (!val) {
    if (required && !IS_TEST) return { name, ok: false, message: `${name} zorunlu ama tanımlı değil` };
    return { name, ok: true, value: null };
  }
  try {
    const parsed = new URL(val);
    const proto = parsed.protocol.replace(':', '');
    if (!protocols.includes(proto)) {
      return { name, ok: false, message: `${name} geçersiz protokol "${proto}" (izin verilenler: ${protocols.join(', ')})` };
    }
  } catch {
    return { name, ok: false, message: `${name} geçerli bir URL değil: "${val}"` };
  }
  return { name, ok: true, value: val };
}

// ── Kural tanımları ───────────────────────────────────────────

const rules = [
  // Zorunlu güvenlik anahtarları
  str('JWT_SECRET',     { required: true, min: 32, redact: true }),
  str('REFRESH_SECRET', { required: true, min: 32, redact: true }),

  // Veritabanı — db/loader.js zaten kendi kontrolünü yapıyor,
  // burada format doğruluyoruz
  str('DATABASE_URL', {
    required: IS_PROD,
    pattern: /^postgresql:\/\/.+/,
  }),

  // Sunucu ayarları
  int('PORT',           { min: 1, max: 65535, default: 3001 }),
  int('PG_POOL_MAX',    { min: 1, max: 100 }),
  int('MAX_FILE_SIZE_MB', { min: 1, max: 10240 }),  // max 10 GB hardcap
  int('MAX_CHANNELS_PER_SERVER', { min: 1, max: 2000, default: 500 }),
  int('MAX_SERVERS_PER_USER',   { min: 1, max: 1000, default: 100 }),
  int('CHUNK_SIZE_MB',    { min: 1 }),

  // Rate limit ayarları
  int('RL_REGISTER_MAX', { min: 1 }),
  int('RL_REGISTER_WIN', { min: 1000 }),
  int('RL_LOGIN_MAX',    { min: 1 }),
  int('RL_LOGIN_WIN',    { min: 1000 }),

  // WebAuthn — yanlış origin passkey girişini kırar
  (() => {
    const rpId     = process.env.WEBAUTHN_RP_ID;
    const origin   = process.env.WEBAUTHN_ORIGIN;
    if (rpId && origin) {
      try {
        const u = new URL(origin);
        if (!u.hostname.endsWith(rpId)) {
          return {
            name: 'WEBAUTHN_ORIGIN',
            ok: false,
            message: `WEBAUTHN_ORIGIN hostname (${u.hostname}) WEBAUTHN_RP_ID (${rpId}) ile eşleşmiyor`,
          };
        }
      } catch {
        return { name: 'WEBAUTHN_ORIGIN', ok: false, message: 'WEBAUTHN_ORIGIN geçerli bir URL değil' };
      }
    }
    return { name: 'WEBAUTHN', ok: true };
  })(),

  // İzin verilen originler CORS için
  (() => {
    const raw = process.env.ALLOWED_ORIGINS;
    if (!raw) return { name: 'ALLOWED_ORIGINS', ok: true };
    const bad = raw.split(',').map(s => s.trim()).filter(Boolean).filter(o => {
      try { new URL(o); return false; } catch { return true; }
    });
    if (bad.length) {
      return {
        name: 'ALLOWED_ORIGINS',
        ok: false,
        message: `ALLOWED_ORIGINS içinde geçersiz URL'ler: ${bad.join(', ')}`,
      };
    }
    return { name: 'ALLOWED_ORIGINS', ok: true };
  })(),

  // SMTP tutarlılık kontrolü — host varsa user/pass de olmalı
  (() => {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (host && (!user || !pass)) {
      return {
        name: 'SMTP',
        ok: IS_TEST,
        message: 'SMTP_HOST tanımlı ama SMTP_USER veya SMTP_PASS eksik',
      };
    }
    return { name: 'SMTP', ok: true };
  })(),

  // VAPID çift kontrolü — biri varsa ikisi de olmalı
  (() => {
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    if ((pub && !priv) || (!pub && priv)) {
      return {
        name: 'VAPID',
        ok: IS_TEST,
        message: 'VAPID_PUBLIC_KEY ve VAPID_PRIVATE_KEY birlikte tanımlanmalı',
      };
    }
    return { name: 'VAPID', ok: true };
  })(),

  // Production: LOG_LEVEL kontrol
  (() => {
    const level = process.env.LOG_LEVEL;
    const valid = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    if (level && !valid.includes(level)) {
      return {
        name: 'LOG_LEVEL',
        ok: false,
        message: `LOG_LEVEL geçersiz: "${level}" (geçerliler: ${valid.join(', ')})`,
      };
    }
    return { name: 'LOG_LEVEL', ok: true };
  })(),

  // Production: Redis — rate limit / CSRF / socket cluster için zorunlu
  (() => {
    if (!IS_PROD) return { name: 'REDIS_URL', ok: true };
    if (!process.env.REDIS_URL?.trim()) {
      return {
        name: 'REDIS_URL',
        ok: false,
        message: 'REDIS_URL production ortamında zorunludur (rate limit, CSRF, socket adapter)',
      };
    }
    return { name: 'REDIS_URL', ok: true };
  })(),

  // Production: Federation/AP key encryption
  (() => {
    if (!IS_PROD) return { name: 'AP_ENCRYPTION_KEY', ok: true };
    const key = process.env.AP_ENCRYPTION_KEY;
    if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
      return {
        name: 'AP_ENCRYPTION_KEY',
        ok: false,
        message: 'AP_ENCRYPTION_KEY production ortamında 64-char hex (32 byte) olmalıdır',
      };
    }
    return { name: 'AP_ENCRYPTION_KEY', ok: true };
  })(),

  // Production: Federation secret
  (() => {
    if (!IS_PROD) return { name: 'FEDERATION_SECRET', ok: true };
    if (!process.env.FEDERATION_SECRET?.trim() || process.env.FEDERATION_SECRET.length < 32) {
      return {
        name: 'FEDERATION_SECRET',
        ok: false,
        message: 'FEDERATION_SECRET production ortamında en az 32 karakter olmalıdır',
      };
    }
    return { name: 'FEDERATION_SECRET', ok: true };
  })(),

  // ── Sprint 120: WebSocket bağlantı limiti (D5) ────────────────
  int('MAX_WS_PER_IP',        { min: 1, max: 1000 }),
  int('MAX_UNAUTH_WS_PER_IP', { min: 1, max: 100  }),
  int('MAX_WS_PER_USER',      { min: 1, max: 100  }),

  // ── Sprint 120: ActivityPub inbox flood koruması (D6) ────────
  int('AP_INBOX_GLOBAL_MAX',  { min: 1, max: 100000 }),
  int('AP_INBOX_PEER_MAX',    { min: 1, max: 10000  }),
  int('AP_INBOX_BURST_MAX',   { min: 1, max: 1000   }),

  // ── Sprint 122: Metrics endpoint güvenliği ───────────────────
  // Production'da METRICS_SECRET tanımlanmadan /metrics açık kalır.
  (() => {
    if (!IS_PROD) return { name: 'METRICS_SECRET', ok: true };
    if (!process.env.METRICS_SECRET?.trim() || process.env.METRICS_SECRET.length < 16) {
      return {
        name: 'METRICS_SECRET',
        ok: false,
        message: 'METRICS_SECRET production ortamında en az 16 karakter olmalıdır (/metrics endpoint\'i korur)',
      };
    }
    return { name: 'METRICS_SECRET', ok: true };
  })(),
];

// ── Doğrulama çalıştır ────────────────────────────────────────

const errors:   string[] = [];
const warnings: string[] = [];

for (const result of rules) {
  if (!result.ok) {
    if (IS_PROD) {
      errors.push(`  ✗ ${result.message}`);
    } else {
      warnings.push(`  ⚠  ${result.message}`);
    }
  }
}

// NOT: Bu dosya sunucunun en başında (logger initialize edilmeden önce) çalışır.
// Bu nedenle console.* kasıtlı kullanılmaktadır — pino henüz hazır değildir.
if (warnings.length) {
  console.warn('\n[ENV] Ortam değişkeni uyarıları:');
  warnings.forEach(w => console.warn(w));
  console.warn('');
}

if (errors.length) {
  console.error('\n╔══════════════════════════════════════════════════════════╗');
  console.error('║  [ENV] KRİTİK — Eksik/hatalı ortam değişkenleri          ║');
  console.error('╚══════════════════════════════════════════════════════════╝');
  errors.forEach(e => console.error(e));
  console.error('\n  .env.example dosyasını incele: server/.env.example');
  console.error('  Doküman: docs/DEPLOYMENT_GUIDE.md\n');
  process.exit(1);
}

export const validated = true;
