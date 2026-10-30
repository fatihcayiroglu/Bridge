import { BridgeRegistry } from '../bridge-registry.ts';
import { closeExclusivePeers } from '../exclusive-surface.ts';
import { BRIDGE_3D_GAME_CATALOG, BRIDGE_SOCIAL_SPACE } from './bridge-game-catalog.ts';
import { startLocalSocialRoom, type RoomDirection, type SocialRoomHandle } from './social-room-webgl.ts';

type ActivitiesTab = 'games' | 'social';
let overlay: HTMLDivElement | null = null;
let previousFocus: HTMLElement | null = null;
let previousAppInert = false;
let room: SocialRoomHandle | null = null;
let currentTab: ActivitiesTab = 'games';

const translations = {
  tr: {
    title: 'Bridge Activities', games: '3D Mini Oyunlar', social: '3D Sosyal Alan',
    close: 'Kapat', subtitle: 'Arkadaşlarla birlikte oynayacağın etkinlikler',
    planned: 'Geliştirme planında', gamesHelp: 'Bu 10 oyun henüz oynanabilir değil. İlk geliştirme için seçilen oyunlar burada listelenir.',
    socialHelp: 'Gerçek WebGL 3D oda prototipi. Avatar yalnızca bu cihazda hareket eder; arkadaşlar, ses ve çok oyunculu bağlantı henüz eklenmedi.',
    roomStatus: 'Yerel 3D prototip · Çok oyunculu değil', noWebgl: 'Bu cihazda WebGL açılamadı. 3D oda kullanılamıyor.',
    moveHelp: 'Hareket etmek için 3D alana dokun, sonra WASD veya ok tuşlarını kullan. Mobilde ekrandaki yön tuşlarını kullan.',
    forward: 'İleri', back: 'Geri', left: 'Sol', right: 'Sağ',
    players: 'oyuncu', free: 'Planlanan ücretsiz oyunlar', local: 'Yerel önizleme',
  },
  en: {
    title: 'Bridge Activities', games: '3D Mini Games', social: '3D Social Space',
    close: 'Close', subtitle: 'Activities to enjoy with friends',
    planned: 'Planned', gamesHelp: 'These 10 games are not playable yet. This is the catalog of games selected for development.',
    socialHelp: 'Real WebGL 3D room prototype. Your avatar moves on this device only; friends, voice and multiplayer networking are not implemented.',
    roomStatus: 'Local 3D prototype · Not multiplayer', noWebgl: 'WebGL is not available on this device. The 3D room cannot run.',
    moveHelp: 'Focus the 3D room and use WASD or arrow keys. On mobile use the directional controls.',
    forward: 'Forward', back: 'Back', left: 'Left', right: 'Right',
    players: 'players', free: 'Planned free games', local: 'Local preview',
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

function showGames(container: HTMLElement): void {
  const s = strings();
  const info = element('p', 'bridge-activities-help', s.gamesHelp);
  container.append(info);
  const grid = element('div', 'bridge-activities-grid');
  for (const game of BRIDGE_3D_GAME_CATALOG) {
    const card = element('article', 'bridge-activities-card');
    card.append(
      element('h3', '', game.title),
      element('p', '', String(game.minPlayers) + '–' + String(game.maxPlayers) + ' ' + s.players),
      element('span', 'bridge-activities-planned', s.planned),
    );
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
    room = startLocalSocialRoom(canvas);
    if (!room) container.append(element('p', 'bridge-room-error', s.noWebgl));
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
