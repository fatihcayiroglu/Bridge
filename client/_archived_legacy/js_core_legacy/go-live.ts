// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/GoLivePanel.svelte
//              client/js/core/go-live-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/go-live.ts
// Modül: Go Live (Ekran Paylaşımı) Geliştirmeleri

import { BridgeRegistry } from './bridge-registry.js';
import { getRtc } from './globals.js';
import { escHtml } from './utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScreenStreamEntry {
  stream: MediaStream;
  el: HTMLVideoElement;
}

type ScreenShareQuality =
  | '4k60' | '1440p60' | '1080p60' | '1080p' | '720p' | 'hd';

const QUALITY_LABELS: Record<ScreenShareQuality, string> = {
  '4k60':    '4K 60fps',
  '1440p60': '1440p 60fps',
  '1080p60': '1080p 60fps',
  '1080p':   '1080p 30fps',
  '720p':    '720p 30fps',
  'hd':      'HD',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

 as Record<string, string>)[c]!
  );
}

function _qualityLabel(q: string): string {
  return QUALITY_LABELS[q as ScreenShareQuality] ?? q;
}

// ── Module state ──────────────────────────────────────────────────────────────

const _goLiveViewers = new Set<string>();
const _remoteScreenStreams = new Map<string, ScreenStreamEntry>();

// ── Viewer count ──────────────────────────────────────────────────────────────

function updateGoLiveViewerCount(count: number): void {
  const el = document.getElementById('ss-viewer-count');
  if (el) el.textContent = count > 0 ? `👁️ ${count} izleyici` : '';
}

function addGoLiveViewer(userId: string, displayName?: string): void {
  _goLiveViewers.add(userId);
  updateGoLiveViewerCount(_goLiveViewers.size);
  renderViewerList();
  toast(`${displayName ?? 'Birisi'} ekranını izlemeye başladı 👁️`, 'info');
}

function removeGoLiveViewer(userId: string): void {
  _goLiveViewers.delete(userId);
  updateGoLiveViewerCount(_goLiveViewers.size);
  renderViewerList();
}

function renderViewerList(): void {
  const el = document.getElementById('ss-viewer-list');
  if (!el) return;

  const peers: Map<string, { userId?: string; displayName?: string }> = BridgeRegistry.get('voiceChannelPeers') ?? new Map();
  el.innerHTML = [..._goLiveViewers].map(uid => {
    const peer = [...peers.values()].find(p => p.userId === uid);
    const name = peer?.displayName ?? uid.slice(0, 8);
    return `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;">
      <span style="width:28px;height:28px;border-radius:50%;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;font-size:14px;">👤</span>
      ${escHtml(name)}
    </div>`;
  }).join('') ||
    `<div style="color:var(--text-muted);font-size:12px;padding:4px 0;">Henüz izleyici yok.</div>`;
}

function openViewerList(): void {
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
    document.addEventListener('click', function handler(e: MouseEvent) {
      const target = e.target as Node | null;
      const countBtn = document.getElementById('ss-viewer-count-btn');
      if (!panel!.contains(target) && target !== countBtn) {
        panel!.remove();
        document.removeEventListener('click', handler);
      }
    });
  }, 100);
}

// ── Multi-stream grid ─────────────────────────────────────────────────────────

function addRemoteScreenStream(
  peerId: string,
  stream: MediaStream,
  displayName?: string
): void {
  const wrap = document.getElementById('ss-video-wrap');
  if (!wrap) return;

  if (_remoteScreenStreams.has(peerId)) {
    _remoteScreenStreams.get(peerId)!.el.srcObject = stream;
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
  label.style.cssText =
    'position:absolute;bottom:6px;left:8px;font-size:12px;background:rgba(0,0,0,.6);color:#fff;padding:2px 8px;border-radius:4px;';
  label.textContent = displayName ?? 'Bilinmeyen';

  container.append(video, label);
  wrap.appendChild(container);
  _remoteScreenStreams.set(peerId, { stream, el: video });

  addGoLiveViewer(peerId, displayName);
}

function removeRemoteScreenStream(peerId: string): void {
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

// ── Quality change ────────────────────────────────────────────────────────────

async function changeScreenShareQuality(quality: ScreenShareQuality): Promise<void> {
  const rtc = getRtc() as { isScreenSharing?: boolean; changeScreenQuality(q: string): Promise<void>; stopScreenShare(): void } | null;
  if (!rtc?.screenSharing) {
    toast('Ekran paylaşımı aktif değil', 'error');
    return;
  }
  try {
    await rtc.stopScreenShare?.();
    await new Promise<void>(r => setTimeout(r, 300));
    const ok = await rtc.startScreenShare(quality, true);
    if (ok) {
      const label = document.getElementById('ss-quality-label');
      if (label) label.textContent = _qualityLabel(quality);
      toast(`Kalite değiştirildi: ${_qualityLabel(quality)} ✅`, 'success');
      document.getElementById('ss-quality-change-panel')?.remove();
    }
  } catch {
    toast('Kalite değiştirilemedi', 'error');
  }
}

function openQualityChangePanel(): void {
  let panel = document.getElementById('ss-quality-change-panel');
  if (panel) { panel.remove(); return; }

  panel = document.createElement('div');
  panel.id = 'ss-quality-change-panel';
  panel.style.cssText = `
    position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;
    padding:12px;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,.5);min-width:260px;`;

  const qualities: [ScreenShareQuality, string][] = [
    ['4k60', '4K 60fps'], ['1440p60', '1440p 60fps'], ['1080p60', '1080p 60fps'],
    ['1080p', '1080p 30fps'], ['720p', '720p 30fps'], ['hd', 'HD'],
  ];

  panel.innerHTML = `
    <div style="font-weight:600;font-size:13px;margin-bottom:10px;text-align:center;">🖥️ Kalite Değiştir</div>
    ${qualities.map(([q, lbl]) => `
      <button onclick="(window).__changeScreenQuality('${q}')" style="
        display:block;width:100%;text-align:left;padding:8px 12px;border:none;cursor:pointer;
        background:transparent;color:var(--text-primary);font-size:13px;border-radius:6px;
        transition:.15s;" onmouseover="this.style.background='var(--bg-primary)'"
        onmouseout="this.style.background='transparent'">
        ${lbl}
      </button>`).join('')}`;

  BridgeRegistry.register('__changeScreenQuality', changeScreenShareQuality);
  document.body.appendChild(panel);

  setTimeout(() => {
    document.addEventListener('click', function handler(e: MouseEvent) {
      if (!panel!.contains(e.target as Node)) {
        panel!.remove();
        document.removeEventListener('click', handler);
      }
    });
  }, 100);
}

// ── HTML injection ────────────────────────────────────────────────────────────

function _injectGoLiveEnhancements(): void {
  const controlsLeft = document.querySelector<HTMLElement>('.ss-controls-left');
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

function _onScreenShareStarted(): void {
  const btn = document.getElementById('ss-change-quality-btn') as HTMLButtonElement | null;
  if (btn) btn.style.display = '';
  _goLiveViewers.clear();
  updateGoLiveViewerCount(0);
}

function _onScreenShareStopped(): void {
  const btn = document.getElementById('ss-change-quality-btn') as HTMLButtonElement | null;
  if (btn) btn.style.display = 'none';
  _goLiveViewers.clear();
  _remoteScreenStreams.clear();
  updateGoLiveViewerCount(0);
}

// ── DOM ready & MutationObserver ──────────────────────────────────────────────

const _ssViewObserver = new MutationObserver(() => {
  const ssView = document.getElementById('screen-share-view') as HTMLElement | null;
  if (ssView && ssView.style.display !== 'none') _injectGoLiveEnhancements();
});

document.addEventListener('DOMContentLoaded', () => {
  _injectGoLiveEnhancements();

  const ssView = document.getElementById('screen-share-view');
  if (ssView) {
    _ssViewObserver.observe(ssView, { attributes: true, attributeFilter: ['style'] });
  }
});

export {
  addGoLiveViewer,
  addRemoteScreenStream,
  changeScreenShareQuality,
  openQualityChangePanel,
  openViewerList,
  removeGoLiveViewer,
  removeRemoteScreenStream,
  updateGoLiveViewerCount,
  _onScreenShareStarted,
  _onScreenShareStopped,
};
