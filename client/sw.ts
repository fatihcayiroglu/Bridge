/// <reference lib="webworker" />
// client/sw.ts
// Sprint 106: sw.js → TypeScript migrasyonu (client JS→TS göçünün son dosyası)
//
// Offline cache + push notification desteği + offline mesaj outbox
// + online/offline durum broadcast'i
//
// Derleme: build.js tarafından TypeScript'ten sw.js üretilir.
// tsconfig.sw.json bu dosyayı ayrı olarak derler.

declare const self: ServiceWorkerGlobalScope & {
  CURRENT_CACHE?: string;
};

// ── Sabitler ──────────────────────────────────────────────────

const STATIC_CACHE_PREFIX = 'bridge-static';
const ALL_CACHES_PREFIX   = STATIC_CACHE_PREFIX;

const OUTBOX_DB    = 'bridge-outbox';
const OUTBOX_STORE = 'pending';

// ── Tipler ────────────────────────────────────────────────────

interface AssetManifest {
  version?: string | number;
  assets?:  string[];
}

interface OutboxItem {
  id?:   number;
  url:   string;
  body:  Record<string, unknown>;
  token: string;
  ts:    number;
}

interface PushPayload {
  title?:       string;
  body?:        string;
  icon?:        string;
  badge?:       string;
  tag?:         string;
  channelId?:   string;
  channelName?: string;
  data?:        { url?: string; [key: string]: unknown };
}

interface SWMessage {
  type:        string;
  callerName?: string;
  callType?:   'video' | 'audio';
  url?:        string;
  body?:       Record<string, unknown>;
  token?:      string;
}

// ── Install: asset-manifest.json'dan varlık listesini al ─────

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil((async (): Promise<void> => {
    let assets: string[] = ['/', '/css/style.css', '/css/tokens.css'];
    let version: string  = 'dev';

    try {
      const res = await fetch('/dist/asset-manifest.json', { cache: 'no-store' });
      if (res.ok) {
        const manifest = await res.json() as AssetManifest;
        version = String(manifest.version ?? Date.now());
        assets  = manifest.assets ?? assets;
      }
    } catch {
      // manifest yoksa (dev modu) fallback listesiyle devam et
    }

    const cacheName = `${STATIC_CACHE_PREFIX}-${version}`;
    self.CURRENT_CACHE = cacheName;

    const cache = await caches.open(cacheName);
    await cache.addAll(assets).catch(() => { /* bazı varlıklar eksik olabilir */ });
    await self.skipWaiting();
  })());
});

// ── Activate: eski cache'leri temizle ─────────────────────────

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil((async (): Promise<void> => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith(ALL_CACHES_PREFIX) && k !== self.CURRENT_CACHE)
        .map(k  => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

// ── Network durum yayını ──────────────────────────────────────

let _lastOnlineState = true;

async function broadcastNetworkStatus(isOnline: boolean): Promise<void> {
  if (isOnline === _lastOnlineState) return;
  _lastOnlineState = isOnline;
  const allClients = await self.clients.matchAll({ type: 'window' });
  for (const client of allClients) {
    client.postMessage({ type: 'SW_NETWORK_STATUS', online: isOnline });
  }
}

// ── Offline Outbox — IndexedDB helpers ───────────────────────

function openOutbox(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB, 1);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_ts', 'ts');
      }
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror   = (): void => reject(req.error);
  });
}

async function getPendingMessages(): Promise<OutboxItem[]> {
  const db = await openOutbox();
  return new Promise<OutboxItem[]>((resolve, reject) => {
    const tx  = db.transaction(OUTBOX_STORE, 'readonly');
    const req = tx.objectStore(OUTBOX_STORE).getAll();
    req.onsuccess = (): void => resolve((req.result as OutboxItem[]) ?? []);
    req.onerror   = (): void => reject(req.error);
  });
}

async function removeOutboxItem(id: number): Promise<void> {
  const db = await openOutbox();
  return new Promise<void>((resolve, reject) => {
    const tx  = db.transaction(OUTBOX_STORE, 'readwrite');
    const req = tx.objectStore(OUTBOX_STORE).delete(id);
    req.onsuccess = (): void => resolve();
    req.onerror   = (): void => reject(req.error);
  });
}

async function flushOutbox(): Promise<void> {
  let pending: OutboxItem[];
  try { pending = await getPendingMessages(); } catch { return; }

  for (const item of pending) {
    try {
      const res = await fetch(item.url, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${item.token}`,
        },
        body: JSON.stringify(item.body),
      });

      if (res.ok || res.status === 409) {
        await removeOutboxItem(item.id!);
      } else if (res.status === 401) {
        await removeOutboxItem(item.id!);
        const authClients = await self.clients.matchAll({ type: 'window' });
        for (const c of authClients) {
          c.postMessage({ type: 'OUTBOX_AUTH_EXPIRED', itemId: item.id });
        }
      } else if (res.status >= 400 && res.status < 500) {
        await removeOutboxItem(item.id!);
      }
    } catch { /* 5xx / network hatası — bir sonraki sync'te tekrar dene */ }
  }

  const remaining  = await getPendingMessages();
  const allClients = await self.clients.matchAll({ type: 'window' });
  for (const client of allClients) {
    client.postMessage({ type: 'OUTBOX_FLUSHED', remaining: remaining.length });
  }
  if (remaining.length === 0) await broadcastNetworkStatus(true);
}

// ── Background Sync ───────────────────────────────────────────

self.addEventListener('sync', (event: SyncEvent) => {
  if (event.tag === 'bridge-outbox') {
    event.waitUntil(flushOutbox());
  }
});

// ── Fetch stratejileri ────────────────────────────────────────

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith('/socket.io/')) return;
  if (url.pathname.startsWith('/uploads/'))   return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request.clone())
        .then((response: Response) => {
          void broadcastNetworkStatus(true);
          return response;
        })
        .catch(async (): Promise<Response> => {
          await broadcastNetworkStatus(false);
          return new Response(
            JSON.stringify({ error: 'offline', message: 'Çevrimdışısın' }),
            {
              status:     503,
              statusText: 'Service Unavailable',
              headers:    { 'Content-Type': 'application/json' },
            },
          );
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(async (cached): Promise<Response> => {
      if (cached) return cached;

      try {
        const response = await fetch(event.request);
        if (response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          void caches.open(self.CURRENT_CACHE ?? STATIC_CACHE_PREFIX)
            .then(cache => cache.put(event.request, clone));
        }
        void broadcastNetworkStatus(true);
        return response;
      } catch {
        await broadcastNetworkStatus(false);
        if (event.request.mode === 'navigate') {
          return (await caches.match('/')) ?? new Response('Offline', { status: 503 });
        }
        return new Response('Offline', { status: 503 });
      }
    }),
  );
});

// ── Push Notifications ────────────────────────────────────────

self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return;

  let data: PushPayload = {};
  try { data = event.data.json() as PushPayload; }
  catch { data = { title: 'Bridge', body: event.data.text() }; }

  const tag = data.tag ?? (data.channelId ? `bridge-ch-${data.channelId}` : 'bridge-msg');

  event.waitUntil((async (): Promise<void> => {
    const existing = await self.registration.getNotifications({ tag });
    let body = data.body ?? 'Yeni bir mesaj var';

    if (existing.length > 0) {
      const count = existing.length + 1;
      body = `${count} yeni mesaj`;
      if (data.channelName) body += ` — #${data.channelName}`;
    }

    await self.registration.showNotification(data.title ?? 'Bridge 🌉', {
      body,
      icon:     data.icon  ?? '/favicon.ico',
      badge:    data.badge ?? '/favicon.ico',
      tag,
      renotify: existing.length === 0,
      data:     data.data  ?? {},
      vibrate:  [200, 100, 200],
      actions: [
        { action: 'open',    title: '📨 Aç'    },
        { action: 'dismiss', title: '✕ Kapat' },
      ],
    });
  })());
});

// ── Notification click ────────────────────────────────────────

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_CLICK', url });
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

// ── Message handler ───────────────────────────────────────────

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as SWMessage | undefined;
  if (!data) return;

  if (data.type === 'DM_CALL_INCOMING') {
    void self.registration.showNotification(
      data.callType === 'video' ? '📹 Görüntülü Arama' : '📞 Ses Araması',
      {
        body:               `${data.callerName ?? 'Biri'} sizi arıyor…`,
        icon:               '/favicon.ico',
        tag:                'dm-call-incoming',
        renotify:           true,
        requireInteraction: true,
        vibrate:            [300, 100, 300, 100, 300],
        actions: [
          { action: 'accept',  title: '✅ Kabul'  },
          { action: 'decline', title: '❌ Reddet' },
        ],
      },
    );
  }

  if (data.type === 'OUTBOX_ADD' && data.url && data.body && data.token) {
    void openOutbox().then(db => {
      const tx    = db.transaction(OUTBOX_STORE, 'readwrite');
      const item: Omit<OutboxItem, 'id'> = {
        url:   data.url!,
        body:  data.body!,
        token: data.token!,
        ts:    Date.now(),
      };
      tx.objectStore(OUTBOX_STORE).add(item);
      return new Promise<void>((res, rej) => {
        tx.oncomplete = (): void => res();
        tx.onerror    = (): void => rej(tx.error);
      });
    }).catch(() => { /* IndexedDB hatası — mesaj kaybolur */ });

    void self.registration.sync?.register('bridge-outbox').catch(() => {});
  }

  if (data.type === 'REQUEST_NETWORK_STATUS') {
    (event.source as WindowClient | null)
      ?.postMessage({ type: 'SW_NETWORK_STATUS', online: _lastOnlineState });
  }
});
