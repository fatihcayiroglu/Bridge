// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/SpotifyWidgetPanel.svelte
//              client/js/core/spotify-widget-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/spotify-widget.ts — Sprint 93
// Spotify "Şu An Çalınan" widget + OAuth bağlantı butonu
// Profil kartına ve kullanıcı paneline enjekte edilir.

import { BridgeRegistry } from './bridge-registry.js';
import { apiFetch, escHtml } from './utils.js';

(function () {

  const API = (window as Record<string,string>).API_BASE || '';

  // ── "Şu An Çalınan" bar ───────────────────────────────────────────────────
  let _npInterval: ReturnType<typeof setInterval> | null = null;
  let _lastTrackId = '';

  async function fetchNowPlaying(): Promise<void> {
    try {
      const r = await apiFetch(`${API}/api/v1/oauth/spotify/now-playing`);
      if (!r.ok) return;
      const data = await r.json() as {
        playing: boolean; track?: string; artist?: string; album?: string;
        albumArt?: string; url?: string; progressMs?: number; durationMs?: number;
      };

      const trackId = data.playing ? `${data.track}-${data.artist}` : 'none';
      if (trackId === _lastTrackId) return; // değişmedi
      _lastTrackId = trackId;

      _renderNowPlayingBar(data);
    } catch { /* noop — Spotify bağlı değilse sessizce atla */ }
  }

  function _renderNowPlayingBar(data: {
    playing: boolean; track?: string; artist?: string; albumArt?: string; url?: string;
  }): void {
    let bar = document.getElementById('spotify-now-playing-bar');

    if (!data.playing) {
      if (bar) bar.style.display = 'none';
      return;
    }

    if (!bar) {
      bar = document.createElement('div');
      bar.id        = 'spotify-now-playing-bar';
      bar.className = 'spotify-np-bar';
      // Sidebar'ın kullanıcı alanına ekle
      const userArea = document.getElementById('user-area') ?? document.querySelector<HTMLElement>('.user-area, .sidebar-footer');
      userArea?.insertAdjacentElement('afterbegin', bar);
    }

    bar.style.display = '';
    bar.innerHTML = `
      <a href="${data.url || '#'}" target="_blank" rel="noopener" class="spotify-np-link">
        ${data.albumArt ? `<img src="${escHtml(data.albumArt)}" class="spotify-np-art" alt="">` : '<span class="spotify-np-icon">🎵</span>'}
        <div class="spotify-np-info">
          <span class="spotify-np-track">${escHtml(data.track || '')}</span>
          <span class="spotify-np-artist">${escHtml(data.artist || '')}</span>
        </div>
        <svg class="spotify-logo" viewBox="0 0 168 168" width="16" height="16" aria-hidden="true">
          <circle cx="84" cy="84" r="84" fill="#1DB954"/>
          <path d="M120.7 104.8c-1.8 0-3-.6-4.4-1.6-12-8-27-12.2-43.4-12.2-9 0-18.4 1.4-27 3.6-1.6.4-3 .8-4.4.8-3.6 0-6-2.8-6-6 0-3.8 2.2-5.8 5.2-6.6 10.8-2.8 21.8-4.4 32.4-4.4 18.6 0 36.4 5 51.2 14.4 2.4 1.4 3.6 3.2 3.6 6 0 3.4-2.8 6-7.2 6zm9.4-23.4c-2.2 0-3.8-.8-5.4-1.8-13.8-8.4-33.4-13.6-53.4-13.6-10.8 0-20.4 1.6-28 3.8-2 .6-3.2 1-4.8 1-4.4 0-7.6-3.4-7.6-7.8 0-4.4 2.4-7 6.4-8.2 9.6-2.8 20.6-4.6 34.4-4.6 23.2 0 45 6 61.6 16.6 2.8 1.8 4.2 4 4.2 7.4 0 4.4-3.4 7.2-7.4 7.2zm10.8-27.2c-2 0-3.4-.6-5.2-1.6-15.8-9.4-40.6-14.8-63.6-14.8-12 0-23.2 1.6-33.4 4.4-1.6.4-3.4 1-5.4 1-5.2 0-8.8-4-8.8-9.2 0-5.2 3-8.4 7.2-9.6 11.8-3.4 24.8-5.2 40.6-5.2 25.8 0 53 5.8 72.4 17 3.4 2 5.2 4.8 5.2 8.6 0 5.2-4 9.4-9 9.4z" fill="#fff"/>
        </svg>
      </a>
    `;
  }

  // 30 saniyede bir güncelle
  function startNowPlayingPoll(): void {
    if (_npInterval) return;
    fetchNowPlaying();
    _npInterval = setInterval(fetchNowPlaying, 30_000);
  }

  function stopNowPlayingPoll(): void {
    if (_npInterval) { clearInterval(_npInterval); _npInterval = null; }
    const bar = document.getElementById('spotify-now-playing-bar');
    if (bar) bar.style.display = 'none';
  }

  // ── BAĞLANTI AYARLARI UI ─────────────────────────────────────────────────
  function renderSpotifyConnectionSettings(container: HTMLElement): void {
    container.innerHTML = `
      <div class="connection-card" id="spotify-connection-card">
        <div class="connection-header">
          <span class="connection-icon">🎵</span>
          <div>
            <div class="connection-name">Spotify</div>
            <div class="connection-desc">Profil kartında "Şu An Çalınıyor" göster</div>
          </div>
          <div class="connection-actions" id="spotify-conn-actions">
            <div class="connection-loading">Kontrol ediliyor...</div>
          </div>
        </div>
      </div>
    `;
    _checkSpotifyStatus(document.getElementById('spotify-conn-actions')!);
  }

  async function _checkSpotifyStatus(actionsEl: HTMLElement): Promise<void> {
    try {
      const r = await apiFetch(`${API}/api/v1/oauth/spotify/now-playing`);
      if (r.status === 404) {
        // Bağlı değil
        actionsEl.innerHTML = `
          <button class="btn btn-spotify" id="spotify-connect-btn" type="button">
            Spotify'a Bağlan
          </button>
        `;
        document.getElementById('spotify-connect-btn')?.addEventListener('click', () => {
          window.location.href = `${API}/api/v1/oauth/spotify`;
        });
      } else {
        // Bağlı
        actionsEl.innerHTML = `
          <span class="connection-status connected">✅ Bağlı</span>
          <button class="btn btn-sm btn-danger" id="spotify-disconnect-btn" type="button">Bağlantıyı Kes</button>
        `;
        document.getElementById('spotify-disconnect-btn')?.addEventListener('click', disconnectSpotify);
      }
    } catch {
      actionsEl.innerHTML = '<span class="error-msg">Durum alınamadı</span>';
    }
  }

  async function disconnectSpotify(): Promise<void> {
    await apiFetch(`${API}/api/v1/oauth/spotify`, { method: 'DELETE' });
    stopNowPlayingPoll();
    const bar = document.getElementById('spotify-now-playing-bar');
    if (bar) bar.remove();
    // Ayarlar bölümünü yenile
    const card = document.getElementById('spotify-connection-card');
    if (card) renderSpotifyConnectionSettings(card.parentElement!);
  }

  // ── BOOT ─────────────────────────────────────────────────────────────────
  // Auth sonrasında spotify bağlıysa poll başlat
  document.addEventListener('bridge:auth-success', () => {
    // Spotify bağlıysa poller başlat
    apiFetch(`${API}/api/v1/oauth/spotify/now-playing`)
      .then(r => { if (r.ok || r.status !== 404) startNowPlayingPoll(); })
      .catch(() => {});
  });

  // OAuth callback'ten dönüşte (/?spotify_connected=1)
  if (new URLSearchParams(window.location.search).get('spotify_connected') === '1') {
    startNowPlayingPoll();
    // Query param'ı temizle
    const url = new URL(window.location.href);
    url.searchParams.delete('spotify_connected');
    history.replaceState({}, '', url.toString());
  }

  BridgeRegistry.register('renderSpotifyConnectionSettings', (el: unknown) =>
    renderSpotifyConnectionSettings(el as HTMLElement));
  BridgeRegistry.register('startSpotifyNowPlaying', startNowPlayingPoll);
  BridgeRegistry.register('stopSpotifyNowPlaying', stopNowPlayingPoll);

})();
