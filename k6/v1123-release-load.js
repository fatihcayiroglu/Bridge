// k6/v1123-release-load.js — v1.123 sürüm öncesi gerçekçi karışık HTTP yükü
//
// AMAÇ: sürüm kararı için ölçülmüş kanıt üretmek. Uydurma bir hedef yoktur;
// yük KADEMELİ artar ve ilk darboğazın nerede göründüğü gözlenir.
//
// Profil, bir kullanıcının uygulamayı açtığında gerçekten yaptığı isteklerin
// karışımıdır — özellikle v1.123'te ölçülen `/unread` yolu dâhil.
//
// Çalıştırma:
//   docker run --rm -i --network host \
//     -e BASE_URL=... -e TOKEN=... grafana/k6 run - < k6/v1123-release-load.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL  = __ENV.BASE_URL  || 'http://127.0.0.1:3000';
const TOKEN     = __ENV.TOKEN     || '';
const SERVER_ID = __ENV.SERVER_ID || '';
const CHANNEL_ID = __ENV.CHANNEL_ID || '';

const errors      = new Rate('bridge_errors');
const unreadTime  = new Trend('bridge_unread_ms');
const listTime    = new Trend('bridge_channel_list_ms');
const msgPageTime = new Trend('bridge_message_page_ms');

export const options = {
  // KADEMELİ tırmanış: küçük başla, ilk darboğazı gör.
  stages: [
    // v1.124: kapasite tavanini ARAMAK icin daha yuksek kademeler.
    { duration: '20s', target: 30 },
    { duration: '40s', target: 50 },
    { duration: '40s', target: 100 },
    { duration: '40s', target: 200 },
    { duration: '20s', target: 0 },   // toparlanmayı gözlemek için soğuma
  ],
  thresholds: {
    // Eşikler DÜŞÜK tutulur: amaç geçmek değil, gerçeği ölçmek.
    http_req_failed: ['rate<0.10'],
  },
};

const authHeaders = { Authorization: `Bearer ${TOKEN}` };

export default function () {
  // 1. Sağlık — yük dengeleyicinin sürekli çağırdığı yol.
  const h = http.get(`${BASE_URL}/api/health`, { tags: { name: 'health' } });
  check(h, { 'health 200': r => r.status === 200 }) || errors.add(1);

  // 2. Sunucu listesi — uygulama açılışının ilk çağrısı.
  const servers = http.get(`${BASE_URL}/api/servers`, { headers: authHeaders, tags: { name: 'servers' } });
  check(servers, { 'servers 200': r => r.status === 200 }) || errors.add(1);

  // 3. Kanal listesi.
  if (SERVER_ID) {
    const ch = http.get(`${BASE_URL}/api/servers/${SERVER_ID}/channels`, { headers: authHeaders, tags: { name: 'channels' } });
    listTime.add(ch.timings.duration);
    check(ch, { 'channels 200': r => r.status === 200 }) || errors.add(1);
  }

  // 4. Okunmamış — v1.123'te N+1 ölçülen ve iyileştirilen yol.
  const unread = http.get(`${BASE_URL}/api/notification-prefs/unread`, { headers: authHeaders, tags: { name: 'unread' } });
  unreadTime.add(unread.timings.duration);
  check(unread, { 'unread 200': r => r.status === 200 }) || errors.add(1);

  // 5. Mesaj sayfalama.
  if (CHANNEL_ID) {
    const msgs = http.get(`${BASE_URL}/api/channels/${CHANNEL_ID}/messages?limit=50`, { headers: authHeaders, tags: { name: 'messages' } });
    msgPageTime.add(msgs.timings.duration);
    check(msgs, { 'messages 200': r => r.status === 200 }) || errors.add(1);
  }

  // 6. Zamanlanmış mesajlar — üyelik/yetki çözümü içeren okuma.
  const sched = http.get(`${BASE_URL}/api/scheduled`, { headers: authHeaders, tags: { name: 'scheduled' } });
  check(sched, { 'scheduled 200': r => r.status === 200 }) || errors.add(1);

  sleep(1);
}
