// server/lib/apKeyEncryption.ts
// AES-256-GCM ile ActivityPub private key şifreleme/çözme
//
// Neden uygulama katmanı şifreleme?
//   PostgreSQL'deki "encryption at rest" (disk şifreleme) bir DB sızıntısında
//   yeterli değildir — saldırgan DB dosyasına değil, çalışan DB bağlantısına
//   erişirse düz metni okur. Uygulama katmanı şifreleme ile:
//   - DB yöneticisi bile private key'i okuyamaz
//   - Sızıntı durumunda federation kimliği korunur
//
// Format: base64( iv[12] || authTag[16] || ciphertext )
// Anahtar: AP_ENCRYPTION_KEY — 32-byte hex string (64 hex karakter)
//
// Key üretmek için:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import logger from './logger';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN    = 12; // GCM için önerilen
const TAG_LEN   = 16;

// ── Key yükleme ────────────────────────────────────────────────────────────

let _encKey: Buffer | null = null;

function _loadKey(): Buffer {
  if (_encKey) return _encKey;

  const raw = process.env.AP_ENCRYPTION_KEY;
  const federationEnabled = process.env.FEDERATION_ENABLED === 'true';

  if (!raw) {
    if (federationEnabled) {
      const msg =
        '[apKeyEncryption] FATAL: AP_ENCRYPTION_KEY is not set but FEDERATION_ENABLED=true.\n' +
        '  Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';
      if (process.env.NODE_ENV === 'production') {
        logger.fatal({ event: 'ap_key.missing' }, msg);
        process.exit(1);
      }
      logger.warn({ event: 'ap_key.missing' }, msg);
    }
    // Federation kapalıysa dummy key — şifreleme/çözme çalışsın, uyarı git
    logger.warn({ event: 'ap_key.fallback' },
      '[apKeyEncryption] Using ephemeral key — set AP_ENCRYPTION_KEY for persistence.');
    _encKey = randomBytes(32);
    return _encKey;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    const msg =
      `[apKeyEncryption] FATAL: AP_ENCRYPTION_KEY must be a 64-char hex string (32 bytes). ` +
      `Got ${raw.length} chars.`;
    if (process.env.NODE_ENV === 'production') {
      logger.fatal({ event: 'ap_key.invalid' }, msg);
      process.exit(1);
    }
    throw new Error(msg);
  }

  _encKey = Buffer.from(raw, 'hex');
  return _encKey;
}

// ── Şifreleme ──────────────────────────────────────────────────────────────

/**
 * Plaintext private key'i AES-256-GCM ile şifreler.
 * @returns base64 string: iv + authTag + ciphertext
 */
export function encryptApPrivateKey(plaintext: string): string {
  const key = _loadKey();
  const iv  = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // iv (12) + authTag (16) + ciphertext
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

// ── Çözme ──────────────────────────────────────────────────────────────────

/**
 * encryptApPrivateKey() çıktısını çözer.
 * @returns plaintext private key veya null (bozuk/geçersiz veri)
 */
export function decryptApPrivateKey(encoded: string): string | null {
  try {
    const key = _loadKey();
    const buf = Buffer.from(encoded, 'base64');

    if (buf.length < IV_LEN + TAG_LEN) {
      logger.warn({ event: 'ap_key.decrypt.too_short' }, '[apKeyEncryption] Encrypted blob too short');
      return null;
    }

    const iv         = buf.subarray(0, IV_LEN);
    const tag        = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN + TAG_LEN);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch (err) {
    logger.warn({ event: 'ap_key.decrypt.failed', err },
      '[apKeyEncryption] Failed to decrypt AP private key — key mismatch or corrupted data');
    return null;
  }
}

/**
 * Mevcut bir şifreli blob'un geçerli anahtar ile çözülüp çözülemediğini test eder.
 * Key rotation sırasında eski kayıtları doğrulamak için kullanılır.
 */
export function canDecrypt(encoded: string): boolean {
  return decryptApPrivateKey(encoded) !== null;
}
