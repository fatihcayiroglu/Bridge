<!-- client/js/core/VoicePanel.svelte -->
<!-- ADR-0008 Faz 2 — voice.ts (~670 satır) → Svelte bileşeni            -->
<!-- Karmaşık state (mute/deafen/video/screenshare/peer listesi/PTT)      -->
<!-- Svelte 5 Runes API, BridgeRegistry üzerinden vanilla servisle köprü  -->
<!-- Sprint 113                                                            -->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { setSrcObject }   from './voice-actions.js';
  import { getRtc }         from './globals.js';
  import { createLogger }   from './logger.js';
  // Sprint 120: VoicePanel refactor — PTT ve ScreenShare controller'ları
  import VoicePTTController from './VoicePTTController.svelte';
  import VoiceScreenShareController from './VoiceScreenShareController.svelte';

  const log = createLogger('VoicePanel');

  // ── Tipler ────────────────────────────────────────────────────────────────

  interface PeerInfo {
    id: string;
    socketId: string;
    displayName: string;
    avatarColor: string;
  }

  interface PeerState {
    muted?: boolean;
    deafened?: boolean;
    screensharing?: boolean;
    video?: boolean;
  }

  interface SfuTile {
    tileId: string;
    stream: MediaStream;
    label: string;
    isLocal: boolean;
    isScreen: boolean;
  }

  interface PTTKey {
    code: string;
    label: string;
  }

  interface PTTStatus {
    enabled: boolean;
    mode: 'hold' | 'toggle';
    key: PTTKey | null;
    releaseDelay: number;
    active: boolean;
  }

  interface QualityPrefs {
    preset?: string;
    bitrateKbps?: number;
  }

  interface Props {
    onLeave?: () => void;
  }

  let { onLeave }: Props = $props();

  // ── State ─────────────────────────────────────────────────────────────────

  let muted         = $state(false);
  let deafened      = $state(false);
  let videoOn       = $state(false);
  let screenSharing = $state(false);

  let peers     = $state<Map<string, PeerInfo>>(new Map());
  let sfuTiles  = $state<Map<string, SfuTile>>(new Map());
  let peerStates = $state<Map<string, PeerState>>(new Map());

  let showScreenShareView = $state(false);
  let ssChannelName       = $state('');
  let sharerName          = $state('');
  let localScreenStream   = $state<MediaStream | null>(null);
  let remoteScreenStream  = $state<MediaStream | null>(null);
  let ssMiniMode          = $state(false);
  let ssLoadingVisible    = $state(false);
  let ssStopVisible       = $state(false);
  let ssShareVisible      = $state(true);
  let ssLocalBadge        = $state(false);
  let ssQualityLabel      = $state('');
  let qualityModalOpen    = $state(false);

  let pttStatus = $state<PTTStatus>({
    enabled: false,
    mode: 'hold',
    key: null,
    releaseDelay: 200,
    active: false,
  });
  // pttCapturing artık VoicePTTController'da yönetiliyor (Sprint 120 refactor)

  let currentChannelName = $state('');

  // video ref'leri
  let remoteScreenVideoEl = $state<HTMLVideoElement | null>(null);
  let ssVideoWrapEl       = $state<HTMLDivElement | null>(null);

  // ── Yardımcı: rtc bağdaştırıcısı ─────────────────────────────────────────

  function rtc() {
    return getRtc() as {
      muted: boolean; deafened: boolean; videoOn: boolean; screenSharing: boolean;
      screenStream: MediaStream | null;
      peers: Map<string, RTCPeerConnection>;
      setMuted(v: boolean): void;
      setDeafened(v: boolean): void;
      enableVideo(on: boolean): Promise<boolean | void>;
      getLocalStream(): MediaStream | null;
      isInVoice(): boolean;
      leaveVoice(): void;
      startScreenShare(quality: string, audio: boolean): Promise<boolean>;
      stopScreenShare(): void;
    } | null;
  }

  function currentUser(): { displayName?: string } | undefined {
    return (BridgeRegistry.get('getMe') as (() => { displayName?: string } | null) | undefined)?.() ?? undefined;
  }

  function currentChannel(): { name?: string; _id?: string } | null {
    return (BridgeRegistry.get('getCurrentChannel') as (() => { name?: string; _id?: string } | null) | undefined)?.() ?? null;
  }

  function currentServer(): { _id: string } | null {
    return (BridgeRegistry.get('getCurrentServer') as (() => { _id: string } | null) | undefined)?.() ?? null;
  }

  function getSocket(): { emit(e: string, d: unknown): void } | null {
    return (window as Record<string, unknown>)['socket'] as { emit(e: string, d: unknown): void } | null;
  }

  function voiceChannelPeers(): Map<string, PeerInfo> {
    return (window as Record<string, unknown>)['voiceChannelPeers'] as Map<string, PeerInfo> ?? new Map();
  }

  function toast(msg: string, type = 'info'): void {
    BridgeRegistry.get('toast')?.(msg, type);
  }

  function cssColor(c: string): string {
    return (BridgeRegistry.get('cssColor') as (c: string) => string | undefined)?.(c) ?? c;
  }

  function initials(name: string): string {
    return (BridgeRegistry.get('initials') as (n: string) => string | undefined)?.(name)
      ?? name.slice(0, 2).toUpperCase();
  }

  function escHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] ?? c));
  }

  // ── Grid hesaplama ────────────────────────────────────────────────────────

  let gridCols = $derived.by(() => {
    const n = sfuTiles.size;
    return n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 2 : 3;
  });

  // ── Kontroller ────────────────────────────────────────────────────────────

  export function toggleMute(): void {
    const r = rtc();
    if (!r) return;
    muted = !r.muted;
    r.setMuted(muted);
    document.dispatchEvent(new CustomEvent('bridge:voice-mute-changed', { detail: { muted } }));
  }

  export function toggleDeafen(): void {
    const r = rtc();
    if (!r) return;
    r.setDeafened(!r.deafened);
    deafened = r.deafened;
  }

  export async function toggleVideo(): Promise<void> {
    const r = rtc();
    if (!r) return;
    if (r.videoOn) {
      await r.enableVideo(false);
      videoOn = false;
      sfuRemoveVideoTile('local');
    } else {
      const ok = await r.enableVideo(true);
      if (ok !== false) {
        videoOn = true;
        const localStream = r.getLocalStream();
        if (localStream) sfuAddVideoTile('local', localStream, currentUser()?.displayName ?? 'Ben', true, false);
      }
    }
  }

  // ── SFU Video Grid ────────────────────────────────────────────────────────

  export function sfuAddVideoTile(
    tileId: string,
    stream: MediaStream,
    label: string,
    isLocal = false,
    isScreen = false,
  ): void {
    sfuTiles = new Map(sfuTiles).set(tileId, { tileId, stream, label, isLocal, isScreen });
  }

  export function sfuRemoveVideoTile(tileId: string): void {
    const m = new Map(sfuTiles);
    m.delete(tileId);
    sfuTiles = m;
  }

  export function sfuHandleNewProducer(
    socketId: string,
    userId: string,
    stream: MediaStream,
    kind: 'video' | 'screen',
  ): void {
    const vcPeers = voiceChannelPeers();
    const peer = [...vcPeers.values()].find(p => p.socketId === socketId);
    const label = peer?.displayName ?? userId ?? 'Kullanıcı';
    sfuAddVideoTile(`${socketId}-${kind}`, stream, label, false, kind === 'screen');
  }

  export function sfuHandlePeerLeft(socketId: string): void {
    sfuRemoveVideoTile(`${socketId}-video`);
    sfuRemoveVideoTile(`${socketId}-screen`);
  }

  export function sfuClearAllVideoTiles(): void {
    sfuTiles = new Map();
  }

  // ── Screen Share — Sprint 120 Refactor: mantık VoiceScreenShareController'a taşındı ──
  // Aşağıdaki wrapper'lar mevcut BridgeRegistry/dış API'ye geriye dönük uyumluluk sağlar.

  let ssController: VoiceScreenShareController | undefined;

  function _onSSShareStarted(): void {
    screenSharing      = true;
    showScreenShareView = true;
    ssLoadingVisible   = false;
    ssStopVisible      = true;
    ssShareVisible     = false;
  }

  function _onSSShareStopped(): void {
    screenSharing    = false;
    ssStopVisible    = false;
    ssShareVisible   = true;
    ssLoadingVisible = false;
  }

  export function toggleScreenShare(): void             { ssController?.toggle(); }
  export function openScreenShareQualityPicker(): void  { ssController?.openQualityPicker(); }
  export async function startScreenShareWithQuality(quality: string): Promise<void> {
    await ssController?.startWithQuality(quality);
  }
  export function stopMyScreenShare(): void             { ssController?.stopShare(); }
  export function toggleSSFullscreen(): void            { ssController?.toggleFullscreen(); }
  export function toggleSSMiniMode(): void              { ssController?.toggleMini(); }

  // ── Leave Voice ───────────────────────────────────────────────────────────

  export function leaveVoice(): void {
    BridgeRegistry.get('BridgeVoiceE2E')?.clearSession?.();
    BridgeRegistry.get('_bridgeStopLocalVAD')?.();
    sfuClearAllVideoTiles();
    rtc()?.leaveVoice();
    voiceChannelPeers().clear();
    peers  = new Map();
    peerStates = new Map();
    muted  = false; deafened = false; videoOn = false; screenSharing = false;
    showScreenShareView = false;
    document.dispatchEvent(new CustomEvent('bridge:voice-left'));
    onLeave?.();
  }

  // ── Peer Rendering ────────────────────────────────────────────────────────

  export function renderVoicePeer(peer: PeerInfo, isLocal = false): void {
    const key = isLocal ? 'local' : peer.socketId;
    if (peers.has(key)) return;
    peers = new Map(peers).set(key, peer);
  }

  export function removeVoicePeer(socketId: string): void {
    const m = new Map(peers);
    m.delete(socketId);
    peers = m;
    sfuRemoveVideoTile(`${socketId}-video`);
    sfuRemoveVideoTile(`${socketId}-screen`);
  }

  export function updatePeerState(socketId: string, state: PeerState): void {
    peerStates = new Map(peerStates).set(socketId, state);
    if (state.video === false) sfuRemoveVideoTile(`${socketId}-video`);
    if (state.screensharing === false) sfuRemoveVideoTile(`${socketId}-screen`);
  }

  export function attachRemoteStream(socketId: string, stream: MediaStream): void {
    const hasScreen = stream.getVideoTracks().some(t =>
      t.label.toLowerCase().includes('screen') ||
      t.label.toLowerCase().includes('window') ||
      t.label.toLowerCase().includes('tab') ||
      t.contentHint === 'detail',
    );

    if (hasScreen) {
      remoteScreenStream = stream;
      showScreenShareView = true;
      ssStopVisible  = false;
      ssShareVisible = true;
      const peer = [...voiceChannelPeers().values()].find(p => p.socketId === socketId);
      if (peer) sharerName = `— ${peer.displayName} paylaşıyor`;
      sfuAddVideoTile(`${socketId}-screen`, stream, peer?.displayName ?? 'Kullanıcı', false, true);
    }
  }

  // ── Reply / Pin ───────────────────────────────────────────────────────────

  export function startReply(msgId: string, displayName: string): void {
    (window as Record<string, unknown>)['replyingTo'] = msgId;
    BridgeRegistry.get('showReplyBar')?.(msgId, displayName);
  }

  export function cancelReply(): void {
    (window as Record<string, unknown>)['replyingTo'] = null;
    BridgeRegistry.get('hideReplyBar')?.();
  }

  export function pinMessage(msgId: string, channelId: string): void {
    getSocket()?.emit('message:pin', {
      messageId: msgId,
      channelId,
      serverId: currentServer()?._id,
    });
  }

  // ── PTT — Sprint 120 Refactor: mantık VoicePTTController'a taşındı ────────
  // VoicePTTController bileşenine bind: ile bağlanır; aşağıdaki wrapper'lar
  // BridgeRegistry ve dış kodun mevcut API'sine geriye dönük uyumluluk sağlar.

  let pttController: VoicePTTController | undefined;

  // pttStatus ve pttCapturing artık controller'dan senkronize edilir
  function _onPttStatusChange(s: PTTStatus): void {
    pttStatus   = s;
  }

  // Public API — dışarıya (BridgeRegistry) aynı isimler korundu
  export function setPttEnabled(on: boolean): void       { pttController?.setEnabled(on); }
  export function setPttMode(m: 'hold' | 'toggle'): void { pttController?.setMode(m); }
  export function setPttReleaseDelay(ms: number): void   { pttController?.setReleaseDelay(ms); }
  export function clearPttKey(): void                    { pttController?.clearKey(); }
  export function getPttStatus(): PTTStatus              { return pttController?.getStatus() ?? pttStatus; }
  export function startPttKeyCapture(): void             { pttController?.startCapture(); }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  function _onFullscreenChange(): void {
    // state güncellemesi template'de derived ile yapılır
  }

  // ── Klavye kısayolları (a11y — B1) ──────────────────────────────────────
  function _handleVoiceKeys(e: KeyboardEvent): void {
    if (!e.ctrlKey || !e.shiftKey) return;
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'M' || e.key === 'm') { e.preventDefault(); toggleMute(); }
    if (e.key === 'D' || e.key === 'd') { e.preventDefault(); toggleDeafen(); }
  }

  onMount(() => {
    document.addEventListener('keydown', _handleVoiceKeys);
    document.addEventListener('fullscreenchange', _onFullscreenChange);

    const ch = currentChannel();
    if (ch?.name) {
      currentChannelName = ch.name;
      ssChannelName = ch.name;
    }

    // BridgeRegistry'ye dışarıdan erişim için fonksiyonlar kaydet
    BridgeRegistry.register('voicePanel:toggleMute',          toggleMute);
    BridgeRegistry.register('voicePanel:toggleDeafen',        toggleDeafen);
    BridgeRegistry.register('voicePanel:toggleVideo',         toggleVideo);
    BridgeRegistry.register('voicePanel:toggleScreenShare',   toggleScreenShare);
    BridgeRegistry.register('voicePanel:leaveVoice',          leaveVoice);
    BridgeRegistry.register('voicePanel:renderVoicePeer',     renderVoicePeer);
    BridgeRegistry.register('voicePanel:removeVoicePeer',     removeVoicePeer);
    BridgeRegistry.register('voicePanel:updatePeerState',     updatePeerState);
    BridgeRegistry.register('voicePanel:attachRemoteStream',  attachRemoteStream);
    BridgeRegistry.register('voicePanel:sfuAddVideoTile',     sfuAddVideoTile);
    BridgeRegistry.register('voicePanel:sfuRemoveVideoTile',  sfuRemoveVideoTile);
    BridgeRegistry.register('voicePanel:sfuHandleNewProducer',sfuHandleNewProducer);
    BridgeRegistry.register('voicePanel:sfuHandlePeerLeft',   sfuHandlePeerLeft);
    BridgeRegistry.register('voicePanel:sfuClearAllVideoTiles', sfuClearAllVideoTiles);
    BridgeRegistry.register('voicePanel:getPttStatus',        getPttStatus);
    BridgeRegistry.register('voicePanel:setPttEnabled',       setPttEnabled);
    BridgeRegistry.register('voicePanel:startPttKeyCapture',  startPttKeyCapture);
    BridgeRegistry.register('voicePanel:clearPttKey',         clearPttKey);
    BridgeRegistry.register('voicePanel:startReply',          startReply);
    BridgeRegistry.register('voicePanel:pinMessage',          pinMessage);
  });

  onDestroy(() => {
    document.removeEventListener('keydown', _handleVoiceKeys);
    document.removeEventListener('fullscreenchange', _onFullscreenChange);

    BridgeRegistry.unregister?.('voicePanel:toggleMute');
    BridgeRegistry.unregister?.('voicePanel:toggleDeafen');
    BridgeRegistry.unregister?.('voicePanel:toggleVideo');
    BridgeRegistry.unregister?.('voicePanel:toggleScreenShare');
    BridgeRegistry.unregister?.('voicePanel:leaveVoice');
    BridgeRegistry.unregister?.('voicePanel:renderVoicePeer');
    BridgeRegistry.unregister?.('voicePanel:removeVoicePeer');
    BridgeRegistry.unregister?.('voicePanel:updatePeerState');
    BridgeRegistry.unregister?.('voicePanel:attachRemoteStream');
    BridgeRegistry.unregister?.('voicePanel:sfuAddVideoTile');
    BridgeRegistry.unregister?.('voicePanel:sfuRemoveVideoTile');
    BridgeRegistry.unregister?.('voicePanel:sfuHandleNewProducer');
    BridgeRegistry.unregister?.('voicePanel:sfuHandlePeerLeft');
    BridgeRegistry.unregister?.('voicePanel:sfuClearAllVideoTiles');
    BridgeRegistry.unregister?.('voicePanel:getPttStatus');
    BridgeRegistry.unregister?.('voicePanel:setPttEnabled');
    BridgeRegistry.unregister?.('voicePanel:startPttKeyCapture');
    BridgeRegistry.unregister?.('voicePanel:clearPttKey');
    BridgeRegistry.unregister?.('voicePanel:startReply');
    BridgeRegistry.unregister?.('voicePanel:pinMessage');
  });

  let isFullscreen = $derived(!!document.fullscreenElement);
</script>

<!-- Sprint 120: PTT ve ScreenShare controller'ları — mantık bu bileşenlerde -->
<VoicePTTController
  bind:this={pttController}
  getRtc={rtc}
  onStatusChange={_onPttStatusChange}
/>
<VoiceScreenShareController
  bind:this={ssController}
  bind:qualityModalOpen
  getRtc={rtc}
  onShareStarted={_onSSShareStarted}
  onShareStopped={_onSSShareStopped}
/>

<!-- ── Ses Kanalı Görünümü ─────────────────────────────────────────────── -->
<div id="voice-view" class="voice-view">

  <!-- Kontrol Çubuğu -->
  <div class="vc-controls" role="toolbar" aria-label="Ses kanalı kontrolleri">
    <button
      id="vc-mute"
      class="vc-btn"
      class:active={muted}
      onclick={toggleMute}
      title={muted ? 'Sesi Aç (Ctrl+Shift+M)' : 'Sesi Kapat (Ctrl+Shift+M)'}
      aria-label={muted ? 'Mikrofonu aç' : 'Mikrofonu kapat'}
      aria-pressed={muted}
    >
      {muted ? '🔇' : '🎙️'}
    </button>

    <button
      id="vc-deafen"
      class="vc-btn"
      class:active={deafened}
      onclick={toggleDeafen}
      title={deafened ? 'Dinlemeye Başla (Ctrl+Shift+D)' : 'Sağırlaş (Ctrl+Shift+D)'}
      aria-label={deafened ? 'Sesi aç' : 'Sesi kapat'}
      aria-pressed={deafened}
    >
      {deafened ? '🔕' : '🔔'}
    </button>

    <button
      id="vc-video"
      class="vc-btn"
      class:active={videoOn}
      onclick={toggleVideo}
      title={videoOn ? 'Kamerayı Kapat' : 'Kamerayı Aç'}
      aria-label={videoOn ? 'Kamerayı kapat' : 'Kamerayı aç'}
      aria-pressed={videoOn}
    >
      {videoOn ? '📸' : '📷'}
    </button>

    <button
      id="vc-screen"
      class="vc-btn"
      class:active={screenSharing}
      onclick={toggleScreenShare}
      title={screenSharing ? 'Paylaşımı Durdur' : 'Ekran Paylaş'}
      aria-label={screenSharing ? 'Ekran paylaşımını durdur' : 'Ekran paylaş'}
      aria-pressed={screenSharing}
    >
      🖥️
    </button>

    <button
      class="vc-btn vc-btn-danger"
      onclick={leaveVoice}
      title="Kanaldan Ayrıl"
      aria-label="Ses kanalından ayrıl"
    >
      📞
    </button>
  </div>

  <!-- Peer Listesi -->
  <div id="voice-peers" class="voice-peers">
    {#each [...peers.entries()] as [key, peer] (key)}
      {@const st = peerStates.get(peer.socketId) ?? {}}
      {@const isLocal = key === 'local'}
      <div
        class="voice-peer"
        class:local={isLocal}
        id="vp-{key}"
        data-socket={peer.socketId ?? 'local'}
      >
        <div class="voice-peer-video-wrap" id="vpw-{key}">
          <div class="voice-peer-avatar-center">
            <div
              class="voice-peer-big-avatar"
              style="background:{cssColor(peer.avatarColor)}"
            >
              {initials(peer.displayName)}
            </div>
          </div>
        </div>
        <div class="voice-peer-name">
          {peer.displayName}{isLocal ? ' (Sen)' : ''}
        </div>
        <div class="voice-peer-icons" id="vpi-{key}">
          {#if st.muted}🔇 {/if}
          {#if st.screensharing}<span class="peer-sharing-badge">🖥️ Paylaşıyor</span> {/if}
          {#if st.video}📷{/if}
        </div>
      </div>
    {/each}
  </div>

  <!-- SFU Video Grid -->
  {#if sfuTiles.size > 0}
    <div
      id="sfu-video-grid"
      class="sfu-video-grid"
      style="grid-template-columns: repeat({gridCols}, 1fr)"
    >
      {#each [...sfuTiles.values()] as tile (tile.tileId)}
        <div
          class="sfu-tile"
          class:sfu-tile-screen={tile.isScreen}
          data-tile-id={tile.tileId}
        >
          <!-- video srcObject reaktif değil; bind + use action ile set edilir -->
          <!-- eslint-disable-next-line svelte/no-unused-svelte-ignore -->
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            autoplay
            playsinline
            muted={tile.isLocal}
            use:setSrcObject={tile.stream}
          ></video>
          <div class="sfu-tile-name">
            {tile.isLocal ? '📹 ' : ''}{tile.isScreen ? '🖥️ ' : ''}{tile.label}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- ── Ekran Paylaşımı Görünümü ────────────────────────────────────────── -->
{#if showScreenShareView}
  <div
    id="screen-share-view"
    class="screen-share-view"
    class:ss-mini={ssMiniMode}
    bind:this={ssVideoWrapEl}
  >
    <div class="ss-header">
      <span id="ss-channel-name">{ssChannelName}</span>
      {#if sharerName}<span id="ss-sharer-name">{sharerName}</span>{/if}
      {#if ssLocalBadge}<span id="ss-local-badge" class="ss-local-badge">📺 Yerel</span>{/if}
      {#if ssQualityLabel}<span id="ss-quality-label" class="ss-quality-label">{ssQualityLabel}</span>{/if}
    </div>

    {#if ssLoadingVisible}
      <div id="ss-loading" class="ss-loading">Başlatılıyor…</div>
    {/if}

    <div class="ss-video-wrap">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        id="remote-screen-video"
        autoplay
        playsinline
        muted
        bind:this={remoteScreenVideoEl}
        use:setSrcObject={remoteScreenStream ?? localScreenStream}
      ></video>
    </div>

    <div class="ss-controls">
      {#if ssStopVisible}
        <button id="ss-stop-btn" class="btn btn-danger" onclick={stopMyScreenShare}>
          ⏹ Paylaşımı Durdur
        </button>
      {/if}
      {#if ssShareVisible}
        <button id="ss-share-btn" class="btn" onclick={openScreenShareQualityPicker}>
          🖥️ Paylaş
        </button>
      {/if}
      <button id="ss-mute-btn" class="btn" class:active={muted} onclick={toggleMute}>
        {muted ? '🔇' : '🎙️'}
      </button>
      <button id="ss-deafen-btn" class="btn" class:active={deafened} onclick={toggleDeafen}>
        {deafened ? '🔕' : '🔔'}
      </button>
      <button id="ss-fullscreen-btn" class="btn" onclick={toggleSSFullscreen}>
        {isFullscreen ? '⊠' : '⛶'}
      </button>
      <button class="btn" onclick={toggleSSMiniMode}>
        {ssMiniMode ? '⤢' : '⤡'}
      </button>
    </div>

    <div id="ss-thumbnails" class="ss-thumbnails"></div>
  </div>
{/if}

<!-- ── Ekran Kalite Seçici Modal ───────────────────────────────────────── -->
{#if qualityModalOpen}
  <div id="ss-quality-modal" class="modal-overlay">
    <div class="modal-card ss-quality-card">
      <h3>🖥️ Ekran Paylaşımı Kalitesi</h3>
      <div class="ss-quality-options">
        {#each [
          { value: '4k60',    label: '4K 60fps' },
          { value: '1440p60', label: '1440p 60fps' },
          { value: '1440p',   label: '1440p 30fps' },
          { value: '1080p60', label: '1080p 60fps' },
          { value: '1080p',   label: '1080p 30fps' },
          { value: '720p',    label: '720p 30fps' },
          { value: 'hd',      label: 'HD' },
        ] as opt (opt.value)}
          <button
            class="btn ss-quality-btn"
            onclick={() => startScreenShareWithQuality(opt.value)}
          >
            {opt.label}
          </button>
        {/each}
      </div>
      <div class="ss-quality-opts">
        <label>
          <input type="checkbox" id="ss-include-audio" checked /> Ses Dahil
        </label>
        <label>
          <input type="checkbox" id="ss-save-as-default" /> Varsayılan Olarak Kaydet
        </label>
      </div>
      <button class="btn" onclick={() => (qualityModalOpen = false)}>İptal</button>
    </div>
  </div>
{/if}

<!-- ── PTT Durumu (Settings'den gösterilir) ───────────────────────────── -->
<div id="ptt-live-status" class="ptt-status" style="display:none">
  {#if !pttStatus.enabled}
    Devre dışı
  {:else if pttStatus.active}
    <span style="color:var(--green,#43b581)">🔴 Yayında — mikrofon açık</span>
  {:else}
    ⏸ Beklemede ({pttStatus.key?.label ?? '—'})
  {/if}
</div>


<style>
  .voice-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-2, #2f3136);
    color: var(--text, #dcddde);
  }

  .vc-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--bg-3, #202225);
    border-bottom: 1px solid var(--border, #40444b);
  }

  .vc-btn {
    background: var(--bg-4, #36393f);
    border: none;
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 16px;
    cursor: pointer;
    color: var(--text, #dcddde);
    transition: background .15s;
  }
  .vc-btn:hover { background: var(--bg-hover, #4f545c); }
  .vc-btn.active { background: var(--brand, #5865f2); color: #fff; }
  .vc-btn-danger:hover { background: var(--danger, #ed4245); }

  .voice-peers {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 8px;
    padding: 12px;
    overflow-y: auto;
  }

  .voice-peer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    width: 80px;
  }
  .voice-peer-video-wrap {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--bg-3, #202225);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .voice-peer-big-avatar {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 18px;
    color: #fff;
  }
  .voice-peer-name {
    font-size: 11px;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 80px;
    color: var(--text-muted, #72767d);
  }
  .voice-peer-icons { font-size: 11px; }
  .peer-sharing-badge {
    background: var(--brand, #5865f2);
    color: #fff;
    border-radius: 3px;
    padding: 0 4px;
    font-size: 10px;
  }

  .sfu-video-grid {
    display: grid;
    gap: 4px;
    padding: 8px;
  }
  .sfu-tile {
    position: relative;
    background: #000;
    border-radius: 4px;
    overflow: hidden;
    aspect-ratio: 16/9;
  }
  .sfu-tile video { width: 100%; height: 100%; object-fit: cover; }
  .sfu-tile-name {
    position: absolute;
    bottom: 4px;
    left: 4px;
    font-size: 11px;
    background: rgba(0,0,0,.6);
    color: #fff;
    border-radius: 3px;
    padding: 1px 5px;
  }
  .sfu-tile-screen { border: 2px solid var(--brand, #5865f2); }

  .screen-share-view {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: #000;
    display: flex;
    flex-direction: column;
  }
  .screen-share-view.ss-mini {
    position: fixed;
    right: 16px; bottom: 16px;
    width: 320px; height: 240px;
    border-radius: 8px;
    overflow: hidden;
  }
  .ss-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: rgba(0,0,0,.7);
    color: #fff;
    font-size: 13px;
  }
  .ss-local-badge {
    background: var(--brand, #5865f2);
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 11px;
  }
  .ss-quality-label {
    background: var(--bg-3, #202225);
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 11px;
  }
  .ss-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,.6);
    color: #fff;
    font-size: 16px;
    z-index: 2;
  }
  .ss-video-wrap { flex: 1; overflow: hidden; }
  .ss-video-wrap video { width: 100%; height: 100%; object-fit: contain; }
  .ss-controls {
    display: flex;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(0,0,0,.7);
  }
  .ss-thumbnails {
    display: none;
    gap: 6px;
    padding: 6px 12px;
    overflow-x: auto;
    background: rgba(0,0,0,.5);
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 2000;
    background: rgba(0,0,0,.6);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .modal-card { background: var(--bg-2, #2f3136); border-radius: 8px; padding: 20px; }
  .ss-quality-card { min-width: 280px; }
  .ss-quality-options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 12px 0;
  }
  .ss-quality-btn {
    padding: 8px;
    border-radius: 4px;
    background: var(--bg-3, #202225);
    border: 1px solid var(--border, #40444b);
    color: var(--text, #dcddde);
    cursor: pointer;
    font-size: 13px;
  }
  .ss-quality-btn:hover { background: var(--brand, #5865f2); color: #fff; }
  .ss-quality-opts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
    font-size: 13px;
  }

  .ptt-status {
    font-size: 12px;
    color: var(--text-muted, #72767d);
    padding: 4px 12px;
  }
</style>
