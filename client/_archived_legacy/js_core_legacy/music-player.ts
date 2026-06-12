// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/MusicPlayerPanel.svelte
//              client/js/core/music-player-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/music-player.ts
// Kanal müzik oynatıcısı

import { getCurrentChannel, getCurrentServer, getSocket } from './globals.js';
import { escHtml } from './utils.js';

import { createLogger } from './logger.js';
const log = createLogger('Music');


// ── Types ─────────────────────────────────────────────────────────────────────

interface MusicTrack {
  streamUrl: string;
  title: string;
  requestedBy?: string;
  thumbnail?: string;
}

interface MusicQueueData {
  current?: MusicTrack;
  queue?: MusicTrack[];
}

// ── State ─────────────────────────────────────────────────────────────────────

let musicAudio: HTMLAudioElement | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

 as Record<string, string>)[c]!
  );
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initMusicPlayer(): void {
  const socket = getSocket() as { emit(ev: string, ...args: unknown[]): void } | null;
  if (!socket) return;

  socket.on('music:play', ({ channelId, track }: { channelId: string; track: MusicTrack }) => {
    const channel = getCurrentChannel() as { _id: string; serverId?: string } | null;
    if (!channel || channel._id !== channelId) return;
    showMusicPlayer(track, channelId);
  });

  socket.on('music:stop', ({ channelId }: { channelId: string }) => {
    const channel = getCurrentChannel() as { _id: string; serverId?: string } | null;
    if (!channel || channel._id !== channelId) return;
    hideMusicPlayer();
  });
}

// ── Show / hide ───────────────────────────────────────────────────────────────

export function showMusicPlayer(track: MusicTrack, channelId: string): void {
  let bar = document.getElementById('music-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'music-bar';
    bar.className = 'music-bar';
    document.getElementById('text-view')?.prepend(bar);
  }

  if (musicAudio) { musicAudio.pause(); musicAudio = null; }

  musicAudio = new Audio(track.streamUrl);
  musicAudio.crossOrigin = 'anonymous';
  musicAudio.volume = 0.5;

  musicAudio.play().catch(err => {
    log.warn('[music] autoplay engellendi:', err.message);
    toast('🎵 Müziği başlatmak için play\'e tıklayın (tarayıcı engelledi)', 'info');
  });

  const socket = getSocket() as { emit(ev: string, ...args: unknown[]): void } | null;
  musicAudio.addEventListener('ended', () => {
    socket.emit('music:ended', { channelId });
  });

  const thumb = track.thumbnail
    ? `<img class="music-thumb" src="${escHtml(track.thumbnail)}" onerror="this.style.display='none'" alt="">`
    : '🎵';

  bar.innerHTML = `
    <div class="music-info">
      ${thumb}
      <div>
        <div class="music-title">${escHtml(track.title)}</div>
        <div class="music-sub">İsteyen: ${escHtml(track.requestedBy ?? '')}</div>
      </div>
    </div>
    <div class="music-controls">
      <button class="music-btn" id="music-playpause" title="Oynat/Duraklat">⏸️</button>
      <input type="range" id="music-vol" min="0" max="1" step="0.05" value="0.5"
             title="Ses seviyesi" aria-label="Ses seviyesi">
      <button class="music-btn" id="music-skip-btn" title="Sonraki">⏭️</button>
      <button class="music-btn" id="music-stop-btn" title="Durdur">⏹️</button>
    </div>`;

  (document.getElementById('music-vol') as HTMLInputElement | null)
    ?.addEventListener('input', (e) => setMusicVolume((e.target as HTMLInputElement).value));
  document.getElementById('music-playpause')?.addEventListener('click', toggleMusicPause);
  document.getElementById('music-skip-btn')?.addEventListener('click', () => {
    socket.emit('music:ended', { channelId });
  });
  document.getElementById('music-stop-btn')?.addEventListener('click', () => {
    const server = getCurrentServer() as { _id: string } | null;
    socket.emit('message:send', { channelId, content: '!stop', serverId: server?._id });
  });
}

export function hideMusicPlayer(): void {
  if (musicAudio) { musicAudio.pause(); musicAudio = null; }
  document.getElementById('music-bar')?.remove();
}

export function toggleMusicPause(): void {
  if (!musicAudio) return;
  const btn = document.getElementById('music-playpause');
  if (musicAudio.paused) {
    musicAudio.play();
    if (btn) btn.textContent = '⏸️';
  } else {
    musicAudio.pause();
    if (btn) btn.textContent = '▶️';
  }
}

export function setMusicVolume(v: string | number): void {
  if (musicAudio) musicAudio.volume = parseFloat(String(v));
}

// ── Music Queue Modal ─────────────────────────────────────────────────────────

export async function openMusicQueue(): Promise<void> {
  const channel = getCurrentChannel() as { _id: string } | null;
  const server  = getCurrentServer() as { _id: string } | null;
  if (!server || !channel) { toast('Önce bir kanala gir', 'error'); return; }
  const API = getAPI();

  let modal = document.getElementById('music-queue-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'music-queue-modal';
    modal.className = 'modal-overlay';
    modal.onclick = (e: MouseEvent) => {
      if (e.target === modal) (modal as HTMLElement).style.display = 'none';
    };
    modal.innerHTML = `
      <div class="modal-card" style="max-width:480px;width:95%;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <h2 style="margin:0;font-size:17px;">🎵 Müzik Kuyruğu</h2>
          <button class="btn" onclick="document.getElementById('music-queue-modal').style.display='none'" style="padding:4px 10px;">✕</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px;">
          <input type="url" id="music-url-input" class="input-field" placeholder="YouTube URL yapıştır..." style="flex:1;">
          <button class="btn btn-primary" onclick="(window).__musicAddToQueue()">▶ Ekle</button>
        </div>
        <div id="music-queue-list" style="max-height:300px;overflow-y:auto;"></div>
        <div style="margin-top:12px;display:flex;gap:8px;">
          <button class="btn" style="flex:1;" onclick="(window).__musicSkip()">⏭ Sonraki</button>
          <button class="btn btn-danger" style="flex:1;" onclick="(window).__musicStop()">⏹ Durdur</button>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin-top:8px;">
          💡 Slash komutları: <code>/play [url]</code>  <code>/skip</code>  <code>/stop</code>
        </p>
      </div>`;
    document.body.appendChild(modal);
    BridgeRegistry.register('__musicAddToQueue', musicAddToQueue);
    BridgeRegistry.register('__musicSkip', musicSkip);
    BridgeRegistry.register('__musicStop', musicStop);
  }

  modal.style.display = 'flex';
  await _refreshMusicQueue();
}

async function _refreshMusicQueue(): Promise<void> {
  const channel = getCurrentChannel() as { _id: string } | null;
  const server  = getCurrentServer() as { _id: string } | null;
  if (!server || !channel) return;
  const API  = getAPI();
  const list = document.getElementById('music-queue-list');
  if (!list) return;

  try {
    const r    = await apiFetch(`${API}/api/music/queue/${server._id}/${channel._id}`);
    const data: MusicQueueData = await r.json();

    if (!data.current && !data.queue?.length) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">🎵 Kuyruk boş</div>';
      return;
    }

    let html = '';
    if (data.current) {
      html += `<div style="background:var(--brand);border-radius:8px;padding:10px;margin-bottom:8px;display:flex;gap:10px;align-items:center;">
        <span style="font-size:20px;">▶️</span>
        <div style="flex:1;overflow:hidden;">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(data.current.title)}</div>
          <div style="font-size:11px;opacity:0.8;">Şu an çalıyor</div>
        </div>
      </div>`;
    }

    (data.queue ?? []).forEach((t, i) => {
      html += `<div style="background:var(--bg-3);border-radius:6px;padding:8px 10px;margin-bottom:6px;display:flex;gap:8px;align-items:center;">
        <span style="color:var(--text-muted);font-size:13px;width:20px;text-align:center;">${i + 1}</span>
        <div style="flex:1;overflow:hidden;">
          <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;">${escHtml(t.title)}</div>
          <div style="font-size:11px;color:var(--text-muted);">İsteyen: ${escHtml(t.requestedBy ?? '')}</div>
        </div>
      </div>`;
    });

    list.innerHTML = html;
  } catch {
    list.innerHTML = '<div style="color:var(--text-muted);padding:12px;">Kuyruk alınamadı</div>';
  }
}

export async function musicAddToQueue(): Promise<void> {
  const input = document.getElementById('music-url-input') as HTMLInputElement | null;
  const url   = input?.value.trim();
  if (!url) { toast('URL gir', 'error'); return; }
  const channel = getCurrentChannel() as { _id: string } | null;
  const server  = getCurrentServer() as { _id: string } | null;
  if (!server || !channel) return;
  if (input) input.value = '';
  const socket = getSocket() as { emit(ev: string, ...args: unknown[]): void } | null;
  socket.emit('message:send', { channelId: channel._id, content: `!play ${url}`, serverId: server._id });
  setTimeout(_refreshMusicQueue, 1500);
}

export function musicSkip(): void {
  const channel = getCurrentChannel() as { _id: string } | null;
  if (!channel) return;
  const socket = getSocket() as { emit(ev: string, ...args: unknown[]): void } | null;
  socket?.emit('music:ended', { channelId: channel._id });
  setTimeout(_refreshMusicQueue, 500);
}

export function musicStop(): void {
  const channel = getCurrentChannel() as { _id: string } | null;
  const server  = getCurrentServer() as { _id: string } | null;
  if (!channel || !server) return;
  const socket = getSocket() as { emit(ev: string, ...args: unknown[]): void } | null;
  socket.emit('message:send', { channelId: channel._id, content: '!stop', serverId: server._id });
  setTimeout(_refreshMusicQueue, 500);
}
