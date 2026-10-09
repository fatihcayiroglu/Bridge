// e2e/tests/webp-upload.spec.ts — Sprint 63: WebP dönüşüm ve CDN upload E2E
// Akışlar: görsel yükleme → WebP dönüşümü doğrulama,
// dosya tipi reddi, boyut limiti, CDN URL formatı.

import { test, expect } from '../helpers/apiTest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { deflateSync } from 'zlib';
import { getTokens } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

// Test için küçük bir PNG oluştur (1x1 kırmızı piksel — base64)
// Bu fixture herhangi bir gerçek görsel kaynağı gerektirmez.
function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, payload, checksum]);
}

function minimalPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createTestPng(filePath: string): void {
  fs.writeFileSync(filePath, minimalPng());
}

test.describe('Dosya Yükleme ve WebP Dönüşümü', () => {
  let tokens: ReturnType<typeof getTokens>;
  let tmpPng: string;

  test.beforeAll(() => {
    tokens = getTokens();
    // os.tmpdir(): Windows'ta '/tmp' YOKTUR.
    tmpPng = path.join(os.tmpdir(), `bridge-e2e-${Date.now()}.png`);
    createTestPng(tmpPng);
  });

  test.afterAll(() => {
    if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng);
  });

  // ── Temel yükleme ─────────────────────────────────────────────────────────

  test('PNG yükleniyor — URL döndürülüyor', async ({ request }) => {
    const pngBuffer = fs.readFileSync(tmpPng);

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: {
          name: 'test.png',
          mimeType: 'image/png',
          buffer: pngBuffer,
        },
      },
    });

    expect(res.status(), 'Upload 200 dönmeli').toBe(200);
    const body = await res.json() as { url?: string; fileUrl?: string };
    const url = body.url ?? body.fileUrl;
    expect(url, 'URL döndürülmeli').toBeTruthy();
    expect(typeof url).toBe('string');
  });

  test('PNG dönüşümü yapılandırılan WEBP_CONVERT moduyla eşleşir', async ({ request }) => {
    // Both modes are asserted. CI also runs a dedicated WEBP_CONVERT=true server,
    // so the conversion branch cannot pass merely because it is disabled locally.

    const pngBuffer = fs.readFileSync(tmpPng);

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: {
          name: 'convert-test.png',
          mimeType: 'image/png',
          buffer: pngBuffer,
        },
      },
    });

    expect(res.status()).toBe(200);
    const body = await res.json() as { url?: string; fileUrl?: string };
    const url = body.url ?? body.fileUrl ?? '';
    if (process.env.WEBP_CONVERT === 'true') {
      expect(url.endsWith('.webp'), `WEBP_CONVERT=true: .webp URL bekleniyor, alınan: ${url}`).toBe(true);
    } else {
      expect(url.endsWith('.webp'), `WEBP_CONVERT kapalıyken beklenmeyen dönüşüm: ${url}`).toBe(false);
    }
  });

  test('GIF yüklenince WebP\'ye dönüştürülmemeli (animasyon korunur)', async ({ request }) => {
    // Minimal GIF89a (1x1, 1 frame)
    const gifBuffer = Buffer.from(
      '47494638396101000100800000ffffff00000021f90400000000002c00000000010001000002024401003b', 'hex'
    );

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: {
          name: 'animated.gif',
          mimeType: 'image/gif',
          buffer: gifBuffer,
        },
      },
    });

    if (res.status() === 200) {
      const body = await res.json() as { url?: string; fileUrl?: string };
      const url = body.url ?? body.fileUrl ?? '';
      // GIF, WebP'ye dönüştürülmemeli
      expect(url.endsWith('.webp'), 'GIF → .gif kalmalı').toBeFalsy();
    }
  });

  // ── Güvenlik ve validasyon ────────────────────────────────────────────────

  test('kimlik doğrulamasız yükleme reddediliyor', async ({ request }) => {
    const pngBuffer = fs.readFileSync(tmpPng);
    const res = await request.post(`${BASE_URL}/api/upload`, {
      multipart: {
        file: { name: 'noauth.png', mimeType: 'image/png', buffer: pngBuffer },
      },
    });
    expect(res.status()).toBe(401);
  });

  test('izin verilmeyen dosya tipi reddediliyor', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: {
          name: 'evil.exe',
          mimeType: 'application/x-msdownload',
          buffer: Buffer.from('MZ'), // PE magic bytes
        },
      },
    });
    expect(res.status(), await res.text()).toBe(400);
  });

  test('SVG yüklenince sanitize ediliyor', async ({ request }) => {
    const maliciousSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>'
    );

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: { name: 'test.svg', mimeType: 'image/svg+xml', buffer: maliciousSvg },
      },
    });

    // Ürün betik içeren SVG'yi temizleyip SAKLAMAZ, reddeder (lib/contentScanner.ts:
    // 422 SVG_XSS, dosya karantinaya). Eski test "ya reddedilmeli ya temizlenmeli" diyordu; 200 dalı
    // hiç çalışmadı ve ret dalı her >= 400'ü (429/5xx dahil) kabul ediyordu.
    expect(res.status(), await res.text()).toBe(422);
    expect(await res.json()).toEqual({ error: 'SVG contains dangerous content', code: 'SVG_XSS' });
  });

  // ── CDN entegrasyonu ──────────────────────────────────────────────────────

  // The former R2-environment-only scenario was a permanent local-mode skip.
  // S3-compatible protected upload is now proved against a real S3-compatible
  // service (RustFS in CI) by remote-storage.spec.ts. This is neither Cloudflare
  // R2 nor MinIO-vendor coverage.
  //
  // The attachment URL does not depend on the provider: routes/upload.ts never
  // exposes a remote public-origin URL for a private attachment and always
  // answers the Bridge-authorised ref `/uploads/<id>` (remote-storage.spec checks
  // the same shape against RustFS). This test used to skip unless the RUNNER's
  // CDN_PROVIDER was local and accepted `http…` as well — i.e. it would have
  // passed on exactly the public-URL leak the contract forbids.

  test('ek URL\'si sağlayıcıdan bağımsız Bridge yetki yoludur (/uploads/<id>)', async ({ request }) => {
    const pngBuffer = fs.readFileSync(tmpPng);
    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: { name: 'local-test.png', mimeType: 'image/png', buffer: pngBuffer },
      },
    });

    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json() as { url?: string; fileUrl?: string };
    expect(body.url ?? body.fileUrl, 'yanıt bir Bridge yetki yolu döndürmeli').toMatch(/^\/uploads\/[A-Za-z0-9._-]+$/);
  });

  // ── Chunked upload ────────────────────────────────────────────────────────

  test('chunked upload — ilk chunk kabul ediliyor', async ({ request }) => {
    const totalSize = 1024 * 1024; // 1 MB simüle et
    const chunkData = Buffer.alloc(512 * 1024, 42); // 512 KB chunk

    const res = await request.post(`${BASE_URL}/api/upload/chunk`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'x-chunk-index': '0',
        'x-total-chunks': '2',
        'x-upload-id': `e2e-${Date.now()}`,
        'x-total-size': String(totalSize),
        'x-file-name': 'large-file.png',
        'x-file-type': 'image/png',
      },
      multipart: {
        chunk: { name: 'chunk', mimeType: 'application/octet-stream', buffer: chunkData },
      },
    });

    // Final21 Faz 22 (19-37): parçalı yükleme uç VAR (ölçüldü 200); ilk parça kabul edilir, yükleme bitmez.
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.done).toBe(false);
  });
});
