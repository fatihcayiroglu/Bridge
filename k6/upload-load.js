// k6/upload-load.js — /api/upload Yük Testi
// Dosya yükleme endpoint'inin yük altındaki davranışı
//
// Çalıştırma:
//   BASE_URL=http://localhost:3000 k6 run k6/upload-load.js
//
// Ölçülen değerler:
//   - Upload throughput (MB/s)
//   - Concurrent upload limiti
//   - Large file davranışı
//   - Rate limit etkinliği

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { randomBytes } from 'k6/crypto';

// ── Özel Metrikler ────────────────────────────────────────
const uploadSuccessRate  = new Rate('upload_success_rate');
const uploadDuration     = new Trend('upload_duration_ms');
const uploadThroughput   = new Trend('upload_throughput_kbps');
const rateLimitHits      = new Counter('upload_rate_limit_hits');
const uploadErrors       = new Counter('upload_errors');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    // Senaryo 1: Normal upload yükü
    normal_uploads: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 5  },
        { duration: '2m',  target: 20 },
        { duration: '1m',  target: 30 },
        { duration: '30s', target: 0  },
      ],
      exec: 'normalUpload',
      tags: { type: 'normal' },
    },
    // Senaryo 2: Büyük dosya yükleme (az VU)
    large_file_uploads: {
      executor: 'constant-vus',
      vus: 3,
      duration: '3m',
      exec: 'largeUpload',
      tags: { type: 'large' },
      startTime: '30s', // normal başladıktan sonra
    },
  },
  thresholds: {
    upload_success_rate: ['rate>0.85'],          // %85 başarı
    upload_duration_ms: ['p(95)<5000'],          // %95 5sn altında
    upload_rate_limit_hits: ['count<50'],        // Rate limit çok sık çalışmamalı
    http_req_failed: ['rate<0.15'],
  },
};

// ── Küçük test dosyası üret ───────────────────────────────
function makeImageFile(sizeKB = 50) {
  // Gerçekçi PNG header + random body
  const pngHeader = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
  ]);

  // Geri kalan rastgele bytes
  const totalBytes = sizeKB * 1024;
  const content = new Uint8Array(totalBytes);
  content.set(pngHeader);

  return http.file(content, `test-${Date.now()}.png`, 'image/png');
}

function makeTextFile(sizeKB = 10) {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 \n';
  for (let i = 0; i < sizeKB * 1024; i++) {
    text += chars[Math.floor(Math.random() * chars.length)];
  }
  return http.file(text, `test-${Date.now()}.txt`, 'text/plain');
}

export function setup() {
  const res = http.post(
    `${BASE_URL}/api/login`,
    JSON.stringify({
      email: __ENV.TEST_EMAIL || 'e2e_alice@bridge-e2e.test',
      password: __ENV.TEST_PASS || 'E2eTestPass123!',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(res, { 'setup login 200': (r) => r.status === 200 });
  if (res.status !== 200) return {};

  const body = res.json();
  return { token: body.token || body.accessToken };
}

// ── Senaryo 1: Normal boyut upload (50-200KB) ─────────────
export function normalUpload(data) {
  if (!data.token) { sleep(1); return; }

  const fileTypes = ['image', 'text'];
  const type = fileTypes[Math.floor(Math.random() * fileTypes.length)];
  const sizeKB = 50 + Math.floor(Math.random() * 150); // 50-200 KB

  const file = type === 'image' ? makeImageFile(sizeKB) : makeTextFile(sizeKB);

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/api/upload`,
    { file },
    {
      headers: { Authorization: `Bearer ${data.token}` },
      timeout: '30s',
    }
  );
  const duration = Date.now() - start;

  uploadDuration.add(duration);

  if (res.status === 200) {
    uploadSuccessRate.add(true);
    const throughputKbps = (sizeKB / duration) * 1000;
    uploadThroughput.add(throughputKbps);

    check(res, {
      'upload URL döndü': (r) => {
        try {
          const d = r.json();
          return !!(d.url || d.fileUrl || d.path);
        } catch { return false; }
      },
    });
  } else if (res.status === 429) {
    uploadSuccessRate.add(false);
    rateLimitHits.add(1);
    sleep(2); // Rate limit sonrası bekle
  } else {
    uploadSuccessRate.add(false);
    uploadErrors.add(1);
  }

  sleep(1 + Math.random() * 2);
}

// ── Senaryo 2: Büyük dosya upload (1-5MB) ────────────────
export function largeUpload(data) {
  if (!data.token) { sleep(5); return; }

  const sizeKB = 1024 + Math.floor(Math.random() * 4096); // 1-5 MB
  const file = makeImageFile(sizeKB);

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/api/upload`,
    { file },
    {
      headers: { Authorization: `Bearer ${data.token}` },
      timeout: '60s',
    }
  );
  const duration = Date.now() - start;

  uploadDuration.add(duration);

  if (res.status === 200) {
    uploadSuccessRate.add(true);
    const throughputKbps = (sizeKB / duration) * 1000;
    uploadThroughput.add(throughputKbps);
    console.log(`Büyük upload OK: ${sizeKB}KB, ${duration}ms, ${throughputKbps.toFixed(1)} KB/s`);
  } else if (res.status === 413) {
    // Dosya çok büyük — bu beklenen davranış
    uploadSuccessRate.add(true); // Doğru davranış
    console.log(`Büyük dosya reddedildi (413) — beklenen: ${sizeKB}KB`);
  } else if (res.status === 429) {
    rateLimitHits.add(1);
    sleep(5);
  } else {
    uploadSuccessRate.add(false);
    uploadErrors.add(1);
    console.warn(`Upload hata: ${res.status}, ${sizeKB}KB`);
  }

  // Büyük dosya yüklemesi arası daha uzun bekle
  sleep(5 + Math.random() * 10);
}
