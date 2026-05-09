#!/usr/bin/env node
// server/scripts/backfill-ap-keys.js
// Mevcut kullanıcılara ActivityPub RSA anahtar çifti üretir.
// Yeni kayıtlar artık auth.js'de otomatik anahtar alıyor.
// Bu script yalnızca eski kullanıcılar için bir kez çalıştırılır.
//
// Kullanım:
//   cd server
//   node scripts/backfill-ap-keys.js
//   node scripts/backfill-ap-keys.js --dry-run   # değişiklik yapmadan say

'use strict';

const crypto = require('crypto');
const path   = require('path');

const dryRun = process.argv.includes('--dry-run');

// DB loader'ı doğrudan require et (SQLite sync API)
const db = require(path.join(__dirname, '..', 'db', 'loader'));

function generateApKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { apPublicKey: publicKey, apPrivateKey: privateKey };
}

async function main() {
  console.log(`[backfill-ap-keys] ${dryRun ? 'DRY RUN — ' : ''}Başlıyor...`);

  const allUsers = await db.users.find({});
  const users = Array.isArray(allUsers) ? allUsers : await allUsers;

  const missing = users.filter(u => !u.apPublicKey || !u.apPrivateKey);

  console.log(`Toplam kullanıcı: ${users.length}`);
  console.log(`AP anahtarı eksik: ${missing.length}`);

  if (missing.length === 0) {
    console.log('Tüm kullanıcıların AP anahtarı zaten var. İşlem gerekmiyor.');
    process.exit(0);
  }

  if (dryRun) {
    console.log('DRY RUN: Aşağıdaki kullanıcılara anahtar üretilecekti:');
    missing.slice(0, 20).forEach(u => console.log(`  - ${u.username} (${u._id})`));
    if (missing.length > 20) console.log(`  ... ve ${missing.length - 20} kullanıcı daha`);
    process.exit(0);
  }

  let success = 0;
  let failed  = 0;

  for (const user of missing) {
    try {
      const keys = generateApKeyPair();
      await db.users.update(
        { _id: user._id },
        { $set: { apPublicKey: keys.apPublicKey, apPrivateKey: keys.apPrivateKey } }
      );
      process.stdout.write('.');
      success++;
    } catch (e) {
      console.error(`\nHATA: ${user.username} — ${e.message}`);
      failed++;
    }
  }

  console.log(`\n\nTamamlandı: ${success} başarılı, ${failed} hatalı`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Script hatası:', e);
  process.exit(1);
});
export {};
