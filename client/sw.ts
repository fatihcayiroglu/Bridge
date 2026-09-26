/// <reference lib="webworker" />
// client/sw.ts
// Sprint 106: sw.js → TypeScript migrasyonu (client JS→TS göçünün son dosyası)
//
// Offline cache + push notification desteği + offline mesaj outbox
// + online/offline durum broadcast'i
//
// Derleme: build.js tarafından TypeScript'ten sw.js üretilir.
// tsconfig.sw.json bu dosyayı ayrı olarak derler.

type BridgeServiceWorkerScope = ServiceWorkerGlobalScope & {
  CURRENT_CACHE?: string;
};

interface SyncEvent extends ExtendableEvent {
  tag: string;
}

// TypeScript's WebWorker lib declares `self` as WorkerGlobalScope.  The
// service-worker runtime has the stricter ServiceWorkerGlobalScope surface.
const worker = self as unknown as BridgeServiceWorkerScope;

// ── Sabitler ──────────────────────────────────────────────────

const STATIC_CACHE_PREFIX = 'bridge-static';
const ALL_CACHES_PREFIX   = STATIC_CACHE_PREFIX;

const OUTBOX_DB    = 'bridge-outbox';
const OUTBOX_STORE = 'pending';
const NOTIFICATION_POLICY_DB = 'bridge-notification-policy';
const NOTIFICATION_POLICY_STORE = 'settings';
const NOTIFICATION_POLICY_KEY = 'policy';
const NOTIFICATION_LOCALE_KEY = 'locale';

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

type WorkerLocale = 'tr' | 'en' | 'es' | 'ru' | 'ja' | 'ko' | 'zh' | 'pt' | 'de' | 'fr';

interface NotificationDevicePolicy {
  dnd: boolean;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
}

interface SWMessage {
  type:        string;
  callerName?: string;
  callType?:   'video' | 'audio';
  url?:        string;
  body?:       Record<string, unknown>;
  token?:      string;
  notificationPolicy?: NotificationDevicePolicy;
  locale?: WorkerLocale;
}


const WORKER_LOCALES = new Set<WorkerLocale>(['tr','en','es','ru','ja','ko','zh','pt','de','fr']);
const SW_COPY: Record<WorkerLocale, Record<string, string>> = {
  tr: { sw_offline:'Çevrimdışısın', sw_new_message:'Yeni bir mesaj var', sw_new_messages:'{count} yeni mesaj', sw_open:'Aç', sw_dismiss:'Kapat', sw_video_call:'Görüntülü Arama', sw_audio_call:'Ses Araması', sw_caller_calling:'{caller} sizi arıyor…', sw_someone:'Biri', sw_accept:'Kabul', sw_decline:'Reddet' },
  en: { sw_offline:"You're offline", sw_new_message:'You have a new message', sw_new_messages:'{count} new messages', sw_open:'Open', sw_dismiss:'Dismiss', sw_video_call:'Video Call', sw_audio_call:'Voice Call', sw_caller_calling:'{caller} is calling you…', sw_someone:'Someone', sw_accept:'Accept', sw_decline:'Decline' },
  es: { sw_offline:'Estás sin conexión', sw_new_message:'Tienes un mensaje nuevo', sw_new_messages:'{count} mensajes nuevos', sw_open:'Abrir', sw_dismiss:'Cerrar', sw_video_call:'Videollamada', sw_audio_call:'Llamada de voz', sw_caller_calling:'{caller} te está llamando…', sw_someone:'Alguien', sw_accept:'Aceptar', sw_decline:'Rechazar' },
  ru: { sw_offline:'Вы не в сети', sw_new_message:'У вас новое сообщение', sw_new_messages:'Новых сообщений: {count}', sw_open:'Открыть', sw_dismiss:'Закрыть', sw_video_call:'Видеозвонок', sw_audio_call:'Голосовой вызов', sw_caller_calling:'{caller} звонит вам…', sw_someone:'Кто-то', sw_accept:'Принять', sw_decline:'Отклонить' },
  ja: { sw_offline:'オフラインです', sw_new_message:'新しいメッセージがあります', sw_new_messages:'新しいメッセージ {count} 件', sw_open:'開く', sw_dismiss:'閉じる', sw_video_call:'ビデオ通話', sw_audio_call:'音声通話', sw_caller_calling:'{caller} さんから着信中…', sw_someone:'誰か', sw_accept:'応答', sw_decline:'拒否' },
  ko: { sw_offline:'오프라인 상태입니다', sw_new_message:'새 메시지가 있습니다', sw_new_messages:'새 메시지 {count}개', sw_open:'열기', sw_dismiss:'닫기', sw_video_call:'영상 통화', sw_audio_call:'음성 통화', sw_caller_calling:'{caller}님이 전화를 걸고 있습니다…', sw_someone:'누군가', sw_accept:'수락', sw_decline:'거절' },
  zh: { sw_offline:'你当前处于离线状态', sw_new_message:'你有一条新消息', sw_new_messages:'{count} 条新消息', sw_open:'打开', sw_dismiss:'关闭', sw_video_call:'视频通话', sw_audio_call:'语音通话', sw_caller_calling:'{caller} 正在呼叫你…', sw_someone:'某人', sw_accept:'接听', sw_decline:'拒绝' },
  pt: { sw_offline:'Você está offline', sw_new_message:'Você tem uma nova mensagem', sw_new_messages:'{count} novas mensagens', sw_open:'Abrir', sw_dismiss:'Fechar', sw_video_call:'Chamada de vídeo', sw_audio_call:'Chamada de voz', sw_caller_calling:'{caller} está ligando para você…', sw_someone:'Alguém', sw_accept:'Aceitar', sw_decline:'Recusar' },
  de: { sw_offline:'Du bist offline', sw_new_message:'Du hast eine neue Nachricht', sw_new_messages:'{count} neue Nachrichten', sw_open:'Öffnen', sw_dismiss:'Schließen', sw_video_call:'Videoanruf', sw_audio_call:'Sprachanruf', sw_caller_calling:'{caller} ruft dich an…', sw_someone:'Jemand', sw_accept:'Annehmen', sw_decline:'Ablehnen' },
  fr: { sw_offline:'Vous êtes hors ligne', sw_new_message:'Vous avez un nouveau message', sw_new_messages:'{count} nouveaux messages', sw_open:'Ouvrir', sw_dismiss:'Fermer', sw_video_call:'Appel vidéo', sw_audio_call:'Appel vocal', sw_caller_calling:'{caller} vous appelle…', sw_someone:'Quelqu’un', sw_accept:'Accepter', sw_decline:'Refuser' },
};

function normalizeWorkerLocale(value: unknown): WorkerLocale {
  return typeof value === 'string' && WORKER_LOCALES.has(value as WorkerLocale) ? value as WorkerLocale : 'en';
}

function workerText(locale: WorkerLocale, key: string, vars?: Record<string, string | number>): string {
  const template = SW_COPY[locale][key] ?? SW_COPY.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}

function safeSameOriginUrl(value: unknown, { apiOnly = false }: { apiOnly?: boolean } = {}): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, worker.location.origin);
    if (url.origin !== worker.location.origin) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (apiOnly && !url.pathname.startsWith('/api/')) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}


const DEFAULT_NOTIFICATION_POLICY: NotificationDevicePolicy = {
  dnd: false,
  quietEnabled: false,
  quietStart: '22:00',
  quietEnd: '08:00',
};

function validPolicyTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normalizeNotificationPolicy(value: unknown): NotificationDevicePolicy {
  if (!value || typeof value !== 'object') return { ...DEFAULT_NOTIFICATION_POLICY };
  const raw = value as Partial<NotificationDevicePolicy>;
  return {
    dnd: raw.dnd === true,
    quietEnabled: raw.quietEnabled === true,
    quietStart: validPolicyTime(raw.quietStart) ? raw.quietStart : DEFAULT_NOTIFICATION_POLICY.quietStart,
    quietEnd: validPolicyTime(raw.quietEnd) ? raw.quietEnd : DEFAULT_NOTIFICATION_POLICY.quietEnd,
  };
}

function openNotificationPolicyDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(NOTIFICATION_POLICY_DB, 1);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NOTIFICATION_POLICY_STORE)) {
        db.createObjectStore(NOTIFICATION_POLICY_STORE);
      }
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error);
  });
}

async function readNotificationPolicy(): Promise<NotificationDevicePolicy> {
  try {
    const db = await openNotificationPolicyDb();
    return await new Promise<NotificationDevicePolicy>((resolve) => {
      const tx = db.transaction(NOTIFICATION_POLICY_STORE, 'readonly');
      const req = tx.objectStore(NOTIFICATION_POLICY_STORE).get(NOTIFICATION_POLICY_KEY);
      req.onsuccess = (): void => resolve(normalizeNotificationPolicy(req.result));
      req.onerror = (): void => resolve({ ...DEFAULT_NOTIFICATION_POLICY });
    });
  } catch {
    return { ...DEFAULT_NOTIFICATION_POLICY };
  }
}

async function writeNotificationPolicy(value: unknown): Promise<void> {
  const policy = normalizeNotificationPolicy(value);
  const db = await openNotificationPolicyDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(NOTIFICATION_POLICY_STORE, 'readwrite');
    tx.objectStore(NOTIFICATION_POLICY_STORE).put(policy, NOTIFICATION_POLICY_KEY);
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error);
  });
}


async function readNotificationLocale(): Promise<WorkerLocale> {
  try {
    const db = await openNotificationPolicyDb();
    return await new Promise<WorkerLocale>((resolve) => {
      const tx = db.transaction(NOTIFICATION_POLICY_STORE, 'readonly');
      const req = tx.objectStore(NOTIFICATION_POLICY_STORE).get(NOTIFICATION_LOCALE_KEY);
      req.onsuccess = (): void => resolve(normalizeWorkerLocale(req.result));
      req.onerror = (): void => resolve('en');
    });
  } catch {
    return 'en';
  }
}

async function writeNotificationLocale(value: unknown): Promise<void> {
  const locale = normalizeWorkerLocale(value);
  const db = await openNotificationPolicyDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(NOTIFICATION_POLICY_STORE, 'readwrite');
    tx.objectStore(NOTIFICATION_POLICY_STORE).put(locale, NOTIFICATION_LOCALE_KEY);
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error);
  });
}

function policyMinutes(value: string): number {
  const [hours = 0, mins = 0] = value.split(':').map(Number);
  return hours * 60 + mins;
}

function quietHoursActive(policy: NotificationDevicePolicy, now: Date = new Date()): boolean {
  if (!policy.quietEnabled) return false;
  const start = policyMinutes(policy.quietStart);
  const end = policyMinutes(policy.quietEnd);
  const current = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

async function shouldSuppressNotification(isCall: boolean): Promise<boolean> {
  const policy = await readNotificationPolicy();
  if (policy.dnd) return true;
  return !isCall && quietHoursActive(policy);
}

// ── Install: asset-manifest.json'dan varlık listesini al ─────

worker.addEventListener('install', (event: ExtendableEvent) => {
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
    worker.CURRENT_CACHE = cacheName;

    const cache = await caches.open(cacheName);
    await cache.addAll(assets).catch(() => { /* bazı varlıklar eksik olabilir */ });
    await worker.skipWaiting();
  })());
});

// ── Activate: eski cache'leri temizle ─────────────────────────

worker.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil((async (): Promise<void> => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith(ALL_CACHES_PREFIX) && k !== worker.CURRENT_CACHE)
        .map(k  => caches.delete(k)),
    );
    await worker.clients.claim();
  })());
});

// ── Network durum yayını ──────────────────────────────────────

let _lastOnlineState = true;

async function broadcastNetworkStatus(isOnline: boolean): Promise<void> {
  if (isOnline === _lastOnlineState) return;
  _lastOnlineState = isOnline;
  const allClients = await worker.clients.matchAll({ type: 'window' });
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
        const authClients = await worker.clients.matchAll({ type: 'window' });
        for (const c of authClients) {
          c.postMessage({ type: 'OUTBOX_AUTH_EXPIRED', itemId: item.id });
        }
      } else if (res.status >= 400 && res.status < 500) {
        await removeOutboxItem(item.id!);
      }
    } catch { /* 5xx / network hatası — bir sonraki sync'te tekrar dene */ }
  }

  const remaining  = await getPendingMessages();
  const allClients = await worker.clients.matchAll({ type: 'window' });
  for (const client of allClients) {
    client.postMessage({ type: 'OUTBOX_FLUSHED', remaining: remaining.length });
  }
  if (remaining.length === 0) await broadcastNetworkStatus(true);
}

// ── Background Sync ───────────────────────────────────────────

worker.addEventListener('sync', (event: Event) => {
  const syncEvent = event as SyncEvent;
  if (syncEvent.tag === 'bridge-outbox') {
    syncEvent.waitUntil(flushOutbox());
  }
});

// ── Fetch stratejileri ────────────────────────────────────────

worker.addEventListener('fetch', (event: FetchEvent) => {
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
            JSON.stringify({ error: 'offline', message: workerText(await readNotificationLocale(), 'sw_offline') }),
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
          void caches.open(worker.CURRENT_CACHE ?? STATIC_CACHE_PREFIX)
            .then(cache => cache.put(event.request, clone));
        }
        void broadcastNetworkStatus(true);
        return response;
      } catch {
        await broadcastNetworkStatus(false);
        if (event.request.mode === 'navigate') {
          return (await caches.match('/')) ?? new Response(workerText(await readNotificationLocale(), 'sw_offline'), { status: 503 });
        }
        return new Response(workerText(await readNotificationLocale(), 'sw_offline'), { status: 503 });
      }
    }),
  );
});

// ── Push Notifications ────────────────────────────────────────

worker.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return;

  let data: PushPayload = {};
  try { data = event.data.json() as PushPayload; }
  catch { data = { title: 'Bridge', body: event.data.text() }; }

  const tag = data.tag ?? (data.channelId ? `bridge-ch-${data.channelId}` : 'bridge-msg');

  event.waitUntil((async (): Promise<void> => {
    const pushType = String(data.data?.type ?? '').toLowerCase();
    const isCall = pushType.includes('call');
    if (await shouldSuppressNotification(isCall)) return;

    const locale = await readNotificationLocale();
    const existing = await worker.registration.getNotifications({ tag });
    let body = data.body ?? workerText(locale, 'sw_new_message');

    if (existing.length > 0) {
      const count = existing.length + 1;
      body = workerText(locale, 'sw_new_messages', { count });
      if (data.channelName) body += ` — #${data.channelName}`;
    }

    await worker.registration.showNotification(data.title ?? 'Bridge 🌉', {
      body,
      icon:     data.icon  ?? '/favicon.ico',
      badge:    data.badge ?? '/favicon.ico',
      tag,
      renotify: existing.length === 0,
      data:     data.data  ?? {},
      vibrate:  [200, 100, 200],
      actions: [
        { action: 'open',    title: `📨 ${workerText(locale, 'sw_open')}` },
        { action: 'dismiss', title: `✕ ${workerText(locale, 'sw_dismiss')}` },
      ],
    } as NotificationOptions & { renotify: boolean });
  })());
});

// ── Notification click ────────────────────────────────────────

worker.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const url = safeSameOriginUrl((event.notification.data as { url?: string } | undefined)?.url) ?? '/';
  event.waitUntil(
    worker.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
      for (const client of list) {
        if (new URL(client.url).origin === worker.location.origin && 'focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_CLICK', url });
          return client.focus();
        }
      }
      return worker.clients.openWindow(url);
    }),
  );
});

// ── Message handler ───────────────────────────────────────────

worker.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as SWMessage | undefined;
  if (!data) return;

  if (data.type === 'DM_CALL_INCOMING') {
    event.waitUntil((async (): Promise<void> => {
      if (await shouldSuppressNotification(true)) return;
      const locale = await readNotificationLocale();
      const caller = data.callerName ?? workerText(locale, 'sw_someone');
      await worker.registration.showNotification(
        `${data.callType === 'video' ? '📹' : '📞'} ${workerText(locale, data.callType === 'video' ? 'sw_video_call' : 'sw_audio_call')}`,
        {
          body:               workerText(locale, 'sw_caller_calling', { caller }),
          icon:               '/favicon.ico',
          tag:                'dm-call-incoming',
          renotify:           true,
          requireInteraction: true,
          vibrate:            [300, 100, 300, 100, 300],
          actions: [
            { action: 'accept',  title: `✅ ${workerText(locale, 'sw_accept')}` },
            { action: 'decline', title: `❌ ${workerText(locale, 'sw_decline')}` },
          ],
        } as NotificationOptions & { renotify: boolean },
      );
    })());
  }

  if (data.type === 'OUTBOX_ADD' && data.url && data.body && data.token) {
    const safeUrl = safeSameOriginUrl(data.url, { apiOnly: true });
    if (!safeUrl) return;
    void openOutbox().then(db => {
      const tx    = db.transaction(OUTBOX_STORE, 'readwrite');
      const item: Omit<OutboxItem, 'id'> = {
        url:   safeUrl,
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

    const registrationWithSync = worker.registration as ServiceWorkerRegistration & {
      sync?: { register(tag: string): Promise<void> };
    };
    void registrationWithSync.sync?.register('bridge-outbox').catch(() => {});
  }

  if (data.type === 'SET_NOTIFICATION_POLICY' && data.notificationPolicy) {
    event.waitUntil(writeNotificationPolicy(data.notificationPolicy).catch(() => {}));
  }

  if (data.type === 'SET_LOCALE' && data.locale) {
    event.waitUntil(writeNotificationLocale(data.locale).catch(() => {}));
  }

  if (data.type === 'REQUEST_NETWORK_STATUS') {
    (event.source as WindowClient | null)
      ?.postMessage({ type: 'SW_NETWORK_STATUS', online: _lastOnlineState });
  }
});
