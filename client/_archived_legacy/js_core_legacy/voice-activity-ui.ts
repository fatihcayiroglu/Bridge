// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/VoiceActivityUiPanel.svelte
//              client/js/core/voice-activity-ui-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/voice-activity-ui.ts
// Ses Kanalı Konuşan Kişi Göstergesi — avatar shimmer, sidebar badge, speaking bar

import { BridgeRegistry }     from './bridge-registry.js';
import { voiceChannelPeers }  from './globals.js';

import { createLogger } from './logger.js';
const log = createLogger('VAD');


(function () {
  const speakingState  = new Map<string, boolean>();
  const nameTimeouts   = new Map<string, ReturnType<typeof setTimeout>>();

  function init(socket: { on(ev: string, fn: (...a: unknown[]) => void): void } | null): void {
    socket.on('voice:activity', ({ socketId, userId, speaking }: { socketId: string; userId: string; speaking: boolean }) => {
      speakingState.set(userId, speaking);
      updatePeerCard(socketId, speaking);
      updateSidebarBadge(userId, speaking);
      updateSpeakingBar(userId, speaking);
    });
    initLocalVAD(socket);
  }

  function updatePeerCard(socketId: string, speaking: boolean): void {
    const wrap = document.getElementById(`vpw-${socketId}`);
    if (!wrap) return;
    wrap.classList.toggle('speaking', speaking);
    wrap.querySelector('.voice-peer-big-avatar')?.classList.toggle('speaking-glow', speaking);
  }

  function updateSidebarBadge(userId: string, speaking: boolean): void {
    document.querySelectorAll<HTMLElement>(`.voice-sidebar-user[data-uid="${userId}"]`).forEach(el =>
      el.classList.toggle('speaking', speaking)
    );
  }

  let speakingBarEl: HTMLElement | null = null;

  function ensureSpeakingBar(): void {
    if (speakingBarEl) return;
    speakingBarEl = document.createElement('div');
    speakingBarEl.id        = 'voice-speaking-bar';
    speakingBarEl.className = 'voice-speaking-bar hidden';
    const voiceUi = document.getElementById('voice-panel') ?? document.getElementById('voice-ui');
    if (voiceUi) voiceUi.prepend(speakingBarEl);
    else document.body.appendChild(speakingBarEl);
  }

  function updateSpeakingBar(userId: string, speaking: boolean): void {
    ensureSpeakingBar();
    const displayName = getDisplayName(userId);
    if (speaking) {
      speakingBarEl!.textContent = `🎙️ ${displayName} konuşuyor…`;
      speakingBarEl!.classList.remove('hidden');
      if (nameTimeouts.has(userId)) clearTimeout(nameTimeouts.get(userId)!);
    } else {
      const t = setTimeout(() => {
        const anySpeaking = [...speakingState.values()].some(v => v);
        if (!anySpeaking) speakingBarEl?.classList.add('hidden');
      }, 1000);
      nameTimeouts.set(userId, t);
    }
  }

  function getDisplayName(userId: string): string {
    const peers = voiceChannelPeers as Map<string, unknown> | undefined;
    if (peers instanceof Map) {
      for (const p of peers.values()) {
        if (p.userId === userId) return p.displayName ?? 'Kullanıcı';
      }
    }
    return 'Kullanıcı';
  }

  function initLocalVAD(socket: { on(ev: string, fn: (...a: unknown[]) => void): void } | null): void {
    let _vadActive = false;
    let _rafHandle: number | null = null;
    let _vadCleanup = () => {};

    function stopLocalVAD(): void {
      _vadActive = false;
      if (_rafHandle !== null) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
      _vadCleanup();
    }

    const _startLocalVAD = async (stream: MediaStream, channelId: string): Promise<void> => {
      if (!stream || !channelId) return;
      stopLocalVAD();
      try {
        const AudioCtx = (window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        const actx     = new AudioCtx() as AudioContext;
        const src      = actx.createMediaStreamSource(stream);
        const analyzer = actx.createAnalyser();
        analyzer.fftSize = 256;
        src.connect(analyzer);

        const data          = new Uint8Array(analyzer.frequencyBinCount);
        let wasSpeaking     = false;
        let silenceCount    = 0;
        const SPEAK_THRESHOLD = 20;
        const SILENCE_FRAMES  = 8;

        _vadActive = true;

        function tick(): void {
          if (!_vadActive) {
            if (wasSpeaking) { wasSpeaking = false; socket.emit('voice:activity', { channelId, speaking: false }); }
            return;
          }
          analyzer.getByteFrequencyData(data);
          const avg        = data.reduce((s, v) => s + v, 0) / data.length;
          const isSpeaking = avg > SPEAK_THRESHOLD;
          if (isSpeaking) {
            silenceCount = 0;
            if (!wasSpeaking) { wasSpeaking = true; socket.emit('voice:activity', { channelId, speaking: true }); }
          } else {
            silenceCount++;
            if (wasSpeaking && silenceCount > SILENCE_FRAMES) {
              wasSpeaking = false;
              socket.emit('voice:activity', { channelId, speaking: false });
            }
          }
          _rafHandle = requestAnimationFrame(tick);
        }
        _rafHandle = requestAnimationFrame(tick);
        _vadCleanup = () => {
          _vadActive = false;
          if (_rafHandle !== null) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
          try { actx.close(); } catch {}
        };
      } catch (e: unknown) {
        log.warn('[VAD] init failed:', e.message);
      }
    };

    BridgeRegistry.register('_bridgeStartLocalVAD', _startLocalVAD as unknown);
  }

  BridgeRegistry.register('VoiceActivityUI', { init } as unknown);
})();

export const voiceActivityUIReady = true;
export const getVoiceActivityUI   = () => BridgeRegistry.get('VoiceActivityUI');
