// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/OfflineCachePanel.svelte
//              client/js/core/offlineCache-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/offlineCache.ts
// Lightweight channel message cache (IndexedDB) + Service Worker outbox

import { BridgeRegistry } from './bridge-registry.js';
import { toast } from './utils.js';

interface CachedMessage { _id: string; createdAt?: number; [key: string]: unknown; }
interface CacheEntry { channelId: string; messages: CachedMessage[]; updatedAt: number; }

type OutboxResult =
  | { sent: true }
  | { sent: false; queued: true }
  | { sent: false; error: unknown };

const DB_NAME    = 'bridge-offline-cache';
const DB_VERSION = 1;
const STORE      = 'channelMessages';
const MAX_PER_CH = 500;

let _dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'channelId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
  return _dbPromise;
}

async function getChannelMessages(channelId: string): Promise<CachedMessage[]> {
  if (!channelId) return [];
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(channelId);
    req.onsuccess = () => resolve((req.result as CacheEntry | undefined)?.messages ?? []);
    req.onerror   = () => reject(req.error);
  });
}

async function setChannelMessages(channelId: string, messages: CachedMessage[]): Promise<void> {
  if (!channelId || !Array.isArray(messages)) return;
  const trimmed = messages.slice(-MAX_PER_CH);
  const db      = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ channelId, messages: trimmed, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function upsertMessage(channelId: string, message: CachedMessage): Promise<void> {
  if (!channelId || !message?._id) return;
  const current = await getChannelMessages(channelId);
  const idx     = current.findIndex(m => m._id === message._id);
  if (idx >= 0) current[idx] = { ...current[idx], ...message };
  else          current.push(message);
  current.sort((a, b) => ((a.createdAt ?? 0) - (b.createdAt ?? 0)));
  await setChannelMessages(channelId, current);
}

async function removeMessage(channelId: string, messageId: string): Promise<void> {
  if (!channelId || !messageId) return;
  const current = await getChannelMessages(channelId);
  await setChannelMessages(channelId, current.filter(m => m._id !== messageId));
}

async function sendMessageWithOutbox(
  channelId: string,
  content: string,
  token: string,
  apiBase: string
): Promise<OutboxResult> {
  const url  = `${apiBase}/api/messages/${channelId}`;
  const body = { content };

  if (navigator.onLine) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify(body),
      });
      if (res.ok) return { sent: true };
      if (res.status >= 500) throw new Error('server_error');
      return { sent: false, error: await res.json() };
    } catch { /* fall through to outbox */ }
  }

  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'OUTBOX_ADD', url, body, token });
    if (!('SyncManager' in window)) {
      setTimeout(async () => {
        if (navigator.onLine) {
          try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); }
          catch {}
        }
      }, 5000);
    }
    return { sent: false, queued: true };
  }

  return { sent: false, error: 'offline' };
}

// SW outbox flush notification
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.type === 'OUTBOX_FLUSHED') {
      const remaining: number = event.data.remaining ?? 0;
      dispatchEvent(new CustomEvent('bridge:outbox-flushed', { detail: { remaining } }));
      if (remaining === 0) {
        toast('📤 Bekleyen mesajlar gönderildi', 'success');
      }
    }
  });
}

const _bridgeOfflineCache = {
  getChannelMessages,
  setChannelMessages,
  upsertMessage,
  removeMessage,
  sendMessageWithOutbox,
};

BridgeRegistry.register('bridgeOfflineCache', _bridgeOfflineCache as unknown);
export const getBridgeOfflineCache = () => _bridgeOfflineCache;
