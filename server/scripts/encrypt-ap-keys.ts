#!/usr/bin/env node
// server/scripts/encrypt-ap-keys.ts
// Mevcut düz metin apPrivateKey verilerini AES-256-GCM ile şifreler.
//
// Ön koşullar:
//   1. Migration 008 çalıştırılmış olmalı
//   2. AP_ENCRYPTION_KEY env değişkeni set edilmiş olmalı
//   3. DATABASE_URL env değişkeni set edilmiş olmalı
//
// Çalıştırma:
//   AP_ENCRYPTION_KEY=<64-hex> DATABASE_URL=postgresql://... npx ts-node server/scripts/encrypt-ap-keys.ts
//
// Güvenli: Zaten şifreli (keyVersion=1) kayıtlara dokunmaz.
// Idempotent: Birden fazla çalıştırılabilir.

import { createCipheriv, randomBytes } from 'crypto';
import { Pool } from 'pg';

const KEY_HEX = process.env.AP_ENCRYPTION_KEY;
if (!KEY_HEX || !/^[0-9a-fA-F]{64}$/.test(KEY_HEX)) {
  console.error('[encrypt-ap-keys] AP_ENCRYPTION_KEY eksik veya geçersiz (64-char hex gerekli)');
  console.error("  Üret: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}
const ENC_KEY = Buffer.from(KEY_HEX, 'hex');

interface ApKeyRow {
  userId: string;
  apPrivateKey: string;
}

function encryptKey(plaintext: string): string {
  const iv     = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const { rows } = await pool.query<ApKeyRow>(
    `SELECT "userId", "apPrivateKey"
     FROM user_ap_keys
     WHERE ("keyVersion" = 0 OR "keyVersion" IS NULL)
       AND "apPrivateKey" IS NOT NULL`
  );

  if (rows.length === 0) {
    console.log('[encrypt-ap-keys] Şifrelenecek kayıt yok. Tamamlandı.');
    await pool.end();
    return;
  }

  console.log(`[encrypt-ap-keys] ${rows.length} kayıt şifrelenecek...`);
  let success = 0;
  let failed  = 0;

  for (const row of rows) {
    try {
      const enc = encryptKey(row.apPrivateKey);
      await pool.query(
        `UPDATE user_ap_keys
         SET "apPrivateKeyEnc" = $1, "keyVersion" = 1, "updatedAt" = $2
         WHERE "userId" = $3`,
        [enc, Date.now(), row.userId]
      );
      success++;
    } catch (err) {
      console.error(`[encrypt-ap-keys] HATA userId=${row.userId}:`, (err as Error).message);
      failed++;
    }
  }

  console.log(`[encrypt-ap-keys] Tamamlandı: ${success} başarılı, ${failed} başarısız.`);

  if (failed === 0) {
    console.log('[encrypt-ap-keys] Tüm kayıtlar şifrelendi.');
    console.log('[encrypt-ap-keys] Artık eski kolonu kaldırabilirsiniz:');
    console.log("  psql -d bridge -c 'ALTER TABLE user_ap_keys DROP COLUMN IF EXISTS \"apPrivateKey\";'");
  }

  await pool.end();
}

main().catch((err: unknown) => {
  console.error('[encrypt-ap-keys] Fatal:', err);
  process.exit(1);
});
