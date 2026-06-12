<!-- client/js/core/DmCallPanel.svelte -->
<!-- Sprint 115 — dm-call.ts (898 satır) → Svelte 5 Runes (ADR-0008 Faz 2) -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';

  const log = createLogger('DmCallPanel');

  // ── State ──────────────────────────────────────────────────────────────────
  let callId        = $state<string | null>(null);
  let callType      = $state<'voice' | 'video' | null>(null);
  let remoteUserId  = $state<string | null>(null);
  let role          = $state<'caller' | 'callee' | null>(null);
  let callStatus    = $state<'idle' | 'ringing' | 'connecting' | 'active' | 'ended'>('idle');
  let isMuted       = $state(false);
  let isVideoOff    = $state(false);
  let isScreenShare = $state(false);
  let duration      = $state(0);
  let remoteUser    = $state<{ username: string; avatarUrl?: string } | null>(null);

  // ── Derived ────────────────────────────────────────────────────────────────
  let isActive      = $derived(callStatus === 'active');
  let isVisible     = $derived(callStatus !== 'idle');
  let durationFmt = $derived.by(() => {
    const m = Math.floor(duration / 60).toString().padStart(2, '0');
    const s = (duration % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  });
  let statusLabel = $derived.by(() => {
    const labels: Record<string, string> = {
      ringing: 'Çağrı bekleniyor…',
      connecting: 'Bağlanıyor…',
      active: durationFmt,
      ended: 'Çağrı sonlandı',
    };
    return labels[callStatus] ?? '';
  });

  // ── Refs ───────────────────────────────────────────────────────────────────
  let localVideo:  HTMLVideoElement | undefined  = $state();
  let remoteVideo: HTMLVideoElement | undefined  = $state();

  // ── Private (non-reactive) ─────────────────────────────────────────────────
  let _pc:         RTCPeerConnection | null = null;
  let _localStream: MediaStream | null      = null;
  let _screenStream: MediaStream | null     = null;
  let _durationInterval: ReturnType<typeof setInterval> | null = null;
  let _ringtoneTimer: ReturnType<typeof setInterval> | null    = null;

  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  // ── Effects ────────────────────────────────────────────────────────────────
  $effect(() => {
    if (isActive) {
      _durationInterval = setInterval(() => { duration++; }, 1000);
    } else {
      if (_durationInterval) { clearInterval(_durationInterval); _durationInterval = null; }
    }
    return () => { if (_durationInterval) clearInterval(_durationInterval); };
  });

  // ── Socket event listeners ─────────────────────────────────────────────────
  function _onIncomingCall(data: { callId: string; callerId: string; type: 'voice' | 'video'; callerName: string; callerAvatar?: string }) {
    callId = data.callId;
    callType = data.type;
    remoteUserId = data.callerId;
    role = 'callee';
    callStatus = 'ringing';
    remoteUser = { username: data.callerName, avatarUrl: data.callerAvatar };
    BridgeRegistry.call('toast', `${data.callerName} sizi arıyor…`, 'info');
    log.info('Incoming call', data);
  }

  function _onCallAnswered(data: { callId: string; answer: RTCSessionDescriptionInit }) {
    if (data.callId !== callId || !_pc) return;
    _pc.setRemoteDescription(new RTCSessionDescription(data.answer)).catch(log.error);
    callStatus = 'active';
    duration = 0;
  }

  function _onIceCandidate(data: { callId: string; candidate: RTCIceCandidateInit }) {
    if (data.callId !== callId || !_pc) return;
    _pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(log.error);
  }

  function _onCallEnded() {
    _cleanup();
    callStatus = 'ended';
    setTimeout(() => { callStatus = 'idle'; }, 2000);
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function startCall(targetUserId: string, type: 'voice' | 'video' = 'voice') {
    callType = type;
    remoteUserId = targetUserId;
    role = 'caller';
    callStatus = 'ringing';

    try {
      _localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
      if (localVideo && _localStream) localVideo.srcObject = _localStream;

      _pc = new RTCPeerConnection(ICE);
      _localStream.getTracks().forEach(t => _pc!.addTrack(t, _localStream!));

      _pc.ontrack = (ev) => {
        if (remoteVideo) remoteVideo.srcObject = ev.streams[0];
        callStatus = 'active';
        duration = 0;
      };

      _pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const socket = BridgeRegistry.get('socket');
        socket?.emit('dm:call:ice', { callId, candidate: ev.candidate.toJSON() });
      };

      const offer = await _pc.createOffer();
      await _pc.setLocalDescription(offer);

      const socket = BridgeRegistry.get('socket');
      const newCallId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      callId = newCallId;
      socket?.emit('dm:call:start', { callId: newCallId, targetUserId, type, offer: offer.toJSON() });
    } catch (err) {
      log.error('Call start failed', err);
      BridgeRegistry.call('toast', 'Arama başlatılamadı', 'error');
      _cleanup();
    }
  }

  async function answerCall() {
    if (!callId || !remoteUserId) return;
    try {
      _localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video',
      });
      if (localVideo) localVideo.srcObject = _localStream;

      _pc = new RTCPeerConnection(ICE);
      _localStream.getTracks().forEach(t => _pc!.addTrack(t, _localStream!));

      _pc.ontrack = (ev) => {
        if (remoteVideo) remoteVideo.srcObject = ev.streams[0];
        callStatus = 'active';
        duration = 0;
      };

      _pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const socket = BridgeRegistry.get('socket');
        socket?.emit('dm:call:ice', { callId, candidate: ev.candidate.toJSON() });
      };

      const socket = BridgeRegistry.get('socket');
      const offerData = BridgeRegistry.get(`pendingOffer:${callId}`);
      if (offerData) {
        await _pc.setRemoteDescription(new RTCSessionDescription(offerData));
      }

      const answer = await _pc.createAnswer();
      await _pc.setLocalDescription(answer);
      socket?.emit('dm:call:answer', { callId, answer: answer.toJSON() });
    } catch (err) {
      log.error('Call answer failed', err);
      BridgeRegistry.call('toast', 'Arama yanıtlanamadı', 'error');
      _cleanup();
    }
  }

  function hangUp() {
    const socket = BridgeRegistry.get('socket');
    socket?.emit('dm:call:end', { callId });
    _cleanup();
    callStatus = 'ended';
    setTimeout(() => { callStatus = 'idle'; }, 1500);
  }

  function toggleMute() {
    isMuted = !isMuted;
    _localStream?.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  }

  function toggleVideo() {
    isVideoOff = !isVideoOff;
    _localStream?.getVideoTracks().forEach(t => { t.enabled = !isVideoOff; });
  }

  async function toggleScreenShare() {
    if (!isScreenShare) {
      try {
        _screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = _screenStream.getVideoTracks()[0];
        const sender = _pc?.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(screenTrack);
        screenTrack.onended = () => { isScreenShare = false; _stopScreenShare(); };
        isScreenShare = true;
      } catch (err) {
        log.warn('Screen share failed', err);
      }
    } else {
      _stopScreenShare();
    }
  }

  function _stopScreenShare() {
    _screenStream?.getTracks().forEach(t => t.stop());
    _screenStream = null;
    const camTrack = _localStream?.getVideoTracks()[0];
    if (camTrack) {
      const sender = _pc?.getSenders().find(s => s.track?.kind === 'video');
      sender?.replaceTrack(camTrack);
    }
    isScreenShare = false;
  }

  function _cleanup() {
    _localStream?.getTracks().forEach(t => t.stop());
    _screenStream?.getTracks().forEach(t => t.stop());
    _pc?.close();
    _localStream = null;
    _screenStream = null;
    _pc = null;
    if (_ringtoneTimer) { clearInterval(_ringtoneTimer); _ringtoneTimer = null; }
    callId = null;
    callType = null;
    remoteUserId = null;
    role = null;
    duration = 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  onMount(() => {
    const socket = BridgeRegistry.get('socket');
    socket?.on('dm:call:incoming',  _onIncomingCall);
    socket?.on('dm:call:answered',  _onCallAnswered);
    socket?.on('dm:call:ice',       _onIceCandidate);
    socket?.on('dm:call:ended',     _onCallEnded);

    // BridgeRegistry API — vanilla kod bu API'yi çağırır
    BridgeRegistry.register('startDmCall',  (uid: string, type?: 'voice' | 'video') => startCall(uid, type));
    BridgeRegistry.register('hangUpDmCall', hangUp);
  });

  onDestroy(() => {
    const socket = BridgeRegistry.get('socket');
    socket?.off('dm:call:incoming',  _onIncomingCall);
    socket?.off('dm:call:answered',  _onCallAnswered);
    socket?.off('dm:call:ice',       _onIceCandidate);
    socket?.off('dm:call:ended',     _onCallEnded);
    _cleanup();
  });
</script>

{#if isVisible}
<div id="dm-call-overlay" class="dm-call-overlay" role="dialog" aria-label="DM Araması" aria-modal="true">
  <div class="dm-call-box">

    <!-- Video area -->
    {#if callType === 'video'}
    <div class="dm-call-video-wrap">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={remoteVideo} class="dm-call-remote-video" autoplay playsinline></video>
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={localVideo}  class="dm-call-local-video"  autoplay playsinline muted></video>
    </div>
    {/if}

    <!-- Avatar (voice only) -->
    {#if callType === 'voice'}
    <div class="dm-call-avatar-wrap">
      <div class="dm-call-avatar" aria-hidden="true">
        {#if remoteUser?.avatarUrl}
          <img src={remoteUser.avatarUrl} alt={remoteUser.username} />
        {:else}
          <div class="dm-call-avatar-fallback">{remoteUser?.username?.[0]?.toUpperCase() ?? '?'}</div>
        {/if}
      </div>
      <div class="dm-call-name">{remoteUser?.username ?? '…'}</div>
      <div class="dm-call-status" aria-live="polite">{statusLabel}</div>
    </div>
    {/if}

    <!-- Actions -->
    <div class="dm-call-actions" role="toolbar" aria-label="Arama kontrolleri">
      {#if callStatus === 'ringing' && role === 'callee'}
        <button class="dm-btn dm-btn-accept" onclick={answerCall} aria-label="Aramayı kabul et" title="Kabul et">
          📞
        </button>
        <button class="dm-btn dm-btn-reject" onclick={hangUp} aria-label="Aramayı reddet" title="Reddet">
          📵
        </button>
      {:else if callStatus !== 'idle'}
        {#if callType === 'video'}
          <button class="dm-btn {isVideoOff ? 'dm-btn-off' : ''}" onclick={toggleVideo}
            aria-label={isVideoOff ? 'Videoyu aç' : 'Videoyu kapat'}
            aria-pressed={isVideoOff}
            title={isVideoOff ? 'Video Aç' : 'Video Kapat'}>
            {isVideoOff ? '📵' : '📹'}
          </button>
          <button class="dm-btn {isScreenShare ? 'dm-btn-active' : ''}" onclick={toggleScreenShare}
            aria-label={isScreenShare ? 'Ekran paylaşımını durdur' : 'Ekranı paylaş'}
            aria-pressed={isScreenShare}
            title="Ekran Paylaşımı">
            🖥️
          </button>
        {/if}
        <button class="dm-btn {isMuted ? 'dm-btn-off' : ''}" onclick={toggleMute}
          aria-label={isMuted ? 'Sesi aç' : 'Sesi kapat'}
          aria-pressed={isMuted}
          title={isMuted ? 'Mikrofon Aç' : 'Mikrofon Kapat'}>
          {isMuted ? '🔇' : '🎤'}
        </button>
        <button class="dm-btn dm-btn-reject" onclick={hangUp} aria-label="Aramayı sonlandır" title="Kapat">
          📵
        </button>
      {/if}
    </div>

    <!-- Duration (active call) -->
    {#if isActive}
      <div class="dm-call-duration" aria-live="polite" aria-label="Arama süresi">{durationFmt}</div>
    {/if}

  </div>
</div>
{/if}

<style>
.dm-call-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.65);
  display: flex; align-items: center; justify-content: center;
  z-index: 9999;
  backdrop-filter: blur(4px);
}
.dm-call-box {
  background: var(--bridge-surface, #1e2124);
  border-radius: 16px;
  padding: 24px;
  min-width: 320px;
  display: flex; flex-direction: column; align-items: center; gap: 16px;
  box-shadow: 0 8px 32px rgba(0,0,0,.5);
}
.dm-call-video-wrap { position: relative; width: 100%; border-radius: 12px; overflow: hidden; }
.dm-call-remote-video { width: 100%; aspect-ratio: 16/9; background: #000; }
.dm-call-local-video {
  position: absolute; bottom: 8px; right: 8px;
  width: 25%; border-radius: 8px; border: 2px solid var(--bridge-blue, #2d9cdb);
}
.dm-call-avatar-wrap { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.dm-call-avatar { width: 80px; height: 80px; border-radius: 50%; overflow: hidden; }
.dm-call-avatar img { width: 100%; height: 100%; object-fit: cover; }
.dm-call-avatar-fallback {
  width: 100%; height: 100%;
  background: var(--bridge-blue, #2d9cdb);
  display: flex; align-items: center; justify-content: center;
  font-size: 2rem; color: #fff; font-weight: 700;
}
.dm-call-name  { font-size: 1.2rem; font-weight: 600; color: var(--bridge-text, #fff); }
.dm-call-status { font-size: .875rem; color: var(--bridge-muted, #99aab5); }
.dm-call-actions { display: flex; gap: 12px; }
.dm-btn {
  width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
  font-size: 1.4rem; display: flex; align-items: center; justify-content: center;
  background: var(--bridge-surface2, #2c2f33); transition: background .15s, transform .1s;
}
.dm-btn:hover  { background: var(--bridge-surface3, #393c40); transform: scale(1.05); }
.dm-btn-accept { background: #43b581; }
.dm-btn-accept:hover { background: #3aa870; }
.dm-btn-reject { background: #f04747; }
.dm-btn-reject:hover { background: #d84040; }
.dm-btn-off    { background: var(--bridge-danger, #f04747); }
.dm-btn-active { background: var(--bridge-blue, #2d9cdb); }
.dm-call-duration { font-size: .8rem; color: var(--bridge-muted, #99aab5); letter-spacing: .05em; }
</style>
