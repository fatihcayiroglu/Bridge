// client/js/core/v44/voice-volume.js
// ModÃ¼l: BridgeVoiceVolume â€” KullanÄ±cÄ± baÅŸÄ±na ses seviyesi (saÄŸ tÄ±kla â†’ slider)
'use strict';

const BridgeVoiceVolume = (() => {
  const gainNodes = new Map();
  let audioCtx = null;

  function _getCtx() {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  function attachGain(socketId, audioEl) {
    if (gainNodes.has(socketId)) return;
    try {
      const ctx    = _getCtx();
      const source = ctx.createMediaElementSource(audioEl);
      const gain   = ctx.createGain();
      source.connect(gain);
      gain.connect(ctx.destination);
      gainNodes.set(socketId, gain);
    } catch (e) {
      // createMediaElementSource: bir element'e iki kez baÄŸlanamaz â€” sessizce atla
    }
  }

  function applyVolume(socketId, pct) {
    const gain = gainNodes.get(socketId);
    if (gain) gain.gain.value = pct / 100;
    const el = document.querySelector(`audio[data-socket="${socketId}"]`);
    if (el) el.volume = Math.min(1, pct / 100);
  }

  function openVolumePanel(socketId, userId, displayName, anchorEl) {
    document.getElementById('bvv-panel')?.remove();

    const saved = parseFloat(localStorage.getItem(`bridge-vol-${userId}`)) || 100;

    const panel = document.createElement('div');
    panel.id = 'bvv-panel';
    panel.innerHTML = `
      <div class="bvv-header">
        ğŸ”Š ${_esc(displayName)} Ses Seviyesi
        <button class="bvv-close" onclick="document.getElementById('bvv-panel')?.remove()">âœ•</button>
      </div>
      <div class="bvv-row">
        <span class="bvv-val" id="bvv-label">${Math.round(saved)}%</span>
        <input type="range" class="bvv-slider" id="bvv-slider"
          min="0" max="200" step="5" value="${saved}">
      </div>
      <div class="bvv-presets">
        <button onclick="_bvvSet(0)">ğŸ”‡ Kapat</button>
        <button onclick="_bvvSet(50)">50%</button>
        <button onclick="_bvvSet(100)">Normal</button>
        <button onclick="_bvvSet(150)">150%</button>
        <button onclick="_bvvSet(200)">200%</button>
      </div>
    `;
    panel.style.cssText = `
      position:fixed; z-index:9999; background:var(--bg-secondary,#2f3136);
      border:1px solid var(--border,#444); border-radius:10px; padding:14px;
      width:240px; box-shadow:0 8px 24px rgba(0,0,0,.5);
      font-size:13px; color:var(--text,#dcddde);
    `;

    const rect = anchorEl?.getBoundingClientRect() || { right: 200, top: 200 };
    panel.style.left = `${Math.min(rect.right + 8, window.innerWidth - 260)}px`;
    panel.style.top  = `${Math.max(8, rect.top - 20)}px`;
    document.body.appendChild(panel);

    window._bvvCtx = { socketId, userId };
    window._bvvSet = (val) => {
      { const _el = document.getElementById('bvv-slider') as HTMLInputElement | null; if (_el) _el.value = val; }
      document.getElementById('bvv-label').textContent = `${val}%`;
      applyVolume(socketId, val);
      localStorage.setItem(`bridge-vol-${userId}`, val);
    };

    document.getElementById('bvv-slider').addEventListener('input', function() {
      const v = parseInt(this.value);
      document.getElementById('bvv-label').textContent = `${v}%`;
      applyVolume(socketId, v);
      localStorage.setItem(`bridge-vol-${userId}`, v);
    });

    setTimeout(() => {
      document.addEventListener('mousedown', function handler(e) {
        if (!panel.contains(e.target)) {
          panel.remove();
          document.removeEventListener('mousedown', handler);
        }
      });
    }, 100);
  }

  function _esc(s) {
    return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  }

  return { attachGain, applyVolume, openVolumePanel };
})();

// Ses peer UI'larÄ±na context menu ekle
document.addEventListener('contextmenu', e => {
  const peer = e.target.closest('.voice-peer');
  if (!peer) return;
  const socketId = peer.dataset.socket;
  const userId   = peer.dataset.userId;
  const name     = peer.querySelector('.peer-name')?.textContent || 'KullanÄ±cÄ±';
  if (!socketId) return;
  e.preventDefault();

  document.getElementById('voice-ctx')?.remove();
  const menu = document.createElement('div');
  menu.id = 'voice-ctx';
  menu.innerHTML = `
    <div class="ctx-item" onclick="BridgeVoiceVolume.openVolumePanel('${socketId}','${userId}','${name}',this);document.getElementById('voice-ctx')?.remove()">
      ğŸ”Š Ses Seviyesini Ayarla
    </div>
  `;
  menu.style.cssText = `
    position:fixed; z-index:9998; background:var(--bg-secondary,#2f3136);
    border:1px solid var(--border,#444); border-radius:6px; padding:4px 0;
    min-width:180px; box-shadow:0 4px 16px rgba(0,0,0,.4); font-size:13px;
  `;
  menu.style.left = `${e.clientX}px`;
  menu.style.top  = `${e.clientY}px`;
  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('mousedown', function h(ev) {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', h); }
    });
  }, 50);
});

// Expose globals
window.BridgeVoiceVolume = BridgeVoiceVolume;

