// k6/load-realistic.js — Gerçekçi Yük Testi (Production Simülasyonu)
//
// ÖNEMLI: Bu test CI'da ÇALIŞTIRILMAZ. Gerçek bir staging/production
// ortamında manuel olarak tetiklenir.
//
// smoke.js (CI'daki) yalnızca 2 VU / 30s / localhost — bu değerler
// production performansını yansıtmaz. Bu script daha gerçekçi bir
// senaryo oluşturur.
//
// Çalıştırma örnekleri:
//   # Temel yük — 50 eş zamanlı kullanıcı, 5 dakika
//   BASE_URL=https://staging.bridge.example.com k6 run k6/load-realistic.js
//
//   # Spike testi — ani trafik artışı
//   BASE_URL=https://staging.bridge.example.com SCENARIO=spike k6 run k6/load-realistic.js
//
//   # Soak testi — uzun süreli dayanıklılık (30 dk)
//   BASE_URL=https://staging.bridge.example.com SCENARIO=soak k6 run k6/load-realistic.js
//
// NOT: Gerçek production metrikler için önce bir staging ortamı kurulması
// ve gerçek kullanıcı trafiği altında test edilmesi gerekir.
// Bu scriptin sonuçları baseline-summary.json'daki CI sonuçlarından
// önemli ölçüde farklı olabilir.

import http    from 'k6/http';
import ws      from 'k6/ws';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ── Özel metrikler ────────────────────────────────────────────
const errorRate       = new Rate('errors');
const authLatency     = new Trend('auth_latency_ms');
const messageLatency  = new Trend('message_latency_ms');
const wsConnections   = new Counter('ws_connections_total');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const SCENARIO = __ENV.SCENARIO || 'load';

// ── Senaryo konfigürasyonları ─────────────────────────────────
const SCENARIOS = {
  // Temel yük: 50 kullanıcı, 5 dakika
  load: {
    executor:   'ramping-vus',
    startVUs:   0,
    stages: [
      { duration: '1m',  target: 20  },  // Isınma
      { duration: '3m',  target: 50  },  // Hedef yük
      { duration: '1m',  target: 0   },  // Soğuma
    ],
  },
  // Spike: ani 200 kullanıcı artışı
  spike: {
    executor:   'ramping-vus',
    startVUs:   0,
    stages: [
      { duration: '30s', target: 10  },
      { duration: '10s', target: 200 },  // Spike
      { duration: '1m',  target: 200 },  // Yükte kal
      { duration: '30s', target: 10  },
      { duration: '30s', target: 0   },
    ],
  },
  // Soak: 30 dakika, 30 kullanıcı (bellek sızıntısı tespiti)
  soak: {
    executor:   'constant-vus',
    vus:        30,
    duration:   '30m',
  },
};

export const options = {
  scenarios: { [SCENARIO]: SCENARIOS[SCENARIO] || SCENARIOS.load },
  thresholds: {
    errors:                 ['rate<0.05'],     // %5'in altında hata
    http_req_failed:        ['rate<0.05'],
    http_req_duration:      ['p(95)<1000'],    // p95 < 1 saniye
    auth_latency_ms:        ['p(95)<500'],
    message_latency_ms:     ['p(95)<300'],
  },
};

// ── Test kullanıcıları ─────────────────────────────────────────
// Gerçek load testinde gerçek test hesapları kullanılmalı.
// TEST_USER_PREFIX ve TEST_USER_COUNT env ile konfig edin.
const USER_COUNT = parseInt(__ENV.TEST_USER_COUNT || '10');
const USER_PREFIX = __ENV.TEST_USER_PREFIX || 'loadtest_user_';

function randomUser() {
  const idx = Math.floor(Math.random() * USER_COUNT) + 1;
  return {
    username: `${USER_PREFIX}${idx}`,
    password: __ENV.TEST_USER_PASS || 'TestPass123!',
  };
}

// ── Ana test akışı ────────────────────────────────────────────
export default function () {
  const user = randomUser();
  let token = null;

  group('1. Kimlik Doğrulama', () => {
    const start = Date.now();
    const res = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({
      username: user.username,
      password: user.password,
    }), {
      headers: { 'Content-Type': 'application/json' },
      tags:    { name: 'auth_login' },
    });

    authLatency.add(Date.now() - start);

    const ok = check(res, {
      'login 200': r => r.status === 200,
      'token var': r => {
        try { return !!JSON.parse(r.body).token; } catch { return false; }
      },
    });

    if (!ok) { errorRate.add(1); return; }
    errorRate.add(0);
    token = JSON.parse(res.body).token;
  });

  if (!token) return;

  const headers = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  };

  group('2. Sunucu Listesi', () => {
    const res = http.get(`${BASE_URL}/api/servers`, { headers, tags: { name: 'servers_list' } });
    check(res, { 'servers 200': r => r.status === 200 });
    errorRate.add(res.status !== 200 ? 1 : 0);
    sleep(0.5);
  });

  group('3. Mesaj Okuma', () => {
    // Bu test için test kanalı ID'si env'den alınabilir
    const channelId = __ENV.TEST_CHANNEL_ID || 'test-channel-id';
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/channels/${channelId}/messages`, {
      headers,
      tags: { name: 'messages_read' },
    });
    messageLatency.add(Date.now() - start);
    // 404 beklenir (test kanalı yoksa) — bu durumda hata sayma
    errorRate.add(res.status >= 500 ? 1 : 0);
    sleep(1);
  });

  group('4. Sağlık Kontrolü', () => {
    const res = http.get(`${BASE_URL}/api/health`, { tags: { name: 'health' } });
    check(res, { 'health 200': r => r.status === 200 });
    errorRate.add(res.status !== 200 ? 1 : 0);
  });

  sleep(Math.random() * 2 + 1); // 1-3 saniye düşünme süresi
}

export function handleSummary(data) {
  // Sonuçları kaydet
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    [`k6/results/load-${SCENARIO}-${timestamp}.json`]: JSON.stringify(data, null, 2),
    stdout: `\n📊 ${SCENARIO.toUpperCase()} TEST TAMAMLANDI\n`,
  };
}
