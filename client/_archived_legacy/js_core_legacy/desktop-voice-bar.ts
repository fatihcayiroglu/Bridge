// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/DesktopVoiceBarPanel.svelte
//              client/js/core/desktop-voice-bar-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/desktop-voice-bar.ts
// Sprint 92: Desktop persistent ses göstergesi
// Mobile için #mobile-voice-bar Sprint 91'de yapıldı; bu desktop karşılığı.
//
// Yerleşim: Sidebar'ın altında, kanal listesinin üstünde sabit bir bar.
// İçerik: Kanal adı, mute/deaf toggle, ses bırak butonu, konuşan kullanıcı göstergesi.

import { BridgeRegistry } from './bridge-registry.js';
import { escHtml }        from './utils.js';

(function () {

  let _barEl: HTMLElement | null = null;
  let _currentChannelId: string | null = null;
  let _currentChannelName = '';
  let _muted   = false;
  let _deafened = false;

  // ── CREATE BAR ───────────────────────────────────────────────
  function createDesktopVoiceBar(channelName: string, channelId: string): void {
    _currentChannelId   = channelId;
    _currentChannelName = channelName;

    if (_barEl) _barEl.remove();

    _barEl = document.createElement('div');
    _barEl.id        = 'desktop-voice-bar';
    _barEl.className = 'desktop-voice-bar';
    _barEl.setAttribute('role', 'region');
    _barEl.setAttribute('aria-label', 'Sesli kanal göstergesi');

    _render();

    // Sidebar'ın altına ekle
    const sidebar = document.getElementById('sidebar-bottom') ??
                    document.getElementById('user-area') ??
                    document.querySelector<HTMLElement>('.sidebar-footer, .sidebar-bottom');
    if (sidebar) {
      sidebar.insertAdjacentElement('beforebegin', _barEl);
    } else {
      // Fallback: sidebar'ın kendisine append
      const sidebarMain = document.getElementById('sidebar') ?? document.querySelector<HTMLElement>('.sidebar');
      sidebarMain?.appendChild(_barEl);
    }

    // CSS var güncelle — içerik kaymasını önle
    document.documentElement.style.setProperty('--desktop-voice-bar-height', '54px');
  }

  function _render(): void {
    if (!_barEl) return;

    _barEl.innerHTML = `
      <div class="dvb-channel-info">
        <span class="dvb-signal" aria-hidden="true">🔊</span>
        <div class="dvb-channel-text">
          <span class="dvb-channel-name">${escHtml(_currentChannelName)}</span>
          <span class="dvb-status" id="dvb-speaking-status">Bağlandı</span>
        </div>
      </div>

      <div class="dvb-controls">
        <!-- Mikrofon aç/kapat -->
        <button
          id="dvb-mute-btn"
          class="dvb-btn ${_muted ? 'active-red' : ''}"
          title="${_muted ? 'Mikrofonu aç' : 'Mikrofonu kapat'}"
          aria-label="${_muted ? 'Mikrofonu aç' : 'Mikrofonu kapat'}"
          aria-pressed="${_muted}"
          type="button"
        >${_muted ? '🔇' : '🎙️'}</button>

        <!-- Sesi kapat (deaf) -->
        <button
          id="dvb-deaf-btn"
          class="dvb-btn ${_deafened ? 'active-red' : ''}"
          title="${_deafened ? 'Sesi aç' : 'Sesi kapat'}"
          aria-label="${_deafened ? 'Sesi aç' : 'Sesi kapat'}"
          aria-pressed="${_deafened}"
          type="button"
        >${_deafened ? '🔕' : '🔔'}</button>

        <!-- Ses kanalını bırak -->
        <button
          id="dvb-leave-btn"
          class="dvb-btn dvb-leave"
          title="Ses kanalını bırak"
          aria-label="Ses kanalını bırak"
          type="button"
        >📞</button>
      </div>`;

    _bindControls();
  }

  function _bindControls(): void {
    document.getElementById('dvb-mute-btn')?.addEventListener('click', () => {
      _muted = !_muted;
      BridgeRegistry.call('toggleMute', _muted);
      _render();
    });

    document.getElementById('dvb-deaf-btn')?.addEventListener('click', () => {
      _deafened = !_deafened;
      BridgeRegistry.call('toggleDeafen', _deafened);
      _render();
    });

    document.getElementById('dvb-leave-btn')?.addEventListener('click', () => {
      BridgeRegistry.call('leaveVoiceChannel');
    });
  }

  // ── DESTROY BAR ──────────────────────────────────────────────
  function destroyDesktopVoiceBar(): void {
    _barEl?.remove();
    _barEl = null;
    _currentChannelId   = null;
    _currentChannelName = '';
    _muted    = false;
    _deafened = false;
    document.documentElement.style.setProperty('--desktop-voice-bar-height', '0px');
  }

  // ── SPEAKING INDICATOR ───────────────────────────────────────
  function updateSpeakingStatus(displayName: string | null): void {
    const el = document.getElementById('dvb-speaking-status');
    if (!el) return;
    el.textContent = displayName ? `🎙️ ${displayName} konuşuyor` : 'Bağlandı';
  }

  // ── SYNC MIC STATE FROM voice.ts ─────────────────────────────
  function syncMuteState(muted: boolean): void {
    _muted = muted;
    const btn = document.getElementById('dvb-mute-btn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.textContent = muted ? '🔇' : '🎙️';
    btn.title       = muted ? 'Mikrofonu aç' : 'Mikrofonu kapat';
    btn.setAttribute('aria-pressed', String(muted));
    btn.classList.toggle('active-red', muted);
  }

  // ── SOCKET EVENTS ─────────────────────────────────────────────
  document.addEventListener('bridge:voice-joined', (e: Event) => {
    const { channelName, channelId } = (e as CustomEvent<{ channelName: string; channelId: string }>).detail;
    // Sadece desktop'ta göster — mobile zaten kendi barını kullanıyor
    if (window.matchMedia('(min-width: 769px)').matches) {
      createDesktopVoiceBar(channelName, channelId);
    }
  });

  document.addEventListener('bridge:voice-left', destroyDesktopVoiceBar);

  document.addEventListener('bridge:voice-speaking', (e: Event) => {
    const { displayName, speaking } = (e as CustomEvent<{ displayName: string; speaking: boolean }>).detail;
    updateSpeakingStatus(speaking ? displayName : null);
  });

  // Mute state sync
  document.addEventListener('bridge:voice-mute-changed', (e: Event) => {
    syncMuteState((e as CustomEvent<{ muted: boolean }>).detail.muted);
  });

  // ── EXPORTS ───────────────────────────────────────────────────
  BridgeRegistry.register('createDesktopVoiceBar',  (name: unknown, id: unknown) =>
    createDesktopVoiceBar(name as string, id as string));
  BridgeRegistry.register('destroyDesktopVoiceBar', destroyDesktopVoiceBar);
  BridgeRegistry.register('syncDesktopMuteState',   (m: unknown) => syncMuteState(m as boolean));

})();
