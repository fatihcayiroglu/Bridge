// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/SettingsModalVoicePanel.svelte
//              client/js/core/settings-modal-voice-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/settings-modal-voice.ts
// Sprint 92: Ses ayarları paneli — noise suppression UI bağlantısı
// settings-modal.ts'e import edilir veya settings:tab-opened event'i dinlenerek tetiklenir.

import { BridgeRegistry } from './bridge-registry.js';

(function () {

  let _testStream: MediaStream | null = null;
  let _testRaf: number | null         = null;

  function initVoicePanel(): void {
    const ns = BridgeRegistry.call('getNoiseSuppression') as {
      enabled: boolean;
      mode:    string;
      setEnabled(v: boolean): void;
      setMode(m: string): void;
      stats: { framesProcessed: number; cpuLoad: number };
    } | null;

    if (!ns) return; // noise-suppression modülü henüz yüklenmediyse atla

    // ── Toggle switch ──
    const toggleBtn = document.getElementById('ns-enabled') as HTMLButtonElement | null;
    const modeRow   = document.getElementById('ns-mode-row');
    const statsRow  = document.getElementById('ns-stats-row');

    if (!toggleBtn) return;

    // Mevcut durumu yansıt
    _syncToggle(toggleBtn, ns.enabled);
    if (modeRow)  modeRow.style.display  = ns.enabled ? '' : 'none';
    if (statsRow) statsRow.style.display = ns.enabled ? '' : 'none';

    toggleBtn.addEventListener('click', () => {
      const next = toggleBtn.getAttribute('aria-checked') !== 'true';
      ns.setEnabled(next);
      _syncToggle(toggleBtn, next);
      if (modeRow)  modeRow.style.display  = next ? '' : 'none';
      if (statsRow) statsRow.style.display = next ? '' : 'none';
    });

    // ── Mod seçimi ──
    const modeSelect = document.getElementById('ns-mode') as HTMLSelectElement | null;
    if (modeSelect) {
      modeSelect.value = ns.mode;
      modeSelect.addEventListener('change', () => {
        ns.setMode(modeSelect.value);
      });
    }

    // ── CPU stats güncelleyici ──
    if (ns.enabled) _startStatsUpdater(ns);

    // ── Mikrofon test butonu ──
    const testBtn = document.getElementById('ns-test-mic-btn');
    testBtn?.addEventListener('click', _toggleMicTest);
  }

  function _syncToggle(btn: HTMLButtonElement, state: boolean): void {
    btn.setAttribute('aria-checked', String(state));
    btn.classList.toggle('on', state);
  }

  function _startStatsUpdater(ns: { stats: { framesProcessed: number; cpuLoad: number } }): void {
    const cpuEl    = document.getElementById('ns-cpu-load');
    const framesEl = document.getElementById('ns-frames');
    if (!cpuEl || !framesEl) return;

    const update = () => {
      cpuEl.textContent    = `${ns.stats.cpuLoad.toFixed(1)} ms`;
      framesEl.textContent = String(ns.stats.framesProcessed);
      requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  }

  async function _toggleMicTest(): Promise<void> {
    const btn        = document.getElementById('ns-test-mic-btn') as HTMLButtonElement | null;
    const meterWrap  = document.getElementById('ns-mic-meter-wrap');
    const meterFill  = document.getElementById('ns-mic-meter-fill');
    const statusEl   = document.getElementById('ns-mic-status');

    if (_testStream) {
      // Test zaten çalışıyor — durdur
      _testStream.getTracks().forEach(t => t.stop());
      _testStream = null;
      if (_testRaf !== null) { cancelAnimationFrame(_testRaf); _testRaf = null; }
      if (meterWrap) meterWrap.style.display = 'none';
      if (btn) btn.textContent = 'Mikrofonu Test Et';
      return;
    }

    try {
      _testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (statusEl) statusEl.textContent = 'Mikrofon erişimi reddedildi';
      if (meterWrap) meterWrap.style.display = '';
      return;
    }

    if (btn) btn.textContent = 'Testi Durdur';
    if (meterWrap) meterWrap.style.display = '';

    const actx     = new AudioContext();
    const src      = actx.createMediaStreamSource(_testStream);
    const analyzer = actx.createAnalyser();
    analyzer.fftSize = 256;
    src.connect(analyzer);
    const data = new Uint8Array(analyzer.frequencyBinCount);

    const ns = BridgeRegistry.call('getNoiseSuppression') as { enabled: boolean } | null;
    if (statusEl) statusEl.textContent = ns?.enabled ? 'aktif 🟢' : 'kapalı 🔴';

    const tick = () => {
      if (!_testStream) return;
      analyzer.getByteFrequencyData(data);
      const avg = data.reduce((s, v) => s + v, 0) / data.length;
      const pct = Math.min(100, (avg / 128) * 100);
      if (meterFill) meterFill.style.width = `${pct}%`;
      _testRaf = requestAnimationFrame(tick);
    };
    _testRaf = requestAnimationFrame(tick);
  }

  // ── Profil sekmesinde Spotify bağlantı panelini init et ────────────────
  document.addEventListener('settings:tab-opened', (e: Event) => {
    if ((e as CustomEvent<{ tabId: string }>).detail?.tabId === 'profile') {
      const container = document.getElementById('spotify-connection-settings');
      if (container) {
        BridgeRegistry.call('renderSpotifyConnectionSettings', container);
      }
    }
  });

  // ── Ses sekmesine geçilince init et ──────────────────────────
  document.addEventListener('settings:tab-opened', (e: Event) => {
    if ((e as CustomEvent<{ tabId: string }>).detail?.tabId === 'voice') {
      initVoicePanel();
    }
  });

  // Settings modal açıldığında ve ses tabı zaten seçiliyse de çalıştır
  document.addEventListener('settings:opened', () => {
    const activeTab = document.querySelector('.settings-tab-btn.active');
    if (activeTab?.id === 'tab-voice') initVoicePanel();
  });

  // Panel kapandığında test durdur
  document.addEventListener('settings:closed', () => {
    if (_testStream) { _testStream.getTracks().forEach(t => t.stop()); _testStream = null; }
    if (_testRaf !== null) { cancelAnimationFrame(_testRaf); _testRaf = null; }
  });

  BridgeRegistry.register('initVoiceSettingsPanel', initVoicePanel);

})();
