#!/usr/bin/env node
// scripts/generate-vapid.js
// VAPID anahtar çifti üretir ve .env / .env.docker dosyasına yazar.
//
// Kullanım:
//   node scripts/generate-vapid.js            → .env'e yazar (varsayılan)
//   node scripts/generate-vapid.js --docker   → .env.docker'a yazar
//   node scripts/generate-vapid.js --print    → sadece ekrana yazar, dosya değiştirmez
//
// npm script olarak:
//   npm run vapid:generate
//   npm run vapid:generate -- --docker
'use strict';

const fs   = require('fs');
const path = require('path');

// ── Bağımlılık kontrolü ───────────────────────────────────────
let webpush;
try {
  webpush = require('web-push');
} catch {
  console.error('\n❌  web-push paketi bulunamadı. Kurmak için:\n\n    npm install web-push\n');
  process.exit(1);
}

// ── Argüman işleme ────────────────────────────────────────────
const args        = process.argv.slice(2);
const printOnly   = args.includes('--print');
const useDocker   = args.includes('--docker');
const targetFile  = useDocker ? '.env.docker' : '.env';
const targetPath  = path.resolve(process.cwd(), targetFile);

// ── Key üretimi ───────────────────────────────────────────────
const keys = webpush.generateVAPIDKeys();

console.log('\n🔑  Yeni VAPID anahtarları üretildi:\n');
console.log(`   VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`   VAPID_PRIVATE_KEY=${keys.privateKey}`);

if (printOnly) {
  console.log('\nℹ️  --print modu: dosya değiştirilmedi.\n');
  console.log('Bu satırları .env dosyanıza manuel olarak ekleyin veya');
  console.log('VAPID_SUBJECT=mailto:admin@yourdomain.com satırını da unutmayın.\n');
  process.exit(0);
}

// ── .env dosyasını güncelle ───────────────────────────────────
let content = '';
let fileExists = false;

try {
  content    = fs.readFileSync(targetPath, 'utf8');
  fileExists = true;
} catch {
  // Dosya yoksa sıfırdan oluşturulacak
}

function upsertEnvVar(src, key, value) {
  const lineRe = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  const newLine = `${key}=${value}`;
  if (lineRe.test(src)) {
    return src.replace(lineRe, newLine);
  }
  // Yoksa sona ekle
  return src.trimEnd() + '\n' + newLine + '\n';
}

let updated = content;
updated = upsertEnvVar(updated, 'VAPID_PUBLIC_KEY',  keys.publicKey);
updated = upsertEnvVar(updated, 'VAPID_PRIVATE_KEY', keys.privateKey);

// VAPID_SUBJECT henüz yoksa ekle (örnek değerle, kullanıcı değiştirir)
if (!/^#?\s*VAPID_SUBJECT=/m.test(updated)) {
  updated = updated.trimEnd() + '\nVAPID_SUBJECT=mailto:admin@bridge.app\n';
}

fs.writeFileSync(targetPath, updated, 'utf8');

const verb = fileExists ? 'güncellendi' : 'oluşturuldu';
console.log(`\n✅  ${targetFile} ${verb}.\n`);
console.log('⚠️  VAPID_PRIVATE_KEY gizlidir — git\'e commitleme!\n');
console.log('Sonraki adım: sunucuyu yeniden başlat → npm start\n');
