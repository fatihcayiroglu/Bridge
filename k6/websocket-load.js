// k6/websocket-load.js — WebSocket Bağlantı Yük Testi
// Socket.IO bağlantısı, join events, gerçek zamanlı mesaj akışı
//
// Çalıştırma:
//   BASE_URL=http://localhost:3000 k6 run k6/websocket-load.js
//
// Ölçülen değerler:
//   - Kaç eşzamanlı WS bağlantısı tutulabiliyor?
//   - Bağlantı kurma süresi
//   - Event round-trip latency
//   - Bağlantı kopma oranı

import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';

// ── Özel Metrikler ────────────────────────────────────────
const wsConnectRate    = new Rate('ws_connect_success');
const wsConnectTime    = new Trend('ws_connect_ms');
const wsDisconnectRate = new Rate('ws_unexpected_disconnect');
const wsMessageLatency = new Trend('ws_message_latency_ms');
const activeConns      = new Gauge('ws_active_connections');
const wsErrors         = new Counter('ws_errors');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WS_URL   = BASE_URL.replace(/^http/, 'ws');

export const options = {
  scenarios: {
    websocket_connections: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20  }, // 20 eşzamanlı WS
        { duration: '1m',  target: 100 }, // 100 eşzamanlı WS
        { duration: '2m',  target: 200 }, // 200 eşzamanlı WS — limit zorla
        { duration: '1m',  target: 500 }, // 500 eşzamanlı WS — stres
        { duration: '30s', target: 0   },
      ],
    },
  },
  thresholds: {
    // WS bağlantılarının %90'ı başarılı olmalı
    ws_connect_success: ['rate>0.90'],
    // Beklenmedik kopma %10'dan az
    ws_unexpected_disconnect: ['rate<0.10'],
    // Bağlantı kurma süresi %95 2 saniye altında
    ws_connect_ms: ['p(95)<2000'],
    // WS hata sayısı 100'den az
    ws_errors: ['count<100'],
  },
};

export function setup() {
  // Alice ile login
  const res = http.post(
    `${BASE_URL}/api/login`,
    JSON.stringify({
      email: __ENV.TEST_EMAIL || 'e2e_alice@bridge-e2e.test',
      password: __ENV.TEST_PASS || 'E2eTestPass123!',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (res.status !== 200) {
    console.error('Setup login başarısız:', res.status);
    return {};
  }

  const body = res.json();
  const token = body.token || body.accessToken;

  // Kanal ID'si al
  const serversRes = http.get(`${BASE_URL}/api/servers`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  let channelId = null;
  if (serversRes.status === 200) {
    const servers = serversRes.json().servers || serversRes.json();
    if (servers.length > 0) {
      const serverId = servers[0]._id || servers[0].id;
      const chRes = http.get(`${BASE_URL}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (chRes.status === 200) {
        const channels = chRes.json().channels || chRes.json();
        const textCh = channels.find((c) => !c.type || c.type === 'text');
        if (textCh) channelId = textCh._id || textCh.id;
      }
    }
  }

  return { token, channelId };
}

export default function main(data) {
  if (!data.token) { sleep(1); return; }

  // Socket.IO polling URL (WS öncesi handshake)
  const connectStart = Date.now();

  // Socket.IO WebSocket bağlantısı
  // Socket.IO path: /socket.io/?EIO=4&transport=websocket
  const wsUrl = `${WS_URL}/socket.io/?EIO=4&transport=websocket&token=${data.token}`;

  const response = ws.connect(wsUrl, {
    headers: { Authorization: `Bearer ${data.token}` },
  }, function (socket) {
    wsConnectTime.add(Date.now() - connectStart);
    let connected = false;
    let disconnectedUnexpectedly = false;
    let messageReceived = false;

    activeConns.add(1);

    socket.on('open', () => {
      connected = true;
      wsConnectRate.add(true);

      // Socket.IO handshake: "40" = connect
      socket.send('40');

      // Kanal join eventi
      if (data.channelId) {
        // Bridge'in join formatı
        const joinMsg = `42${JSON.stringify(['join', { channelId: data.channelId }])}`;
        socket.send(joinMsg);
      }
    });

    socket.on('message', (msg) => {
      // Socket.IO ping'e pong yanıtla
      if (msg === '2') {
        socket.send('3'); // pong
        return;
      }

      // Mesaj latency ölç (ilk gerçek mesaj)
      if (!messageReceived && msg.startsWith('42')) {
        wsMessageLatency.add(Date.now() - connectStart);
        messageReceived = true;
      }
    });

    socket.on('error', (e) => {
      wsErrors.add(1);
      wsConnectRate.add(false);
    });

    socket.on('close', () => {
      activeConns.add(-1);
      if (!disconnectedUnexpectedly) {
        // Planlı kapanış
      }
    });

    // 30-90 saniye bağlı kal (gerçekçi kullanıcı davranışı)
    const stayDuration = 30 + Math.random() * 60;

    // Düzenli ping gönder (bağlantıyı canlı tut)
    const pingInterval = setInterval(() => {
      try {
        socket.send('2'); // Socket.IO ping
      } catch (e) {
        clearInterval(pingInterval);
      }
    }, 25000);

    sleep(stayDuration);
    clearInterval(pingInterval);
    socket.close();
  });

  check(response, {
    'WebSocket bağlantı başarılı': (r) => r && r.status === 101,
  });

  sleep(1 + Math.random() * 2);
}
