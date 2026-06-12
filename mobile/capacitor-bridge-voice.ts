// mobile/capacitor-bridge-voice.ts  (Sprint 91)
// Mobil ses kanalı kalıcılığı — background audio, floating voice bar,
// iOS Live Activities benzeri ses göstergesi, Android foreground service
//
// Mevcut capacitor-bridge.js'e eklenti olarak çalışır.

'use strict';

// ── Voice persistence state ────────────────────────────────────────────────

interface VoiceSession {
  channelId:   string;
  channelName: string;
  serverId:    string;
  serverName:  string;
  muted:       boolean;
  deafened:    boolean;
  startedAt:   number;
}

let _voiceSession: VoiceSession | null = null;
let _floatingBarEl: HTMLElement | null = null;
let _elapsedInterval: ReturnType<typeof setInterval> | null = null;

// ── Init ──────────────────────────────────────────────────────────────────────

export function initMobileVoicePersistence(): void {
  // Listen to voice join/leave events from WebRTC module
  window.addEventListener('bridge:voice:joined', ((e: CustomEvent<VoiceSession>) => {
    _voiceSession = e.detail;
    _showFloatingBar();
    _startElapsedTimer();
    _requestBackgroundAudio();
    _updateBadge();
  }) as EventListener);

  window.addEventListener('bridge:voice:left', () => {
    _voiceSession = null;
    _hideFloatingBar();
    _stopElapsedTimer();
    _releaseBackgroundAudio();
    _clearBadge();
  });

  window.addEventListener('bridge:voice:mute_changed', ((e: CustomEvent<{ muted: boolean }>) => {
    if (_voiceSession) _voiceSession.muted = e.detail.muted;
    _updateFloatingBarMute();
  }) as EventListener);

  // App resume: reconnect if session was active
  window.addEventListener('bridge:app:resume', () => {
    if (_voiceSession) {
      _showFloatingBar();
      _requestBackgroundAudio();
    }
  });

  // Restore floating bar on page navigation
  document.addEventListener('bridge:navigate', () => {
    if (_voiceSession && !document.getElementById('mobile-voice-bar')) {
      _showFloatingBar();
    }
  });
}

// ── Floating voice bar ────────────────────────────────────────────────────────

function _showFloatingBar(): void {
  if (!_voiceSession) return;
  document.getElementById('mobile-voice-bar')?.remove();

  const bar = document.createElement('div');
  bar.id = 'mobile-voice-bar';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');

  bar.style.cssText = `
    position: fixed;
    top: env(safe-area-inset-top, 0px);
    left: 0; right: 0;
    z-index: 9000;
    background: linear-gradient(90deg, #3ba55d, #2d8f50);
    color: #fff;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    font-weight: 600;
    box-shadow: 0 2px 8px rgba(0,0,0,.3);
    cursor: pointer;
  `;

  const s = _voiceSession;

  bar.innerHTML = `
    <span style="font-size:18px;animation:voice-pulse 2s infinite;">🔊</span>
    <div style="flex:1;min-width:0;">
      <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtmlMobile(s.channelName)}</div>
      <div style="font-size:11px;opacity:.8;" id="voice-bar-elapsed">Bağlı</div>
    </div>
    <button id="voice-bar-mute" onclick="event.stopPropagation();window._mobileVoiceToggleMute()"
      style="background:rgba(255,255,255,.2);border:none;border-radius:20px;padding:5px 10px;color:#fff;cursor:pointer;font-size:13px;" aria-label="Sesi kapat">
      ${s.muted ? '🔇' : '🎙️'}
    </button>
    <button onclick="event.stopPropagation();window._mobileVoiceLeave()"
      style="background:rgba(255,0,0,.3);border:none;border-radius:20px;padding:5px 10px;color:#fff;cursor:pointer;font-size:13px;" aria-label="Kanaldan çık">
      📵
    </button>
  `;

  bar.addEventListener('click', () => {
    // Navigate back to voice channel
    window.dispatchEvent(new CustomEvent('bridge:navigate:voice', { detail: { channelId: s.channelId, serverId: s.serverId } }));
  });

  document.body.prepend(bar);
  _floatingBarEl = bar;

  // Shift main content down
  document.documentElement.style.setProperty('--voice-bar-height', `${bar.offsetHeight + 48}px`);
  document.getElementById('app-main')?.style.setProperty('padding-top', 'var(--voice-bar-height)');
}

function _hideFloatingBar(): void {
  document.getElementById('mobile-voice-bar')?.remove();
  _floatingBarEl = null;
  document.documentElement.style.setProperty('--voice-bar-height', '0px');
  document.getElementById('app-main')?.style.removeProperty('padding-top');
}

function _updateFloatingBarMute(): void {
  const btn = document.getElementById('voice-bar-mute');
  if (btn && _voiceSession) btn.textContent = _voiceSession.muted ? '🔇' : '🎙️';
}

// ── Elapsed timer ─────────────────────────────────────────────────────────────

function _startElapsedTimer(): void {
  _stopElapsedTimer();
  _elapsedInterval = setInterval(() => {
    const el = document.getElementById('voice-bar-elapsed');
    if (!el || !_voiceSession) return;
    const secs = Math.floor((Date.now() - _voiceSession.startedAt) / 1000);
    el.textContent = _formatDuration(secs);
  }, 1000);
}

function _stopElapsedTimer(): void {
  if (_elapsedInterval) { clearInterval(_elapsedInterval); _elapsedInterval = null; }
}

function _formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

// ── Background audio lock ─────────────────────────────────────────────────────

async function _requestBackgroundAudio(): Promise<void> {
  // Capacitor: keep audio session active in background
  try {
    const { Capacitor: Cap } = window as Window & { Capacitor?: { Plugins?: Record<string, { keepAwake?: () => Promise<void>; setAudioMode?: (opts: { mode: string }) => Promise<void> }> } };
    const NativeAudio = Cap?.Plugins?.NativeAudio;
    const KeepAwake   = Cap?.Plugins?.KeepAwake;

    if (KeepAwake?.keepAwake) await KeepAwake.keepAwake();
    if (NativeAudio?.setAudioMode) await NativeAudio.setAudioMode({ mode: 'voiceChat' });

    // Web fallback: acquire wake lock (Chrome/Edge)
    if ('wakeLock' in navigator) {
      const lock = await (navigator as Navigator & { wakeLock: { request: (t: string) => Promise<{ release: () => void }> } }).wakeLock.request('screen');
      (window as Window & { _voiceWakeLock?: { release: () => void } })._voiceWakeLock = lock;
    }
  } catch { /* non-critical */ }

  // Android: request foreground service via postMessage to native layer
  if (typeof Android !== 'undefined') {
    try {
      (window as Window & { Android?: { startVoiceForegroundService?: (s: string) => void } })
        .Android?.startVoiceForegroundService?.(JSON.stringify({
          channelName: _voiceSession?.channelName,
          serverName:  _voiceSession?.serverName,
        }));
    } catch { /* non-critical */ }
  }
}

async function _releaseBackgroundAudio(): Promise<void> {
  try {
    const { Capacitor: Cap } = window as Window & { Capacitor?: { Plugins?: Record<string, { allowSleep?: () => Promise<void> }> } };
    await Cap?.Plugins?.KeepAwake?.allowSleep?.();
    const lock = (window as Window & { _voiceWakeLock?: { release: () => void } })._voiceWakeLock;
    if (lock) { lock.release(); (window as Window & { _voiceWakeLock?: unknown })._voiceWakeLock = undefined; }
  } catch { /* non-critical */ }

  try {
    (window as Window & { Android?: { stopVoiceForegroundService?: () => void } })
      .Android?.stopVoiceForegroundService?.();
  } catch { /* non-critical */ }
}

// ── Badge ─────────────────────────────────────────────────────────────────────

async function _updateBadge(): Promise<void> {
  try {
    const { Capacitor: Cap } = window as Window & { Capacitor?: { Plugins?: { Badge?: { set: (opts: { count: number }) => Promise<void> } } } };
    await Cap?.Plugins?.Badge?.set({ count: 1 }); // 1 = "in call" indicator
  } catch { /* non-critical */ }
}

async function _clearBadge(): Promise<void> {
  try {
    const { Capacitor: Cap } = window as Window & { Capacitor?: { Plugins?: { Badge?: { set: (opts: { count: number }) => Promise<void> } } } };
    await Cap?.Plugins?.Badge?.set({ count: 0 });
  } catch { /* non-critical */ }
}

// ── Window handlers ───────────────────────────────────────────────────────────

(window as Window & { _mobileVoiceToggleMute?: () => void })._mobileVoiceToggleMute = () => {
  window.dispatchEvent(new CustomEvent('bridge:voice:toggle_mute'));
};

(window as Window & { _mobileVoiceLeave?: () => void })._mobileVoiceLeave = () => {
  window.dispatchEvent(new CustomEvent('bridge:voice:leave'));
};

// ── CSS injection ─────────────────────────────────────────────────────────────

const style = document.createElement('style');
style.textContent = `
  @keyframes voice-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .6; }
  }
  #mobile-voice-bar { transition: top .2s; }
`;
document.head.appendChild(style);

// ── Util ──────────────────────────────────────────────────────────────────────

function escHtmlMobile(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

declare const Android: unknown;
