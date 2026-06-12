// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/StageVideoGridPanel.svelte
//              client/js/core/stage-video-grid-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/stage-video-grid.ts — Sprint 83: Stage Kanal Video Grid Layout
// Stage kanalında kamera açan konuşmacılar için Discord benzeri video grid
// Dinamik grid: 1 kişi = tam ekran, 2 = yan yana, 3-4 = 2x2, 5-9 = 3x3

import { getSocket } from './globals.js';
import { BridgeRegistry } from './bridge-registry.js';

export interface VideoParticipant {
  userId:      string;
  displayName: string;
  avatarColor: string;
  hasVideo:    boolean;
  muted:       boolean;
  speaking:    boolean;
  stream?:     MediaStream;
}

// ── State ─────────────────────────────────────────────────────────────────────

let _container:   HTMLElement | null = null;
let _participants: Map<string, VideoParticipant> = new Map();
let _localStream:  MediaStream | null = null;
let _channelId:    string | null = null;
let _videoEnabled  = false;

// ── Grid Layout Calculator ────────────────────────────────────────────────────

function _getGridCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

function _getGridStyle(count: number): string {
  const cols = _getGridCols(count);
  return `grid-template-columns: repeat(${cols}, 1fr); grid-template-rows: repeat(${Math.ceil(count / cols)}, 1fr);`;
}

// ── Render ────────────────────────────────────────────────────────────────────

function _renderGrid(): void {
  if (!_container) return;

  const participants = [..._participants.values()];
  const count = participants.length;

  if (count === 0) {
    _container.innerHTML = '';
    _container.style.display = 'none';
    return;
  }

  _container.style.display = 'grid';
  _container.style.cssText = `
    display: grid;
    ${_getGridStyle(count)}
    gap: 4px;
    width: 100%;
    height: 100%;
    background: #0f1117;
    padding: 4px;
  `;

  // Preserve existing video elements to avoid flicker
  const existingTiles = new Map<string, HTMLElement>();
  _container.querySelectorAll<HTMLElement>('[data-user-id]').forEach(el => {
    existingTiles.set(el.dataset['userId']!, el);
  });

  const newIds = new Set(participants.map(p => p.userId));

  // Remove stale tiles
  existingTiles.forEach((el, id) => {
    if (!newIds.has(id)) el.remove();
  });

  // Add / update tiles
  participants.forEach((p, idx) => {
    let tile = existingTiles.get(p.userId);
    const isNew = !tile;

    if (isNew) {
      tile = document.createElement('div');
      tile.dataset['userId'] = p.userId;
      tile.style.cssText = `
        position: relative;
        background: #1a1d27;
        border-radius: 8px;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 120px;
      `;
    }

    // Speaking border
    tile!.style.outline = p.speaking ? '2px solid #57F287' : '2px solid transparent';

    if (p.hasVideo && p.stream) {
      // Has video stream
      let video = tile!.querySelector<HTMLVideoElement>('video');
      if (!video) {
        video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = p.userId === _getMyUserId(); // mute self to prevent echo
        video.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        tile!.innerHTML = '';
        tile!.appendChild(video);
      }
      if (video.srcObject !== p.stream) video.srcObject = p.stream;
    } else {
      // No video — show avatar
      const initials = (p.displayName || '?')[0].toUpperCase();
      const avatarHtml = `
        <div style="
          width:72px; height:72px;
          border-radius:50%;
          background:${p.avatarColor || '#2d9cdb'};
          display:flex; align-items:center; justify-content:center;
          font-size:28px; font-weight:700; color:#fff;
          ${p.speaking ? 'box-shadow:0 0 0 3px #57F287;' : ''}
        ">${initials}</div>
      `;
      tile!.innerHTML = avatarHtml;
    }

    // Overlay: name + mic status
    let overlay = tile!.querySelector<HTMLElement>('.vg-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'vg-overlay';
      overlay.style.cssText = `
        position: absolute;
        bottom: 0; left: 0; right: 0;
        padding: 20px 8px 6px;
        background: linear-gradient(transparent, rgba(0,0,0,.7));
        display: flex;
        align-items: center;
        gap: 4px;
      `;
      tile!.appendChild(overlay);
    }
    overlay.innerHTML = `
      <span style="font-size:11px;color:#fff;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escHtml(p.displayName)}</span>
      ${p.muted ? '<span title="Sessiz" style="font-size:14px">🔇</span>' : ''}
    `;

    if (isNew) _container!.appendChild(tile!);
  });
}

function _getMyUserId(): string {
  return (window as Record<string, unknown>)['me'] ? ((window as Record<string, unknown>)['me'] as { id?: string })?.id ?? '' : '';
}

function _escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Init — çağrı: stage kanalı açılırken
 * @param containerEl  Grid yerleştirileceği DOM elementi
 * @param channelId    Kanal ID'si
 */
export function initVideoGrid(containerEl: HTMLElement, channelId: string): void {
  _container = containerEl;
  _channelId = channelId;
  _participants.clear();
  _renderGrid();
  _bindSocketEvents();
}

/** Mevcut grid'i kapat ve kaynakları temizle */
export function destroyVideoGrid(): void {
  stopLocalVideo();
  _participants.clear();
  if (_container) {
    _container.innerHTML = '';
    _container.style.display = 'none';
  }
  _container = null;
  _channelId = null;
}

/** Kamerayı aç/kapat */
export async function toggleLocalVideo(): Promise<boolean> {
  if (_videoEnabled) {
    stopLocalVideo();
    return false;
  }
  try {
    _localStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    _videoEnabled = true;

    const myId = _getMyUserId();
    if (myId) {
      const p = _participants.get(myId);
      if (p) {
        p.hasVideo = true;
        p.stream = _localStream;
        _renderGrid();
      }
    }

    getSocket()?.emit('stage:video-on', { channelId: _channelId });
    return true;
  } catch (err) {
    console.warn('[VideoGrid] Kamera açılamadı:', err);
    return false;
  }
}

/** Yerel kamerayı kapat */
export function stopLocalVideo(): void {
  _localStream?.getTracks().forEach(t => t.stop());
  _localStream = null;
  _videoEnabled = false;

  const myId = _getMyUserId();
  if (myId) {
    const p = _participants.get(myId);
    if (p) { p.hasVideo = false; p.stream = undefined; _renderGrid(); }
  }

  getSocket()?.emit('stage:video-off', { channelId: _channelId });
}

/** Katılımcı ekle / güncelle */
export function upsertParticipant(p: VideoParticipant): void {
  _participants.set(p.userId, { ..._participants.get(p.userId), ...p });
  _renderGrid();
}

/** Katılımcı çıkar */
export function removeParticipant(userId: string): void {
  _participants.delete(userId);
  _renderGrid();
}

/** Konuşma göstergesi güncelle */
export function updateSpeaking(userId: string, speaking: boolean): void {
  const p = _participants.get(userId);
  if (p) { p.speaking = speaking; _renderGrid(); }
}

/** Tüm katılımcılar */
export function getParticipants(): VideoParticipant[] {
  return [..._participants.values()];
}

// ── Socket events ─────────────────────────────────────────────────────────────

function _bindSocketEvents(): void {
  const socket = getSocket();
  if (!socket) return;

  socket.on('stage:video-on', (data: { userId: string; stream?: MediaStream }) => {
    const p = _participants.get(data.userId);
    if (p) { p.hasVideo = true; _renderGrid(); }
  });

  socket.on('stage:video-off', (data: { userId: string }) => {
    const p = _participants.get(data.userId);
    if (p) { p.hasVideo = false; p.stream = undefined; _renderGrid(); }
  });

  socket.on('stage:speaking', (data: { userId: string; speaking: boolean }) => {
    updateSpeaking(data.userId, data.speaking);
  });
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function initStageVideoGrid(): void {
  BridgeRegistry.register('stageVideoGrid:init',    initVideoGrid);
  BridgeRegistry.register('stageVideoGrid:destroy', destroyVideoGrid);
  BridgeRegistry.register('stageVideoGrid:toggle',  toggleLocalVideo);
  BridgeRegistry.register('stageVideoGrid:upsert',  upsertParticipant);
  BridgeRegistry.register('stageVideoGrid:remove',  removeParticipant);
}
