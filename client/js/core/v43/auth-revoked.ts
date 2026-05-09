// client/js/core/v43/auth-revoked.js
// ModÃ¼l: auth:revoked socket handler â€” JWT iptalinde kullanÄ±cÄ±yÄ± bilgilendir
'use strict';

document.addEventListener('bridge:socket-ready', () => {
  if (typeof socket === 'undefined') return;
  socket.on('auth:revoked', ({ reason } = {}) => {
    const msg = reason === 'token_revoked'
      ? 'Oturumunuz baÅŸka bir yerden sonlandÄ±rÄ±ldÄ±. Tekrar giriÅŸ yapÄ±nÄ±z.'
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

console.log('[Bridge] Features yÃ¼klendi:', [
  'Virtual Scroll', 'Skeleton Loading', 'Search Highlight',
  'Persistent Drafts', 'Sunset/Forest Temalar', 'AI Streaming', 'Auth Revoke Handler'
].join(', '));

