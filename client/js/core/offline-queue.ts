// core/offline-queue.js â€” Sprint 10
// Socket koptuÄŸunda gÃ¶nderilemeyen mesajlarÄ± hafÄ±zada saklar.
// Reconnect olunca _flushPendingQueue() Ã§aÄŸrÄ±larak sÄ±raya girer.
//
// SW outbox ile farkÄ±:
//   â€¢ SW outbox â€” sayfa kapatÄ±lsa bile gÃ¶nderir (Background Sync)
//   â€¢ Bu kuyruk â€” sayfa aÃ§Ä±k ama socket kopuk iken hÄ±zlÄ± geri yÃ¼kleme
//
// Entegrasyon:
//   â€¢ sendMessage() â†’ socket emit baÅŸarÄ±sÄ±zsa _enqueue() Ã§aÄŸÄ±rÄ±r
//   â€¢ socket.on('reconnect') â†’ _flushPendingQueue() Ã§aÄŸÄ±rÄ±r
//   â€¢ offline-banner.js zaten SW outbox'u flush ediyor

'use strict';

(function initOfflineQueue() {

  const MAX_QUEUE_SIZE = 50;       // max bekleyen mesaj sayÄ±sÄ±
  const FLUSH_DELAY_MS = 300;      // reconnect sonrasÄ± flush gecikmesi (ms)

  // { id, channelId, content, serverId, replyToId?, ts }
  const _queue = [];

  let _flushTimer  = null;
  let _isFlushing  = false;

  // â”€â”€ Kuyruk yÃ¶netimi â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function _enqueue(item) {
    if (_queue.length >= MAX_QUEUE_SIZE) {
      // En eski mesajÄ± at â€” memory overflow Ã¶nlemi
      _queue.shift();
    }
    _queue.push({ ...item, id: item.id || _uid(), ts: Date.now() });
    _updateQueueBadge();
  }

  function _dequeue() {
    return _queue.shift();
  }

  function _uid() {
    return 'q-' + Math.random().toString(36).slice(2, 10);
  }

  // â”€â”€ Badge gÃ¼ncelleme â€” kullanÄ±cÄ±ya bekleyen mesaj sayÄ±sÄ± â”€â”€

  function _updateQueueBadge() {
    const count = _queue.length;
    let badge = document.getElementById('offline-queue-badge');

    if (count === 0) {
      badge?.remove();
      return;
    }

    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'offline-queue-badge';
      badge.style.cssText = `
        position: fixed; bottom: 72px; left: 50%; transform: translateX(-50%);
        background: #ed4245; color: #fff; font-size: 12px; font-weight: 700;
        padding: 4px 12px; border-radius: 20px; z-index: 9998;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        cursor: default; user-select: none;
      `;
      document.body.appendChild(badge);
    }

    badge.textContent = `ğŸ“¤ ${count} mesaj bekliyor â€” baÄŸlantÄ± bekleniyor`;
  }

  // â”€â”€ Ana flush iÅŸlevi â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function _flushPendingQueue() {
    if (_isFlushing || _queue.length === 0) return;
    if (typeof socket === 'undefined' || !socket?.connected) return;

    clearTimeout(_flushTimer);
    _flushTimer = setTimeout(async () => {
      _isFlushing = true;
      const total = _queue.length;
      let sent = 0;

      while (_queue.length > 0) {
        if (!socket?.connected) break; // baÄŸlantÄ± tekrar koptu

        const item = _dequeue();
        if (!item) break;

        try {
          if (item.replyToId) {
            socket.emit('message:reply', {
              channelId: item.channelId,
              content:   item.content,
              serverId:  item.serverId,
              replyToId: item.replyToId,
            });
          } else {
            socket.emit('message:send', {
              channelId: item.channelId,
              content:   item.content,
              serverId:  item.serverId,
            });
          }
          sent++;
          // Her mesaj arasÄ± kÃ¼Ã§Ã¼k gecikme â€” rate limit korumasÄ±
          await new Promise(r => setTimeout(r, 80));
        } catch {
          // GÃ¶nderme baÅŸarÄ±sÄ±z â†’ kuyruÄŸun baÅŸÄ±na geri koy
          _queue.unshift(item);
          break;
        }
      }

      _isFlushing = false;
      _updateQueueBadge();

      if (sent > 0) {
        if (typeof toast === 'function') {
          toast(`ğŸ“¤ ${sent} bekleyen mesaj gÃ¶nderildi`, 'success');
        }
      }
    }, FLUSH_DELAY_MS);
  }

  // â”€â”€ sendMessage entegrasyonu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Orijinal sendMessage'Ä± wrap et: socket kopuksa kuyruÄŸa ekle

  const _originalSendMessage = window.sendMessage;
  window.sendMessage = function sendMessageWithQueue() {
    // Socket baÄŸlÄ± deÄŸilse kuyruÄŸa al
    if (typeof socket === 'undefined' || !socket?.connected) {
      const input = document.getElementById('msg-input');
      const content = input?.value?.trim();
      if (!content || !currentChannel) return;
      if (content.length > 2000) return;

      _enqueue({
        channelId: currentChannel._id,
        serverId:  currentServer?._id,
        content,
        replyToId: replyingTo || undefined,
      });

      // Input'u temizle â€” kullanÄ±cÄ± gÃ¶rsel feedback alÄ±r
      if (input) { input.value = ''; input.style.height = 'auto'; }
      if (typeof cancelReply === 'function') cancelReply();
      if (typeof toast === 'function') toast('ğŸ“¤ Mesaj kuyruÄŸa alÄ±ndÄ± â€” baÄŸlantÄ± bekleniyor', 'info');
      return;
    }

    // Normal akÄ±ÅŸ
    if (typeof _originalSendMessage === 'function') {
      _originalSendMessage.apply(this, arguments);
    }
  };

  // â”€â”€ Global API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window._enqueueOfflineMessage = _enqueue;
  window._flushPendingQueue     = _flushPendingQueue;

  // Sayfa gÃ¶rÃ¼nÃ¼r olunca da flush dene
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _queue.length > 0) _flushPendingQueue();
  });

  // online event'i de dinle (tarayÄ±cÄ± network recovery)
  window.addEventListener('online', () => {
    setTimeout(_flushPendingQueue, 1000); // socket reconnect iÃ§in bekle
  });

})();

