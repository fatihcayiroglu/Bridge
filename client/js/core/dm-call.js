// core/dm-call.js
// DM Ses & Video Araması (1-1 WebRTC over Socket.IO)

'use strict';

const DmCall = (() => {
  let _currentCallId  = null;
  let _currentType    = null;   // 'voice' | 'video'
  let _remoteUserId   = null;
  let _role           = null;   // 'caller' | 'callee'
  let _pc             = null;   // RTCPeerConnection
  let _localStream    = null;
  let _screenStream   = null;
  let _ringtoneTimer  = null;

  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  // ── Overlay HTML ──────────────────────────────────────────
  function _injectOverlay() {
    if (document.getElementById('dm-call-overlay')) return;
    const el = document.createElement('div');
    el.id = 'dm-call-overlay';
    el.innerHTML = `
      <div id="dm-call-box">
        <div id="dm-call-video-wrap">
          <video id="dm-call-remote-video" autoplay playsinline></video>
          <video id="dm-call-local-video"  autoplay playsinline muted></video>
        </div>
        <div id="dm-call-avatar-wrap">
          <div id="dm-call-avatar"></div>
          <div id="dm-call-name"></div>
          <div id="dm-call-status"></div>
        </div>
        <div id="dm-call-actions">
          <button class="dm-call-btn dm-call-btn-red"   id="dm-call-hangup"  onclick="DmCall.hangUp()"      title="Kapat">📵</button>
          <button class="dm-call-btn dm-call-btn-gray"  id="dm-call-mute"    onclick="DmCall.toggleMic()"   title="Mikrofon">🎤</button>
          <button class="dm-call-btn dm-call-btn-gray"  id="dm-call-cam"     onclick="DmCall.toggleCam()"   title="Kamera" style="display:none">📷</button>
          <button class="dm-call-btn dm-call-btn-gray"  id="dm-call-screen"  onclick="DmCall.toggleScreen()" title="Ekran Paylaş" style="display:none">🖥️</button>
        </div>
        <div id="dm-call-incoming-actions" style="display:none">
          <button class="dm-call-btn dm-call-btn-green" id="dm-call-accept"  onclick="DmCall.accept()"   title="Kabul">📞</button>
          <button class="dm-call-btn dm-call-btn-red"   id="dm-call-reject"  onclick="DmCall.decline()"  title="Reddet">📵</button>
        </div>
      </div>
    `;
    // Styles
    const style = document.createElement('style');
    style.textContent = `
      #dm-call-overlay {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,.55); backdrop-filter: blur(6px);
        display: none; align-items: center; justify-content: center;
      }
      #dm-call-overlay.active { display: flex; }
      #dm-call-box {
        background: var(--bg-secondary, #2f3136);
        border-radius: 16px; padding: 24px 28px;
        width: min(420px, 94vw); text-align: center;
        box-shadow: 0 20px 60px rgba(0,0,0,.6);
        display: flex; flex-direction: column; gap: 16px;
        position: relative;
      }
      #dm-call-video-wrap {
        display: none; position: relative;
        width: 100%; height: 240px; border-radius: 10px; overflow: hidden;
        background: #111;
      }
      #dm-call-video-wrap.active { display: block; }
      #dm-call-remote-video {
        width: 100%; height: 100%; object-fit: cover;
      }
      #dm-call-local-video {
        position: absolute; bottom: 8px; right: 8px;
        width: 90px; height: 60px; border-radius: 6px;
        object-fit: cover; border: 2px solid var(--brand, #5865f2);
      }
      #dm-call-avatar {
        width: 72px; height: 72px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 28px; font-weight: 700; color: #fff;
        margin: 0 auto 10px;
      }
      #dm-call-name {
        font-size: 18px; font-weight: 700;
        color: var(--text-primary, #fff);
      }
      #dm-call-status {
        font-size: 13px; color: var(--text-muted, #aaa);
        margin-top: 4px;
      }
      #dm-call-actions, #dm-call-incoming-actions {
        display: flex; justify-content: center; gap: 16px;
      }
      .dm-call-btn {
        width: 52px; height: 52px; border-radius: 50%; border: none;
        cursor: pointer; font-size: 22px; transition: transform .12s, filter .12s;
        display: flex; align-items: center; justify-content: center;
      }
      .dm-call-btn:hover { transform: scale(1.1); filter: brightness(1.15); }
      .dm-call-btn-red   { background: #ed4245; }
      .dm-call-btn-green { background: #3ba55d; }
      .dm-call-btn-gray  { background: var(--bg-tertiary, #40444b); }
      .dm-call-btn.active { background: var(--brand, #5865f2); }
    `;
    document.head.appendChild(style);
    document.body.appendChild(el);
  }

  function _show()  { document.getElementById('dm-call-overlay').classList.add('active'); }
  function _hide()  { document.getElementById('dm-call-overlay').classList.remove('active'); }

  function _setStatus(txt) {
    const el = document.getElementById('dm-call-status');
    if (el) el.textContent = txt;
  }

  function _renderUser(displayName, avatarColor) {
    const av = document.getElementById('dm-call-avatar');
    const nm = document.getElementById('dm-call-name');
    if (av) {
      av.style.background = avatarColor || '#5865f2';
      av.textContent = (displayName || '?').slice(0,2).toUpperCase();
    }
    if (nm) nm.textContent = displayName || '';
  }

  // ── WebRTC ────────────────────────────────────────────────
  async function _initPC() {
    _pc = new RTCPeerConnection(ICE);

    _pc.onicecandidate = ({ candidate }) => {
      if (candidate && _remoteUserId) {
        socket.emit('dm:call:ice', { callId: _currentCallId, targetUserId: _remoteUserId, candidate });
      }
    };

    _pc.ontrack = ({ streams }) => {
      const remoteVid = document.getElementById('dm-call-remote-video');
      if (remoteVid && streams[0]) remoteVid.srcObject = streams[0];
    };

    _pc.onconnectionstatechange = () => {
      if (_pc.connectionState === 'connected') _setStatus(_currentType === 'video' ? '📹 Görüntülü arama aktif' : '🎤 Ses araması aktif');
      if (['failed','disconnected','closed'].includes(_pc.connectionState)) hangUp();
    };
  }

  async function _getMedia(withVideo) {
    try {
      _localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: withVideo ? { width: 640, height: 480, facingMode: 'user' } : false,
      });
    } catch (e) {
      _localStream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    }
    if (!_localStream) { toast('Mikrofona erişilemiyor', 'error'); return false; }

    const localVid = document.getElementById('dm-call-local-video');
    if (localVid && withVideo) localVid.srcObject = _localStream;

    for (const track of _localStream.getTracks()) _pc.addTrack(track, _localStream);

    if (withVideo) {
      document.getElementById('dm-call-video-wrap').classList.add('active');
      document.getElementById('dm-call-cam').style.display = '';
    }
    // Screen share button available once call is active
    document.getElementById('dm-call-screen').style.display = '';
    return true;
  }

  // ── Screen Share inside DM call ───────────────────────────
  async function toggleScreen() {
    if (_screenStream) {
      // Stop screen share
      _screenStream.getTracks().forEach(t => t.stop());
      _screenStream = null;
      // Revert video sender to camera track (or null)
      if (_pc) {
        const camTrack = _localStream?.getVideoTracks()[0] || null;
        const sender = _pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(camTrack).catch(() => {});
      }
      const btn = document.getElementById('dm-call-screen');
      if (btn) { btn.textContent = '🖥️'; btn.classList.remove('active'); }
      // Hide video wrap if no camera
      if (!_localStream?.getVideoTracks().length) {
        document.getElementById('dm-call-video-wrap').classList.remove('active');
      }
      return;
    }
    try {
      _screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, cursor: 'always' },
        audio: false,
      });
      const screenTrack = _screenStream.getVideoTracks()[0];
      screenTrack.onended = () => toggleScreen(); // user stops from browser UI

      if (_pc) {
        const sender = _pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(screenTrack);
        } else {
          _pc.addTrack(screenTrack, _screenStream);
        }
      }
      // Show local preview in video wrap
      const localVid = document.getElementById('dm-call-local-video');
      if (localVid) localVid.srcObject = _screenStream;
      document.getElementById('dm-call-video-wrap').classList.add('active');

      const btn = document.getElementById('dm-call-screen');
      if (btn) { btn.textContent = '⏹️'; btn.classList.add('active'); }
    } catch (e) {
      if (e.name !== 'NotAllowedError') console.warn('Screen share error:', e);
    }
  }

  // ── Start call (caller side) ──────────────────────────────
  async function startCall(toUserId, displayName, avatarColor, type = 'voice') {
    _injectOverlay();
    _currentType   = type;
    _remoteUserId  = toUserId;
    _role          = 'caller';

    _renderUser(displayName, avatarColor);
    _setStatus(type === 'video' ? '📹 Görüntülü arama kuruluyor…' : '📞 Aranıyor…');
    document.getElementById('dm-call-actions').style.display = 'flex';
    document.getElementById('dm-call-incoming-actions').style.display = 'none';
    _show();

    socket.emit('dm:call:start', { toUserId, type });
  }

  // ── Incoming call (callee side) ───────────────────────────
  function _notifySwIncoming(callerName, callType) {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'DM_CALL_INCOMING',
        callerName,
        callType,
      });
    }
  }

  function _handleIncoming({ callId, type, callerId, callerDisplayName, callerAvatarColor }) {
    _injectOverlay();
    _currentCallId = callId;
    _currentType   = type;
    _remoteUserId  = callerId;
    _role          = 'callee';

    _renderUser(callerDisplayName, callerAvatarColor);
    _setStatus(type === 'video' ? '📹 Görüntülü arama geliyor…' : '📞 Ses araması geliyor…');
    document.getElementById('dm-call-actions').style.display = 'none';
    document.getElementById('dm-call-incoming-actions').style.display = 'flex';
    _show();
    // Notify SW for background tab notification
    if (document.visibilityState === 'hidden') {
      _notifySwIncoming(callerDisplayName, type);
    }

    // Ringtone (browser beep fallback)
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      let beat = 0;
      _ringtoneTimer = setInterval(() => {
        if (beat++ > 10) { clearInterval(_ringtoneTimer); return; }
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = 480; g.gain.value = 0.15;
        o.start(); o.stop(ctx.currentTime + 0.4);
      }, 900);
    } catch {}
  }

  function accept() {
    clearInterval(_ringtoneTimer);
    _setStatus('Bağlanıyor…');
    document.getElementById('dm-call-incoming-actions').style.display = 'none';
    document.getElementById('dm-call-actions').style.display = 'flex';
    socket.emit('dm:call:accept', { callId: _currentCallId });
  }

  function decline() {
    clearInterval(_ringtoneTimer);
    socket.emit('dm:call:decline', { callId: _currentCallId });
    _cleanup();
  }

  function hangUp() {
    if (_currentCallId) socket.emit('dm:call:end', { callId: _currentCallId });
    _cleanup();
  }

  function toggleMic() {
    if (!_localStream) return;
    const track = _localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const btn = document.getElementById('dm-call-mute');
    if (btn) { btn.textContent = track.enabled ? '🎤' : '🔇'; btn.classList.toggle('active', !track.enabled); }
  }

  function toggleCam() {
    if (!_localStream) return;
    const track = _localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const btn = document.getElementById('dm-call-cam');
    if (btn) { btn.textContent = track.enabled ? '📷' : '🚫'; btn.classList.toggle('active', !track.enabled); }
  }

  function _cleanup() {
    clearInterval(_ringtoneTimer);
    _screenStream?.getTracks().forEach(t => t.stop()); _screenStream = null;
    _pc?.close(); _pc = null;
    _localStream?.getTracks().forEach(t => t.stop()); _localStream = null;
    const remoteVid = document.getElementById('dm-call-remote-video');
    const localVid  = document.getElementById('dm-call-local-video');
    if (remoteVid) remoteVid.srcObject = null;
    if (localVid)  localVid.srcObject = null;
    document.getElementById('dm-call-video-wrap')?.classList.remove('active');
    _currentCallId = null; _currentType = null; _remoteUserId = null; _role = null;
    _hide();
  }

  // ── Socket event bindings (called after socket ready) ─────
  function bindSocketEvents(sock) {
    sock.on('dm:call:outgoing', ({ callId, type, toUserId }) => {
      _currentCallId = callId;
    });

    sock.on('dm:call:incoming', (data) => _handleIncoming(data));

    sock.on('dm:call:accepted', async ({ callId, type, calleeDisplayName }) => {
      _setStatus(`${calleeDisplayName} kabul etti — bağlanıyor…`);
    });

    sock.on('dm:call:ready', async ({ callId, channelId, role, type }) => {
      _currentCallId = callId;
      _role          = role;
      await _initPC();
      const ok = await _getMedia(type === 'video');
      if (!ok) { hangUp(); return; }

      if (role === 'caller') {
        // Create and send offer
        const offer = await _pc.createOffer();
        await _pc.setLocalDescription(offer);
        sock.emit('dm:call:offer', { callId, targetUserId: _remoteUserId, offer });
        _setStatus('Bağlanıyor…');
      }
    });

    sock.on('dm:call:offer', async ({ callId, fromSocketId, offer }) => {
      if (!_pc) return;
      await _pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await _pc.createAnswer();
      await _pc.setLocalDescription(answer);
      sock.emit('dm:call:answer', { callId, targetUserId: _remoteUserId, answer });
    });

    sock.on('dm:call:answer', async ({ callId, fromSocketId, answer }) => {
      if (!_pc || _pc.signalingState === 'stable') return;
      await _pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    sock.on('dm:call:ice', async ({ callId, fromSocketId, candidate }) => {
      if (!_pc) return;
      try { await _pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    });

    sock.on('dm:call:declined', ({ callId }) => {
      _setStatus('Arama reddedildi');
      setTimeout(_cleanup, 1500);
    });

    sock.on('dm:call:ended', ({ callId }) => {
      _setStatus('Arama sonlandı');
      setTimeout(_cleanup, 1200);
    });

    sock.on('dm:call:missed', ({ callId }) => {
      if (_role === 'caller') { _setStatus('Cevap alınamadı'); setTimeout(_cleanup, 2000); }
      else _cleanup();
    });
  }

  return { startCall, accept, decline, hangUp, toggleMic, toggleCam, toggleScreen, bindSocketEvents };
})();

// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
export const DmCall = window.DmCall;
export const getDmCall = () => window.DmCall;
