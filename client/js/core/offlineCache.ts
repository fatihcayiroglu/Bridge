// core/offlineCache.js
// Lightweight channel message cache for offline/read-fallback UX.
(function initBridgeOfflineCache() {
  const DB_NAME = 'bridge-offline-cache';
  const DB_VERSION = 1;
  const STORE = 'channelMessages';
  const MAX_MESSAGES_PER_CHANNEL = 500;

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB not supported'));
        return;
      }
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'channelId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
    });
    return dbPromise;
  }

  async function getChannelMessages(channelId) {
    if (!channelId) return [];
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.get(channelId);
      req.onsuccess = () => resolve(req.result?.messages || []);
      req.onerror = () => reject(req.error || new Error('Failed to read cache'));
    });
  }

  async function setChannelMessages(channelId, messages) {
    if (!channelId || !Array.isArray(messages)) return;
    const trimmed = messages.slice(-MAX_MESSAGES_PER_CHANNEL);
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({
        channelId,
        messages: trimmed,
        updatedAt: Date.now(),
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Failed to write cache'));
    });
  }

  async function upsertMessage(channelId, message) {
    if (!channelId || !message?._id) return;
    const current = await getChannelMessages(channelId);
    const idx = current.findIndex((m) => m._id === message._id);
    if (idx >= 0) current[idx] = { ...current[idx], ...message };
    else current.push(message);
    current.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    await setChannelMessages(channelId, current);
  }

  async function removeMessage(channelId, messageId) {
    if (!channelId || !messageId) return;
    const current = await getChannelMessages(channelId);
    await setChannelMessages(channelId, current.filter((m) => m._id !== messageId));
  }

  window.bridgeOfflineCache = {
    getChannelMessages,
    setChannelMessages,
    upsertMessage,
    removeMessage,
  };

  // â”€â”€ v68: Offline Outbox â€” mesaj gÃ¶nderme â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // BaÄŸlantÄ± yoksa SW outbox'a yazar, Background Sync ile gÃ¶nderir.
  // BaÄŸlantÄ± varsa doÄŸrudan gÃ¶nderir.
  async function sendMessageWithOutbox(channelId, content, token, apiBase) {
    const url  = `${apiBase}/api/messages/${channelId}`;
    const body = { content };

    // Online ise direkt gÃ¶nder
    if (navigator.onLine) {
      try {
        const res = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body:    JSON.stringify(body),
        });
        if (res.ok) return { sent: true };
        if (res.status >= 500) throw new Error('server_error');
        return { sent: false, error: await res.json() };
      } catch {
        // Network hatasÄ± â€” outbox'a ekle
      }
    }

    // Offline veya hata â€” SW outbox'a gÃ¶nder
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type:  'OUTBOX_ADD',
        url,
        body,
        token,
      });
      // Background Sync yoksa hemen tekrar dene (5sn sonra)
      if (!('SyncManager' in window)) {
        setTimeout(async () => {
          if (navigator.onLine) {
            try {
              await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body:    JSON.stringify(body),
              });
            } catch {}
          }
        }, 5000);
      }
      return { sent: false, queued: true };
    }

    return { sent: false, error: 'offline' };
  }

  // SW'den outbox flush bildirimi al
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'OUTBOX_FLUSHED') {
        const remaining = event.data.remaining || 0;
        // UI'a bildir
        window.dispatchEvent(new CustomEvent('bridge:outbox-flushed', { detail: { remaining } }));
        if (remaining === 0) {
          window.bridgeApp?.toast('ğŸ“¤ Bekleyen mesajlar gÃ¶nderildi', 'success');
        }
      }
    });
  }

  window.bridgeOfflineCache.sendMessageWithOutbox = sendMessageWithOutbox;
})();

