// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ScrollPanel.svelte
//              client/js/core/scroll-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/messages/scroll.ts
// Kanal scroll pozisyonu hafızası + infinite scroll
// Sprint 49: .js → .ts (tam TypeScript geçişi)

import { getCurrentChannel } from '../globals.js';
import { BridgeRegistry }    from '../bridge-registry.js';

type ScrollPos = number | 'bottom';

const _channelScrollPos = new Map<string, ScrollPos>();

export function saveChannelScroll(channelId: string): void {
  const area = document.getElementById('messages-area') as HTMLElement | null;
  if (!area || !channelId) return;
  const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 60;
  _channelScrollPos.set(channelId, atBottom ? 'bottom' : area.scrollTop);
}

export function restoreChannelScroll(channelId: string): void {
  const area = document.getElementById('messages-area') as HTMLElement | null;
  if (!area || !channelId) return;
  const saved = _channelScrollPos.get(channelId);
  if (saved === undefined || saved === 'bottom') {
    area.scrollTop = area.scrollHeight;
  } else {
    area.scrollTop = saved as number;
  }
}

export function scrollToBottom(smooth = true): void {
  const area = document.getElementById('messages-area') as HTMLElement | null;
  if (!area) return;
  area.scrollTo({ top: area.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

export function initInfiniteScroll(
  loadOlderMessages?: (channelId: string) => Promise<void>,
  state?: { loadingMoreMessages: boolean; noMoreMessages: boolean; oldestMessageTimestamp: number | null }
): void {
  const area = document.getElementById('messages-area') as HTMLElement | null;
  if (!area) return;

  // İç state — dışarıdan verilmezse BridgeRegistry'den al
  const _getState = () => state ?? (BridgeRegistry.get('_scrollState') as typeof state | null) ?? {
    loadingMoreMessages: false, noMoreMessages: false, oldestMessageTimestamp: null,
  };
  // loadOlderMessages — dışarıdan verilmezse BridgeRegistry'den al
  const _load = loadOlderMessages
    ?? (BridgeRegistry.get('loadOlderMessages') as ((id: string) => Promise<void>) | null)
    ?? (() => Promise.resolve());

  area.addEventListener('scroll', async () => {
    const channel = getCurrentChannel();
    const s = _getState();
    if (
      area.scrollTop < 80 &&
      !s.loadingMoreMessages &&
      !s.noMoreMessages &&
      s.oldestMessageTimestamp &&
      channel
    ) {
      s.loadingMoreMessages = true;
      const prevHeight = area.scrollHeight;
      await _load(channel._id);
      area.scrollTop = area.scrollHeight - prevHeight;
      s.loadingMoreMessages = false;
    }
  });
}

// Geriye dönük uyumluluk — eski underscore prefix adları
/** @deprecated saveChannelScroll kullan */
export const _saveChannelScroll    = saveChannelScroll;
/** @deprecated restoreChannelScroll kullan */
export const _restoreChannelScroll = restoreChannelScroll;
