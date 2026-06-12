#!/usr/bin/env node
// server/scripts/sign-federation-body.js
// Federation isteği için X-Bridge-Signature header üretir (curl/test için).
//
// Kullanım:
//   AP_ENCRYPTION_KEY=<64_hex> DATABASE_URL=postgresql://... \
//   BODY='{"url":"https://bridge.example.com"}' \
//   node server/scripts/sign-federation-body.js

'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

const ENC_HEX = process.env.AP_ENCRYPTION_KEY;
const DB_URL  = process.env.DATABASE_URL;
const BODY_RAW = process.env.BODY || '{"url":"http://localhost:3001"}';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function decrypt(encoded, key) {
  const buf = Buffer.from(encoded, 'base64');
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct  = buf.subarray(IV_LEN + TAG_LEN);
  const dec = crypto.createDecipheriv(ALG, key, iv);
  dec.setAuthTag(tag);
  return dec.update(ct) + dec.final('utf8');
}

function sign(privateKeyPem, ts, body) {
  const payload = ts + JSON.stringify(body);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(payload);
  return signer.sign(privateKeyPem, 'base64');
}

async function main() {
  if (!ENC_HEX || !/^[0-9a-fA-F]{64}$/.test(ENC_HEX)) {
    console.error('AP_ENCRYPTION_KEY geçersiz (64-char hex)');
    process.exit(1);
  }
  if (!DB_URL) {
    console.error('DATABASE_URL eksik');
    process.exit(1);
  }

  const body = JSON.parse(BODY_RAW);
  const pool = new Pool({ connectionString: DB_URL });
  const { rows } = await pool.query(
    `SELECT "publicKeyPem", "privateKeyEnc" FROM server_federation_keys WHERE _id = 'instance'`,
  );
  await pool.end();

  if (!rows.length) {
    console.error('server_federation_keys kaydı yok — sunucuyu bir kez başlatın veya rotate script çalıştırın.');
    process.exit(1);
  }

  const key = Buffer.from(ENC_HEX, 'hex');
  const privateKeyPem = decrypt(rows[0].privateKeyEnc, key);
  const instanceUrl = (process.env.INSTANCE_URL || 'http://localhost:3001').replace(/\/$/, '');
  const keyId = `${instanceUrl}/api/federation/key`;
  const ts = String(Date.now());
  const signature = sign(privateKeyPem, ts, body);

  console.log(`x-bridge-ts: ${ts}`);
  console.log(`X-Bridge-Signature: RSA-SHA256 keyId="${keyId}",signature="${signature}"`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
