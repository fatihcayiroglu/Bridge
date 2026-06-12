#!/usr/bin/env node
// server/scripts/rotate-federation-keys.js
// ADR-0006 Faz 2: Instance RSA federation key rotasyonu
//
// Kullanım:
//   AP_ENCRYPTION_KEY=<64_hex> DATABASE_URL=postgresql://... \
//   node server/scripts/rotate-federation-keys.js

'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

const ENC_HEX = process.env.AP_ENCRYPTION_KEY;
const DB_URL  = process.env.DATABASE_URL;
const INSTANCE_ID = 'instance';

if (!ENC_HEX || !/^[0-9a-fA-F]{64}$/.test(ENC_HEX)) {
  console.error('[rotate-federation-keys] AP_ENCRYPTION_KEY geçersiz (64-char hex)');
  process.exit(1);
}
if (!DB_URL) {
  console.error('[rotate-federation-keys] DATABASE_URL eksik');
  process.exit(1);
}

const ENC_KEY = Buffer.from(ENC_HEX, 'hex');
const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function encryptPrivateKey(pem) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(pem, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

async function main() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const privateKeyEnc = encryptPrivateKey(privateKey);
  const now = Date.now();
  const pool = new Pool({ connectionString: DB_URL });

  const existing = await pool.query(
    'SELECT "keyVersion" FROM server_federation_keys WHERE _id = $1',
    [INSTANCE_ID],
  );
  const nextVersion = existing.rows[0] ? (existing.rows[0].keyVersion + 1) : 1;

  if (existing.rows.length) {
    await pool.query(
      `UPDATE server_federation_keys
       SET "publicKeyPem" = $1, "privateKeyEnc" = $2, "keyVersion" = $3, "rotatedAt" = $4
       WHERE _id = $5`,
      [publicKey, privateKeyEnc, nextVersion, now, INSTANCE_ID],
    );
  } else {
    await pool.query(
      `INSERT INTO server_federation_keys (_id, "publicKeyPem", "privateKeyEnc", "keyVersion", "createdAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [INSTANCE_ID, publicKey, privateKeyEnc, nextVersion, now],
    );
  }

  console.log(`[rotate-federation-keys] Tamamlandı (keyVersion=${nextVersion}).`);
  console.log('[rotate-federation-keys] Sunucuyu yeniden başlatın.');
  await pool.end();
}

main().catch((err) => {
  console.error('[rotate-federation-keys] Fatal:', err.message);
  process.exit(1);
});
