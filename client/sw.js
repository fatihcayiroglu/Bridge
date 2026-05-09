// Bridge Service Worker
// Offline cache + push notification desteği + offline mesaj outbox
//      online/offline durum broadcast'i eklendi.

const CACHE_VERSION = 'bridge-v2';  // chunk sistemi için güncellendi (Sprint 10)
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const ALL_CACHES    = [STATIC_CACHE];

// Production: chunk-*.js dosyaları (npm run build sonrası)
// Dev: bireysel dosyalar (window.BRIDGE_DEV === true)
const STATIC_ASSETS = [
  '/',
  '/css/style.css',
  '/css/tokens.css',
  '/js/chunk-boot.js',
  '/js/chunk-core.js',
  '/js/chunk-comms.js',
  '/js/chunk-webrtc.js',
  '/js/chunk-features.js',
  '/js/chunk-pages.js',
  '/js/chunk-heavy.js',
  '/js/chunk-compat.js',
];

// ── Install: statik varlıkları önbelleğe al ──────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: eski cache'leri temizle ────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => !ALL_CACHES.includes(k))
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Network durumu izle ve tüm client'lara bildir ───────
let _lastOnlineState = true;

async function broadcastNetworkStatus(isOnline) {
  if (isOnline === _lastOnlineState) return;
  _lastOnlineState = isOnline;
  const allClients = await self.clients.matchAll({ type: 'window' });
  for (const client of allClients) {
    client.postMessage({ type: 'SW_NETWORK_STATUS', online: isOnline });
  }
}

// ── Offline Outbox ───────────────────────────────────────────
const OUTBOX_DB    = 'bridge-outbox';
const OUTBOX_STORE = 'pending';

function openOutbox() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function getPendingMessages() {
  const db = await openOutbox();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(OUTBOX_STORE, 'readonly');
    const req = tx.objectStore(OUTBOX_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function removeOutboxItem(id) {
  const db = await openOutbox();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(OUTBOX_STORE, 'readwrite');
    const req = tx.objectStore(OUTBOX_STORE).delete(id);
    req.onsuccess = resolve;
    req.onerror   = () => reject(req.error);
  });
}

self.addEventListener('sync', event => {
  if (event.tag === 'bridge-outbox') {
    event.waitUntil(flushOutbox());
  }
});

async function flushOutbox() {
  let pending;
  try { pending = await getPendingMessages(); } catch { return; }

  for (const item of pending) {
    try {
      const res = await fetch(item.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${item.token}` },
        body:    JSON.stringify(item.body),
      });
      if (res.ok || res.status === 409) {
        await removeOutboxItem(item.id);
      } else if (res.status === 401) {
        // Token süresi dolmuş — mesajı sil ve kullanıcıyı bilgilendir
        await removeOutboxItem(item.id);
        const authClients = await self.clients.matchAll({ type: 'window' });
        for (const c of authClients) c.postMessage({ type: 'OUTBOX_AUTH_EXPIRED', itemId: item.id });
      } else if (res.status >= 400 && res.status < 500) {
        // Diğer 4xx — kalıcı hata, sil
        await removeOutboxItem(item.id);
      }
    } catch { /* 5xx / network — bir sonraki sync */ }
  }

  const remaining = await getPendingMessages();
  const allClients = await self.clients.matchAll({ type: 'window' });
  for (const client of allClients) {
    client.postMessage({ type: 'OUTBOX_FLUSHED', remaining: remaining.length });
  }
  if (remaining.length === 0) await broadcastNetworkStatus(true);
}

// ── Fetch stratejileri ───────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Socket.io — hiç dokunma
  if (url.pathname.startsWith('/socket.io/')) return;

  // Upload'lar — önbelleğe alma
  if (url.pathname.startsWith('/uploads/')) return;

  // Mesaj API'si — Network-first, offline'da SW_NETWORK_STATUS yayınla
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request.clone())
        .then(response => {
          broadcastNetworkStatus(true);
          return response;
        })
        .catch(async () => {
          await broadcastNetworkStatus(false);
          return new Response(
            JSON.stringify({ error: 'offline', message: 'Çevrimdışısın' }),
            {
              status: 503,
              statusText: 'Service Unavailable',
              headers: { 'Content-Type': 'application/json' },
            }
          );
        })
    );
    return;
  }

  // Statik varlıklar — Cache-first, sonra network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then(cache => cache.put(event.request, clone));
        }
        broadcastNetworkStatus(true);
        return response;
      }).catch(async () => {
        await broadcastNetworkStatus(false);
        if (event.request.mode === 'navigate') return caches.match('/');
      });
    })
  );
});

// ── Push Notifications — gruplandırma ────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'Bridge', body: event.data.text() }; }

  const tag = data.tag || (data.channelId ? `bridge-ch-${data.channelId}` : 'bridge-msg');

  event.waitUntil((async () => {
    const existing = await self.registration.getNotifications({ tag });
    let body = data.body || 'Yeni bir mesaj var';
    if (existing.length > 0) {
      const count = existing.length + 1;
      body = `${count} yeni mesaj`;
      if (data.channelName) body += ` — #${data.channelName}`;
    }
    await self.registration.showNotification(data.title || 'Bridge 🌉', {
      body,
      icon:     data.icon  || '/favicon.ico',
      badge:    data.badge || '/favicon.ico',
      tag,
      renotify: existing.length === 0,
      data:     data.data  || {},
      vibrate:  [200, 100, 200],
      actions: [
        { action: 'open',    title: '📨 Aç'    },
        { action: 'dismiss', title: '✕ Kapat' },
      ],
    });
  })());
});

// ── Notification click ───────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_CLICK', url });
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ── Message handler ──────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'DM_CALL_INCOMING') {
    const { callerName, callType } = event.data;
    self.registration.showNotification(
      callType === 'video' ? '📹 Görüntülü Arama' : '📞 Ses Araması',
      {
        body:    `${callerName} sizi arıyor…`,
        icon:    '/favicon.ico',
        tag:     'dm-call-incoming',
        renotify: true,
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 300],
        actions: [
          { action: 'accept',  title: '✅ Kabul' },
          { action: 'decline', title: '❌ Reddet' },
        ],
      }
    );
  }

  if (event.data?.type === 'OUTBOX_ADD') {
    openOutbox().then(db => {
      const tx = db.transaction(OUTBOX_STORE, 'readwrite');
      tx.objectStore(OUTBOX_STORE).add({
        url:   event.data.url,
        body:  event.data.body,
        token: event.data.token,
        ts:    Date.now(),
      });
      return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    }).catch(() => {});
    self.registration.sync?.register('bridge-outbox').catch(() => {});
  }

  // İstek üzerine anlık durum cevabı
  if (event.data?.type === 'REQUEST_NETWORK_STATUS') {
    event.source?.postMessage({ type: 'SW_NETWORK_STATUS', online: _lastOnlineState });
  }
});
