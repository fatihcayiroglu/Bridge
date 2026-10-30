import { BridgeRegistry } from '../bridge-registry.ts';
import { closeExclusivePeers } from '../exclusive-surface.ts';
import { BRIDGE_3D_GAME_CATALOG, BRIDGE_SOCIAL_SPACE } from './bridge-game-catalog.ts';
import { startLocalSocialRoom, type RoomDirection, type SocialRoomHandle } from './social-room-webgl.ts';
import { joinSocialRoomPreview, type SocialClient, type SocialClientStatus, type SocialSocket } from './social-room-client.ts';
import { startMiniGolfPractice, type MiniGolfHandle } from './mini-golf-webgl.ts';
import type { GolfState } from './mini-golf-physics.ts';
import { joinOnlineMiniGolf, type OnlineGolfSession, type OnlineGolfMatch, type OnlineGolfStatus } from './mini-golf-client.ts';

type ActivitiesTab = 'games' | 'social';
let overlay: HTMLDivElement | null = null;
let previousFocus: HTMLElement | null = null;
let previousAppInert = false;
let room: SocialRoomHandle | null = null;
let socialSession: SocialClient | null = null;
let miniGolf: MiniGolfHandle | null = null;
let onlineGolf: OnlineGolfSession | null = null;
let currentTab: ActivitiesTab = 'games';

const translations = {
  tr: {
    title: 'Bridge Activities', games: '3D Mini Oyunlar', social: '3D Sosyal Alan',
    close: 'Kapat', subtitle: 'Arkadaşlarla birlikte oynayacağın etkinlikler',
    planned: 'Geliştirme planında', gamesHelp: '9 oyun planlama aşamasında. Mini Golf için tek kişilik, çevrimdışı 3D antrenman önizlemesi var; çok oyunculu oyun henüz hazır değil.',
    solo: 'Tek kişilik 3D antrenman', tryGolf: '3D Mini Golf dene', backToGames: 'Oyunlara dön',
    golfHelp: 'Yerel antrenman · Sunucuya skor gönderilmez, rakip ve çok oyunculu mod yok.',
    golfAim: 'Yön (derece)', golfPower: 'Vuruş gücü', golfShoot: 'Vur', golfReset: 'Yeniden başlat',
    golfStrokes: 'Vuruş', golfReady: 'Top hazır', golfMoving: 'Top hareket ediyor', golfWon: 'Tebrikler! Top deliğe girdi.',
    golfOnlineHelp: 'Deneysel iki oyunculu mod sunucuda ayrıca açılmalıdır. Yerel antrenman varsayılandır. Çevrimiçi maçta fizik ve skor sunucuya aittir.',
    golfJoin: 'İki oyunculu maça katıl (deneysel)', golfLeave: 'Çevrimiçi maçtan ayrıl',
    golfWait: 'İkinci oyuncu bekleniyor…', golfTurn: 'Sıra sende', golfOtherTurn: 'Rakibinin sırası',
    golfFinished: 'Maç sona erdi', golfConnecting: 'Maç durumuna bağlanıyor…',
    golfUnavailable: 'Çevrimiçi maç kapalı veya erişim reddedildi. Yerel antrenman açık.',
    golfInvalid: 'Geçersiz sunucu maç verisi reddedildi.', golfDisconnected: 'Maç bağlantısı kapandı.',
    golfYou: '(sen)', golfPlayer: 'Oyuncu', golfGoal: 'Deliğe girdi',
    socialHelp: 'Gerçek WebGL 3D alan. Yerel önizleme varsayılandır. Sunucunda deneysel ortak oda açıksa ve sen katılmayı seçersen arkadaş avatarları gösterilir; ses henüz bağlı değildir.',
    roomStatus: 'Yerel 3D prototip · Çok oyunculu değil', noWebgl: 'Bu cihazda WebGL açılamadı. 3D oda kullanılamıyor.',
    moveHelp: 'Hareket etmek için 3D alana dokun, sonra WASD veya ok tuşlarını kullan. Mobilde ekrandaki yön tuşlarını kullan.',
    forward: 'İleri', back: 'Geri', left: 'Sol', right: 'Sağ',
    players: 'oyuncu', free: 'Planlanan ücretsiz oyunlar', local: 'Yerel önizleme',
    tryOnline: 'Ortak odayı dene (deneysel)', leaveOnline: 'Ortak odadan ayrıl',
    chooseServer: 'Önce erişimin olan bir sunucu seç.',
    onlineConnecting: 'Sunucudan izin ve oda yanıtı bekleniyor…',
    onlineOnline: 'Ortak odada · Sunucudan gelen avatarlar çiziliyor',
    onlineUnavailable: 'Çevrimiçi oda kullanılamıyor veya sunucuda kapalı. Yerel 3D oda çalışmaya devam ediyor.',
    onlineDisconnected: 'Ortak odadan ayrıldın. Yerel 3D oda açık.',
    onlineInvalid: 'Güvenilmeyen veya geçersiz oda verisi reddedildi.',
    graphicsMode: 'Grafik motoru', quality: 'Grafik kalitesi', low: 'Düşük', balanced: 'Dengeli', high: 'Yüksek',
    graphicsLost: '3D grafik bağlamı kayboldu; çevrimiçi oturum kapatıldı. Geri yükleme bekleniyor…',
    graphicsRestored: '3D grafikler geri yüklendi. Yerel odadasın; çevrimiçi odaya yalnızca yeniden seçerek katılabilirsin.',
  },
  en: {
    title: 'Bridge Activities', games: '3D Mini Games', social: '3D Social Space',
    close: 'Close', subtitle: 'Activities to enjoy with friends',
    planned: 'Planned', gamesHelp: '9 games are planned. Mini Golf has a local, single-player 3D practice preview; multiplayer is not implemented.',
    solo: 'Solo 3D practice', tryGolf: 'Play 3D Mini Golf practice', backToGames: 'Back to games',
    golfHelp: 'Local practice only · No server scores, opponents or multiplayer.',
    golfAim: 'Aim (degrees)', golfPower: 'Shot power', golfShoot: 'Shoot', golfReset: 'Restart',
    golfStrokes: 'Strokes', golfReady: 'Ball ready', golfMoving: 'Ball rolling', golfWon: 'Nice shot! Ball in the hole.',
    golfOnlineHelp: 'Experimental two-player mode requires a separate server feature gate. Solo practice is the default. Online ball physics and scores belong to the server.',
    golfJoin: 'Join two-player match (experimental)', golfLeave: 'Leave online match',
    golfWait: 'Waiting for second player…', golfTurn: 'Your turn', golfOtherTurn: 'Opponent\'s turn',
    golfFinished: 'Match finished', golfConnecting: 'Connecting to match…',
    golfUnavailable: 'Online match disabled or access denied. Solo practice remains available.',
    golfInvalid: 'Invalid server match rejected.', golfDisconnected: 'Match disconnected.',
    golfYou: '(you)', golfPlayer: 'Player', golfGoal: 'Holed',
    socialHelp: 'Real WebGL 3D space. Local preview is the default. Shared avatars are available only when your server enables the experimental room and you explicitly join; voice is not connected yet.',
    roomStatus: 'Local 3D prototype · Not multiplayer', noWebgl: 'WebGL is not available on this device. The 3D room cannot run.',
    moveHelp: 'Focus the 3D room and use WASD or arrow keys. On mobile use the directional controls.',
    forward: 'Forward', back: 'Back', left: 'Left', right: 'Right',
    players: 'players', free: 'Planned free games', local: 'Local preview',
    tryOnline: 'Try shared room (experimental)', leaveOnline: 'Leave shared room',
    chooseServer: 'Select a server you belong to first.',
    onlineConnecting: 'Waiting for server permissions and room response…',
    onlineOnline: 'In shared room · Drawing server-owned avatars',
    onlineUnavailable: 'Shared room unavailable or disabled on server. Local 3D room remains available.',
    onlineDisconnected: 'You left the shared room. Local 3D room remains open.',
    onlineInvalid: 'Untrusted or malformed room snapshot was rejected.',
    graphicsMode: 'Graphics API', quality: 'Graphics quality', low: 'Low', balanced: 'Balanced', high: 'High',
    graphicsLost: '3D graphics context lost; the online session was closed. Waiting for restoration…',
    graphicsRestored: '3D graphics restored in local-only mode. Explicitly opt in again to rejoin the shared room.',
  },
} as const;

function strings() {
  return document.documentElement.lang.toLowerCase().startsWith('tr') ? translations.tr : translations.en;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = '', text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function makeButton(label: string, className: string, action: () => void): HTMLButtonElement {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', action);
  return button;
}

function disposeRoom(): void {
  onlineGolf?.dispose();
  onlineGolf = null;
  miniGolf?.dispose();
  miniGolf = null;
  socialSession?.dispose();
  socialSession = null;
  room?.dispose();
  room = null;
}

function hideBridgeActivities(restoreFocus = true): void {
  disposeRoom();
  if (!overlay) return;
  const last = overlay;
  overlay = null;
  document.removeEventListener('keydown', onDocumentKeydown);
  last.remove();
  const app = document.getElementById('app');
  if (app) app.inert = previousAppInert;
  if (restoreFocus && previousFocus?.isConnected && !document.hidden) previousFocus.focus();
  previousFocus = null;
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (!overlay) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    hideBridgeActivities();
    return;
  }
  if (event.key !== 'Tab') return;
  const targets = [...overlay.querySelectorAll<HTMLElement>(
    'button:not([disabled]),canvas[tabindex="0"],[href],[tabindex="0"]',
  )].filter(item => item.getClientRects().length > 0);
  if (!targets.length) { event.preventDefault(); return; }
  if (event.shiftKey && document.activeElement === targets[0]) {
    event.preventDefault();
    targets[targets.length - 1]!.focus();
  } else if (!event.shiftKey && document.activeElement === targets[targets.length - 1]) {
    event.preventDefault();
    targets[0]!.focus();
  }
}

function showMiniGolf(container: HTMLElement): void {
  // Solo practice by default; online authority is separately feature gated
  // and only started by an explicit action. Never use activity:start, claim
  // production-ready multiplayer or ask for microphone permissions.
  const s = strings();
  container.replaceChildren();
  const back = makeButton(s.backToGames, 'bridge-room-direction', () => {
    onlineGolf?.dispose();
    onlineGolf = null;
    miniGolf?.dispose();
    miniGolf = null;
    container.replaceChildren();
    showGames(container);
  });
  back.classList.add('bridge-mini-golf-back');
  const heading = element('h3', 'bridge-mini-golf-heading', 'Mini Golf · ' + s.solo);
  const help = element('p', 'bridge-activities-help', s.golfHelp);
  const canvas = element('canvas', 'bridge-activities-canvas bridge-mini-golf-canvas');
  canvas.setAttribute('aria-label', 'Mini Golf 3D');
  const status = element('p', 'bridge-room-status bridge-mini-golf-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const controls = element('div', 'bridge-mini-golf-controls');
  const onlineHelp = element('p', 'bridge-activities-help', s.golfOnlineHelp);
  const onlineStatus = element('p', 'bridge-room-status bridge-mini-golf-online-status', s.roomStatus);
  onlineStatus.setAttribute('role','status');
  onlineStatus.setAttribute('aria-live','polite');
  const scoreboard = element('ol', 'bridge-mini-golf-scoreboard');
  const onlineButton = makeButton(s.golfJoin, 'bridge-room-direction bridge-mini-golf-online-button', toggleOnline);
  let joiningOnline = false;
  function updateMatch(match: OnlineGolfMatch): void {
    scoreboard.replaceChildren();
    match.players.forEach((p, index) => {
      const label = s.golfPlayer + ' ' + (index + 1) +
        (p.userId === match.you ? ' ' + s.golfYou : '') +
        ' · ' + s.golfStrokes + ': ' + p.strokes + (p.won ? ' · ' + s.golfGoal : '');
      scoreboard.append(element('li', '', label));
    });
    const displayed = match.players.find(p => p.userId === match.turnUserId) ??
      match.players.find(p => p.userId === match.you);
    if (!displayed || !miniGolf?.setAuthoritativeBall(displayed.x, displayed.z)) {
      onlineGolf?.dispose(); return;
    }
    const myTurn = match.phase === 'playing' && match.turnUserId === match.you;
    const canShoot = myTurn && miniGolf.isGraphicsAvailable;
    shoot.disabled = !canShoot;
    aim.disabled = !canShoot;
    power.disabled = !canShoot;
    reset.disabled = true;
    onlineStatus.textContent = match.phase === 'waiting' ? s.golfWait :
      match.phase === 'finished' ? s.golfFinished : myTurn ? s.golfTurn : s.golfOtherTurn;
  }
  function onlineState(status: OnlineGolfStatus): void {
    if (status === 'connecting') {
      onlineStatus.textContent = s.golfConnecting;
      shoot.disabled = true;
      aim.disabled = true;
      power.disabled = true;
      reset.disabled = true;
      return;
    }
    if (status === 'waiting' || status === 'playing' || status === 'finished') {
      onlineButton.textContent = s.golfLeave;
      joiningOnline = false;
      return;
    }
    joiningOnline = false;
    onlineGolf = null;
    miniGolf?.leaveOnline();
    scoreboard.replaceChildren();
    onlineButton.textContent = s.golfJoin;
    onlineStatus.textContent = {
      unavailable: s.golfUnavailable, invalid: s.golfInvalid,
      disconnected: s.golfDisconnected,
    }[status];
    shoot.disabled = false;
    aim.disabled = false;
    power.disabled = false;
    reset.disabled = false;
  }
  function toggleOnline(): void {
    if (onlineGolf || joiningOnline) {
      onlineGolf?.dispose();
      onlineGolf = null;
      joiningOnline = false;
      return;
    }
    const selected = BridgeRegistry.call<unknown>('getCurrentServer');
    const rawId = selected && typeof selected === 'object' ? (selected as { _id?: unknown })._id : null;
    const serverId = typeof rawId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(rawId) ? rawId : null;
    const socketValue = BridgeRegistry.get<unknown>('socket');
    const socket = socketValue && typeof socketValue === 'object'
      ? socketValue as SocialSocket : null;
    if (!serverId || !socket?.connected || !miniGolf?.isGraphicsAvailable) {
      onlineStatus.textContent = serverId ? s.golfUnavailable : s.chooseServer;
      return;
    }
    miniGolf.reset();
    joiningOnline = true;
    onlineButton.textContent = s.golfLeave;
    onlineGolf = joinOnlineMiniGolf(socket, serverId, updateMatch, onlineState);
  }
  const aimLabel = element('label', 'bridge-mini-golf-label', s.golfAim);
  const aim = element('input', 'bridge-mini-golf-aim');
  aim.type = 'range'; aim.min = '-70'; aim.max = '70'; aim.step = '5'; aim.value = '0';
  aimLabel.append(aim);
  const powerLabel = element('label', 'bridge-mini-golf-label', s.golfPower);
  const power = element('input', 'bridge-mini-golf-power');
  power.type = 'range'; power.min = '10'; power.max = '100'; power.step = '5'; power.value = '60';
  powerLabel.append(power);
  const shoot = makeButton(s.golfShoot, 'bridge-room-direction bridge-mini-golf-shoot', () => {
    if (onlineGolf?.active) onlineGolf.shoot(Number(aim.value), Number(power.value));
    else if (!joiningOnline) miniGolf?.shoot(Number(aim.value), Number(power.value));
  });
  const reset = makeButton(s.golfReset, 'bridge-room-direction bridge-mini-golf-reset', () => {
    if (!onlineGolf && !joiningOnline) miniGolf?.reset();
  });
  function update(state: GolfState): void {
    if (onlineGolf || joiningOnline) return;
    status.textContent = s.golfStrokes + ': ' + state.strokes + ' · ' + (
      state.status === 'won' ? s.golfWon : state.status === 'moving' ? s.golfMoving : s.golfReady
    );
    const playable = state.status === 'ready' && (miniGolf?.isGraphicsAvailable ?? true);
    shoot.disabled = !playable;
    aim.disabled = !playable;
    power.disabled = !playable;
  }
  controls.append(aimLabel, powerLabel, shoot, reset);
  container.append(back, heading, help, canvas, status, controls,
    onlineHelp, onlineStatus, onlineButton, scoreboard);
  try {
    miniGolf = startMiniGolfPractice(canvas, update, () => {
      onlineGolf?.dispose();
      onlineGolf = null;
      onlineStatus.textContent = s.graphicsLost;
    });
    if (!miniGolf) {
      status.textContent = s.noWebgl;
      shoot.disabled = true;
      onlineButton.disabled = true;
      return;
    }
    update(miniGolf.state);
  } catch {
    miniGolf?.dispose();
    miniGolf = null;
    status.textContent = s.noWebgl;
    shoot.disabled = true;
    onlineButton.disabled = true;
  }
}

function showGames(container: HTMLElement): void {
  const s = strings();
  container.append(element('p', 'bridge-activities-help', s.gamesHelp));
  const grid = element('div', 'bridge-activities-grid');
  for (const game of BRIDGE_3D_GAME_CATALOG) {
    const card = element('article', 'bridge-activities-card');
    card.append(
      element('h3', '', game.title),
      element('p', '', String(game.minPlayers) + '–' + String(game.maxPlayers) + ' ' + s.players),
      element('span', game.state === 'solo-practice' ? 'bridge-activities-solo' : 'bridge-activities-planned',
        game.state === 'solo-practice' ? s.solo : s.planned),
    );
    if (game.state === 'solo-practice') {
      const play = makeButton(s.tryGolf, 'bridge-room-direction bridge-mini-golf-launch', () => showMiniGolf(container));
      play.setAttribute('data-game-id', game.id);
      card.append(play);
    }
    grid.append(card);
  }
  container.append(grid);
}

function directionControl(
  label: string, direction: RoomDirection,
): HTMLButtonElement {
  const button = element('button', 'bridge-room-direction', label);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  const stop = () => room?.setDirection(direction, false);
  button.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    button.setPointerCapture(event.pointerId);
    room?.setDirection(direction, true);
  });
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointercancel', stop);
  button.addEventListener('lostpointercapture', stop);
  button.addEventListener('blur', stop);
  return button;
}

function showSocial(container: HTMLElement): void {
  const s = strings();
  container.append(
    element('p', 'bridge-activities-help', s.socialHelp),
    element('p', 'bridge-room-status', s.roomStatus),
  );
  const canvas = element('canvas', 'bridge-activities-canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', s.social + ': ' + s.moveHelp);
  container.append(canvas);
  const controls = element('div', 'bridge-room-controls');
  controls.append(
    directionControl('↑ ' + s.forward, 'forward'),
    directionControl('← ' + s.left, 'left'),
    directionControl('↓ ' + s.back, 'back'),
    directionControl('→ ' + s.right, 'right'),
  );
  container.append(controls, element('p', 'bridge-activities-help', s.moveHelp));
  try {
    const graphicsWarning = element('p', 'bridge-room-error');
    graphicsWarning.setAttribute('role', 'status');
    graphicsWarning.setAttribute('aria-live', 'polite');
    let onlineJoin: HTMLButtonElement | null = null;
    let allowJoinOnRestore = false;
    room = startLocalSocialRoom(
      canvas, direction => socialSession?.step(direction),
      () => {
        socialSession?.dispose();
        socialSession = null;
        room?.leaveOnline();
        if (onlineJoin) onlineJoin.disabled = true;
        graphicsWarning.textContent = s.graphicsLost;
        canvas.setAttribute('aria-disabled', 'true');
      },
      () => {
        canvas.removeAttribute('aria-disabled');
        graphicsWarning.textContent = s.graphicsRestored;
        if (onlineJoin) onlineJoin.disabled = !allowJoinOnRestore;
      },
    );
    if (!room) {
      container.append(element('p', 'bridge-room-error', s.noWebgl));
      return;
    }
    const graphicsMode = element('p', 'bridge-room-status',
      s.graphicsMode + ': ' + (room.graphicsApi === 'webgl2' ? 'WebGL 2' : 'WebGL 1'));
    const qualityLabel = element('label', 'bridge-room-quality-label', s.quality);
    qualityLabel.htmlFor = 'bridge-room-quality';
    const qualitySelect = element('select', 'bridge-room-quality');
    qualitySelect.id = 'bridge-room-quality';
    for (const [value, title] of [['low', s.low], ['balanced', s.balanced], ['high', s.high]]) {
      const option = element('option', '', title);
      option.value = value;
      if (value === 'balanced') option.selected = true;
      qualitySelect.append(option);
    }
    qualitySelect.addEventListener('change', () => {
      const selected = qualitySelect.value;
      if (selected === 'low' || selected === 'balanced' || selected === 'high') {
        room?.setQuality(selected);
      }
    });
    container.append(graphicsMode, qualityLabel, qualitySelect, graphicsWarning);
    // The network protocol is an explicit, optional experiment. Merely opening
    // this tab neither joins a server room nor reads mic/camera permissions.
    const chosen = BridgeRegistry.call<unknown>('getCurrentServer');
    const candidate = chosen && typeof chosen === 'object' ? (chosen as { _id?: unknown })._id : null;
    const serverId = typeof candidate === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(candidate) ? candidate : null;
    allowJoinOnRestore = Boolean(serverId);
    const currentSocket = BridgeRegistry.get<unknown>('socket');
    const socket = currentSocket && typeof currentSocket === 'object'
      ? currentSocket as SocialSocket : null;
    const onlineStatus = element('p', 'bridge-room-status', serverId ? s.roomStatus : s.chooseServer);
    onlineStatus.setAttribute('role', 'status');
    onlineStatus.setAttribute('aria-live', 'polite');
    const joinButton = makeButton(s.tryOnline, 'bridge-room-direction', () => {
      if (!serverId || !room || !room.isGraphicsAvailable) return;
      if (socialSession?.active) {
        socialSession.dispose();
        socialSession = null;
        room.leaveOnline();
        joinButton.textContent = s.tryOnline;
        return;
      }
      // Read the canonical socket at the moment of the click. Reconnect may
      // replace it since the modal first opened.
      const live = BridgeRegistry.get<unknown>('socket');
      const chosenSocket = live && typeof live === 'object' ? live as SocialSocket : socket;
      if (!chosenSocket || !chosenSocket.connected ||
          typeof chosenSocket.on !== 'function' || typeof chosenSocket.off !== 'function' ||
          typeof chosenSocket.emit !== 'function') {
        onlineStatus.textContent = s.onlineUnavailable;
        return;
      }
      socialSession = joinSocialRoomPreview(
        chosenSocket, serverId,
        (snapshot, ownSocketId) => room?.setOnlinePeers(snapshot.peers, ownSocketId) ?? false,
        (status: SocialClientStatus) => {
          if (status !== 'online') room?.leaveOnline();
          const message = {
            connecting: s.onlineConnecting, online: s.onlineOnline,
            unavailable: s.onlineUnavailable, disconnected: s.onlineDisconnected,
            invalid: s.onlineInvalid,
          }[status];
          onlineStatus.textContent = message;
          joinButton.textContent = status === 'online' ? s.leaveOnline : s.tryOnline;
        },
      );
    });
    onlineJoin = joinButton;
    joinButton.disabled = !serverId || !room.isGraphicsAvailable;
    container.append(onlineStatus, joinButton);
  } catch {
    disposeRoom();
    container.append(element('p', 'bridge-room-error', s.noWebgl));
  }
}

function switchTab(tab: ActivitiesTab): void {
  if (!overlay) return;
  currentTab = tab;
  disposeRoom();
  const body = overlay.querySelector<HTMLElement>('#bridge-activities-body');
  if (!body) return;
  body.replaceChildren();
  for (const button of overlay.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const active = button.dataset.tab === currentTab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  if (tab === 'social') showSocial(body);
  else showGames(body);
}

export function showBridgeActivities(tab: ActivitiesTab = 'games'): void {
  const app = document.getElementById('app');
  // This is an authenticated shell feature, never a public landing-page modal.
  if (!app || getComputedStyle(app).display === 'none') return;
  if (overlay) { switchTab(tab); return; }
  closeExclusivePeers('activities');
  const s = strings();
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousAppInert = app.inert;
  const root = element('div', 'bridge-activities-overlay');
  root.setAttribute('role', 'presentation');
  const dialog = element('section', 'bridge-activities-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'bridge-activities-title');
  dialog.setAttribute('aria-describedby', 'bridge-activities-subtitle');
  const header = element('header', 'bridge-activities-header');
  const heading = element('div');
  const title = element('h2', '', s.title);
  title.id = 'bridge-activities-title';
  const subtitle = element('p', '', s.subtitle);
  subtitle.id = 'bridge-activities-subtitle';
  heading.append(title, subtitle);
  header.append(heading, makeButton('×', 'bridge-activities-close', () => hideBridgeActivities()));
  header.lastElementChild?.setAttribute('aria-label', s.close);
  const tabs = element('div', 'bridge-activities-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', s.title);
  const gamesTab = makeButton(s.games, 'bridge-activities-tab', () => switchTab('games'));
  gamesTab.setAttribute('role', 'tab');
  gamesTab.dataset.tab = 'games';
  gamesTab.setAttribute('aria-controls', 'bridge-activities-body');
  const socialTab = makeButton(s.social, 'bridge-activities-tab', () => switchTab('social'));
  socialTab.setAttribute('role', 'tab');
  socialTab.dataset.tab = 'social';
  socialTab.setAttribute('aria-controls', 'bridge-activities-body');
  tabs.append(gamesTab, socialTab);
  const body = element('div', 'bridge-activities-body');
  body.id = 'bridge-activities-body';
  body.setAttribute('role', 'tabpanel');
  dialog.append(header, tabs, body);
  root.append(dialog);
  root.addEventListener('pointerdown', event => {
    if (event.target === root) hideBridgeActivities();
  });
  overlay = root;
  document.body.append(root);
  app.inert = true;
  document.addEventListener('keydown', onDocumentKeydown);
  switchTab(tab);
  (tab === 'social' ? socialTab : gamesTab).focus();
}

// Register only when the feature is opened; no web renderer or GPU is loaded
// during the ordinary Bridge startup.
BridgeRegistry.register('showBridgeActivities', showBridgeActivities);
BridgeRegistry.register('closeBridgeActivities', hideBridgeActivities);
document.addEventListener('bridge:auth-logout', () => hideBridgeActivities(false));
