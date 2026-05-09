// k6/messages-load.js — /api/messages Yük Testi
// Gerçekçi kullanıcı davranışı: login → sunucu al → mesaj gönder/oku
//
// Kurulum:
//   brew install k6               # macOS
//   sudo apt-get install k6       # Ubuntu
//   docker run -i grafana/k6 run  # Docker
//
// Çalıştırma:
//   BASE_URL=http://localhost:3000 \
//   TEST_EMAIL=admin@test.com \
//   TEST_PASS=sifre123 \
//   k6 run k6/messages-load.js
//
//   # HTML raporu ile:
//   k6 run --out json=k6-results.json k6/messages-load.js
//
// Senaryolar:
//   smoke:    2 VU, 1 dakika  — hız doğrulama
//   load:     50 VU, 5 dakika — normal yük
//   stress:   200 VU, 10 dak  — stres testi
//   spike:    0→500→0 VU       — ani trafik artışı

import http from 'k6/http';
import ws from 'k6/ws';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// ── Özel Metrikler ────────────────────────────────────────
const errorRate      = new Rate('error_rate');
const msgSendTime    = new Trend('msg_send_duration_ms');
const msgFetchTime   = new Trend('msg_fetch_duration_ms');
const wsConnectTime  = new Trend('ws_connect_duration_ms');
const failedRequests = new Counter('failed_requests');

// ── Konfigürasyon ─────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WS_URL   = BASE_URL.replace('http', 'ws');

// Senaryo seçimi: SCENARIO=smoke|load|stress|spike
const SCENARIO = __ENV.SCENARIO || 'load';

// ── Test Senaryoları ──────────────────────────────────────
const scenarios = {
  smoke: {
    executor: 'constant-vus',
    vus: 2,
    duration: '1m',
    tags: { scenario: 'smoke' },
  },
  load: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 10  }, // ısınma
      { duration: '2m',  target: 50  }, // normal yük
      { duration: '1m',  target: 100 }, // yüksek yük
      { duration: '30s', target: 0   }, // soğuma
    ],
    tags: { scenario: 'load' },
  },
  stress: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m',  target: 50  },
      { duration: '2m',  target: 100 },
      { duration: '2m',  target: 200 },
      { duration: '2m',  target: 300 }, // limit zorla
      { duration: '1m',  target: 0   },
    ],
    tags: { scenario: 'stress' },
  },
  spike: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '10s', target: 5   }, // normal
      { duration: '30s', target: 500 }, // ani spike
      { duration: '1m',  target: 500 }, // spike devam
      { duration: '10s', target: 5   }, // geri dön
      { duration: '30s', target: 0   },
    ],
    tags: { scenario: 'spike' },
  },
};

export const options = {
  scenarios: {
    main: scenarios[SCENARIO],
  },
  thresholds: {
    // %95 istek 500ms altında
    http_req_duration: ['p(95)<500', 'p(99)<2000'],
    // Hata oranı %5 altında
    error_rate: ['rate<0.05'],
    // Mesaj gönderme %95 200ms altında
    msg_send_duration_ms: ['p(95)<200'],
    // Mesaj okuma %95 300ms altında
    msg_fetch_duration_ms: ['p(95)<300'],
    // HTTP başarısız istek sayısı
    http_req_failed: ['rate<0.05'],
  },
};

// ── Setup: Tek seferlik login ve test verisi ──────────────
export function setup() {
  const email    = __ENV.TEST_EMAIL || 'e2e_alice@bridge-e2e.test';
  const password = __ENV.TEST_PASS  || 'E2eTestPass123!';

  const loginRes = http.post(
    `${BASE_URL}/api/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(loginRes, { 'setup: login 200': (r) => r.status === 200 });

  if (loginRes.status !== 200) {
    console.error('Login başarısız! Status:', loginRes.status, loginRes.body);
    return {};
  }

  const body = loginRes.json();
  const token = body.token || body.accessToken;

  // Sunucu listesini al
  const serversRes = http.get(`${BASE_URL}/api/servers`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  let channelId = null;
  if (serversRes.status === 200) {
    const servers = serversRes.json();
    const serverList = servers.servers || servers;
    if (serverList.length > 0) {
      const serverId = serverList[0]._id || serverList[0].id;
      const chRes = http.get(`${BASE_URL}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (chRes.status === 200) {
        const channels = chRes.json();
        const chList = channels.channels || channels;
        const textCh = chList.find((c) => c.type === 'text' || !c.type);
        if (textCh) channelId = textCh._id || textCh.id;
      }
    }
  }

  console.log(`Setup tamamlandı. Kanal ID: ${channelId}`);
  return { token, channelId };
}

// ── Ana Test Fonksiyonu ───────────────────────────────────
export default function main(data) {
  if (!data.token) {
    console.warn('Token yok, test atlanıyor');
    sleep(1);
    return;
  }

  const headers = {
    Authorization: `Bearer ${data.token}`,
    'Content-Type': 'application/json',
  };

  // VU bazlı rastgele davranış dağılımı
  const behavior = Math.random();

  if (behavior < 0.4) {
    // %40: Mesaj oku (en yaygın işlem)
    group('Mesaj Okuma', () => {
      if (!data.channelId) return;

      const start = Date.now();
      const res = http.get(
        `${BASE_URL}/api/channels/${data.channelId}/messages?limit=20`,
        { headers }
      );
      msgFetchTime.add(Date.now() - start);

      const ok = check(res, {
        'mesaj fetch 200': (r) => r.status === 200,
        'mesajlar dizi': (r) => {
          try {
            const d = r.json();
            return Array.isArray(d.messages || d);
          } catch { return false; }
        },
      });

      if (!ok) { errorRate.add(1); failedRequests.add(1); }
      else errorRate.add(0);
    });

  } else if (behavior < 0.65) {
    // %25: Mesaj gönder
    group('Mesaj Gönderme', () => {
      if (!data.channelId) return;

      const content = `k6 test mesajı ${Date.now()} - VU ${__VU} iter ${__ITER}`;
      const start = Date.now();

      const res = http.post(
        `${BASE_URL}/api/channels/${data.channelId}/messages`,
        JSON.stringify({ content }),
        { headers }
      );
      msgSendTime.add(Date.now() - start);

      const ok = check(res, {
        'mesaj gönder 200': (r) => r.status === 200,
        'mesaj ID döndü': (r) => {
          try {
            const d = r.json();
            return !!(d._id || d.id || d.message?._id);
          } catch { return false; }
        },
      });

      if (!ok) { errorRate.add(1); failedRequests.add(1); }
      else errorRate.add(0);
    });

  } else if (behavior < 0.80) {
    // %15: Sunucu/kanal listesi
    group('Sunucu & Kanal Listesi', () => {
      const res = http.get(`${BASE_URL}/api/servers`, { headers });
      const ok = check(res, { 'sunucu listesi 200': (r) => r.status === 200 });
      if (!ok) { errorRate.add(1); failedRequests.add(1); }
      else errorRate.add(0);
    });

  } else if (behavior < 0.90) {
    // %10: Profil / Me
    group('Kullanıcı Profili', () => {
      const res = http.get(`${BASE_URL}/api/me`, { headers });
      const ok = check(res, { '/api/me 200': (r) => r.status === 200 });
      if (!ok) { errorRate.add(1); failedRequests.add(1); }
      else errorRate.add(0);
    });

  } else {
    // %10: Health check
    group('Health Check', () => {
      const res = http.get(`${BASE_URL}/api/health`);
      const ok = check(res, { 'health 200': (r) => r.status === 200 });
      if (!ok) { errorRate.add(1); failedRequests.add(1); }
      else errorRate.add(0);
    });
  }

  // Gerçekçi kullanıcı davranışı: 0.5–2 sn bekle
  sleep(0.5 + Math.random() * 1.5);
}

// ── Teardown ──────────────────────────────────────────────
export function teardown(data) {
  console.log('\n📊 K6 Yük Testi Tamamlandı');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Senaryo: ${SCENARIO}`);
}
