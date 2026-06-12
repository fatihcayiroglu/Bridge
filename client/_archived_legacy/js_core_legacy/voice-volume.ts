// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/VoiceVolumePanel.svelte
//              client/js/core/voice-volume-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/voice-volume.ts
// BridgeVoiceVolume — Kullanıcı başına ses seviyesi (sağ tıkla → slider)

import { escHtml } from './utils.js';
import { BridgeRegistry } from './bridge-registry.js';

const BridgeVoiceVolume = (() => {
  const gainNodes = new Map<string, GainNode>();
  let audioCtx: AudioContext | null = null;

  function _getCtx(): AudioContext {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new ((window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!)();
    }
    return audioCtx;
  }

  function attachGain(socketId: string, audioEl: HTMLMediaElement): void {
    if (gainNodes.has(socketId)) return;
    try {
      const ctx    = _getCtx();
      const source = ctx.createMediaElementSource(audioEl as HTMLMediaElement);
      const gain   = ctx.createGain();
      source.connect(gain);
      gain.connect(ctx.destination);
      gainNodes.set(socketId, gain);
    } catch { /* already connected */ }
  }

  function applyVolume(socketId: string, pct: number): void {
    const gain = gainNodes.get(socketId);
    if (gain) gain.gain.value = pct / 100;
    const el = document.querySelector<HTMLMediaElement>(`audio[data-socket="${socketId}"]`);
    if (el) el.volume = Math.min(1, pct / 100);
  }

  function _setVolume(panel: HTMLElement, socketId: string, userId: string, val: number): void {
    const slider = panel.querySelector<HTMLInputElement>('.bvv-slider');
    const label  = panel.querySelector<HTMLElement>('.bvv-val');
    if (slider) slider.value = String(val);
    if (label)  label.textContent = `${val}%`;
    applyVolume(socketId, val);
    localStorage.setItem(`bridge-vol-${userId}`, String(val));
  }

  function openVolumePanel(socketId: string, userId: string, displayName: string, anchorEl?: HTMLElement): void {
    document.getElementById('bvv-panel')?.remove();
    const saved = parseFloat(localStorage.getItem(`bridge-vol-${userId}`) ?? '100') || 100;

    const panel = document.createElement('div');
    panel.id = 'bvv-panel';
    panel.innerHTML = `
      <div class="bvv-header">
        🔊 ${escHtml(displayName)} Ses Seviyesi
        <button class="bvv-close" data-action="close">✕</button>
      </div>
      <div class="bvv-row">
        <span class="bvv-val">${Math.round(saved)}%</span>
        <input type="range" class="bvv-slider" min="0" max="200" step="5" value="${saved}">
      </div>
      <div class="bvv-presets">
        <button data-vol="0">🔇 Kapat</button>
        <button data-vol="50">50%</button>
        <button data-vol="100">Normal</button>
        <button data-vol="150">150%</button>
        <button data-vol="200">200%</button>
      </div>`;
    panel.style.cssText = `
      position:fixed; z-index:9999; background:var(--bg-secondary,#2f3136);
      border:1px solid var(--border,#444); border-radius:10px; padding:14px;
      width:240px; box-shadow:0 8px 24px rgba(0,0,0,.5);
      font-size:13px; color:var(--text,#dcddde);`;

    const rect = anchorEl?.getBoundingClientRect() ?? { right: 200, top: 200 };
    panel.style.left = `${Math.min(rect.right + 8, window.innerWidth - 260)}px`;
    panel.style.top  = `${Math.max(8, rect.top - 20)}px`;
    document.body.appendChild(panel);

    // Preset buttons — event delegation, no global
    panel.querySelector('.bvv-presets')!.addEventListener('click', (e: Event) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-vol]');
      if (btn) _setVolume(panel, socketId, userId, parseInt(btn.dataset.vol!));
    });

    // Close button
    panel.querySelector('[data-action="close"]')!.addEventListener('click', () => panel.remove());

    // Slider
    panel.querySelector<HTMLInputElement>('.bvv-slider')!.addEventListener('input', function (this: HTMLInputElement) {
      const v = parseInt(this.value);
      panel.querySelector<HTMLElement>('.bvv-val')!.textContent = `${v}%`;
      applyVolume(socketId, v);
      localStorage.setItem(`bridge-vol-${userId}`, String(v));
    });

    setTimeout(() => {
      document.addEventListener('mousedown', function handler(e: MouseEvent) {
        if (!panel.contains(e.target as Node)) {
          panel.remove();
          document.removeEventListener('mousedown', handler);
        }
      });
    }, 100);
  }

  return { attachGain, applyVolume, openVolumePanel };
})();

// Context menu on voice peer cards
document.addEventListener('contextmenu', (e: MouseEvent) => {
  const peer = (e.target as HTMLElement).closest<HTMLElement>('.voice-peer');
  if (!peer) return;
  const socketId = peer.dataset.socket;
  const userId   = peer.dataset.userId ?? '';
  const name     = peer.querySelector<HTMLElement>('.peer-name')?.textContent ?? 'Kullanıcı';
  if (!socketId) return;
  e.preventDefault();

  document.getElementById('voice-ctx')?.remove();
  const menu = document.createElement('div');
  menu.id = 'voice-ctx';
  menu.innerHTML = `
    <div class="ctx-item" data-action="volume">
      🔊 Ses Seviyesini Ayarla
    </div>`;
  menu.style.cssText = `
    position:fixed; z-index:9998; background:var(--bg-secondary,#2f3136);
    border:1px solid var(--border,#444); border-radius:6px; padding:4px 0;
    min-width:180px; box-shadow:0 4px 16px rgba(0,0,0,.4); font-size:13px;`;
  menu.style.left = `${e.clientX}px`;
  menu.style.top  = `${e.clientY}px`;
  document.body.appendChild(menu);

  menu.querySelector('[data-action="volume"]')!.addEventListener('click', () => {
    BridgeVoiceVolume.openVolumePanel(socketId, userId, name, menu);
    menu.remove();
  });

  setTimeout(() => {
    document.addEventListener('mousedown', function handler(ev: MouseEvent) {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener('mousedown', handler);
      }
    });
  }, 50);
});

BridgeRegistry.register('BridgeVoiceVolume', BridgeVoiceVolume as unknown);
export { BridgeVoiceVolume };
