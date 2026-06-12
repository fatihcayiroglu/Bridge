// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/DmReadPanel.svelte
//              client/js/core/dm-read-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/dm-read.ts
// DM Okundu Bilgisi UI — çift tik göstergesi
// ✓  = gönderildi  |  ✓✓ = okundu

import { BridgeRegistry } from './bridge-registry.js';
import type { AnyFn } from './bridge-registry.js';
type SocketInstance = {
  on(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
};

interface ReadState { readBy: string; readAt: number; }

interface TickElement extends HTMLElement {
  dataset: DOMStringMap & { dmId: string; createdAt: string };
}

(function () {
  const readState = new Map<string, ReadState>();

  function init(socket: SocketInstance, _currentUserId: string): void {
    socket.on('dm:read-ack', ({ dmId, readBy, readAt }: { dmId: string; readBy: string; readAt: number }) => {
      readState.set(dmId, { readBy, readAt });
      updateTicks(dmId, readAt);
    });

    socket.on('dm:messages', ({ dmId }: { dmId: string }) => {
      if (dmId) emitRead(socket, dmId);
    });
  }

  function emitRead(socket: SocketInstance, dmId: string): void {
    socket.emit('dm:read', { dmId });
  }

  function renderTick(el: HTMLElement, isSelf: boolean, dmId: string, msgCreatedAt: number): void {
    if (!isSelf) return;
    if (el.querySelector('.dm-tick')) return;

    const tick = document.createElement('span') as TickElement;
    tick.className = 'dm-tick';
    tick.dataset.dmId      = dmId;
    tick.dataset.createdAt = String(msgCreatedAt);
    tick.textContent = '✓';
    tick.title       = 'Gönderildi';
    el.appendChild(tick);

    const state = readState.get(dmId);
    if (state && state.readAt >= msgCreatedAt) setRead(tick);
  }

  function updateTicks(dmId: string, readAt: number): void {
    document.querySelectorAll<TickElement>(`.dm-tick[data-dm-id="${dmId}"]`).forEach(tick => {
      const msgTs = Number(tick.dataset.createdAt);
      if (readAt >= msgTs) setRead(tick);
    });
  }

  function setRead(tickEl: HTMLElement): void {
    tickEl.textContent = '✓✓';
    tickEl.classList.add('read');
    tickEl.title = 'Okundu';
  }

  BridgeRegistry.register('DmRead', { init, renderTick, emitRead } as unknown as AnyFn);
})();

export const dmReadReady = true;
