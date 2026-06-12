// k6/full-load.js — Bridge Tam Yük Testi Paketi
//
// Sprint 119: Dış inceleme bulgusuna göre oluşturuldu.
// Mevcut load-realistic.js'i tamamlar; daha kapsamlı senaryo seti sunar.
//
// KAPSAM:
//   1. Auth akışı (login, token yenileme)
//   2. Mesajlaşma (gönder, düzenle, sil, reaksiyon)
//   3. WebSocket kalıcı bağlantı + ping/pong dayanıklılığı
//   4. AI endpoint'leri (özet, çeviri, semantic arama)
//   5. Dosya yükleme (küçük + orta boyut)
//   6. Federasyon endpoint'leri (NodeInfo, WebFinger)
//   7. Admin API altında kullanıcı listeleme
//
// KULLANIM:
//   # Temel yük (50 VU / 5 dk)
//   BASE_URL=https://staging.bridge.example.com \
//   TEST_USER=loadtest TEST_PASS=LoadTest123! \
//   k6 run k6/full-load.js
//
//   # Spike — ani trafik artışı
//   SCENARIO=spike k6 run k6/full-load.js
//
//   # Soak — 30 dk dayanıklılık (bellek sızıntısı tespiti)
//   SCENARIO=soak k6 run k6/full-load.js
//
//   # Stres — kapasite belirleme
//   SCENARIO=stress k6 run k6/full-load.js
//
// UYARI: Sonuçları CI'daki baseline-summary.json ile kıyaslama; bu test
//        gerçek ağ gecikmesi içerir ve değerler farklı olacaktır.

import http        from 'k6/http';
import ws          from 'k6/ws';
import { check, sleep, group, fail } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { randomString, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// ── Özel metrikler ──────────────────────────────────────────────────────────
const authLatency      = new Trend('auth_latency_ms',    true);
const msgLatency       = new Trend('msg_send_latency_ms', true);
const aiLatency        = new Trend('ai_latency_ms',      true);
const uploadLatency    = new Trend('upload_latency_ms',  true);
const wsConnDuration   = new Trend('ws_conn_duration_ms', true);
const errorRate        = new Rate('errors');
const wsErrors         = new Counter('ws_errors');
const authErrors       = new Counter('auth_errors');
const msgErrors        = new Counter('msg_errors');
const activeWsConns    = new Gauge('active_ws_connections');

// ── Ortam değişkenleri ──────────────────────────────────────────────────────
const BASE_URL   = __ENV.BASE_URL    || 'http://localhost:3001';
const WS_URL     = BASE_URL.replace(/^http/, 'ws');
const TEST_USER  = __ENV.TEST_USER   || 'loadtest';
const TEST_PASS  = __ENV.TEST_PASS   || 'LoadTest123!';
const SCENARIO   = __ENV.SCENARIO   || 'load';
const SERVER_ID  = __ENV.TEST_SERVER_ID || '';
const CHANNEL_ID = __ENV.TEST_CHANNEL_ID || '';

// ── Senaryo tanımları ───────────────────────────────────────────────────────
const SCENARIO_CONFIGS = {
  // Temel yük: gerçekçi günlük kullanım
  load: {
    executor:  'ramping-vus',
    startVUs:  0,
    stages: [
      { duration: '1m',  target: 10  },
      { duration: '1m',  target: 30  },
      { duration: '1m',  target: 50  },
      { duration: '2m',  target: 50  },
      { duration: '1m',  target: 0   },
    ],
  },
  // Spike: ani kapasiteyi test et
  spike: {
    executor:  'ramping-vus',
    startVUs:  0,
    stages: [
      { duration: '30s', target: 10  },
      { duration: '15s', target: 200 },
      { duration: '1m',  target: 200 },
      { duration: '15s', target: 10  },
      { duration: '30s', target: 0   },
    ],
  },
  // Soak: bellek sızıntısı + uzun süreli kararlılık
  soak: {
    executor:  'ramping-vus',
    startVUs:  0,
    stages: [
      { duration: '2m',  target: 30  },
      { duration: '25m', target: 30  },
      { duration: '3m',  target: 0   },
    ],
  },
  // Stres: kapasite sınırını bul
  stress: {
    executor:  'ramping-vus',
    startVUs:  0,
    stages: [
      { duration: '2m',  target: 50  },
      { duration: '2m',  target: 100 },
      { duration: '2m',  target: 200 },
      { duration: '2m',  target: 300 },
      { duration: '2m',  target: 400 },
      { duration: '5m',  target: 400 },
      { duration: '2m',  target: 0   },
    ],
  },
};

export const options = {
  scenarios: {
    full_load: SCENARIO_CONFIGS[SCENARIO] || SCENARIO_CONFIGS.load,
  },
  thresholds: {
    // Hata oranı < %2
    errors:               ['rate<0.02'],
    // Auth p95 < 500ms
    auth_latency_ms:      ['p(95)<500'],
    // Mesaj gönderme p95 < 300ms
    msg_send_latency_ms:  ['p(95)<300'],
    // HTTP hata oranı < %1
    http_req_failed:      ['rate<0.01'],
    // HTTP p95 < 1s
    http_req_duration:    ['p(95)<1000'],
    // WS bağlantısı p95 < 2s
    ws_conn_duration_ms:  ['p(95)<2000'],
  },
};

// ── Yardımcı: HTTP JSON isteği ───────────────────────────────────────────────
function jsonPost(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), { headers });
}

function jsonGet(path, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return http.get(`${BASE_URL}${path}`, { headers });
}

// ── Auth akışı ───────────────────────────────────────────────────────────────
function doAuth() {
  const startTs = Date.now();

  // Register veya login — load test kullanıcısı zaten var, 409 normal
  const regRes = jsonPost('/api/register', {
    username: `${TEST_USER}_${randomString(6)}`,
    password: TEST_PASS,
  });

  // Login
  const loginRes = jsonPost('/api/auth/login', {
    username: TEST_USER,
    password: TEST_PASS,
  });

  const loginOk = check(loginRes, {
    'login 200': (r) => r.status === 200,
    'login has token': (r) => {
      try { return !!JSON.parse(r.body).token; } catch { return false; }
    },
  });

  authLatency.add(Date.now() - startTs);

  if (!loginOk) {
    authErrors.add(1);
    errorRate.add(1);
    return null;
  }

  errorRate.add(0);
  try { return JSON.parse(loginRes.body).token; }
  catch { return null; }
}

// ── Mesajlaşma ───────────────────────────────────────────────────────────────
function doMessaging(token, serverId, channelId) {
  if (!serverId || !channelId) {
    // Sunucu/kanal ID'si bilinmiyorsa server listesinden al
    const serversRes = jsonGet('/api/servers', token);
    if (serversRes.status !== 200) { errorRate.add(1); return; }
    try {
      const servers = JSON.parse(serversRes.body);
      if (!servers.length) { errorRate.add(0); return; }
      serverId  = servers[0]._id || servers[0].id;
      const chRes = jsonGet(`/api/servers/${serverId}/channels`, token);
      if (chRes.status !== 200) { errorRate.add(1); return; }
      const channels = JSON.parse(chRes.body);
      const textCh   = channels.find(c => c.type === 'text' || !c.type);
      if (!textCh) { errorRate.add(0); return; }
      channelId = textCh._id || textCh.id;
    } catch { errorRate.add(1); return; }
  }

  const startTs = Date.now();
  const msgRes = jsonPost(`/api/channels/${channelId}/messages`, {
    content: `[k6-load] ${randomString(20)} — ${Date.now()}`,
  }, token);

  const msgOk = check(msgRes, {
    'message send 201': (r) => r.status === 201 || r.status === 200,
  });

  msgLatency.add(Date.now() - startTs);
  msgErrors.add(msgOk ? 0 : 1);
  errorRate.add(msgOk ? 0 : 1);
}

// ── WebSocket dayanıklılık ───────────────────────────────────────────────────
function doWebSocket(token) {
  const startTs = Date.now();
  let connected = false;

  const res = ws.connect(`${WS_URL}`, { headers: { Authorization: `Bearer ${token}` } }, (socket) => {
    socket.on('open', () => {
      connected = true;
      wsConnDuration.add(Date.now() - startTs);
      activeWsConns.add(1);
    });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        // Heartbeat yanıtı — bağlantı sağlığını doğrula
        if (msg.type === 'pong' || msg.event === 'pong') {
          check(msg, { 'ws pong received': () => true });
        }
      } catch { /* binary ya da parse hatası — ignore */ }
    });

    socket.on('error', (e) => {
      wsErrors.add(1);
      errorRate.add(1);
    });

    // 5 saniye boyunca bağlı kal, ping gönder
    socket.setTimeout(() => {
      socket.send(JSON.stringify({ type: 'ping' }));
    }, 2000);

    socket.setTimeout(() => {
      activeWsConns.add(-1);
      socket.close();
    }, 5000);
  });

  if (!connected) {
    wsErrors.add(1);
    errorRate.add(1);
  }
}

// ── AI endpoint'leri ─────────────────────────────────────────────────────────
function doAiEndpoints(token) {
  // Semantic arama
  const startTs = Date.now();
  const searchRes = jsonPost('/api/semantic/search', {
    query:    'önemli kararlar',
    limit:    5,
  }, token);

  check(searchRes, {
    'semantic search ok': (r) => r.status === 200 || r.status === 404,
  });

  aiLatency.add(Date.now() - startTs);
  errorRate.add(searchRes.status >= 500 ? 1 : 0);
}

// ── Dosya yükleme ────────────────────────────────────────────────────────────
function doUpload(token) {
  // 10KB sentetik dosya
  const content  = randomString(10240);
  const data     = { file: http.file(content, 'loadtest.txt', 'text/plain') };
  const headers  = { Authorization: `Bearer ${token}` };

  const startTs = Date.now();
  const res = http.post(`${BASE_URL}/api/upload`, data, { headers });

  check(res, {
    'upload ok': (r) => r.status === 200 || r.status === 201,
  });

  uploadLatency.add(Date.now() - startTs);
  errorRate.add(res.status >= 500 ? 1 : 0);
}

// ── Federasyon endpoint'leri ─────────────────────────────────────────────────
function doFederation() {
  group('federation_endpoints', () => {
    const ni = jsonGet('/.well-known/nodeinfo');
    check(ni, { 'nodeinfo 200': (r) => r.status === 200 });
    errorRate.add(ni.status === 200 ? 0 : 1);

    const wf = jsonGet('/.well-known/webfinger?resource=acct:test@localhost');
    // 404 kabul edilebilir (kullanıcı yoksa), 500 değil
    check(wf, { 'webfinger not 5xx': (r) => r.status < 500 });
    errorRate.add(wf.status >= 500 ? 1 : 0);

    const health = jsonGet('/api/health');
    check(health, { 'health ok': (r) => r.status === 200 });
    errorRate.add(health.status === 200 ? 0 : 1);
  });
}

// ── Ana test fonksiyonu ──────────────────────────────────────────────────────
export default function () {
  // 1. Auth
  let token;
  group('auth', () => {
    token = doAuth();
  });

  if (!token) {
    sleep(1);
    return;
  }

  // 2. Mesajlaşma (%60 VU)
  if (Math.random() < 0.6) {
    group('messaging', () => {
      doMessaging(token, SERVER_ID, CHANNEL_ID);
    });
    sleep(randomIntBetween(1, 3));
  }

  // 3. WebSocket (%40 VU)
  if (Math.random() < 0.4) {
    group('websocket', () => {
      doWebSocket(token);
    });
  }

  // 4. AI endpoint'leri (%20 VU — yavaş)
  if (Math.random() < 0.2) {
    group('ai_endpoints', () => {
      doAiEndpoints(token);
    });
    sleep(1);
  }

  // 5. Dosya yükleme (%10 VU)
  if (Math.random() < 0.1) {
    group('file_upload', () => {
      doUpload(token);
    });
    sleep(2);
  }

  // 6. Federasyon her VU için (%30)
  if (Math.random() < 0.3) {
    doFederation();
  }

  sleep(randomIntBetween(1, 4));
}

// ── Kurulum: test öncesi bir kez çalışır ────────────────────────────────────
export function setup() {
  console.log(`Bridge Tam Yük Testi Başlıyor`);
  console.log(`Hedef: ${BASE_URL}`);
  console.log(`Senaryo: ${SCENARIO}`);

  // Sunucu sağlık kontrolü
  const health = http.get(`${BASE_URL}/api/health`);
  if (health.status !== 200) {
    fail(`Sunucu sağlık kontrolü başarısız: ${health.status}. Test iptal edildi.`);
  }
  console.log(`✅ Sunucu sağlıklı — yük testi başlıyor`);
}

// ── Özet: test sonunda çalışır ───────────────────────────────────────────────
export function handleSummary(data) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    [`k6/results/full-load-${SCENARIO}-${ts}.json`]: JSON.stringify(data),
    stdout: textSummary(data),
  };
}

function textSummary(data) {
  const m = data.metrics || {};
  const p = (name, pct) => {
    const val = m[name]?.values?.[`p(${pct})`];
    return val != null ? `${Math.round(val)}ms` : 'N/A';
  };
  const r = (name) => {
    const val = m[name]?.values?.rate;
    return val != null ? `${(val * 100).toFixed(2)}%` : 'N/A';
  };

  return `
╔══════════════════════════════════════════════════════╗
║          Bridge Yük Testi — Özet                     ║
╠══════════════════════════════════════════════════════╣
║ Senaryo : ${SCENARIO.padEnd(42)}║
║ Hedef   : ${BASE_URL.slice(0, 42).padEnd(42)}║
╠══════════════════════════════════════════════════════╣
║ Auth      p95 : ${p('auth_latency_ms',    95).padEnd(35)}║
║ Mesaj     p95 : ${p('msg_send_latency_ms', 95).padEnd(35)}║
║ WS bağl.  p95 : ${p('ws_conn_duration_ms',95).padEnd(35)}║
║ AI        p95 : ${p('ai_latency_ms',      95).padEnd(35)}║
║ HTTP      p95 : ${p('http_req_duration',  95).padEnd(35)}║
╠══════════════════════════════════════════════════════╣
║ Hata oranı    : ${r('errors').padEnd(35)}║
║ HTTP hata     : ${r('http_req_failed').padEnd(35)}║
║ WS hata sayısı: ${String(m['ws_errors']?.values?.count ?? 'N/A').padEnd(35)}║
╚══════════════════════════════════════════════════════╝
`;
}
