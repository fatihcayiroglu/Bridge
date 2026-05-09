// client/js/core/v43/auth-revoked.js
// Modül: auth:revoked socket handler — JWT iptalinde kullanıcıyı bilgilendir
'use strict';

document.addEventListener('bridge:socket-ready', () => {
  if (typeof socket === 'undefined') return;
  socket.on('auth:revoked', ({ reason } = {}) => {
    const msg = reason === 'token_revoked'
      ? 'Oturumunuz başka bir yerden sonlandırıldı. Tekrar giriş yapınız.'
      : 'Oturumunuz sona erdi.';
    if (typeof toast === 'function') toast(msg, 'error');
    else alert(msg);
    setTimeout(() => {
      localStorage.removeItem('bridge_token');
      localStorage.removeItem('bridge_refresh_token');
      window.location.reload();
    }, 2000);
  });
});

console.log('[Bridge] Features yüklendi:', [
  'Virtual Scroll', 'Skeleton Loading', 'Search Highlight',
  'Persistent Drafts', 'Sunset/Forest Temalar', 'AI Streaming', 'Auth Revoke Handler'
].join(', '));
