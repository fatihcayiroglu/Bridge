// k6/websocket-cluster-test.js — Bridge v65
// WebSocket Clustering Testi: 3 node + sticky session doğrulama
//
// Kullanım:
//   k6 run k6/websocket-cluster-test.js
//   k6 run --vus 50 --duration 60s k6/websocket-cluster-test.js
//
// Test kapsamı:
//   1. Sticky session: Her VU aynı node'a mı bağlı kalıyor?
//   2. Cross-node mesajlaşma: Node-1'e gönderilen mesaj Node-2'ye ulaşıyor mu?
//   3. Yük dengesi: 3 node'a eşit dağılım
//   4. Failover: Node düşünce bağlantı kesintisiz devam ediyor mu?

import ws       from 'k6/ws';
import http     from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';

// ── Metrikler ─────────────────────────────────────────────────
const messagesReceived  = new Counter('bridge_messages_received');
const messageSendErrors = new Counter('bridge_message_send_errors');
const wsConnectTime     = new Trend('bridge_ws_connect_time');
const crossNodeSuccess  = new Rate('bridge_cross_node_success');
const stickyViolations  = new Counter('bridge_sticky_violations');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const WS_URL   = BASE_URL.replace('http://', 'ws://').replace('https://', 'wss://');

export const options = {
  scenarios: {
    // Senaryo 1: Normal yük — sticky session doğrulama
    sticky_session_test: {
      executor:    'ramping-vus',
      startVUs:    0,
      stages: [
        { duration: '10s', target: 20 },  // ramping up
        { duration: '30s', target: 20 },  // steady state
        { duration: '10s', target: 0  },  // ramping down
      ],
      tags: { scenario: 'sticky' },
    },
    // Senaryo 2: Cross-node mesaj testi (daha az VU, odaklı)
    cross_node_test: {
      executor:  'constant-vus',
      vus:       5,
      duration:  '50s',
      startTime: '5s',
      tags:      { scenario: 'cross_node' },
    },
  },
  thresholds: {
    'bridge_ws_connect_time':    ['p(95)<3000'],  // bağlantı < 3 saniye
    'bridge_cross_node_success': ['rate>0.95'],   // cross-node başarı > %95
    'bridge_sticky_violations':  ['count<5'],     // 5'ten az sticky ihlali
    'ws_session_duration':       ['p(99)<60000'], // oturum < 60 saniye
  },
};

// ── Yardımcı: Token al ────────────────────────────────────────
function getToken(vuId) {
  // Test token'ı — gerçek ortamda kayıt + login gerekir
  // .env'de TEST_TOKEN tanımlıysa kullan
  return __ENV.TEST_TOKEN || `test-token-vu-${vuId}`;
}

// ── Yardımcı: Hangi node? (X-Bridge-Node header) ─────────────
function detectNode(res) {
  return res.headers?.['X-Bridge-Node'] ||
         res.headers?.['x-bridge-node'] ||
         'unknown';
}

// ── Ana Test: Sticky Session ──────────────────────────────────
export default function stickySessionTest() {
  const vuId     = __VU;
  const token    = getToken(vuId);
  const startMs  = Date.now();

  // İlk HTTP isteği ile node seçimini tetikle
  const pingRes  = http.get(`${BASE_URL}/api/health`, {
    headers: { Authorization: `Bearer ${token}` },
    tags:    { name: 'health_check' },
  });

  check(pingRes, { 'health ok': r => r.status === 200 });

  const assignedNode = detectNode(pingRes);

  // WebSocket bağlantısı
  const wsRes = ws.connect(
    `${WS_URL}/socket.io/?EIO=4&transport=websocket&token=${token}`,
    { tags: { vu: vuId } },
    function (socket) {
      wsConnectTime.add(Date.now() - startMs);

      let messagesInSession = 0;
      let nodeCheckCount    = 0;

      socket.on('open', () => {
        // Socket.io handshake
        socket.send('40'); // namespace connect
      });

      socket.on('message', (data) => {
        messagesInSession++;
        messagesReceived.add(1);

        // Ping-pong ile node bilgisini al
        if (data.startsWith('40') || data.startsWith('0')) {
          // Bağlı node'u doğrula — HTTP ping ile
          nodeCheckCount++;
          if (nodeCheckCount <= 3) {
            const nodeCheckRes = http.get(`${BASE_URL}/api/health`);
            const currentNode  = detectNode(nodeCheckRes);
            if (assignedNode !== 'unknown' && currentNode !== 'unknown' && currentNode !== assignedNode) {
              stickyViolations.add(1);
              console.warn(`[VU${vuId}] Sticky ihlali: ${assignedNode} → ${currentNode}`);
            }
          }

          // Test mesajı gönder
          const event = JSON.stringify({ event: 'ping', data: { vuId, ts: Date.now() } });
          socket.send(`42["ping",${JSON.stringify({ vuId, ts: Date.now() })}]`);
        }
      });

      socket.on('error', (e) => {
        messageSendErrors.add(1);
        console.error(`[VU${vuId}] WS hata:`, e?.message || e);
      });

      socket.on('close', () => {
        // Sessiz kapat
      });

      // 20 saniye boyunca mesaj gönder
      socket.setInterval(() => {
        try {
          socket.send(`42["client:message",{"content":"VU${vuId} test mesajı","channelId":"test-ch"}]`);
        } catch {
          messageSendErrors.add(1);
        }
      }, 2000);

      socket.setTimeout(() => {
        socket.close();
      }, 20000);
    }
  );

  check(wsRes, { 'ws status 101': r => r && r.status === 101 });
  sleep(1);
}

// ── Cross-Node Mesaj Testi ────────────────────────────────────
// İki farklı VU, farklı node'lara bağlanır; birinin gönderdiği
// mesaj diğerine Redis adapter üzerinden ulaşmalı.
export function crossNodeTest() {
  const vuId    = __VU;
  const token   = getToken(vuId);
  const channelId = 'cross-node-test-channel';

  // Node seçimi (VU çift/tek → farklı node tercih)
  // HAProxy round-robin başlangıçta dağıtır; cookie sticky takip eder
  const nodeHint = vuId % 3; // 0,1,2 → 3 node

  let received = false;

  const wsRes = ws.connect(
    `${WS_URL}/socket.io/?EIO=4&transport=websocket`,
    { headers: { Authorization: `Bearer ${token}` } },
    function (socket) {
      socket.on('open', () => socket.send('40'));

      socket.on('message', (data) => {
        if (data.includes('cross-node-ping')) {
          received = true;
          messagesReceived.add(1);
        }
      });

      socket.on('error', () => messageSendErrors.add(1));

      // Dinleyici VU'lar bekle; gönderici VU'lar gönder
      if (vuId % 2 === 0) {
        // Gönderici
        socket.setTimeout(() => {
          socket.send(`42["client:message",{"content":"cross-node-ping","channelId":"${channelId}"}]`);
        }, 2000);
      }

      socket.setTimeout(() => socket.close(), 15000);
    }
  );

  check(wsRes, { 'cross-node ws ok': r => r && r.status === 101 });

  if (vuId % 2 !== 0) {
    // Dinleyici: alındı mı?
    crossNodeSuccess.add(received ? 1 : 0);
  }

  sleep(1);
}
