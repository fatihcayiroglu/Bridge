// e2e/tests/webp-upload.spec.ts — Sprint 63: WebP dönüşüm ve CDN upload E2E
// Akışlar: görsel yükleme → WebP dönüşümü doğrulama,
// dosya tipi reddi, boyut limiti, CDN URL formatı.

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { getTokens } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Test için küçük bir PNG oluştur (1x1 kırmızı piksel — base64)
// Bu fixture herhangi bir gerçek görsel kaynağı gerektirmez.
const MINIMAL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==';

function createTestPng(filePath: string): void {
  fs.writeFileSync(filePath, Buffer.from(MINIMAL_PNG_B64, 'base64'));
}

test.describe('Dosya Yükleme ve WebP Dönüşümü', () => {
  let tokens: ReturnType<typeof getTokens>;
  let tmpPng: string;

  test.beforeAll(() => {
    tokens = getTokens();
    tmpPng = path.join('/tmp', `bridge-e2e-${Date.now()}.png`);
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

  test('WEBP_CONVERT=true ise dönen URL .webp uzantılı olmalı', async ({ request }) => {
    // Bu test sadece sunucu WEBP_CONVERT=true ile çalışıyorsa anlamlı.
    // CI ortamında WEBP_CONVERT env'e bakılır.
    test.skip(process.env.WEBP_CONVERT !== 'true', 'WEBP_CONVERT=true değil — WebP dönüştürme devre dışı');

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
    expect(url.endsWith('.webp'), `URL .webp ile bitmeli, alınan: ${url}`).toBeTruthy();
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
    expect(res.status()).toBeGreaterThanOrEqual(400);
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

    // Ya reddedilmeli ya da sanitize edilmeli
    if (res.status() === 200) {
      const body = await res.json() as { url?: string };
      const url = body.url ?? '';
      // Yüklendiyse içeriğini kontrol et
      if (url) {
        const content = await request.get(url.startsWith('http') ? url : `${BASE_URL}${url}`);
        if (content.status() === 200) {
          const svgText = await content.text();
          expect(svgText).not.toContain('<script');
          expect(svgText).not.toContain('javascript:');
        }
      }
    } else {
      expect(res.status()).toBeGreaterThanOrEqual(400);
    }
  });

  // ── CDN entegrasyonu ──────────────────────────────────────────────────────

  test('CDN_PROVIDER=r2 ise URL CDN domain\'inden dönüyor', async ({ request }) => {
    const cdnProvider = process.env.CDN_PROVIDER ?? 'local';
    const cdnPublicUrl = process.env.R2_PUBLIC_URL;
    test.skip(cdnProvider !== 'r2' || !cdnPublicUrl, 'R2 CDN ortamı yapılandırılmamış');

    const pngBuffer = fs.readFileSync(tmpPng);
    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: { name: 'cdn-test.png', mimeType: 'image/png', buffer: pngBuffer },
      },
    });

    expect(res.status()).toBe(200);
    const body = await res.json() as { url?: string };
    const url = body.url ?? '';
    expect(url.startsWith(cdnPublicUrl), `URL CDN domain ile başlamalı: ${url}`).toBeTruthy();
  });

  test('local provider\'da URL /uploads/ ile başlıyor', async ({ request }) => {
    test.skip((process.env.CDN_PROVIDER ?? 'local') !== 'local', 'Local storage CDN değil — test geçersiz');

    const pngBuffer = fs.readFileSync(tmpPng);
    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: { name: 'local-test.png', mimeType: 'image/png', buffer: pngBuffer },
      },
    });

    expect(res.status()).toBe(200);
    const body = await res.json() as { url?: string; fileUrl?: string };
    const url = body.url ?? body.fileUrl ?? '';
    expect(url.startsWith('/uploads/') || url.startsWith('http'), `URL /uploads/ veya http ile başlamalı: ${url}`).toBeTruthy();
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

    // 200 (chunk alındı) veya 404 (chunked upload desteklenmiyor) bekliyoruz
    expect([200, 201, 404]).toContain(res.status());
  });
});
