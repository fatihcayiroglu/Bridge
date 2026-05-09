// core/servers.js
import { getAPI, getMe, getCurrentServer, getCurrentChannel,
         loadServerEmojis }                                       from './globals.js';
import { apiFetch, setToken, setRefreshToken }                    from './api-fetch.js';
import { setSocket }                                              from './socket.js';
import { toast }                                                  from './utils.js';
import { loadTheme }                                              from './theme.js';
import { loadClientConfig }                                       from './auth.js';
import { bindSocketEvents }                                       from './socket-events.js';
import { initEmojiPicker }                                        from './emoji-picker.js';

async function startApp(t, user, rToken) {
  setToken(t);  me = user;
  if (rToken) refreshToken = rToken;
  localStorage.setItem('bridge_token', t);
  if (rToken) localStorage.setItem('bridge_refresh_token', rToken);
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  await loadClientConfig();
  await loadTheme();
  updateUserPanel(user);
  if (typeof adminInjectButton === 'function') adminInjectButton(user);
  const _sock = io(getAPI(), { auth: { token: t }, transports: ['websocket', 'polling'] });
  setSocket(_sock);
  const socket = _sock;  // local alias for rest of startApp
  rtc = new BridgeRTC(socket);
  rtc.loadSavedDevices();
  if (user?._id) rtc.registerVoiceE2EEvents(user._id);
  window.bridgeApp = bridgeAppInterface();
  bindSocketEvents();

//   personal room for GDM + socket-ready event
  socket.on('connect', () => {
    socket.emit('user:join-room', user?._id);
    document.dispatchEvent(new Event('bridge:socket-ready'));
  });
  if (socket.connected) {
    socket.emit('user:join-room', user?._id);
    document.dispatchEvent(new Event('bridge:socket-ready'));
  }

//   engellenen kullanıcıları yükle
  window._blockedUserIds = new Set();
  apiFetch(`${getAPI()}/api/friends/blocked`).then(r => r.json()).then(users => {
    users.forEach(u => window._blockedUserIds.add(u.id));
  }).catch(() => {});

  await loadServers();
  initEmojiPicker();
  loadScheduledBadge();
  initStatusPicker(); // v15 status dot
//   patch selectChannel for draft save/restore
  const _sc = selectChannel;
  selectChannel = async function(channel) {
    const inp = document.getElementById('msg-input');
    if (currentChannel && inp) saveDraft(currentChannel._id, inp.value);
    await _sc(channel);
    if (inp && channel) inp.value = restoreDraft(channel._id) || '';
  };

//   E2EE otomatik başlat (daha önce kurulmuşsa)
  if (window.BridgeE2E) {
    window.BridgeE2E.autoInit(user.id).then(status => {
      const btn = document.getElementById('btn-e2e');
      if (btn) btn.textContent = status?.enabled ? '🔒' : '🔓';
    }).catch(() => {});
  }

//   Aktivite socket handler bağla
  socket.on('user:activity', (data) => {
    if (typeof handleUserActivity === 'function') handleUserActivity(data);
  });

//   Kendi aktivitemizi me objesine yükle
  apiFetch(`${getAPI()}/api/activity/${user.id}`).then(r => r.json()).then(data => {
    if (me && data.activity) me.activity = data.activity;
  }).catch(() => {});

//   İlk giriş onboarding turu — yeni kullanıcılar için
  setTimeout(() => {
    if (window.BridgeTour) window.BridgeTour.start();
  }, 1500);

  // Sentry kullanıcı bağlamını ayarla (sentryClient yüklüyse)
  if (window.sentryClient && user) {
    window.sentryClient.setSentryUser({ id: user._id || user.id, username: user.username });
  }
}

function updateUserPanel(user) {
  document.getElementById('my-avatar').textContent = initials(user.displayName);
  document.getElementById('my-avatar').style.background = user.avatarColor;
  document.getElementById('my-username').textContent = user.displayName;
  me = { ...me, ...user };
}

window.addEventListener('load', async () => {
  // CAPTCHA config'i sayfa yüklenince çek (auth öncesi gerekli)
  if (typeof loadCaptchaConfig === 'function') await loadCaptchaConfig();

  const saved = localStorage.getItem('bridge_token');
  const savedRefresh = localStorage.getItem('bridge_refresh_token');
  if (!saved && !savedRefresh) return;
  setToken(saved); setRefreshToken(savedRefresh);
  try {
    const r = await apiFetch(`${getAPI()}/api/me`);
    if (!r.ok) { localStorage.removeItem('bridge_token'); localStorage.removeItem('bridge_refresh_token'); setToken(null); setRefreshToken(null); return; }
    const user = await r.json();
    await startApp(token, user, refreshToken);
  } catch { localStorage.removeItem('bridge_token'); localStorage.removeItem('bridge_refresh_token'); setToken(null); setRefreshToken(null); }
});

// ══════════════════════════════════════════════════
// SERVERS
// ══════════════════════════════════════════════════
async function loadServers() {
  const r = await apiFetch(`${getAPI()}/api/servers`);
  const servers = await r.json();
  renderServerList(servers);
  if (servers[0]) selectServer(servers[0]);
}

function renderServerList(servers) {
  const list = document.getElementById('server-list');
  list.innerHTML = '';
  for (const s of servers) {
    const el = document.createElement('div');
    el.className = 'server-icon tooltip'; el.setAttribute('data-tip', s.name); el.setAttribute('data-id', s._id);
    if (s.iconUrl) {
      el.style.backgroundImage = `url(${API}${s.iconUrl})`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.innerHTML = '<div class="pill"></div>';
    } else {
      el.innerHTML = `<div class="pill"></div>${s.icon || '🌐'}`;
    }
    el.onclick = () => selectServer(s);
    list.appendChild(el);
  }
  const sep = document.createElement('div'); sep.className = 'server-separator';
  const add = document.createElement('div');
  add.className = 'server-add tooltip'; add.setAttribute('data-tip', 'Add / Join Server');
  add.textContent = '+'; add.onclick = openAddServerModal;
  list.appendChild(sep); list.appendChild(add);
}

async function selectServer(server) {
  currentServer = server;
  loadServerEmojis(server._id);
  // Show server banner if exists
  let bannerWrap = document.getElementById('server-banner-wrap');
  if (!bannerWrap) {
    bannerWrap = document.createElement('div');
    bannerWrap.id = 'server-banner-wrap';
    bannerWrap.className = 'server-banner-wrap';
    const headerEl = document.getElementById('sidebar-server-name')?.parentElement;
    if (headerEl) headerEl.insertBefore(bannerWrap, headerEl.firstChild);
  }
  if (server.bannerUrl) {
    bannerWrap.innerHTML = `<img src="${API}${encodeURI(server.bannerUrl)}" alt="banner" class="server-banner">`;
    bannerWrap.style.display = '';
  } else {
    bannerWrap.style.display = 'none';
  }
  // Show server icon image on server list
  const iconEl = document.querySelector(`.server-icon[data-id="${server._id}"]`);
  if (iconEl && server.iconUrl) {
    iconEl.style.backgroundImage = `url(${API}${server.iconUrl})`;
    iconEl.style.backgroundSize = 'cover';
    iconEl.textContent = '';
  }
  document.getElementById('sidebar-server-name').textContent = server.name;
  document.querySelectorAll('.server-icon').forEach(el => el.classList.toggle('active', el.getAttribute('data-id') === server._id));
  await loadChannels(server._id);
  await loadMembers(server._id);

//   Context menu komutlarını yükle (bot context commands)
  apiFetch(`${getAPI()}/api/interactions/context-commands?serverId=${server._id}`)
    .then(r => r.ok ? r.json() : [])
    .then(cmds => { window._contextCommands = cmds; })
    .catch(() => { window._contextCommands = []; });

//   Onboarding kontrolü — yeni üye wizard'ı
  setTimeout(() => {
    if (typeof checkAndShowOnboarding === 'function') checkAndShowOnboarding(server._id);
  }, 1000);
}

// ══════════════════════════════════════════════════
// CHANNELS
// ══════════════════════════════════════════════════
async function loadChannels(serverId) {
  if (typeof window.loadChannelsImpl === 'function') {
    return window.loadChannelsImpl(serverId);
  }
}

// ─────────────────────────────────────────────────────────────
// FAZ 2: ESM Export + Compat Shim
// loadChannels/loadMembers → event-based (socket döngüsü kırma)
// ─────────────────────────────────────────────────────────────

// socket-events.js / socket.js'deki event handler'lar
// 'bridge:load-channels' ve 'bridge:load-members' event'lerini dinler.
// Bu sayede servers.js → socket.js → servers.js döngüsü kırılır.
export function requestLoadChannels(serverId) {
  document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId } }));
}
export function requestLoadMembers(serverId) {
  document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId } }));
}

export {
  startApp,
  updateUserPanel,
  loadServers,
  renderServerList,
  selectServer,
  loadChannels,
};

