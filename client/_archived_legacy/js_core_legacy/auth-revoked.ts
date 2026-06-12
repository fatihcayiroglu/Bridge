// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/AuthRevokedPanel.svelte
//              client/js/core/auth-revoked-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/auth-revoked.ts
// Sprint 43: JS→TS geçişi
// auth:revoked socket handler — JWT iptalinde kullanıcıyı bilgilendir

import { BridgeRegistry } from './bridge-registry.js';

type SocketLike = { on(event: string, handler: (...args: unknown[]) => void): void };

document.addEventListener('bridge:socket-ready', () => {
  const socket = BridgeRegistry.get('socketInstance') as SocketLike | null;
  if (!socket) return;

  socket.on('auth:revoked', (payload: unknown) => {
    const { reason } = (payload ?? {}) as { reason?: string };
    const msg = reason === 'token_revoked'
      ? 'Oturumunuz başka bir yerden sonlandırıldı. Tekrar giriş yapınız.'
      : 'Oturumunuz sona erdi.';

    const toastFn = BridgeRegistry.get('toast') as ((msg: string, type: string) => void) | null;
    if (toastFn) toastFn(msg, 'error');
    else alert(msg);

    setTimeout(() => {
      localStorage.removeItem('bridge_token');
      localStorage.removeItem('bridge_refresh_token');
      window.location.reload();
    }, 2000);
  });
});
