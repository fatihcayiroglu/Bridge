// client/js/core/v41/go-live.js
// Modül: Go Live (Ekran Paylaşımı) Geliştirmeleri
'use strict';
import { getRtc } from '../globals.js';

// İzleyici listesi (voice channel peer'larından türetilir)
const _goLiveViewers = new Set();

function updateGoLiveViewerCount(count) {
  const el = document.getElementById('ss-viewer-count');
  if (el) el.textContent = count > 0 ? `👁️ ${count} izleyici` : '';
}

function addGoLiveViewer(userId, displayName) {
  _goLiveViewers.add(userId);
  updateGoLiveViewerCount(_goLiveViewers.size);
  renderViewerList();
  toast(`${displayName || 'Birisi'} ekranını izlemeye başladı 👁️`, 'info');
}

function removeGoLiveViewer(userId) {
  _goLiveViewers.delete(userId);
  updateGoLiveViewerCount(_goLiveViewers.size);
  renderViewerList();
}

function renderViewerList() {
  const el = document.getElementById('ss-viewer-list');
  if (!el) return;
  el.innerHTML = [..._goLiveViewers].map(uid => {
    const peer = [...(window.voiceChannelPeers?.values?.() || [])].find(p => p.userId === uid);
    const name = peer?.displayName || uid.slice(0, 8);
    return `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;">
      <span style="width:28px;height:28px;border-radius:50%;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;font-size:14px;">👤</span>
      ${escHtml(name)}
    </div>`;
  }).join('') || `<div style="color:var(--text-muted);font-size:12px;padding:4px 0;">Henüz izleyici yok.</div>`;
}

function openViewerList() {
  let panel = document.getElementById('ss-viewer-panel');
  if (panel) { panel.remove(); return; }

  panel = document.createElement('div');
  panel.id = 'ss-viewer-panel';
  panel.style.cssText = `
    position:fixed;top:60px;right:16px;z-index:9999;
    background:var(--bg-secondary);border:1px solid var(--border);
    border-radius:10px;padding:14px;width:200px;
    box-shadow:0 4px 20px rgba(0,0,0,.4);`;
  panel.innerHTML = `
    <div style="font-weight:600;font-size:13px;margin-bottom:10px;">👁️ İzleyiciler</div>
    <div id="ss-viewer-list"></div>`;
  document.body.appendChild(panel);
  renderViewerList();

  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!panel.contains(e.target) && e.target.id !== 'ss-viewer-count-btn') {
        panel.remove();
        document.removeEventListener('click', handler);
      }
    });
  }, 100);
}

// Çoklu stream grid
const _remoteScreenStreams = new Map(); // peerId → { stream, el }

function addRemoteScreenStream(peerId, stream, displayName) {
  const wrap = document.getElementById('ss-video-wrap');
  if (!wrap) return;

  if (_remoteScreenStreams.has(peerId)) {
    const existing = _remoteScreenStreams.get(peerId);
    if (existing.el) existing.el.srcObject = stream;
    return;
  }

  if (_remoteScreenStreams.size > 0) {
    wrap.style.display = 'grid';
    wrap.style.gridTemplateColumns = 'repeat(auto-fit, minmax(300px, 1fr))';
    wrap.style.gap = '4px';
  }

  const container = document.createElement('div');
  container.id = `ss-stream-${peerId}`;
  container.style.cssText = 'position:relative;background:#000;border-radius:6px;overflow:hidden;';

  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  video.style.cssText = 'width:100%;height:100%;object-fit:contain;';

  const label = document.createElement('div');
  label.style.cssText = 'position:absolute;bottom:6px;left:8px;font-size:12px;background:rgba(0,0,0,.6);color:#fff;padding:2px 8px;border-radius:4px;';
  label.textContent = displayName || 'Bilinmeyen';

  container.append(video, label);
  wrap.appendChild(container);
  _remoteScreenStreams.set(peerId, { stream, el: video });

  addGoLiveViewer(peerId, displayName);
}

function removeRemoteScreenStream(peerId) {
  document.getElementById(`ss-stream-${peerId}`)?.remove();
  _remoteScreenStreams.delete(peerId);
  removeGoLiveViewer(peerId);

  const wrap = document.getElementById('ss-video-wrap');
  if (wrap && _remoteScreenStreams.size <= 1) {
    wrap.style.display = '';
    wrap.style.gridTemplateColumns = '';
    wrap.style.gap = '';
  }
}

// Kalite değiştirme
async function changeScreenShareQuality(quality) {
  if (!getRtc()?.screenSharing) return toast('Ekran paylaşımı aktif değil', 'error');
  try {
    await getRtc().stopScreenShare?.();
    await new Promise(r => setTimeout(r, 300));
    const ok = await getRtc().startScreenShare(quality, true);
    if (ok) {
      const label = document.getElementById('ss-quality-label');
      if (label) label.textContent = _qualityLabel(quality);
      toast(`Kalite değiştirildi: ${_qualityLabel(quality)} ✅`, 'success');
      document.getElementById('ss-quality-change-panel')?.remove();
    }
  } catch { toast('Kalite değiştirilemedi', 'error'); }
}

function openQualityChangePanel() {
  let panel = document.getElementById('ss-quality-change-panel');
  if (panel) { panel.remove(); return; }

  panel = document.createElement('div');
  panel.id = 'ss-quality-change-panel';
  panel.style.cssText = `
    position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;
    padding:12px;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,.5);min-width:260px;`;
  panel.innerHTML = `
    <div style="font-weight:600;font-size:13px;margin-bottom:10px;text-align:center;">🖥️ Kalite Değiştir</div>
    ${[['4k60','4K 60fps'],['1440p60','1440p 60fps'],['1080p60','1080p 60fps'],['1080p','1080p 30fps'],['720p','720p 30fps'],['hd','HD']].map(([q, label]) => `
      <button onclick="changeScreenShareQuality('${q}')" style="
        display:block;width:100%;text-align:left;padding:8px 12px;border:none;cursor:pointer;
        background:transparent;color:var(--text-primary);font-size:13px;border-radius:6px;
        transition:.15s;" onmouseover="this.style.background='var(--bg-primary)'" onmouseout="this.style.background='transparent'">
        ${label}
      </button>`).join('')}`;
  document.body.appendChild(panel);

  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!panel.contains(e.target)) {
        panel.remove();
        document.removeEventListener('click', handler);
      }
    });
  }, 100);
}

// ── Go Live HTML enjeksiyonu ─────────────────────────────────────────────────

function _injectGoLiveEnhancements() {
  const controlsLeft = document.querySelector('.ss-controls-left');
  if (!controlsLeft || document.getElementById('ss-viewer-count')) return;

  const viewerBtn = document.createElement('button');
  viewerBtn.id = 'ss-viewer-count-btn';
  viewerBtn.className = 'ss-ctrl-btn tooltip';
  viewerBtn.setAttribute('data-tip', 'İzleyiciler');
  viewerBtn.onclick = openViewerList;
  viewerBtn.innerHTML = '<span id="ss-viewer-count"></span>';
  viewerBtn.style.cssText = 'font-size:12px;min-width:60px;';
  controlsLeft.appendChild(viewerBtn);

  const qualityBtn = document.createElement('button');
  qualityBtn.id = 'ss-change-quality-btn';
  qualityBtn.className = 'ss-ctrl-btn tooltip';
  qualityBtn.setAttribute('data-tip', 'Kalite Değiştir');
  qualityBtn.onclick = openQualityChangePanel;
  qualityBtn.textContent = '⚙️ Kalite';
  qualityBtn.style.cssText = 'font-size:12px;display:none;';
  controlsLeft.appendChild(qualityBtn);
}

function _onScreenShareStarted() {
  const btn = document.getElementById('ss-change-quality-btn');
  if (btn) btn.style.display = '';
  _goLiveViewers.clear();
  updateGoLiveViewerCount(0);
}

function _onScreenShareStopped() {
  const btn = document.getElementById('ss-change-quality-btn');
  if (btn) btn.style.display = 'none';
  _goLiveViewers.clear();
  _remoteScreenStreams.clear();
  updateGoLiveViewerCount(0);
}

document.addEventListener('DOMContentLoaded', () => {
  _injectGoLiveEnhancements();
});

const _ssViewObserver = new MutationObserver(() => {
  const ssView = document.getElementById('screen-share-view');
  if (ssView && ssView.style.display !== 'none') {
    _injectGoLiveEnhancements();
  }
});
document.addEventListener('DOMContentLoaded', () => {
  const ssView = document.getElementById('screen-share-view');
  if (ssView) _ssViewObserver.observe(ssView, { attributes: true, attributeFilter: ['style'] });
});

// Expose globals
