import { getCurrentChannel } from './globals.js';
// client/js/core/unread.js
// Okunmamış mesaj sayaçları
// misc.js'den ayrıştırıldı

const unreadCounts = {};

function incrementUnread(channelId) {
  if (getCurrentChannel()?._id === channelId) return;
  unreadCounts[channelId] = (unreadCounts[channelId] || 0) + 1;
  _renderUnreadBadge(channelId);
}

function clearUnread(channelId) {
  unreadCounts[channelId] = 0;
  document.querySelector(`.ch-item[data-id="${channelId}"] .ch-unread`)?.remove();
}

function _renderUnreadBadge(channelId) {
  const el = document.querySelector(`.ch-item[data-id="${channelId}"]`);
  if (!el) return;
  let badge = el.querySelector('.ch-unread');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'ch-unread';
    el.appendChild(badge);
  }
  const count = unreadCounts[channelId] || 0;
  badge.textContent = count > 9 ? '9+' : count;
}

export {
  clearUnread,
  incrementUnread,
};

