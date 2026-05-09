// client/js/core/dm-read.js
// DM Okundu Bilgisi UI — çift tik göstergesi
// ✓  = gönderildi (mesaj DB'ye yazıldı)
// ✓✓ = okundu (karşı taraf ekrana aldı)

'use strict';

(function () {
  // dmId → { readBy: userId, readAt: timestamp }
  const readState = new Map();

  function init(socket, currentUserId) {
    // Karşı tarafın okuduğunu sunucudan al
    socket.on('dm:read-ack', ({ dmId, readBy, readAt }) => {
      readState.set(dmId, { readBy, readAt });
      updateTicks(dmId, readAt);
    });

    // Kendi DM panelini açınca — mesajları okundu say
    socket.on('dm:messages', ({ dmId }) => {
      if (dmId) emitRead(socket, dmId);
    });
  }

  /** Sunucuya "bu DM'i okudum" bil */
  function emitRead(socket, dmId) {
    socket.emit('dm:read', { dmId });
  }

  /**
   * Bir mesaj balonuna tik ekle.
   * el: .dm-msg elementi, isSelf: gönderen ben miyim, msgId: mesaj id
   */
  function renderTick(el, isSelf, dmId, msgCreatedAt) {
    if (!isSelf) return; // Kendi mesajlarıma tik eklerim
    const existing = el.querySelector('.dm-tick');
    if (existing) return;

    const tick = document.createElement('span');
    tick.className = 'dm-tick';
    tick.dataset.dmId     = dmId;
    tick.dataset.createdAt = String(msgCreatedAt);
    tick.textContent = '✓';
    tick.title = 'Gönderildi';
    el.appendChild(tick);

    // Eğer zaten okunmuşsa hemen güncelle
    const state = readState.get(dmId);
    if (state && state.readAt >= msgCreatedAt) {
      setRead(tick);
    }
  }

  function updateTicks(dmId, readAt) {
    document.querySelectorAll(`.dm-tick[data-dm-id="${dmId}"]`).forEach(tick => {
      const msgTs = Number(tick.dataset.createdAt);
      if (readAt >= msgTs) setRead(tick);
    });
  }

  function setRead(tickEl) {
    tickEl.textContent = '✓✓';
    tickEl.classList.add('read');
    tickEl.title = 'Okundu';
  }

  window.DmRead = { init, renderTick, emitRead };
})();

// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
export const dmReadReady = true;
