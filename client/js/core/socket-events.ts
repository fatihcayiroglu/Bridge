export {};
// client/js/core/socket-events.js
// v15+ socket event baÄŸlantÄ±larÄ± + status picker
// misc.js'den ayrÄ±ÅŸtÄ±rÄ±ldÄ±

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// UYGULAMA DURUMU (misc.js'den taÅŸÄ±ndÄ±)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

let gsTab          = 'all';
let gsTimer        = null;
let msgDrafts      = {};
let notifPrefs     = {};
let friendsList    = [];
let pendingRequests = [];
let timeoutTargetId = null;
let notifCtxChannel = null;
let currentStatusText = '';

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SOCKET EVENTS (v15+)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function bindSocketEvents() {
  // Thread socket events (varsa)
  if (typeof _bindThreadSocketEvents === 'function') {
    _bindThreadSocketEvents();
  }

  // Timeout uyarÄ±sÄ±
  socket.on('error:timeout', ({ remaining }) => {
    toast(`â±ï¸ Susturuldunuz. ${Math.ceil(remaining / 60)} dakika kaldÄ±.`, 'error');
  });

  // ArkadaÅŸlÄ±k isteÄŸi
  socket.on('friend:request:received', ({ from }) => {
    toast(`ğŸ‘¥ ${from.displayName} sana arkadaÅŸlÄ±k isteÄŸi gÃ¶nderdi!`, 'success');
    if (typeof loadFriends === 'function') loadFriends();
  });

  // KullanÄ±cÄ± durumu gÃ¼ncellemesi
  socket.on('user:status', ({ userId, status, statusText, statusEmoji }) => {
    const idx = friendsList.findIndex(f => f._id === userId);
    if (idx !== -1) {
      friendsList[idx].status      = status;
      friendsList[idx].statusText  = statusText  || '';
      friendsList[idx].statusEmoji = statusEmoji || '';
    }
  });

  // Ses aktivitesi (konuÅŸuyor mu gÃ¶stergesi)
  socket.on('voice:activity', ({ socketId, speaking }) => {
    document.querySelector(`.voice-peer[data-socket="${socketId}"]`)
      ?.classList.toggle('speaking', speaking);
  });

  // Bildirim tercihi gÃ¼ncellemesi
  socket.on('notif:pref:updated', ({ channelId, level }) => {
    notifPrefs[channelId] = level;
  });

  // Kategori olaylarÄ±
  socket.on('category:created', () => {
    if (window.currentServer) loadChannels(currentServer._id);
  });
  socket.on('category:updated', () => {
    if (window.currentServer) loadChannels(currentServer._id);
  });
  socket.on('category:deleted', () => {
    if (window.currentServer) loadChannels(currentServer._id);
  });
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STATUS PICKER
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function initStatusPicker() {
  const dot = document.getElementById('my-status-dot');
  if (dot) dot.addEventListener('click', openStatusPicker);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// BRIDGE APP INTERFACE (WebRTC kÃ¶prÃ¼sÃ¼)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function bridgeAppInterface() {
  return {
    renderVoicePeer,
    removeVoicePeer,
    attachRemoteStream,
    updatePeerState,
    toast,
  };
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STAGE CHANNEL SOCKET EVENTS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

// â”€â”€ Reaction Role bildirimleri â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (typeof socket !== 'undefined') {
  socket.on('role:granted', ({ roleId, emoji }) => {
    // Rol adÄ±nÄ± bulmaya Ã§alÄ±ÅŸ
    const roleName = (typeof currentServer !== 'undefined' && currentServer?.roles)
      ? (currentServer.roles.find(r => r._id === roleId)?.name || roleId)
      : roleId;
    toast(`${emoji} ${roleName} rolÃ¼ verildi!`, 'success');
  });
  socket.on('role:revoked', ({ roleId, emoji }) => {
    const roleName = (typeof currentServer !== 'undefined' && currentServer?.roles)
      ? (currentServer.roles.find(r => r._id === roleId)?.name || roleId)
      : roleId;
    toast(`${emoji} ${roleName} rolÃ¼ alÄ±ndÄ±`, 'info');
  });
}

