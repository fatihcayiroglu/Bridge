// @ts-nocheck
// server/lib/cdnStorage.js — Cloudflare R2 + Backblaze B2 CDN depolama katmanı
//
// ENV değişkenleri:
//   CDN_PROVIDER=r2|b2|local (default: local)
//
//   -- Cloudflare R2 --
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL
//
//   -- Backblaze B2 --
//   B2_KEY_ID, B2_APP_KEY, B2_BUCKET_ID, B2_BUCKET_NAME, B2_REGION (opsiyonel, default us-west-004)
//   B2_PUBLIC_URL  (CDN/custom domain — opsiyonel, aksi halde otomatik)

'use strict';

const fs   = require('fs');
const path = require('path');

const PROVIDER = (process.env.CDN_PROVIDER || 'local').toLowerCase();

// ─────────────────────────────────────────────────────────────────────────────
// Yardımcılar
// ─────────────────────────────────────────────────────────────────────────────

function _mime(filePath) {
  // Basit mime tespiti — multer zaten doğruladığı için sadece extension kullanıyoruz
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png',  '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',  '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',  '.flac': 'audio/flac',
  };
  return map[ext] || 'application/octet-stream';
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare R2 (S3-uyumlu API)
// ─────────────────────────────────────────────────────────────────────────────

let _r2Client = null;

function _getR2() {
  if (_r2Client) return _r2Client;

  let S3Client, PutObjectCommand;
  try {
    ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
  } catch {
    throw new Error('[CDN] @aws-sdk/client-s3 yüklü değil. npm install @aws-sdk/client-s3');
  }

  _r2Client = {
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    }),
    PutObjectCommand,
    bucket:    process.env.R2_BUCKET,
    publicUrl: (process.env.R2_PUBLIC_URL || '').replace(/\/$/, ''),
  };
  return _r2Client;
}

async function _uploadR2(filePath, key) {
  const r2 = _getR2();
  const body = fs.createReadStream(filePath);
  const cmd  = new r2.PutObjectCommand({
    Bucket:      r2.bucket,
    Key:         key,
    Body:        body,
    ContentType: _mime(filePath),
    // Statik dosyalar için CDN cache
    CacheControl: 'public, max-age=31536000, immutable',
  });
  await r2.client.send(cmd);
  return `${r2.publicUrl}/${key}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backblaze B2 (S3-uyumlu API — Native B2 API değil)
// ─────────────────────────────────────────────────────────────────────────────

let _b2Client = null;

function _getB2() {
  if (_b2Client) return _b2Client;

  let S3Client, PutObjectCommand;
  try {
    ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
  } catch {
    throw new Error('[CDN] @aws-sdk/client-s3 yüklü değil. npm install @aws-sdk/client-s3');
  }

  const region = process.env.B2_REGION || 'us-west-004';
  const bucket = process.env.B2_BUCKET_NAME;

  _b2Client = {
    client: new S3Client({
      region,
      endpoint: `https://s3.${region}.backblazeb2.com`,
      credentials: {
        accessKeyId:     process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APP_KEY,
      },
    }),
    PutObjectCommand,
    bucket,
    publicUrl: process.env.B2_PUBLIC_URL
      ? process.env.B2_PUBLIC_URL.replace(/\/$/, '')
      : `https://f000.backblazeb2.com/file/${bucket}`,
  };
  return _b2Client;
}

async function _uploadB2(filePath, key) {
  const b2 = _getB2();
  const body = fs.createReadStream(filePath);
  const cmd  = new b2.PutObjectCommand({
    Bucket:      b2.bucket,
    Key:         key,
    Body:        body,
    ContentType: _mime(filePath),
    CacheControl: 'public, max-age=31536000, immutable',
  });
  await b2.client.send(cmd);
  return `${b2.publicUrl}/${key}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete (CDN'den silme — mesaj silindiğinde çağrılır)
// ─────────────────────────────────────────────────────────────────────────────

async function deleteFromCDN(key) {
  if (PROVIDER === 'local') return; // local'de fs.unlink çağıran upload.js zaten halleder

  let DeleteObjectCommand;
  try {
    ({ DeleteObjectCommand } = require('@aws-sdk/client-s3'));
  } catch { return; }

  try {
    if (PROVIDER === 'r2') {
      const r2  = _getR2();
      await r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: key }));
    } else if (PROVIDER === 'b2') {
      const b2  = _getB2();
      await b2.client.send(new DeleteObjectCommand({ Bucket: b2.bucket, Key: key }));
    }
  } catch (e) {
    console.warn(`[CDN] delete failed for key ${key}:`, e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ana upload fonksiyonu
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dosyayı yapılandırılmış CDN sağlayıcısına yükler.
 * @param {string} localPath  — Disk üzerindeki geçici dosya yolu
 * @param {string} key        — CDN'deki nesne anahtarı (ör: "uploads/uuid.jpg")
 * @param {object} [opts]
 * @param {boolean} [opts.deleteLocal=true] — CDN'e yüklendikten sonra yerel dosyayı sil
 * @returns {{ url: string, key: string, provider: string }}
 */
async function uploadToCDN(localPath, key, opts = {}) {
  const { deleteLocal = true } = opts;

  if (PROVIDER === 'local') {
    // CDN yok — yerel URL döndür
    return { url: `/uploads/${path.basename(localPath)}`, key: null, provider: 'local' };
  }

  let url;
  if (PROVIDER === 'r2') {
    url = await _uploadR2(localPath, key);
  } else if (PROVIDER === 'b2') {
    url = await _uploadB2(localPath, key);
  } else {
    throw new Error(`[CDN] Bilinmeyen provider: ${PROVIDER}. CDN_PROVIDER=r2|b2|local olmalı.`);
  }

  // Yerel dosyayı temizle (disk yer açıcı)
  if (deleteLocal) {
    fs.unlink(localPath, () => {});
  }

  console.log(`[CDN] ${PROVIDER.toUpperCase()} yükleme başarılı: ${key}`);
  return { url, key, provider: PROVIDER };
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { uploadToCDN, deleteFromCDN, PROVIDER };
export {};
