// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/OfflineQueuePanel.svelte
//              client/js/core/offline-queue-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/offline-queue.ts
// Socket koptuğunda gönderilemeyen mesajları hafızada saklar.

import { BridgeRegistry } from './bridge-registry.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface QueueItem {
  id: string;
  channelId: string;
  content: string;
  serverId?: string;
  replyToId?: string;
  ts: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_QUEUE_SIZE = 50;
const FLUSH_DELAY_MS = 300;

// ── Queue ─────────────────────────────────────────────────────────────────────

const _queue: QueueItem[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _isFlushing = false;

function _uid(): string { return 'q-' + Math.random().toString(36).slice(2, 10); }

function _enqueue(item: Omit<QueueItem, 'id' | 'ts'> & Partial<Pick<QueueItem, 'id'>>): void {
  if (_queue.length >= MAX_QUEUE_SIZE) _queue.shift();
  _queue.push({ ...item, id: item.id ?? _uid(), ts: Date.now() } as QueueItem);
  _updateQueueBadge();
}

function _updateQueueBadge(): void {
  const count = _queue.length;
  let badge   = document.getElementById('offline-queue-badge');

  if (count === 0) { badge?.remove(); return; }

  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'offline-queue-badge';
    badge.style.cssText = `
      position: fixed; bottom: 72px; left: 50%; transform: translateX(-50%);
      background: #ed4245; color: #fff; font-size: 12px; font-weight: 700;
      padding: 4px 12px; border-radius: 20px; z-index: 9998;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3); cursor: default; user-select: none;`;
    document.body.appendChild(badge);
  }
  badge.textContent = `📤 ${count} mesaj bekliyor — bağlantı bekleniyor`;
}

// ── Flush ─────────────────────────────────────────────────────────────────────

async function _flushPendingQueue(): Promise<void> {
  if (_isFlushing || _queue.length === 0) return;
  const socket = BridgeRegistry.call('getSocket') as { connected?: boolean; emit(ev: string, ...a: unknown[]): void } | null;
  if (!socket?.connected) return;

  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(async () => {
    _isFlushing = true;
    let sent = 0;

    while (_queue.length > 0) {
      const sock = BridgeRegistry.call('getSocket') as { emit(ev: string, ...a: unknown[]): void } | null;
      if (!sock?.connected) break;
      const item = _queue.shift();
      if (!item) break;

      try {
        if (item.replyToId) {
          sock.emit('message:reply', { channelId: item.channelId, content: item.content, serverId: item.serverId, replyToId: item.replyToId });
        } else {
          sock.emit('message:send', { channelId: item.channelId, content: item.content, serverId: item.serverId });
        }
        sent++;
        await new Promise<void>(r => setTimeout(r, 80));
      } catch {
        _queue.unshift(item);
        break;
      }
    }

    _isFlushing = false;
    _updateQueueBadge();

    if (sent > 0) {
      const toastFn: Function | undefined = BridgeRegistry.get('toast');
      toastFn?.(`📤 ${sent} bekleyen mesaj gönderildi`, 'success');
    }
  }, FLUSH_DELAY_MS);
}

// ── sendMessage wrap ──────────────────────────────────────────────────────────

BridgeRegistry.wrap('sendMessage', (orig: ((...a: unknown[]) => unknown) | undefined, ...args: unknown[]) => {
  const socket = BridgeRegistry.call('getSocket') as { connected?: boolean; emit(ev: string, ...a: unknown[]): void } | null;
  if (!socket?.connected) {
    const currentChannel = BridgeRegistry.call('getCurrentChannel') as { _id: string } | null;
    const currentServer = BridgeRegistry.call('getCurrentServer') as { _id: string } | null;
    const input = document.getElementById('msg-input') as HTMLTextAreaElement | null;
    const content = input?.value?.trim();
    if (!content || !currentChannel) return;
    if (content.length > 2000) return;

    const replyingTo: string | null = BridgeRegistry.call('getReplyingTo');
    _enqueue({
      channelId: currentChannel._id,
      serverId:  currentServer?._id,
      content,
      replyToId: replyingTo ?? undefined,
    });

    if (input) { input.value = ''; input.style.height = 'auto'; }
    BridgeRegistry.call('cancelReply');
    BridgeRegistry.get<(m: string, t: string) => void>('toast')?.('📤 Mesaj kuyruğa alındı — bağlantı bekleniyor', 'info');
    return;
  }

  if (typeof orig === 'function') return orig(...args);
});

// ── Event listeners ───────────────────────────────────────────────────────────

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && _queue.length > 0) _flushPendingQueue();
});

window.addEventListener('online', () => {
  setTimeout(_flushPendingQueue, 1000);
});

BridgeRegistry.register('flushOfflineQueue', _flushPendingQueue);

export const getOfflineQueue = (): QueueItem[] => _queue;
export const sendMessage = (...args: unknown[]): unknown => BridgeRegistry.call('sendMessage', ...args);
