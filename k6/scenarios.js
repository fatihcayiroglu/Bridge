// k6/scenarios.js — Bridge Birleşik Yük Test Senaryoları
// Sprint 111: Tüm senaryolar tek dosyada — ortam değişkeniyle seçilir.
//
// Kullanım:
//   SCENARIO=smoke   BASE_URL=http://localhost:3000 k6 run k6/scenarios.js
//   SCENARIO=load    BASE_URL=http://localhost:3000 k6 run k6/scenarios.js
//   SCENARIO=stress  BASE_URL=http://localhost:3000 k6 run k6/scenarios.js
//   SCENARIO=spike   BASE_URL=http://localhost:3000 k6 run k6/scenarios.js
//   SCENARIO=soak    BASE_URL=http://localhost:3000 k6 run k6/scenarios.js
//
// Kimlik doğrulama:
//   TEST_EMAIL=admin@test.com TEST_PASS=sifre123 k6 run ...
//
// Grafana Cloud çıktısı:
//   k6 run --out cloud k6/scenarios.js
//
// JSON raporu:
//   k6 run --out json=k6-results.json k6/scenarios.js

import http          from 'k6/http';
import ws            from 'k6/ws';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';
import { SharedArray }  from 'k6/data';
import { randomIntBetween, randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// ── Özel Metrikler ─────────────────────────────────────────────────────────────

const errorRate       = new Rate('bridge_errors');
const apiLatency      = new Trend('bridge_api_ms', true);
const wsLatency       = new Trend('bridge_ws_ms',  true);
const msgSent         = new Counter('bridge_messages_sent');
const activeUsers     = new Gauge('bridge_active_users');

// ── Konfigürasyon ──────────────────────────────────────────────────────────────

const BASE_URL  = __ENV.BASE_URL  || 'http://localhost:3000';
const SCENARIO  = __ENV.SCENARIO  || 'smoke';
const EMAIL     = __ENV.TEST_EMAIL || 'loadtest@bridge.local';
const PASSWORD  = __ENV.TEST_PASS  || 'LoadTest_Sifre123!';

// ── Senaryo Tanımları ──────────────────────────────────────────────────────────

const SCENARIOS = {
  // Smoke: Hızlı doğrulama — CI'da kullanılır (30s, 2 VU)
  smoke: {
    scenarios: {
      smoke: {
        executor: 'constant-vus',
        vus:      2,
        duration: '30s',
        tags:     { scenario: 'smoke' },
      },
    },
    thresholds: {
      bridge_errors:      ['rate<0.05'],
      bridge_api_ms:      ['p(95)<2000'],
      http_req_failed:    ['rate<0.05'],
      http_req_duration:  ['p(95)<2000'],
    },
  },

  // Load: Normal üretim yükü (5dk ramp-up, 10dk sabit, 3dk ramp-down)
  load: {
    scenarios: {
      api_load: {
        executor:          'ramping-vus',
        startVUs:          0,
        stages: [
          { duration: '5m',  target: 50  },   // ramp-up
          { duration: '10m', target: 50  },   // sabit yük
          { duration: '3m',  target: 0   },   // ramp-down
        ],
        tags: { scenario: 'load', type: 'api' },
      },
      ws_load: {
        executor:          'constant-vus',
        vus:               20,
        duration:          '18m',
        startTime:         '0s',
        tags: { scenario: 'load', type: 'websocket' },
        exec: 'wsScenario',
      },
    },
    thresholds: {
      bridge_errors:      ['rate<0.01'],           // %1 hata
      bridge_api_ms:      ['p(95)<1000', 'p(99)<2000'],
      bridge_ws_ms:       ['p(95)<500'],
      http_req_failed:    ['rate<0.01'],
      http_req_duration:  ['p(95)<1000'],
    },
  },

  // Stress: Maksimum kapasite bulma (kademeli artış)
  stress: {
    scenarios: {
      stress: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '2m',  target: 50  },
          { duration: '3m',  target: 100 },
          { duration: '3m',  target: 200 },
          { duration: '3m',  target: 300 },
          { duration: '2m',  target: 400 },
          { duration: '3m',  target: 0   },  // ramp-down
        ],
        tags: { scenario: 'stress' },
      },
    },
    thresholds: {
      bridge_errors:      ['rate<0.10'],           // stres altında %10 kabul
      bridge_api_ms:      ['p(95)<3000'],
      http_req_failed:    ['rate<0.10'],
      http_req_duration:  ['p(95)<3000'],
    },
  },

  // Spike: Ani trafik artışı — 0 → 500 VU → 0
  spike: {
    scenarios: {
      spike: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '10s', target: 10  },  // ısınma
          { duration: '1m',  target: 10  },  // normal
          { duration: '10s', target: 500 },  // ani artış
          { duration: '3m',  target: 500 },  // pik sabit
          { duration: '10s', target: 10  },  // ani düşüş
          { duration: '3m',  target: 10  },  // toparlanma
          { duration: '10s', target: 0   },
        ],
        tags: { scenario: 'spike' },
      },
    },
    thresholds: {
      bridge_errors:      ['rate<0.15'],           // pik sırasında %15 kabul
      http_req_failed:    ['rate<0.15'],
      http_req_duration:  ['p(95)<5000'],
    },
  },

  // Soak: Uzun süreli dayanıklılık testi (2 saat)
  soak: {
    scenarios: {
      soak: {
        executor: 'constant-vus',
        vus:      20,
        duration: '2h',
        tags:     { scenario: 'soak' },
      },
    },
    thresholds: {
      bridge_errors:      ['rate<0.005'],          // uzun sürede %0.5 hata
      bridge_api_ms:      ['p(95)<1500'],
      http_req_failed:    ['rate<0.005'],
      http_req_duration:  ['p(95)<1500'],
    },
  },
};

// Aktif senaryoyu seç
const activeScenario = SCENARIOS[SCENARIO] || SCENARIOS.smoke;
export const options = {
  ...activeScenario,
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

// ── Yardımcı Fonksiyonlar ──────────────────────────────────────────────────────

function apiHeaders(token) {
  return {
    'Content-Type':  'application/json',
    'Authorization': token ? `Bearer ${token}` : '',
  };
}

function record(res, name) {
  const ok = res.status >= 200 && res.status < 400;
  errorRate.add(!ok);
  apiLatency.add(res.timings.duration, { endpoint: name });
  return ok;
}

// ── Kimlik Doğrulama ──────────────────────────────────────────────────────────

export function setup() {
  // Yük testi kullanıcısını giriş yaptır
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (loginRes.status !== 200) {
    console.warn(`[setup] Giriş başarısız (${loginRes.status}) — token'sız devam`);
    return { token: null, serverId: null };
  }

  const body    = JSON.parse(loginRes.body);
  const token   = body.token || body.accessToken;

  // İlk sunucuyu al
  const srvRes  = http.get(`${BASE_URL}/api/servers`, { headers: apiHeaders(token) });
  const servers = srvRes.status === 200 ? JSON.parse(srvRes.body) : [];
  const serverId = Array.isArray(servers) && servers.length > 0 ? servers[0]._id : null;

  return { token, serverId };
}

// ── Ana Senaryo (API) ──────────────────────────────────────────────────────────

export default function main(data) {
  const { token, serverId } = data;
  const headers = apiHeaders(token);

  activeUsers.add(1);

  group('Health Check', () => {
    const res = http.get(`${BASE_URL}/api/health`, { headers });
    check(res, { 'health 200': r => r.status === 200 });
    record(res, 'health');
  });

  sleep(randomIntBetween(1, 3));

  group('Server Listesi', () => {
    const res = http.get(`${BASE_URL}/api/servers`, { headers });
    check(res, { 'servers 200': r => r.status === 200 });
    record(res, 'servers');
  });

  sleep(randomIntBetween(1, 2));

  if (serverId) {
    group('Mesaj Gönder', () => {
      // Önce kanalları al
      const chRes = http.get(`${BASE_URL}/api/servers/${serverId}/channels`, { headers });
      if (chRes.status !== 200) return;
      const channels = JSON.parse(chRes.body);
      const textCh   = (Array.isArray(channels) ? channels : []).find(c => c.type === 'text');
      if (!textCh) return;

      const msgRes = http.post(
        `${BASE_URL}/api/messages`,
        JSON.stringify({ channelId: textCh._id, content: `Yük testi mesajı #${randomString(6)}` }),
        { headers },
      );
      check(msgRes, { 'message 201': r => r.status === 201 || r.status === 200 });
      if (record(msgRes, 'message')) msgSent.add(1);
    });

    sleep(randomIntBetween(2, 5));

    group('Keşif', () => {
      const res = http.get(`${BASE_URL}/api/discover?sort=members&limit=10`, { headers });
      check(res, { 'discover 200': r => r.status === 200 });
      record(res, 'discover');
    });
  }

  sleep(randomIntBetween(1, 3));
  activeUsers.add(-1);
}

// ── WebSocket Senaryosu ────────────────────────────────────────────────────────

export function wsScenario(data) {
  const { token, serverId } = data;
  if (!token || !serverId) return;

  const url  = BASE_URL.replace('http', 'ws') + `/socket.io/?EIO=4&transport=websocket&token=${token}`;
  const start = Date.now();

  const res = ws.connect(url, { headers: { 'Authorization': `Bearer ${token}` } }, (socket) => {
    socket.on('open', () => {
      wsLatency.add(Date.now() - start, { event: 'connect' });
      // Socket.IO handshake
      socket.send('40');
    });

    socket.on('message', (data) => {
      // Socket.IO ping/pong yönetimi
      if (data === '2') socket.send('3');
    });

    socket.on('error', (e) => {
      errorRate.add(1);
    });

    // 10-30 saniye bağlı kal
    sleep(randomIntBetween(10, 30));
    socket.close();
  });

  check(res, { 'ws bağlantı kuruldu': r => r && r.status === 101 });
}

// ── Teardown ───────────────────────────────────────────────────────────────────

export function teardown(data) {
  console.log(`[teardown] Senaryo: ${SCENARIO}, Token: ${data.token ? 'var' : 'yok'}`);
}

// ── Özet Rapor ─────────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const passed  = Object.values(data.metrics).every(m => !m.thresholds || Object.values(m.thresholds).every(t => t.ok));
  const summary = {
    scenario:    SCENARIO,
    baseUrl:     BASE_URL,
    passed,
    duration:    data.state.testRunDurationMs,
    vus_max:     data.metrics.vus_max?.values?.value ?? 0,
    errors:      data.metrics.bridge_errors?.values?.rate ?? 0,
    p95_ms:      data.metrics.bridge_api_ms?.values?.['p(95)'] ?? 0,
    msgs_sent:   data.metrics.bridge_messages_sent?.values?.count ?? 0,
    thresholds:  Object.fromEntries(
      Object.entries(data.metrics)
        .filter(([, m]) => m.thresholds)
        .map(([name, m]) => [name, Object.values(m.thresholds).every(t => t.ok) ? '✅' : '❌'])
    ),
  };

  return {
    'k6-summary.json': JSON.stringify(summary, null, 2),
    stdout: `
══════════════════════════════════════
  Bridge k6 — ${SCENARIO.toUpperCase()} SONUÇLARI
══════════════════════════════════════
  Sonuç:   ${passed ? '✅ BAŞARILI' : '❌ BAŞARISIZ'}
  Süre:    ${(summary.duration / 1000).toFixed(0)}s
  Max VU:  ${summary.vus_max}
  Hata:    %${(summary.errors * 100).toFixed(2)}
  p95 API: ${summary.p95_ms.toFixed(0)}ms
  Mesaj:   ${summary.msgs_sent} gönderildi

  Eşik Sonuçları:
${Object.entries(summary.thresholds).map(([k,v]) => `  ${v} ${k}`).join('\n')}
══════════════════════════════════════
`,
  };
}
