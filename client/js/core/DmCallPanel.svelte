<!-- client/js/core/DmCallPanel.svelte -->
<!--
  FAZ 8/1 — DM ARAMA: SINYALLESME SUNUCU SOZLESMESINE HIZALANDI.

  ════════════════════════════════════════════════════════════════════════════
  KAPATILAN GERCEK KUSUR
  ════════════════════════════════════════════════════════════════════════════
  Bu panel gercek bir uygulamaydi ama sunucununkinden FARKLI bir protokol
  konusuyordu; baglanmasi imkansizdi. Arama CALARDI, asla BAGLANMAZDI:

    · `callId`i istemci uyduruyordu — sunucu kendi uuid'sini uretir ve
      `dm:call:outgoing` ile bildirir. Uydurma kimlik `activeDmCalls`te
      bulunmadigi icin sonraki HER sinyal sessizce dusuyordu.
    · `dm:call:start` `{ targetUserId, offer }` gonderiyordu; sema
      `{ toUserId, type }` bekler ve teklifi AYRI `dm:call:offer` ile alir.
    · `dm:call:answer` `targetUserId` tasimiyordu → `signalPeer()` null.
    · Istemci `dm:call:answered` dinliyordu — sunucu boyle bir olay YAYMAZ.
    · `accept` / `decline` / `ready` / `missed` HIC ele alinmiyordu; kabul
      el sikismasi calismiyor, reddetme yolu bulunmuyordu.
    · Kabul yolunda `pendingOffer:<callId>` registry anahtari okunuyordu —
      o anahtari HICBIR YER yazmiyordu.

  Protokol artik tek yerde: `dm-call/dm-call-protocol.ts`. WebRTC ve arayuz
  burada kalir; alan adlari orada tutulur ki uc ayri cagri yerinde sessizce
  sapmasin.

  ── YETKI ────────────────────────────────────────────────────────────────
  Yetkilendirme SUNUCUDADIR (`callParticipant` / `signalPeer`). Bu panel
  hicbir denetimi atlamaz; yalnizca sunucunun bekledigi alanlari dogru
  doldurur.
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { safeServerUrl } from './globals.ts';
  import { createLogger } from './logger.js';
  import { focusTrap } from './a11y/focusTrap.ts';
  import {
    OUTBOUND, INBOUND,
    startPayload, callIdPayload, offerPayload, answerPayload, icePayload,
    parseIncoming, parseReady, parseOutgoing, parseAccepted, isForCall,
    type CallSession, type CallType, type CallRole,
  } from './dm-call/dm-call-protocol.ts';

  const log = createLogger('DmCallPanel');

  // ── State ──────────────────────────────────────────────────────────────────
  let callType      = $state<CallType | null>(null);
  let role          = $state<CallRole | null>(null);
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
      ringing: t('call_ringing', 'Çağrı bekleniyor…'),
      connecting: t('call_connecting', 'Bağlanıyor…'),
      active: durationFmt,
      ended: t('call_ended', 'Çağrı sonlandı'),
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
  let _endedResetTimer: ReturnType<typeof setTimeout> | null   = null;

  type IceConfig = { iceServers: RTCIceServer[]; iceTransportPolicy?: RTCIceTransportPolicy };
  let ICE: IceConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    iceTransportPolicy: 'all',
  };
  let _iceReady: Promise<void> | null = null;

  function ensureIceConfig(): Promise<void> {
    if (_iceReady) return _iceReady;
    _iceReady = (async () => {
      const apiFetch = BridgeRegistry.get<(url: string, opts?: RequestInit) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error('Canonical API client unavailable for RTC ICE config');
      const api = (globalThis as { BRIDGE_API?: string }).BRIDGE_API || location.origin;
      const response = await apiFetch(`${api}/api/rtc/ice-config`);
      if (!response.ok) throw new Error(`RTC ICE config unavailable (${response.status})`);
      const raw = await response.json() as { iceServers?: unknown; iceTransportPolicy?: unknown };
      if (!Array.isArray(raw.iceServers) || raw.iceServers.length === 0) throw new Error('RTC ICE config is malformed');
      ICE = {
        iceServers: raw.iceServers as RTCIceServer[],
        iceTransportPolicy: raw.iceTransportPolicy === 'relay' ? 'relay' : 'all',
      };
    })().catch((err) => {
      // Public STUN remains the compatibility fallback when the config endpoint
      // itself is unavailable. The server is authoritative for relay-only
      // policy whenever it can be reached.
      log.warn('DM call ICE config yüklenemedi; STUN fallback kullanılacak', err);
    });
    return _iceReady;
  }

  // ── Effects ────────────────────────────────────────────────────────────────
  $effect(() => {
    if (isActive) {
      _durationInterval = setInterval(() => { duration++; }, 1000);
    } else {
      if (_durationInterval) { clearInterval(_durationInterval); _durationInterval = null; }
    }
    return () => { if (_durationInterval) clearInterval(_durationInterval); };
  });

  // ── Oturum ────────────────────────────────────────────────────────────────
  //
  // Sunucu her sinyalde `callId` VE `targetUserId` ister. Ikisini tek yerde
  // tutmak, uc ayri emit yerinde birinin unutulmasini onler.
  let _session: CallSession | null = null;
  /** `ready` gelmeden once biriken ICE adaylari. */
  let _pendingIce: unknown[] = [];
  /** Teklif, uzak aciklama kurulmadan once gelirse burada bekler. */
  let _pendingOffer: RTCSessionDescriptionInit | null = null;

  function sock() { return BridgeRegistry.get<{ emit: Function; on: Function; off: Function }>('socket'); }

  function _setSession(next: CallSession | null): void {
    _session = next;
    callType     = next?.type ?? null;
    role         = next?.role ?? null;
  }

  // ── Gelen olaylar ─────────────────────────────────────────────────────────

  function _onIncoming(payload: unknown): void {
    const call = parseIncoming(payload);
    if (!call) return;
    // Zaten bir gorusmedeysek yeni cagriyi kabul etmeyiz; sunucu 30 sn sonra
    // `missed` yayar. Ikinci bir gorusme durumu kurmak, iki ayri WebRTC
    // baglantisinin ayni panelde carpismasi demekti.
    if (_session) return;

    _setSession({ callId: call.callId, peerUserId: call.callerId, type: call.type, role: 'callee' });
    const callerName = call.callerDisplayName || t('ui_unknown_user', 'Bilinmeyen kullanıcı');
    remoteUser = { username: callerName };
    callStatus = 'ringing';
    BridgeRegistry.call('toast', t('call_incoming_from', '{name} sizi arıyor…', { name: callerName }), 'info');
  }

  /** Sunucunun urettigi KANONIK `callId` — istemcininki degil. */
  function _onOutgoing(payload: unknown): void {
    const out = parseOutgoing(payload);
    if (!out || !_session || _session.role !== 'caller') return;
    _setSession({ ..._session, callId: out.callId });
    callStatus = 'ringing';
  }

  function _onAccepted(payload: unknown): void {
    const accepted = parseAccepted(payload);
    if (!accepted || !isForCall(_session, payload)) return;
    remoteUser = { username: accepted.calleeDisplayName || t('ui_unknown_user', 'Bilinmeyen kullanıcı') };
    callStatus = 'connecting';
  }

  /**
   * WebRTC BURADA baslar — once degil.
   *
   * Sunucu her iki tarafa da rolunu soyler; teklifi YALNIZCA `caller` uretir.
   * Eski istemci teklifi `start` ile gonderiyordu, yani karsi taraf daha
   * kabul etmeden.
   */
  async function _onReady(payload: unknown): Promise<void> {
    const ready = parseReady(payload);
    if (!ready || !isForCall(_session, payload)) return;
    callStatus = 'connecting';
    try {
      await _ensurePeer();
      if (ready.role === 'caller') {
        const offer = await _pc!.createOffer();
        await _pc!.setLocalDescription(offer);
        sock()?.emit(OUTBOUND.offer, offerPayload(_session!, offer));
      } else if (_pendingOffer) {
        // Teklif `ready`den once gelmis olabilir.
        await _acceptOffer(_pendingOffer);
        _pendingOffer = null;
      }
    } catch (err) {
      log.error('WebRTC kurulamadı', err);
      BridgeRegistry.call('toast', t("ui_arama_baglantisi_kurulamadi", "Arama bağlantısı kurulamadı"), 'error');
      hangUp();
    }
  }

  async function _onOffer(payload: unknown): Promise<void> {
    if (!isForCall(_session, payload)) return;
    const offer = (payload as { offer?: RTCSessionDescriptionInit }).offer;
    if (!offer) return;
    if (!_pc) { _pendingOffer = offer; return; }
    await _acceptOffer(offer);
  }

  async function _acceptOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    await _ensurePeer();
    await _pc!.setRemoteDescription(new RTCSessionDescription(offer));
    await _flushIce();
    const answer = await _pc!.createAnswer();
    await _pc!.setLocalDescription(answer);
    sock()?.emit(OUTBOUND.answer, answerPayload(_session!, answer));
  }

  async function _onAnswer(payload: unknown): Promise<void> {
    if (!isForCall(_session, payload) || !_pc) return;
    const answer = (payload as { answer?: RTCSessionDescriptionInit }).answer;
    if (!answer) return;
    await _pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(err => log.error('setRemote', err));
    await _flushIce();
  }

  async function _onIce(payload: unknown): Promise<void> {
    if (!isForCall(_session, payload)) return;
    const candidate = (payload as { candidate?: RTCIceCandidateInit }).candidate;
    if (!candidate) return;
    // Uzak aciklama yoksa aday EKLENEMEZ; atmak yerine biriktirilir.
    if (!_pc?.remoteDescription) { _pendingIce.push(candidate); return; }
    await _pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => log.warn('addIce', err));
  }

  async function _flushIce(): Promise<void> {
    if (!_pc?.remoteDescription) return;
    const queued = _pendingIce;
    _pendingIce = [];
    for (const candidate of queued) {
      await _pc.addIceCandidate(new RTCIceCandidate(candidate as RTCIceCandidateInit))
        .catch(err => log.warn('addIce(queued)', err));
    }
  }

  function _onDeclined(payload: unknown): void {
    if (!isForCall(_session, payload)) return;
    BridgeRegistry.call('toast', 'Arama reddedildi', 'info');
    _endLocally();
  }

  function _onMissed(payload: unknown): void {
    if (!isForCall(_session, payload)) return;
    BridgeRegistry.call('toast', t("ui_cevapsiz_arama", "Cevapsız arama"), 'info');
    _endLocally();
  }

  function _onEnded(payload: unknown): void {
    if (!isForCall(_session, payload)) return;
    _endLocally();
  }

  function _endLocally(): void {
    _cleanup();
    callStatus = 'ended';
    if (_endedResetTimer) clearTimeout(_endedResetTimer);
    _endedResetTimer = setTimeout(() => {
      _endedResetTimer = null;
      if (callStatus === 'ended') callStatus = 'idle';
    }, 1800);
  }

  // ── WebRTC ────────────────────────────────────────────────────────────────

  async function _ensurePeer(): Promise<void> {
    if (_pc) return;
    if (!_localStream) await _acquireMedia();
    await ensureIceConfig();

    _pc = new RTCPeerConnection(ICE);
    _localStream?.getTracks().forEach(t => _pc!.addTrack(t, _localStream!));

    _pc.ontrack = (ev) => {
      if (remoteVideo) remoteVideo.srcObject = ev.streams[0] ?? null;
      callStatus = 'active';
      duration = 0;
    };

    _pc.onicecandidate = (ev) => {
      if (!ev.candidate || !_session) return;
      sock()?.emit(OUTBOUND.ice, icePayload(_session, ev.candidate.toJSON()));
    };

    _pc.onconnectionstatechange = () => {
      if (_pc?.connectionState === 'connected') callStatus = 'active';
      // Baglanti KOPARSA sessiz kalinmaz; kullanici olu bir ekrana bakmamali.
      if (_pc?.connectionState === 'failed') {
        BridgeRegistry.call('toast', t("ui_arama_baglantisi_koptu", "Arama bağlantısı koptu"), 'warning');
        hangUp();
      }
    };
  }

  async function _acquireMedia(): Promise<void> {
    _localStream = await navigator.mediaDevices.getUserMedia({
      // Ses kisitlari kanonik ses yoluyla AYNI (webrtc.ts): yankı, gürültü ve
      // kazanç işlemleri istenir; tarayıcı uygulamayabilir.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: callType === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
    if (localVideo) localVideo.srcObject = _localStream;
  }

  // ── Eylemler ──────────────────────────────────────────────────────────────

  async function startCall(targetUserId: string, type: CallType = 'voice'): Promise<void> {
    if (_session) { BridgeRegistry.call('toast', t("ui_zaten_bir_aramadasiniz", "Zaten bir aramadasınız"), 'warning'); return; }
    if (!targetUserId) return;

    // `callId` SUNUCUDAN gelir (`dm:call:outgoing`); burada gecici bos birakilir.
    _setSession({ callId: '', peerUserId: targetUserId, type, role: 'caller' });
    callStatus = 'ringing';
    try {
      await _acquireMedia();
      sock()?.emit(OUTBOUND.start, startPayload(targetUserId, type));
    } catch (err) {
      log.error('Arama başlatılamadı', err);
      BridgeRegistry.call('toast', t("ui_mikrofona_erisilemedi_arama_baslatilamadi", "Mikrofona erişilemedi; arama başlatılamadı"), 'error');
      _cleanup();
      callStatus = 'idle';
    }
  }

  /** Kabul: sunucu el sikismayi baslatir ve iki tarafa `ready` yayar. */
  async function acceptCall(): Promise<void> {
    if (!_session || _session.role !== 'callee') return;
    callStatus = 'connecting';
    try {
      await _acquireMedia();
      sock()?.emit(OUTBOUND.accept, callIdPayload(_session.callId));
    } catch (err) {
      log.error('Arama kabul edilemedi', err);
      BridgeRegistry.call('toast', t("ui_mikrofona_erisilemedi", "Mikrofona erişilemedi"), 'error');
      declineCall();
    }
  }

  function declineCall(): void {
    if (!_session) return;
    sock()?.emit(OUTBOUND.decline, callIdPayload(_session.callId));
    _endLocally();
  }

  function hangUp(): void {
    if (_session?.callId) sock()?.emit(OUTBOUND.end, callIdPayload(_session.callId));
    _endLocally();
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
    if (_endedResetTimer) { clearTimeout(_endedResetTimer); _endedResetTimer = null; }
    _pendingIce = [];
    _pendingOffer = null;
    _setSession(null);
    duration = 0;
  }

  // ── Yasam dongusu ─────────────────────────────────────────────────────────
  //
  // Sunucunun YAYDIGI her olay dinlenir. Eski surum yalnizca dordunu
  // dinliyordu ve biri (`dm:call:answered`) hic yayilmayan bir addi.
  const HANDLERS: Array<[string, (p: unknown) => void]> = [
    [INBOUND.incoming, _onIncoming],
    [INBOUND.outgoing, _onOutgoing],
    [INBOUND.accepted, _onAccepted],
    [INBOUND.ready,    (p) => { void _onReady(p); }],
    [INBOUND.offer,    (p) => { void _onOffer(p); }],
    [INBOUND.answer,   (p) => { void _onAnswer(p); }],
    [INBOUND.ice,      (p) => { void _onIce(p); }],
    [INBOUND.declined, _onDeclined],
    [INBOUND.missed,   _onMissed],
    [INBOUND.ended,    _onEnded],
  ];

  let _bound: { on: Function; off: Function } | null = null;

  /** Socket yeniden baglanmada BASKA bir nesne olabilir. */
  function syncSocketBinding(): void {
    const socket = sock() ?? null;
    if (socket === _bound) return;
    for (const [event, handler] of HANDLERS) _bound?.off?.(event, handler);
    _bound = socket;
    for (const [event, handler] of HANDLERS) _bound?.on?.(event, handler);
  }

  onMount(() => {
    syncSocketBinding();
    document.addEventListener('bridge:socket-ready', syncSocketBinding);
    document.addEventListener('bridge:socket-reconnected', syncSocketBinding);

    BridgeRegistry.register('startDmCall', (uid: string, type?: CallType) => { void startCall(uid, type ?? 'voice'); });
    BridgeRegistry.register('acceptDmCall', () => { void acceptCall(); });
    BridgeRegistry.register('declineDmCall', declineCall);
    BridgeRegistry.register('hangUpDmCall', hangUp);
    BridgeRegistry.register('getDmCallStatus', () => ({ status: callStatus, role, type: callType }));
  });

  onDestroy(() => {
    for (const [event, handler] of HANDLERS) _bound?.off?.(event, handler);
    _bound = null;
    document.removeEventListener('bridge:socket-ready', syncSocketBinding);
    document.removeEventListener('bridge:socket-reconnected', syncSocketBinding);
    for (const key of ['startDmCall', 'acceptDmCall', 'declineDmCall', 'hangUpDmCall', 'getDmCallStatus']) {
      BridgeRegistry.unregister?.(key);
    }
    _cleanup();
  });

</script>

{#if isVisible}
<div id="dm-call-overlay" class="dm-call-overlay" role="dialog" aria-label={t('dmc_title', 'DM Araması')} aria-modal="true" use:focusTrap={{ active: isVisible, initialFocus: '.dm-btn-reject' }}>
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
          <img src={safeServerUrl(remoteUser.avatarUrl)} alt={remoteUser.username} />
        {:else}
          <div class="dm-call-avatar-fallback">{remoteUser?.username?.[0]?.toUpperCase() ?? '?'}</div>
        {/if}
      </div>
      <div class="dm-call-name">{remoteUser?.username ?? '…'}</div>
      <div class="dm-call-status" aria-live="polite">{statusLabel}</div>
    </div>
    {/if}

    <!-- Actions -->
    <div class="dm-call-actions" role="toolbar" aria-label={t('attr_arama_kontrolleri_a7291ba', "Arama kontrolleri")}>
      {#if callStatus === 'ringing' && role === 'callee'}
        <button class="dm-btn dm-btn-accept" onclick={() => void acceptCall()} aria-label={t('dmc_accept', 'Aramayı kabul et')} title={t('dmc_accept')}>
          📞
        </button>
        <!-- REDDETME kendi olayidir: `dm:call:decline` arayana `declined`
             yayar. Eskiden burada `hangUp` cagriliyordu; `dm:call:end` ise
             KURULMUS bir gorusmeyi kapatir ve henuz kabul edilmemis cagri
             icin arayan tarafta hicbir geri bildirim uretmezdi. -->
        <button class="dm-btn dm-btn-reject" onclick={declineCall} aria-label={t('dmc_reject', 'Aramayı reddet')} title={t('dmc_reject')}>
          📵
        </button>
      {:else if callStatus !== 'idle'}
        {#if callType === 'video'}
          <button class="dm-btn {isVideoOff ? 'dm-btn-off' : ''}" onclick={toggleVideo}
            aria-label={isVideoOff ? t("surface_videoyu_ac_aa8eb2") : t("surface_videoyu_kapat_796466")}
            aria-pressed={isVideoOff}
            title={isVideoOff ? t("surface_video_ac_770b22") : t("surface_video_kapat_7d732c")}>
            {isVideoOff ? '📵' : '📹'}
          </button>
          <button class="dm-btn {isScreenShare ? 'dm-btn-active' : ''}" onclick={toggleScreenShare}
            aria-label={isScreenShare ? t("vp_stop_share") : t("surface_ekran_paylas_bcad04")}
            aria-pressed={isScreenShare}
            title={t('vcb_screen_share', 'Ekran Paylaşımı')}>
            🖥️
          </button>
        {/if}
        <button class="dm-btn {isMuted ? 'dm-btn-off' : ''}" onclick={toggleMute}
          aria-label={isMuted ? t("surface_sesi_ac_3bbb7e") : t("surface_sesi_kapat_559649")}
          aria-pressed={isMuted}
          title={isMuted ? t("surface_mikrofon_ac_af2ff4") : t("surface_mikrofon_kapat_90c24f")}>
          {isMuted ? '🔇' : '🎤'}
        </button>
        <button class="dm-btn dm-btn-reject" onclick={hangUp} aria-label={t('dmc_end', 'Aramayı sonlandır')} title={t('close')}>
          📵
        </button>
      {/if}
    </div>

    <!-- Duration (active call) -->
    {#if isActive}
      <div class="dm-call-duration" aria-live="polite" aria-label={t('dmc_duration', 'Arama süresi')}>{durationFmt}</div>
    {/if}

  </div>
</div>
{/if}

<style>
.dm-call-overlay {
  position: fixed; inset: 0;
  background: color-mix(in srgb, var(--bg-0) 82%, transparent);
  display: flex; align-items: center; justify-content: center;
  padding: var(--space-4);
  /* Gelen/giden arama ortusu bir MODALDIR. Onceden `9999` sabitiydi ve
     tirmanma yarisinin parcasiydi (bkz. tests/z-index-scale.test.ts). */
  z-index: var(--layer-modal);
  backdrop-filter: blur(4px);
}
.dm-call-box {
  background: var(--bridge-surface, #1e2124);
  width: min(520px, 100%);
  max-height: calc(var(--bridge-visual-viewport-height, 100dvh) - (var(--space-4) * 2));
  overflow-y: auto;
  border-radius: var(--radius-modal);
  padding: 24px;
  min-width: 0;
  display: flex; flex-direction: column; align-items: center; gap: 16px;
  box-shadow: var(--shadow-xl);
}
.dm-call-video-wrap { position: relative; width: 100%; border-radius: 12px; overflow: hidden; }
.dm-call-remote-video { width: 100%; aspect-ratio: 16/9; background: var(--surface-video); }
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
  font-size: 2rem; color: var(--text-on-solid); font-weight: 700;
}
.dm-call-name  { font-size: 1.2rem; font-weight: 600; color: var(--bridge-text, #fff); }
.dm-call-status { font-size: .875rem; color: var(--bridge-muted, #8a91ad); }
.dm-call-actions { display: flex; gap: 12px; }
.dm-btn {
  width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
  font-size: 1.4rem; display: flex; align-items: center; justify-content: center;
  background: var(--bridge-surface2, #232636); transition: background .15s, transform .1s;
}
.dm-btn:hover  { background: var(--bridge-surface3, #2c3048); transform: scale(1.05); }
.dm-btn-accept { background: var(--success); }
.dm-btn-accept:hover { background: var(--success-hover); }
.dm-btn-reject { background: var(--danger); }
.dm-btn-reject:hover { background: var(--danger-hover); }
.dm-btn-off    { background: var(--bridge-danger, #e05260); }
.dm-btn-active { background: var(--bridge-blue, #2d9cdb); }
.dm-call-duration { font-size: .8rem; color: var(--bridge-muted, #8a91ad); letter-spacing: .05em; }

@media (max-width: 560px) {
  .dm-call-overlay { padding: 0; align-items: flex-end; }
  .dm-call-box {
    width: 100%;
    max-height: min(90dvh, var(--bridge-visual-viewport-height, 90dvh));
    padding: 22px 18px calc(22px + env(safe-area-inset-bottom));
    border-right: 0; border-bottom: 0; border-left: 0;
    border-radius: var(--radius-modal) var(--radius-modal) 0 0;
  }
  .dm-call-video-wrap { max-height: 46dvh; }
  .dm-call-actions { flex-wrap: wrap; justify-content: center; }
  .dm-btn { width: 56px; height: 56px; }
}
@media (prefers-reduced-motion: reduce) { .dm-btn { transition: none; } .dm-btn:hover { transform: none; } }
</style>
