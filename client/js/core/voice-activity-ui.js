// client/js/core/voice-activity-ui.js
// Ses Kanalı Konuşan Kişi Göstergesi — gelişmiş UI
// Mevcut voice.js'te 'speaking' class'ı ekleniyor ama
// bu dosya: avatar shimmer, sidebar badge, speaking name bar ekler.

'use strict';

(function () {
  // userId → speaking bool
  const speakingState = new Map();
  // speaking name bar timeout handles
  const nameTimeouts  = new Map();

  function init(socket) {
    socket.on('voice:activity', ({ socketId, userId, speaking }) => {
      speakingState.set(userId, speaking);
      updatePeerCard(socketId, userId, speaking);
      updateSidebarBadge(userId, speaking);
      updateSpeakingBar(userId, speaking);
    });

    // Local speaking detection (Web Audio API VAD — basit energy threshold)
    initLocalVAD(socket);
  }

  // ── Peer card (ses kanalı büyük kart) ────────────────────────
  function updatePeerCard(socketId, userId, speaking) {
    const wrap = document.getElementById(`vpw-${socketId}`);
    if (!wrap) return;
    wrap.classList.toggle('speaking', speaking);
    const avatar = wrap.querySelector('.voice-peer-big-avatar');
    if (avatar) avatar.classList.toggle('speaking-glow', speaking);
  }

  // ── Sidebar ses kanalı listesi ───────────────────────────────
  function updateSidebarBadge(userId, speaking) {
    document.querySelectorAll(`.voice-sidebar-user[data-uid="${userId}"]`).forEach(el => {
      el.classList.toggle('speaking', speaking);
    });
  }

  // ── Speaking bar ─────────────────────────────────────────────
  let speakingBarEl = null;

  function ensureSpeakingBar() {
    if (speakingBarEl) return;
    speakingBarEl = document.createElement('div');
    speakingBarEl.id = 'voice-speaking-bar';
    speakingBarEl.className = 'voice-speaking-bar hidden';
    const voiceUi = document.getElementById('voice-panel') || document.getElementById('voice-ui');
    if (voiceUi) voiceUi.prepend(speakingBarEl);
    else document.body.appendChild(speakingBarEl);
  }

  function updateSpeakingBar(userId, speaking) {
    ensureSpeakingBar();
    const displayName = getDisplayName(userId);
    if (speaking) {
      speakingBarEl.textContent = `🎙️ ${displayName} konuşuyor…`;
      speakingBarEl.classList.remove('hidden');
      if (nameTimeouts.has(userId)) clearTimeout(nameTimeouts.get(userId));
    } else {
      const t = setTimeout(() => {
        const anySpeaking = [...speakingState.values()].some(v => v);
        if (!anySpeaking) speakingBarEl.classList.add('hidden');
      }, 1000);
      nameTimeouts.set(userId, t);
    }
  }

  function getDisplayName(userId) {
    const peers = window.voiceChannelPeers;
    if (peers instanceof Map) {
      for (const p of peers.values()) {
        if (p.userId === userId) return p.displayName || 'Kullanıcı';
      }
    }
    return 'Kullanıcı';
  }

  // ── Local VAD (basit Web Audio energy threshold) ─────────────
  // FIX: rAF döngüsünü durdurmak için flag + cancelAnimationFrame
  function initLocalVAD(socket) {
    let _vadActive = false;
    let _rafHandle = null;

    function stopLocalVAD() {
      _vadActive = false;
      if (_rafHandle !== null) {
        cancelAnimationFrame(_rafHandle);
        _rafHandle = null;
      }
      if (typeof window._bridgeVADCleanup === 'function') {
        window._bridgeVADCleanup();
      }
    }

    window._bridgeStartLocalVAD = async function (stream, channelId) {
      if (!stream || !channelId) return;
      // Önceki VAD oturumunu temizle
      stopLocalVAD();
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const actx     = new AudioContext();
        const src      = actx.createMediaStreamSource(stream);
        const analyzer = actx.createAnalyser();
        analyzer.fftSize = 256;
        src.connect(analyzer);

        const data         = new Uint8Array(analyzer.frequencyBinCount);
        let   wasSpeaking  = false;
        let   silenceCount = 0;

        const SPEAK_THRESHOLD = 20;
        const SILENCE_FRAMES  = 8; // ~160ms at 50fps

        _vadActive = true;

        function tick() {
          // Döngü durdurulmuşsa son "speaking: false" gönder ve çık
          if (!_vadActive) {
            if (wasSpeaking) {
              wasSpeaking = false;
              socket.emit('voice:activity', { channelId, speaking: false });
            }
            return;
          }

          analyzer.getByteFrequencyData(data);
          const avg        = data.reduce((s, v) => s + v, 0) / data.length;
          const isSpeaking = avg > SPEAK_THRESHOLD;

          if (isSpeaking) {
            silenceCount = 0;
            if (!wasSpeaking) {
              wasSpeaking = true;
              socket.emit('voice:activity', { channelId, speaking: true });
            }
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

        // AudioContext'i kapatan cleanup
        window._bridgeVADCleanup = function () {
          _vadActive = false;
          if (_rafHandle !== null) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
          try { actx.close(); } catch (_) {}
        };
      } catch (e) {
        console.warn('[VAD] init failed:', e.message);
      }
    };

    // Ses kanalından çıkışta çağrılır (voice.js → leaveVoice)
  }

  window.VoiceActivityUI = { init };
})();

// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
export const voiceActivityUIReady = true;
export const getVoiceActivityUI = () => window._bridgeVoiceActivityUI;
