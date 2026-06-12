// k6/smoke.js — CI Smoke Load Test
// Yalnızca CI pipeline için: hafif, hızlı (< 60s), kritik endpoint'leri doğrular.
// Tam yük testleri için k6/messages-load.js ve k6/websocket-load.js kullanın.
//
// Çalıştırma (lokal):
//   BASE_URL=http://localhost:3000 k6 run k6/smoke.js
//
// CI'da tetikleme (bkz. .github/workflows/ci.yml — load-test job):
//   Sadece main/develop branch'larında çalışır, staging ortamında.

import http  from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ── Özel metrikler ────────────────────────────────────────────────────────────

const errorRate    = new Rate('smoke_errors');
const responseTime = new Trend('smoke_response_ms');

// ── Konfigürasyon ─────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  // CI smoke: 2 VU, 30 saniye — hızlı ve güvenilir
  scenarios: {
    smoke: {
      executor:  'constant-vus',
      vus:       2,
      duration:  '30s',
    },
  },
  thresholds: {
    // Hata oranı %5'in altında olmalı
    smoke_errors:        ['rate<0.05'],
    // %95'lik yanıt süresi 2 saniye altında olmalı
    smoke_response_ms:   ['p(95)<2000'],
    // HTTP hata oranı %5'in altında
    http_req_failed:     ['rate<0.05'],
    // Ortalama yanıt süresi 1 saniye altında
    http_req_duration:   ['avg<1000'],
  },
};

// ── Test senaryoları ──────────────────────────────────────────────────────────

export default function () {
  // 1. Health check — sunucu canlı mı?
  {
    const res = http.get(`${BASE_URL}/api/health`);
    responseTime.add(res.timings.duration);
    const ok = check(res, {
      'health: status 200':    (r) => r.status === 200,
      'health: body var':      (r) => r.body && r.body.length > 0,
      'health: status field':  (r) => {
        try { return JSON.parse(r.body).status !== undefined; }
        catch { return false; }
      },
    });
    if (!ok) errorRate.add(1);
    else     errorRate.add(0);
  }

  sleep(0.5);

  // 2. Discovery endpoint — sunucu keşfi
  {
    const res = http.get(`${BASE_URL}/api/discover`);
    responseTime.add(res.timings.duration);
    const ok = check(res, {
      'discover: status 200 veya 401': (r) => r.status === 200 || r.status === 401,
      'discover: JSON döndü':          (r) => {
        try { JSON.parse(r.body); return true; }
        catch { return false; }
      },
    });
    if (!ok) errorRate.add(1);
    else     errorRate.add(0);
  }

  sleep(0.5);

  // 3. Static assets — client dağıtımı çalışıyor mu?
  {
    const res = http.get(`${BASE_URL}/`);
    responseTime.add(res.timings.duration);
    const ok = check(res, {
      'index: status 200':     (r) => r.status === 200,
      'index: HTML döndü':     (r) => (r.headers['Content-Type'] || '').includes('text/html'),
    });
    if (!ok) errorRate.add(1);
    else     errorRate.add(0);
  }

  sleep(0.5);

  // 4. Federation info — federasyon endpoint'i
  {
    const res = http.get(`${BASE_URL}/api/federation/info`);
    responseTime.add(res.timings.duration);
    const ok = check(res, {
      'federation: status 200': (r) => r.status === 200,
      'federation: name field': (r) => {
        try { return JSON.parse(r.body).name !== undefined; }
        catch { return false; }
      },
    });
    if (!ok) errorRate.add(1);
    else     errorRate.add(0);
  }

  sleep(1);

  // 5. API auth endpoint — kayıt/giriş formu yükleniyor mu?
  {
    const res = http.post(
      `${BASE_URL}/api/auth/login`,
      JSON.stringify({ username: '__smoke_nonexistent__', password: 'wrong' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    responseTime.add(res.timings.duration);
    const ok = check(res, {
      'login: status 400 veya 401': (r) => r.status === 400 || r.status === 401 || r.status === 429,
      'login: JSON hata döndü':     (r) => {
        try { JSON.parse(r.body); return true; }
        catch { return false; }
      },
    });
    if (!ok) errorRate.add(1);
    else     errorRate.add(0);
  }

  sleep(1);
}

// ── Summary ───────────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const passed  = Object.values(data.metrics.smoke_errors?.values ?? {}).every(v => v < 0.05);
  const p95     = data.metrics.smoke_response_ms?.values?.['p(95)'] ?? 0;
  const errRate = (data.metrics.smoke_errors?.values?.rate ?? 0) * 100;

  console.log('\n══════════════════════════════════════');
  console.log('  Bridge CI Smoke Test Sonuçları');
  console.log('══════════════════════════════════════');
  console.log(`  Hata Oranı   : ${errRate.toFixed(1)}%  (eşik: <5%)`);
  console.log(`  P95 Yanıt    : ${p95.toFixed(0)}ms  (eşik: <2000ms)`);
  console.log(`  Sonuç        : ${passed ? '✅ BAŞARILI' : '❌ BAŞARISIZ'}`);
  console.log('══════════════════════════════════════\n');

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
