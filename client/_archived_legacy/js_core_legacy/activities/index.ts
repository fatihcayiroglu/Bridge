// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/IndexPanel.svelte
//              client/js/core/index-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/activities/index.ts
// Sprint 82: Activities sistemi — Discord Activities muadili
// Sesli kanal üzerinde iframe tabanlı mini uygulamalar (Watch Together, oyunlar, vb.)

import { BridgeRegistry } from '../bridge-registry.js';
import { getSocket } from '../globals.js';
import { escHtml } from '../utils.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActivityDefinition {
  id:          string;
  name:        string;
  description: string;
  iconUrl:     string;
  url:         string;          // iframe src (same-origin veya CORS izinli)
  category:    ActivityCategory;
  maxUsers?:   number;
  minUsers?:   number;
}

export type ActivityCategory = 'watch' | 'game' | 'draw' | 'music' | 'other';

export interface ActiveActivity {
  activityId:  string;
  channelId:   string;
  serverId:    string;
  hostUserId:  string;
  participants: string[];       // user IDs
  startedAt:   number;
  sessionId:   string;
}

// ── Built-in Activity Catalog ─────────────────────────────────────────────────

export const BUILTIN_ACTIVITIES: ActivityDefinition[] = [
  {
    id:          'watch-together',
    name:        'Watch Together',
    description: 'YouTube videolarını birlikte izleyin, senkronize oynatma',
    iconUrl:     '/assets/activities/watch-together.svg',
    url:         '/activities/watch-together/',
    category:    'watch',
    maxUsers:    20,
  },
  {
    id:          'chess',
    name:        'Satranç',
    description: 'Kanaldaki birisiyle satranç oynayın',
    iconUrl:     '/assets/activities/chess.svg',
    url:         '/activities/chess/',
    category:    'game',
    maxUsers:    2,
    minUsers:    2,
  },
  {
    id:          'draw-together',
    name:        'Birlikte Çiz',
    description: 'Birlikte gerçek zamanlı tuval üzerinde çizin',
    iconUrl:     '/assets/activities/draw.svg',
    url:         '/activities/draw-together/',
    category:    'draw',
    maxUsers:    10,
  },
  {
    id:          'word-snack',
    name:        'Kelime Oyunu',
    description: 'Hızlı kelime bulma yarışması',
    iconUrl:     '/assets/activities/word.svg',
    url:         '/activities/word-snack/',
    category:    'game',
    maxUsers:    8,
  },
  {
    id:          'trivia',
    name:        'Trivia',
    description: 'Genel kültür yarışması',
    iconUrl:     '/assets/activities/trivia.svg',
    url:         '/activities/trivia/',
    category:    'game',
    maxUsers:    16,
  },
];

// ── State ─────────────────────────────────────────────────────────────────────

const _activeActivities = new Map<string, ActiveActivity>(); // channelId → ActiveActivity
let _activityContainer: HTMLElement | null = null;

// ── Socket Events ─────────────────────────────────────────────────────────────

function bindSocketEvents(): void {
  const socket = getSocket();
  if (!socket) return;

  socket.on('activity:started', (data: ActiveActivity) => {
    _activeActivities.set(data.channelId, data);
    _renderActivityBadge(data.channelId);
    _notifyParticipants(data);
  });

  socket.on('activity:ended', (data: { channelId: string }) => {
    _activeActivities.delete(data.channelId);
    _removeActivityBadge(data.channelId);
    _closeActivityWindow(data.channelId);
  });

  socket.on('activity:participants_updated', (data: { channelId: string; participants: string[] }) => {
    const act = _activeActivities.get(data.channelId);
    if (act) {
      act.participants = data.participants;
      _updateParticipantCount(data.channelId, data.participants.length);
    }
  });
}

// ── Launch / Join / Leave ─────────────────────────────────────────────────────

export async function launchActivity(activityId: string, channelId: string, serverId: string): Promise<void> {
  const definition = BUILTIN_ACTIVITIES.find(a => a.id === activityId);
  if (!definition) throw new Error(`Unknown activity: ${activityId}`);

  const socket = getSocket();
  if (!socket) throw new Error('Socket not connected');

  socket.emit('activity:start', { activityId, channelId, serverId });
  _openActivityWindow(definition, channelId);
}

export async function joinActivity(channelId: string): Promise<void> {
  const act = _activeActivities.get(channelId);
  if (!act) return;

  const definition = BUILTIN_ACTIVITIES.find(a => a.id === act.activityId);
  if (!definition) return;

  const socket = getSocket();
  socket?.emit('activity:join', { channelId, sessionId: act.sessionId });
  _openActivityWindow(definition, channelId);
}

export async function leaveActivity(channelId: string): Promise<void> {
  const socket = getSocket();
  socket?.emit('activity:leave', { channelId });
  _closeActivityWindow(channelId);
}

export function getActiveActivity(channelId: string): ActiveActivity | undefined {
  return _activeActivities.get(channelId);
}

export function hasActiveActivity(channelId: string): boolean {
  return _activeActivities.has(channelId);
}

// ── UI ────────────────────────────────────────────────────────────────────────

function _openActivityWindow(def: ActivityDefinition, channelId: string): void {
  _closeActivityWindow(channelId); // önce kapat

  const container = document.createElement('div');
  container.id = `activity-window-${channelId}`;
  container.className = 'activity-window';
  container.setAttribute('data-channel', channelId);

  const sessionId = _activeActivities.get(channelId)?.sessionId ?? '';
  const src = `${def.url}?channel=${encodeURIComponent(channelId)}&session=${encodeURIComponent(sessionId)}`;

  container.innerHTML = `
    <div class="activity-header">
      <img class="activity-icon" src="${escHtml(def.iconUrl)}" alt="${escHtml(def.name)}" width="24" height="24">
      <span class="activity-title">${escHtml(def.name)}</span>
      <span class="activity-participants" id="act-participants-${escHtml(channelId)}">0 katılımcı</span>
      <button class="activity-close-btn" data-channel="${escHtml(channelId)}" title="Kapat">✕</button>
    </div>
    <iframe
      class="activity-iframe"
      src="${escHtml(src)}"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      allow="camera; microphone; autoplay; clipboard-write"
      title="${escHtml(def.name)}"
    ></iframe>
  `;

  container.querySelector<HTMLButtonElement>('.activity-close-btn')?.addEventListener('click', () => {
    leaveActivity(channelId);
  });

  document.body.appendChild(container);
  _activityContainer = container;
}

function _closeActivityWindow(channelId: string): void {
  document.getElementById(`activity-window-${channelId}`)?.remove();
}

function _renderActivityBadge(channelId: string): void {
  const channelEl = document.querySelector(`[data-channel-id="${channelId}"]`);
  if (!channelEl) return;
  if (channelEl.querySelector('.activity-badge')) return;

  const badge = document.createElement('span');
  badge.className = 'activity-badge';
  badge.title = 'Aktif aktivite var — katılmak için tıkla';
  badge.textContent = '🎮';
  badge.addEventListener('click', () => joinActivity(channelId));
  channelEl.appendChild(badge);
}

function _removeActivityBadge(channelId: string): void {
  document.querySelector(`[data-channel-id="${channelId}"] .activity-badge`)?.remove();
}

function _notifyParticipants(act: ActiveActivity): void {
  const def = BUILTIN_ACTIVITIES.find(a => a.id === act.activityId);
  if (!def) return;
  // Toast bildirimi (globals showToast varsa)
  const toastFn = (window as Record<string, unknown>)['showToast'] as ((msg: string, type?: string) => void) | undefined;
  toastFn?.(`${def.name} aktivitesi başlatıldı! Katılmak için tıkla.`, 'info');
}

function _updateParticipantCount(channelId: string, count: number): void {
  const el = document.getElementById(`act-participants-${channelId}`);
  if (el) el.textContent = `${count} katılımcı`;
}

// ── Picker UI ─────────────────────────────────────────────────────────────────

export function openActivityPicker(channelId: string, serverId: string): void {
  const existing = document.getElementById('activity-picker-modal');
  if (existing) { existing.remove(); return; }

  const modal = document.createElement('div');
  modal.id = 'activity-picker-modal';
  modal.className = 'activity-picker-modal';

  const activeAct = _activeActivities.get(channelId);

  modal.innerHTML = `
    <div class="activity-picker-inner">
      <h3 class="activity-picker-title">🎮 Aktiviteler</h3>
      ${activeAct ? `
        <div class="activity-active-banner">
          <span>Aktif: <strong>${escHtml(BUILTIN_ACTIVITIES.find(a => a.id === activeAct.activityId)?.name ?? activeAct.activityId)}</strong></span>
          <button id="act-join-btn" class="btn-primary">Katıl</button>
        </div>
      ` : ''}
      <div class="activity-grid">
        ${BUILTIN_ACTIVITIES.map(def => `
          <button class="activity-card" data-activity-id="${escHtml(def.id)}">
            <img src="${escHtml(def.iconUrl)}" alt="${escHtml(def.name)}" width="48" height="48" onerror="this.src='/assets/activities/default.svg'">
            <span class="activity-card-name">${escHtml(def.name)}</span>
            <span class="activity-card-desc">${escHtml(def.description)}</span>
            ${def.maxUsers ? `<span class="activity-card-meta">Maks. ${def.maxUsers} kişi</span>` : ''}
          </button>
        `).join('')}
      </div>
      <button id="activity-picker-close" class="activity-picker-close">Kapat</button>
    </div>
  `;

  modal.querySelector('#activity-picker-close')?.addEventListener('click', () => modal.remove());
  modal.querySelector('#act-join-btn')?.addEventListener('click', () => {
    modal.remove();
    joinActivity(channelId);
  });
  modal.querySelectorAll<HTMLButtonElement>('.activity-card').forEach(card => {
    card.addEventListener('click', () => {
      const actId = card.dataset['activityId'];
      if (!actId) return;
      modal.remove();
      launchActivity(actId, channelId, serverId);
    });
  });

  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initActivities(): void {
  bindSocketEvents();

  BridgeRegistry.register('openActivityPicker', openActivityPicker);
  BridgeRegistry.register('launchActivity', launchActivity);
  BridgeRegistry.register('joinActivity', joinActivity);
  BridgeRegistry.register('leaveActivity', leaveActivity);
  BridgeRegistry.register('getActiveActivity', getActiveActivity);
  BridgeRegistry.register('hasActiveActivity', hasActiveActivity);
}
