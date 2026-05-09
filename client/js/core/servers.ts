export {};
// core/servers.js
async function startApp(t, user, rToken) {
  token = t; me = user;
  window._myUser = user;
  if (rToken) refreshToken = rToken;
  localStorage.setItem('bridge_token', t);
  if (rToken) localStorage.setItem('bridge_refresh_token', rToken);
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  await loadClientConfig();
  await loadTheme();
  updateUserPanel(user);
  if (typeof adminInjectButton === 'function') adminInjectButton(user);
  socket = io(API, { auth: { token }, transports: ['websocket', 'polling'] });
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

//   engellenen kullanÄ±cÄ±larÄ± yÃ¼kle
  window._blockedUserIds = new Set();
  apiFetch(`${API}/api/friends/blocked`).then(r => r.json()).then(users => {
    users.forEach(u => window._blockedUserIds.add(u.id));
  }).catch(() => {});

  await loadServers();
  initEmojiPicker();
  loadScheduledBadge();
  initStatusPicker(); // v15 status dot
//   patch selectChannel for draft save/restore
  const _sc = selectChannel;
  window._scOrig = _sc;
  window.selectChannel = async function(channel) {
    const inp = document.getElementById('msg-input');
    if (currentChannel && inp) saveDraft(currentChannel._id, inp.value);
    await _sc(channel);
    if (inp && channel) inp.value = restoreDraft(channel._id) || '';
  };

//   E2EE otomatik baÅŸlat (daha Ã¶nce kurulmuÅŸsa)
  if (window.BridgeE2E) {
    window.BridgeE2E.autoInit(user.id).then(status => {
      const btn = document.getElementById('btn-e2e');
      if (btn) btn.textContent = status?.enabled ? 'ğŸ”’' : 'ğŸ”“';
    }).catch(() => {});
  }

//   Aktivite socket handler baÄŸla
  socket.on('user:activity', (data) => {
    if (typeof handleUserActivity === 'function') handleUserActivity(data);
  });

//   Kendi aktivitemizi me objesine yÃ¼kle
  apiFetch(`${API}/api/activity/${user.id}`).then(r => r.json()).then(data => {
    if (me && data.activity) me.activity = data.activity;
  }).catch(() => {});

//   Ä°lk giriÅŸ onboarding turu â€” yeni kullanÄ±cÄ±lar iÃ§in
  setTimeout(() => {
    if (window.BridgeTour) window.BridgeTour.start();
  }, 1500);
}

function updateUserPanel(user) {
  document.getElementById('my-avatar').textContent = initials(user.displayName);
  document.getElementById('my-avatar').style.background = user.avatarColor;
  document.getElementById('my-username').textContent = user.displayName;
  me = { ...me, ...user };
}

window.addEventListener('load', async () => {
  // CAPTCHA config'i sayfa yÃ¼klenince Ã§ek (auth Ã¶ncesi gerekli)
  if (typeof loadCaptchaConfig === 'function') await loadCaptchaConfig();

  const saved = localStorage.getItem('bridge_token');
  const savedRefresh = localStorage.getItem('bridge_refresh_token');
  if (!saved && !savedRefresh) return;
  token = saved; refreshToken = savedRefresh;
  try {
    const r = await apiFetch(`${API}/api/me`);
    if (!r.ok) { localStorage.removeItem('bridge_token'); localStorage.removeItem('bridge_refresh_token'); token = null; refreshToken = null; return; }
    const user = await r.json();
    await startApp(token, user, refreshToken);
  } catch { localStorage.removeItem('bridge_token'); localStorage.removeItem('bridge_refresh_token'); token = null; refreshToken = null; }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SERVERS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function loadServers() {
  const r = await apiFetch(`${API}/api/servers`);
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
      el.innerHTML = `<div class="pill"></div>${s.icon || 'ğŸŒ'}`;
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

//   Context menu komutlarÄ±nÄ± yÃ¼kle (bot context commands)
  apiFetch(`${API}/api/interactions/context-commands?serverId=${server._id}`)
    .then(r => r.ok ? r.json() : [])
    .then(cmds => { window._contextCommands = cmds; })
    .catch(() => { window._contextCommands = []; });

//   Onboarding kontrolÃ¼ â€” yeni Ã¼ye wizard'Ä±
  setTimeout(() => {
    if (typeof checkAndShowOnboarding === 'function') checkAndShowOnboarding(server._id);
  }, 1000);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CHANNELS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function loadChannels(serverId) {
  if (typeof window.loadChannelsImpl === 'function') {
    return window.loadChannelsImpl(serverId);
  }
}

