// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ServersPanel.svelte
//              client/js/core/servers-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// @ts-check
// core/servers.ts
import { getAPI, getMe, setMe, getCurrentServer, getCurrentChannel,
         loadServerEmojis, initBlockedUserIds, addBlockedUserId,
         setContextCommands, setCurrentServer }                    from './globals.js';
import { apiFetch, setToken, setRefreshToken }                    from './api-fetch.js';
import { setSocket }                                              from './socket.js';
import { toast }                                                  from './utils.js';
import { loadTheme }                                              from './theme.js';
import { loadClientConfig }                                       from './auth.js';
import { bindSocketEvents, bridgeAppInterface }                   from './socket-events.js';
import { initEmojiPicker }                                        from './emoji-picker.js';
import { BridgeRegistry }                                         from './bridge-registry.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface BridgeServer {
  _id: string;
  name: string;
  icon?: string;
  iconUrl?: string;
  bannerUrl?: string;
  ownerId?: string;
  roles?: Array<{ _id: string; name: string }>;
}

interface BridgeUser {
  _id?: string;
  id?: string;
  username?: string;
  displayName: string;
  avatarColor?: string;
  avatarUrl?: string;
  activity?: unknown;
}

// ── App bootstrap ────────────────────────────────────────────────────────────

async function startApp(t: string, user: BridgeUser, rToken?: string | null): Promise<void> {
  setToken(t);
  if (rToken) setRefreshToken(rToken);
  localStorage.setItem('bridge_token', t);
  if (rToken) localStorage.setItem('bridge_refresh_token', rToken);

  (document.getElementById('auth-screen') as HTMLElement).style.display = 'none';
  (document.getElementById('app') as HTMLElement).style.display = 'flex';

  await loadClientConfig();
  await loadTheme();
  updateUserPanel(user);

  BridgeRegistry.call('adminInjectButton', user);

  const _sock = (window as { io?(...args: unknown[]): unknown }).io!(getAPI(), {
    auth: { token: t },
    transports: ['websocket', 'polling'],
  });
  setSocket(_sock);
  const socket = _sock;

  const _rtc = new (window as { BridgeRTC?: new (s: unknown) => { loadSavedDevices(): void; registerVoiceE2EEvents(id: string): void } }).BridgeRTC!(socket);
  _rtc.loadSavedDevices();
  if (user?._id) _rtc.registerVoiceE2EEvents(user._id);

  const _bridgeAppInstance = bridgeAppInterface();
  BridgeRegistry.register('bridgeApp', _bridgeAppInstance);
  bindSocketEvents();

  // Personal room for GDM + socket-ready event
  socket.on('connect', () => {
    socket.emit('user:join-room', user?._id);
    document.dispatchEvent(new Event('bridge:socket-ready'));
  });
  if (socket.connected) {
    socket.emit('user:join-room', user?._id);
    document.dispatchEvent(new Event('bridge:socket-ready'));
  }

  // Load blocked user IDs
  initBlockedUserIds();
  apiFetch(`${getAPI()}/api/friends/blocked`)
    .then(r => r.json())
    .then((users: Array<{ id: string }>) => {
      users.forEach(u => addBlockedUserId(u.id));
    })
    .catch(() => {});

  await loadServers();
  initEmojiPicker();
  BridgeRegistry.call('loadScheduledBadge');
  BridgeRegistry.call('initStatusPicker');

  // Patch selectChannel for draft save/restore — BridgeRegistry.wrap sprint 71
  BridgeRegistry.wrap<(...a: unknown[]) => Promise<void>>('selectChannel', async (orig, channel) => {
    const inp = document.getElementById('msg-input') as HTMLTextAreaElement | null;
    const ch = getCurrentChannel();
    if (ch && inp) BridgeRegistry.call('saveDraft', (ch as { _id: string })._id, inp.value);
    if (orig) await orig(channel);
    if (inp && channel) inp.value = (BridgeRegistry.call('restoreDraft', (channel as { _id: string })._id) as string) || '';
  });

  // E2EE auto-init — BridgeRegistry sprint 71
  const _e2e = BridgeRegistry.get<(id: string) => Promise<{ enabled?: boolean }>>('BridgeE2E:autoInit');
  if (_e2e) {
    _e2e(user.id ?? user._id ?? '').then((status) => {
      const btn = document.getElementById('btn-e2e');
      if (btn) btn.textContent = status?.enabled ? '🔒' : '🔓';
    }).catch(() => {});
  }

  // Activity socket handler
  socket.on('user:activity', (data: unknown) => {
    BridgeRegistry.call('handleUserActivity', data);
  });

  // Load own activity into me object
  apiFetch(`${getAPI()}/api/activity/${user.id ?? user._id}`)
    .then(r => r.json())
    .then((data: Record<string, unknown>) => {
      const me = getMe() as Record<string, unknown> | null | undefined;
      if (me && data.activity) me.activity = data.activity;
    })
    .catch(() => {});

  // First-login onboarding tour
  setTimeout(() => {
    BridgeRegistry.call('BridgeTour:start');
  }, 1500);

  // Sentry user context
  const _setSentryUser = BridgeRegistry.get<(u: { id?: string; username?: string }) => void>('sentryClient:setSentryUser');
  if (_setSentryUser && user) {
    _setSentryUser({ id: user._id || user.id, username: user.username });
  }
}

function updateUserPanel(user: BridgeUser): void {
  const avatarEl = document.getElementById('my-avatar');
  const usernameEl = document.getElementById('my-username');
  if (avatarEl) {
    avatarEl.textContent = initials(user.displayName);
    avatarEl.style.background = user.avatarColor ?? '';
  }
  if (usernameEl) usernameEl.textContent = user.displayName;
  setMe(user); // Sprint 71: window.me kaldırıldı — getMe()/setMe() canonical
}

// ── Window load ──────────────────────────────────────────────────────────────

window.addEventListener('load', async () => {
  await (BridgeRegistry.get<() => Promise<void>>('loadCaptchaConfig') ?? (() => Promise.resolve()))();

  const saved = localStorage.getItem('bridge_token');
  const savedRefresh = localStorage.getItem('bridge_refresh_token');
  if (!saved && !savedRefresh) return;

  setToken(saved!);
  setRefreshToken(savedRefresh ?? null);

  try {
    const r = await apiFetch(`${getAPI()}/api/me`);
    if (!r.ok) {
      localStorage.removeItem('bridge_token');
      localStorage.removeItem('bridge_refresh_token');
      setToken(null);
      setRefreshToken(null);
      return;
    }
    const user: BridgeUser = await r.json();
    await startApp(saved!, user, savedRefresh);
  } catch {
    localStorage.removeItem('bridge_token');
    localStorage.removeItem('bridge_refresh_token');
    setToken(null);
    setRefreshToken(null);
  }
});

// ── Servers ──────────────────────────────────────────────────────────────────

async function loadServers(): Promise<void> {
  const r = await apiFetch(`${getAPI()}/api/servers`);
  const servers: BridgeServer[] = await r.json();
  renderServerList(servers);
  if (servers[0]) await selectServer(servers[0]);
}

function renderServerList(servers: BridgeServer[]): void {
  const list = document.getElementById('server-list');
  if (!list) return;
  list.innerHTML = '';

  for (const s of servers) {
    const el = document.createElement('div');
    el.className = 'server-icon tooltip';
    el.setAttribute('data-tip', s.name);
    el.setAttribute('data-id', s._id);

    if (s.iconUrl) {
      el.style.backgroundImage = `url(${getAPI()}${s.iconUrl})`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.innerHTML = '<div class="pill"></div>';
    } else {
      el.innerHTML = `<div class="pill"></div>${s.icon ?? '🌐'}`;
    }

    el.onclick = () => selectServer(s);
    list.appendChild(el);
  }

  const sep = document.createElement('div');
  sep.className = 'server-separator';
  const add = document.createElement('div');
  add.className = 'server-add tooltip';
  add.setAttribute('data-tip', 'Add / Join Server');
  add.textContent = '+';
  add.onclick = () => BridgeRegistry.call('openAddServerModal');
  list.appendChild(sep);
  list.appendChild(add);
}

async function selectServer(server: BridgeServer): Promise<void> {
  setCurrentServer(server as unknown as import('./globals.js').Server);
  loadServerEmojis(server._id);

  // Server banner
  let bannerWrap = document.getElementById('server-banner-wrap');
  if (!bannerWrap) {
    bannerWrap = document.createElement('div');
    bannerWrap.id = 'server-banner-wrap';
    bannerWrap.className = 'server-banner-wrap';
    const headerEl = document.getElementById('sidebar-server-name')?.parentElement;
    if (headerEl) headerEl.insertBefore(bannerWrap, headerEl.firstChild);
  }

  if (server.bannerUrl) {
    bannerWrap.innerHTML = `<img src="${getAPI()}${encodeURI(server.bannerUrl)}" alt="banner" class="server-banner">`;
    bannerWrap.style.display = '';
  } else {
    bannerWrap.style.display = 'none';
  }

  // Server icon on sidebar
  const iconEl = document.querySelector<HTMLElement>(`.server-icon[data-id="${server._id}"]`);
  if (iconEl && server.iconUrl) {
    iconEl.style.backgroundImage = `url(${getAPI()}${server.iconUrl})`;
    iconEl.style.backgroundSize = 'cover';
    iconEl.textContent = '';
  }

  const nameEl = document.getElementById('sidebar-server-name');
  if (nameEl) nameEl.textContent = server.name;

  document.querySelectorAll<HTMLElement>('.server-icon').forEach(el =>
    el.classList.toggle('active', el.getAttribute('data-id') === server._id)
  );

  await loadChannels(server._id);
  await loadMembers(server._id);

  // Context commands (bot)
  apiFetch(`${getAPI()}/api/interactions/context-commands?serverId=${server._id}`)
    .then(r => r.ok ? r.json() : [])
    .then((cmds: unknown[]) => setContextCommands(cmds))
    .catch(() => setContextCommands([]));

  // Onboarding check for new member wizard
  setTimeout(() => {
    BridgeRegistry.call('checkAndShowOnboarding', server._id);
  }, 1000);
}

// ── Channels ─────────────────────────────────────────────────────────────────

async function loadChannels(_serverId: string): Promise<void> {
  // Sprint 32: event-based — loadChannelsImpl is no longer needed
  // Sprint 40: Dead code removed — window.loadChannelsImpl never set
}

async function loadMembers(serverId: string): Promise<void> {
  // Delegated to bridge:load-members event handlers
  document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId } }));
}

// ─────────────────────────────────────────────────────────────
// FAZ 2: ESM Export + Compat Shim
// loadChannels/loadMembers → event-based (breaks socket loop)
// ─────────────────────────────────────────────────────────────

export function requestLoadChannels(serverId: string): void {
  document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId } }));
}

export function requestLoadMembers(serverId: string): void {
  document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId } }));
}

// Sprint 36: category:* events forwarded here, breaking the socket-events.js loop.
document.addEventListener('bridge:reload-channels', (e: Event) => {
  const { serverId } = (e as CustomEvent<{ serverId: string }>).detail;
  loadChannels(serverId);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return (name ?? '')
    .split(' ')
    .slice(0, 2)
    .map(w => w[0] ?? '')
    .join('')
    .toUpperCase();
}

export {
  startApp,
  updateUserPanel,
  loadServers,
  renderServerList,
  selectServer,
  loadChannels,
};
