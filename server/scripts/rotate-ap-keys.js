#!/usr/bin/env node
// server/scripts/rotate-ap-keys.js
// AP_ENCRYPTION_KEY rotasyonu: tüm kayıtları yeni anahtarla yeniden şifreler.
//
// Algoritma: AES-256-GCM — format: base64(iv[12] || authTag[16] || ciphertext)
// Veritabanı: user_ap_keys.apPrivateKeyEnc  (keyVersion = 1)
//
// Kullanım:
//   AP_ENCRYPTION_KEY_OLD=<eski_64hex> \
//   AP_ENCRYPTION_KEY_NEW=<yeni_64hex> \
//   DATABASE_URL=postgresql://...       \
//   node server/scripts/rotate-ap-keys.js
//
// Güvenli:
//   - Yalnızca keyVersion=1 kayıtlara dokunur (şifreli olanlar)
//   - Idempotent: her satır bağımsız güncellenir, yarıda kesilirse kalan
//     kayıtlar eski anahtarla şifreli kalmaya devam eder — tekrar çalıştır
//   - Hata olan satırlar atlanır, exitCode=1 ile bildirilir
//   - --dry-run ile gerçek DB yazımı yapılmaz
//
// Rollback:
//   AP_ENCRYPTION_KEY_OLD=<yeni_anahtar> \
//   AP_ENCRYPTION_KEY_NEW=<eski_anahtar> \
//   node server/scripts/rotate-ap-keys.js

'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');
const { Pool } = require('pg');

// ── Argümanlar ─────────────────────────────────────────────────────────────
const DRY_RUN  = process.argv.includes('--dry-run');
const OLD_HEX  = process.env.AP_ENCRYPTION_KEY_OLD;
const NEW_HEX  = process.env.AP_ENCRYPTION_KEY_NEW;

// ── Doğrulama ──────────────────────────────────────────────────────────────
if (!OLD_HEX || !/^[0-9a-fA-F]{64}$/.test(OLD_HEX)) {
  console.error('[rotate-ap-keys] HATA: AP_ENCRYPTION_KEY_OLD eksik veya geçersiz.');
  console.error('  Beklenen: 64 karakterlik hex string (32 byte AES-256 key)');
  console.error('  Üretmek için: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
if (!NEW_HEX || !/^[0-9a-fA-F]{64}$/.test(NEW_HEX)) {
  console.error('[rotate-ap-keys] HATA: AP_ENCRYPTION_KEY_NEW eksik veya geçersiz.');
  console.error('  Beklenen: 64 karakterlik hex string (32 byte AES-256 key)');
  process.exit(1);
}
if (OLD_HEX === NEW_HEX) {
  console.error('[rotate-ap-keys] HATA: AP_ENCRYPTION_KEY_OLD ve AP_ENCRYPTION_KEY_NEW aynı.');
  console.error('  Rotasyon yapılmadı.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('[rotate-ap-keys] HATA: DATABASE_URL eksik.');
  process.exit(1);
}

const OLD_KEY = Buffer.from(OLD_HEX, 'hex');
const NEW_KEY = Buffer.from(NEW_HEX, 'hex');
const ALG     = 'aes-256-gcm';
const IV_LEN  = 12;
const TAG_LEN = 16;

// ── Şifreleme yardımcıları ─────────────────────────────────────────────────
function decrypt(encoded, key) {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error(`Geçersiz blob uzunluğu: ${buf.length} byte`);
  }
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct  = buf.subarray(IV_LEN + TAG_LEN);
  const dec = createDecipheriv(ALG, key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}

function encrypt(plaintext, key) {
  const iv     = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

// ── Ana mantık ─────────────────────────────────────────────────────────────
async function main() {
  if (DRY_RUN) {
    console.log('[rotate-ap-keys] DRY RUN modu — veritabanına yazılmayacak');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  let rows;
  try {
    const result = await pool.query(
      `SELECT "userId", "apPrivateKeyEnc"
       FROM user_ap_keys
       WHERE "keyVersion" = 1 AND "apPrivateKeyEnc" IS NOT NULL`
    );
    rows = result.rows;
  } catch (err) {
    console.error('[rotate-ap-keys] DB sorgu hatası:', err.message);
    await pool.end();
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log('[rotate-ap-keys] Rotate edilecek kayıt yok. (keyVersion=1 satır bulunamadı)');
    await pool.end();
    return;
  }

  console.log(`[rotate-ap-keys] ${rows.length} kayıt yeniden şifrelenecek${DRY_RUN ? ' (dry run)' : ''}...`);

  let success = 0;
  let failed  = 0;

  for (const row of rows) {
    try {
      // Eski anahtarla çöz
      const plaintext = decrypt(row.apPrivateKeyEnc, OLD_KEY);

      // Yeni anahtarla şifrele
      const newEnc = encrypt(plaintext, NEW_KEY);

      if (!DRY_RUN) {
        await pool.query(
          `UPDATE user_ap_keys
           SET "apPrivateKeyEnc" = $1,
               "updatedAt"       = $2
           WHERE "userId" = $3`,
          [newEnc, Date.now(), row.userId]
        );
      }

      success++;
    } catch (err) {
      console.error(`[rotate-ap-keys] HATA userId=${row.userId}: ${err.message}`);
      failed++;
    }
  }

  // ── Özet ─────────────────────────────────────────────────────────────────
  console.log(`[rotate-ap-keys] Tamamlandı: ${success} başarılı, ${failed} başarısız.`);

  if (DRY_RUN) {
    console.log('[rotate-ap-keys] DRY RUN bitti — gerçek değişiklik yapılmadı.');
  } else if (failed === 0) {
    console.log('[rotate-ap-keys] Tüm kayıtlar yeni anahtarla şifrelendi.');
    console.log('[rotate-ap-keys] Sıradaki adım: AP_ENCRYPTION_KEY env değişkenini güncelleyin ve sunucuyu yeniden başlatın.');
    console.log('  Bkz: docs/AP_ENCRYPTION_KEY_ROTATION_RUNBOOK.md');
  } else {
    console.error(`[rotate-ap-keys] ${failed} kayıt başarısız — lütfen logları inceleyin.`);
    console.error('[rotate-ap-keys] Başarısız kayıtlar eski anahtarla şifreli kalmaya devam eder.');
    console.error('[rotate-ap-keys] AP_ENCRYPTION_KEY_OLD ile sunucu çalışmaya devam edebilir.');
  }

  await pool.end();

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('[rotate-ap-keys] Fatal:', err);
  process.exit(1);
});
