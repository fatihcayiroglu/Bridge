// client/js/core/socket-events.js
import { getSocket, getCurrentChannel, getCurrentServer } from './globals.js';
import { toast }                                          from './utils.js';
import { loadChannels }                                   from './servers.js';

// v15+ socket event bağlantıları + status picker
// misc.js'den ayrıştırıldı

// ══════════════════════════════════════════════════
// UYGULAMA DURUMU (misc.js'den taşındı)
// ══════════════════════════════════════════════════

let gsTab          = 'all';
let gsTimer        = null;
let msgDrafts      = {};
let notifPrefs     = {};
let friendsList    = [];
let pendingRequests = [];
let timeoutTargetId = null;
let notifCtxChannel = null;
let currentStatusText = '';

// ══════════════════════════════════════════════════
// SOCKET EVENTS (v15+)
// ══════════════════════════════════════════════════

function bindSocketEvents() {
  // Thread socket events (varsa)
  if (typeof _bindThreadSocketEvents === 'function') {
    _bindThreadSocketEvents();
  }

  // Timeout uyarısı
  socket.on('error:timeout', ({ remaining }) => {
    toast(`⏱️ Susturuldunuz. ${Math.ceil(remaining / 60)} dakika kaldı.`, 'error');
  });

  // Arkadaşlık isteği
  socket.on('friend:request:received', ({ from }) => {
    toast(`👥 ${from.displayName} sana arkadaşlık isteği gönderdi!`, 'success');
    if (typeof loadFriends === 'function') loadFriends();
  });

  // Kullanıcı durumu güncellemesi
  socket.on('user:status', ({ userId, status, statusText, statusEmoji }) => {
    const idx = friendsList.findIndex(f => f._id === userId);
    if (idx !== -1) {
      friendsList[idx].status      = status;
      friendsList[idx].statusText  = statusText  || '';
      friendsList[idx].statusEmoji = statusEmoji || '';
    }
  });

  // Ses aktivitesi (konuşuyor mu göstergesi)
  socket.on('voice:activity', ({ socketId, speaking }) => {
    document.querySelector(`.voice-peer[data-socket="${socketId}"]`)
      ?.classList.toggle('speaking', speaking);
  });

  // Bildirim tercihi güncellemesi
  socket.on('notif:pref:updated', ({ channelId, level }) => {
    notifPrefs[channelId] = level;
  });

  // Kategori olayları
  socket.on('category:created', () => {
    if (getCurrentServer()) loadChannels(currentServer._id);
  });
  socket.on('category:updated', () => {
    if (getCurrentServer()) loadChannels(currentServer._id);
  });
  socket.on('category:deleted', () => {
    if (getCurrentServer()) loadChannels(currentServer._id);
  });
}

// ══════════════════════════════════════════════════
// STATUS PICKER
// ══════════════════════════════════════════════════

function initStatusPicker() {
  const dot = document.getElementById('my-status-dot');
  if (dot) dot.addEventListener('click', openStatusPicker);
}

// ══════════════════════════════════════════════════
// BRIDGE APP INTERFACE (WebRTC köprüsü)
// ══════════════════════════════════════════════════

function bridgeAppInterface() {
  return {
    renderVoicePeer,
    removeVoicePeer,
    attachRemoteStream,
    updatePeerState,
    toast,
  };
}

// ══════════════════════════════════════════════════
// STAGE CHANNEL SOCKET EVENTS
// ══════════════════════════════════════════════════
function initStageSocketEvents() {
  const stageEvents = [
    'stage:state', 'stage:userJoined', 'stage:userLeft',
    'stage:handRaise', 'stage:muteUpdate', 'stage:promoted',
  ];
  stageEvents.push('stage:demoted');
  stageEvents.forEach(ev => {
    socket.on(ev, (data) => {
      if (typeof handleStageEvent === 'function') handleStageEvent(ev, data);
    });
  });
}

// ── Reaction Role bildirimleri ────────────────────────────────
if (typeof socket !== 'undefined') {
  socket.on('role:granted', ({ roleId, emoji }) => {
    // Rol adını bulmaya çalış
    const roleName = (typeof currentServer !== 'undefined' && currentServer?.roles)
      ? (currentServer.roles.find(r => r._id === roleId)?.name || roleId)
      : roleId;
    toast(`${emoji} ${roleName} rolü verildi!`, 'success');
  });
  socket.on('role:revoked', ({ roleId, emoji }) => {
    const roleName = (typeof currentServer !== 'undefined' && currentServer?.roles)
      ? (currentServer.roles.find(r => r._id === roleId)?.name || roleId)
      : roleId;
    toast(`${emoji} ${roleName} rolü alındı`, 'info');
  });
}

export {
  bindSocketEvents,
  bridgeAppInterface,
  initStageSocketEvents,
  initStatusPicker,
};

