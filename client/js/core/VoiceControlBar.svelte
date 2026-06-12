<!-- client/js/core/VoiceControlBar.svelte -->
<!-- Sprint 116 — voice.ts (670 satır) → Svelte 5 Runes -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('VoiceControlBar');

  // ── State ──────────────────────────────────────────────────────────────────
  let isMuted        = $state(false);
  let isDeafened     = $state(false);
  let isVideoOn      = $state(false);
  let isScreenShare  = $state(false);
  let inVoice        = $state(false);
  let channelName    = $state('');
  let peerCount      = $state(0);
  let isPTT          = $state(false);
  let pttActive      = $state(false);
  let videoQuality   = $state<'auto'|'360p'|'720p'|'1080p'>('auto');

  // ── Derived ────────────────────────────────────────────────────────────────
  let muteIcon    = $derived(isMuted    ? '🔇' : '🎙️');
  let deafenIcon  = $derived(isDeafened ? '🔕' : '🔔');
  let videoIcon   = $derived(isVideoOn  ? '📹' : '📷');
  let ssIcon      = $derived(isScreenShare ? '🖥️' : '🖵');

  // ── Actions ────────────────────────────────────────────────────────────────
  function toggleMute() {
    isMuted = !isMuted;
    BridgeRegistry.call('rtc:setMuted', isMuted);
  }
  function toggleDeafen() {
    isDeafened = !isDeafened;
    BridgeRegistry.call('rtc:setDeafened', isDeafened);
  }
  async function toggleVideo() {
    const ok = await BridgeRegistry.call('rtc:enableVideo', !isVideoOn);
    if (ok !== false) isVideoOn = !isVideoOn;
  }
  async function toggleScreenShare() {
    if (isScreenShare) {
      BridgeRegistry.call('rtc:stopScreenShare');
      isScreenShare = false;
    } else {
      const ok = await BridgeRegistry.call('rtc:startScreenShare', videoQuality, true);
      if (ok !== false) isScreenShare = true;
    }
  }
  function leaveVoice() {
    BridgeRegistry.call('rtc:leaveVoice');
    inVoice = false;
    isMuted = false; isDeafened = false; isVideoOn = false; isScreenShare = false;
    peerCount = 0; channelName = '';
  }

  // PTT
  function onKeyDown(e: KeyboardEvent) {
    if (!isPTT) return;
    const pttKey = BridgeRegistry.get('pttKey');
    if (pttKey && e.code === pttKey.code && !pttActive) {
      pttActive = true;
      if (isMuted) { isMuted = false; BridgeRegistry.call('rtc:setMuted', false); }
    }
  }
  function onKeyUp(e: KeyboardEvent) {
    if (!isPTT || !pttActive) return;
    const pttKey = BridgeRegistry.get('pttKey');
    if (pttKey && e.code === pttKey.code) {
      pttActive = false;
      isMuted = true; BridgeRegistry.call('rtc:setMuted', true);
    }
  }

  // ── Socket / RTC event handlers ───────────────────────────────────────────
  function onVoiceJoined(data: { channelName: string }) {
    inVoice = true; channelName = data.channelName;
  }
  function onVoiceLeft() {
    inVoice = false; channelName = ''; peerCount = 0;
    isMuted = false; isDeafened = false; isVideoOn = false; isScreenShare = false;
  }
  function onPeerUpdate(peers: unknown[]) { peerCount = peers.length; }
  function onRtcState(state: { muted?: boolean; deafened?: boolean; videoOn?: boolean; screenSharing?: boolean }) {
    if (state.muted      !== undefined) isMuted       = state.muted;
    if (state.deafened   !== undefined) isDeafened    = state.deafened;
    if (state.videoOn    !== undefined) isVideoOn     = state.videoOn;
    if (state.screenSharing !== undefined) isScreenShare = state.screenSharing;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  onMount(() => {
    const socket = BridgeRegistry.get('socket');
    socket?.on('voice:joined',    onVoiceJoined);
    socket?.on('voice:left',      onVoiceLeft);
    socket?.on('voice:peers',     onPeerUpdate);
    socket?.on('rtc:state',       onRtcState);

    BridgeRegistry.register('toggleMute',        toggleMute);
    BridgeRegistry.register('toggleDeafen',      toggleDeafen);
    BridgeRegistry.register('toggleVideo',       toggleVideo);
    BridgeRegistry.register('toggleScreenShare', toggleScreenShare);
    BridgeRegistry.register('leaveVoice',        leaveVoice);

    isPTT = BridgeRegistry.get('pttEnabled') ?? false;
  });
  onDestroy(() => {
    const socket = BridgeRegistry.get('socket');
    socket?.off('voice:joined',  onVoiceJoined);
    socket?.off('voice:left',    onVoiceLeft);
    socket?.off('voice:peers',   onPeerUpdate);
    socket?.off('rtc:state',     onRtcState);
  });
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} />

{#if inVoice}
<div class="voice-bar" role="toolbar" aria-label="Ses kontrolü">
  <div class="voice-bar-channel">
    <span class="voice-bar-icon" aria-hidden="true">🔊</span>
    <span class="voice-bar-name">{channelName}</span>
    {#if peerCount > 0}
      <span class="voice-bar-peers">{peerCount + 1}</span>
    {/if}
  </div>
  <div class="voice-bar-controls">
    <button
      class="vb-btn {isMuted ? 'active' : ''}"
      onclick={toggleMute}
      aria-label={isMuted ? 'Mikrofonu aç' : 'Mikrofonu kapat'}
      aria-pressed={isMuted}
      title={isMuted ? 'Mikrofon Kapalı' : 'Mikrofon Açık'}
    >{muteIcon}</button>
    <button
      class="vb-btn {isDeafened ? 'active' : ''}"
      onclick={toggleDeafen}
      aria-label={isDeafened ? 'Hoparlörü aç' : 'Hoparlörü kapat'}
      aria-pressed={isDeafened}
      title={isDeafened ? 'Hoparlör Kapalı' : 'Hoparlör Açık'}
    >{deafenIcon}</button>
    <button
      class="vb-btn {isVideoOn ? 'active' : ''}"
      onclick={toggleVideo}
      aria-label={isVideoOn ? 'Videoyu kapat' : 'Videoyu aç'}
      aria-pressed={isVideoOn}
      title="Video"
    >{videoIcon}</button>
    <button
      class="vb-btn {isScreenShare ? 'active ss' : ''}"
      onclick={toggleScreenShare}
      aria-label={isScreenShare ? 'Ekran paylaşımını durdur' : 'Ekranı paylaş'}
      aria-pressed={isScreenShare}
      title="Ekran Paylaşımı"
    >{ssIcon}</button>
    <button
      class="vb-btn vb-leave"
      onclick={leaveVoice}
      aria-label="Kanaldan ayrıl"
      title="Ayrıl"
    >📵</button>
  </div>
  {#if isPTT}
    <div class="voice-bar-ptt {pttActive ? 'active' : ''}" aria-live="polite">
      {pttActive ? '🔴 Konuşuluyor' : 'PTT aktif'}
    </div>
  {/if}
</div>
{/if}

<style>
.voice-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  background: var(--bridge-surface2, #2c2f33);
  border-top: 1px solid var(--bridge-border, #23272a);
  gap: 12px; flex-wrap: wrap;
}
.voice-bar-channel { display: flex; align-items: center; gap: 6px; font-size: .85rem; }
.voice-bar-name { color: var(--bridge-green, #43b581); font-weight: 500; }
.voice-bar-peers {
  background: var(--bridge-surface3, #393c40);
  border-radius: 10px; padding: 1px 6px; font-size: .75rem;
  color: var(--bridge-muted, #99aab5);
}
.voice-bar-controls { display: flex; gap: 4px; }
.vb-btn {
  width: 34px; height: 34px; border-radius: 8px; border: none; cursor: pointer;
  background: var(--bridge-surface3, #393c40);
  font-size: 1rem; display: flex; align-items: center; justify-content: center;
  transition: background .12s, transform .1s;
}
.vb-btn:hover { background: var(--bridge-surface4, #4f545c); transform: scale(1.08); }
.vb-btn.active { background: var(--bridge-danger, #f04747); }
.vb-btn.active.ss { background: var(--bridge-blue, #2d9cdb); }
.vb-leave { background: var(--bridge-danger, #f04747) !important; }
.vb-leave:hover { background: #d84040 !important; }
.voice-bar-ptt { font-size: .75rem; color: var(--bridge-muted, #99aab5); }
.voice-bar-ptt.active { color: var(--bridge-danger, #f04747); font-weight: 600; }
</style>
