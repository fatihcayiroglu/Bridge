// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/UnreadPanel.svelte
//              client/js/core/unread-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
import { getCurrentChannel } from './globals.js';
// client/js/core/unread.ts
// Okunmamış mesaj sayaçları
// misc.js'den ayrıştırıldı

const unreadCounts: Record<string, number> = {};

function incrementUnread(channelId: string): void {
  if (getCurrentChannel()?._id === channelId) return;
  unreadCounts[channelId] = (unreadCounts[channelId] || 0) + 1;
  _renderUnreadBadge(channelId);
}

function clearUnread(channelId: string): void {
  unreadCounts[channelId] = 0;
  document.querySelector(`.ch-item[data-id="${channelId}"] .ch-unread`)?.remove();
}

function _renderUnreadBadge(channelId: string): void {
  const el = document.querySelector(`.ch-item[data-id="${channelId}"]`);
  if (!el) return;
  let badge = el.querySelector('.ch-unread') as HTMLElement | null;
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'ch-unread';
    el.appendChild(badge);
  }
  const count = unreadCounts[channelId] || 0;
  badge.textContent = count > 9 ? '9+' : String(count);
}
