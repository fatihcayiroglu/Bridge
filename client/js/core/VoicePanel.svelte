<!-- client/js/core/VoicePanel.svelte -->
<!-- ADR-0008 Faz 2 — voice.ts (~670 satır) → Svelte bileşeni            -->
<!-- Karmaşık state (mute/deafen/video/screenshare/peer listesi/PTT)      -->
<!-- Svelte 5 Runes API, BridgeRegistry üzerinden vanilla servisle köprü  -->
<!-- Sprint 113                                                            -->

<script lang="ts">
  import { avatarStyleFromResolved } from './avatar-color.ts';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { setSrcObject, remoteAudio } from './voice-actions.js';
  import { getRtc }         from './globals.js';
  // KANONIK i18n. Bu yuzeydeki metinler INGILIZCE sabit kodlanmisti ve
  // Turkce arayuzde oldugu gibi gorunuyordu (kullanici tarafindan bildirildi).
  import { t } from './i18n/reactive.svelte.ts';
  import {
    collectConnectionQuality, unknownConnectionQuality,
    type VoiceConnectionQuality, type ConnectionQuality,
  } from './voice-connection-quality.ts';
  // Sprint 120: VoicePanel refactor — PTT ve ScreenShare controller'ları
  import VoicePTTController from './VoicePTTController.svelte';
  import VoiceScreenShareController from './VoiceScreenShareController.svelte';


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
    /** Faz K2 — GERCEK ses genliginden olculur (voice-activity-detector.ts). */
    speaking?: boolean;
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
  let remoteAudioStreams = $state<Map<string, MediaStream>>(new Map());
  /**
   * User-id -> local playback volume (0..1). This preference is intentionally
   * device-local: it changes only how loudly *this* user hears a peer and is
   * never sent to the server.
   */
  let peerVolumes = $state<Map<string, number>>(new Map());
  let inVoice = $state(false);

  const PEER_VOLUME_PREFIX = 'bridge:voice-peer-volume:';

  function clampPeerVolume(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.min(1, Math.max(0, value));
  }

  function storedPeerVolume(userId: string): number {
    const cached = peerVolumes.get(userId);
    if (cached !== undefined) return cached;
    try {
      const raw = localStorage.getItem(`${PEER_VOLUME_PREFIX}${userId}`);
      if (raw === null) return 1;
      return clampPeerVolume(Number(raw));
    } catch {
      return 1;
    }
  }

  function setPeerVolume(userId: string, value: number): void {
    const next = clampPeerVolume(value);
    peerVolumes = new Map(peerVolumes).set(userId, next);
    try { localStorage.setItem(`${PEER_VOLUME_PREFIX}${userId}`, String(next)); } catch { /* best effort */ }
  }

  function baseAudioSocketId(key: string): string {
    return key.endsWith('::screen-audio') ? key.slice(0, -'::screen-audio'.length) : key;
  }

  function peerForSocket(socketId: string): PeerInfo | undefined {
    const base = baseAudioSocketId(socketId);
    return peers.get(base) ?? [...voiceChannelPeers().values()].find(peer => peer.socketId === base);
  }

  function playbackVolumeForSocket(socketId: string): number {
    const peer = peerForSocket(socketId);
    return peer?.id ? storedPeerVolume(peer.id) : 1;
  }

  // ── FAZ K/2 — CANLI BAĞLANTI KALİTESİ ────────────────────────────────────
  //
  // Başlıkta yalnızca ikili bir "Connected / Disconnected" vardı. Bağlı olmak
  // ile duyulabilir olmak aynı şey değildir: %8 paket kaybıyla da bağlantı
  // "connected" görünür. `collectConnectionQuality` gerçek `getStats()`
  // ölçümlerini zaten üretiyordu ama HİÇBİR yüzeyde çizilmiyordu.
  //
  // Ölçüm yalnızca ses odasındayken alınır; ayrılınca zamanlayıcı durur.
  let quality = $state<VoiceConnectionQuality>(unknownConnectionQuality());
  let qualityTimer: ReturnType<typeof setInterval> | null = null;
  let qualitySeq = 0;

  const QUALITY_TEXT: Record<ConnectionQuality, string> = $derived.by(() => ({
    excellent: t('voice_quality_excellent', 'Mükemmel'),
    good: t('voice_quality_good', 'İyi'),
    poor: t('voice_quality_poor', 'Zayıf'),
    unknown: t('ui_olculemiyor', 'Ölçülemiyor'),
  }));

  /** Ekran okuyucu ve tooltip için sayısal özet; ölçülemeyen değer uydurulmaz. */
  let qualityDetail = $derived.by(() => {
    const parts: string[] = [];
    if (quality.latencyMs !== null) parts.push(t('voice_latency', 'gecikme {value} ms', { value: quality.latencyMs }));
    if (quality.jitterMs !== null) parts.push(`jitter ${quality.jitterMs} ms`);
    if (quality.packetLossPercent !== null) parts.push(t('voice_packet_loss', 'paket kaybı %{value}', { value: quality.packetLossPercent }));
    return parts.length ? parts.join(', ') : t("ui_olcum_alinamiyor", "ölçüm alınamıyor");
  });

  function peerConnections(): RTCPeerConnection[] {
    const owner = rtc() as { peers?: Map<unknown, RTCPeerConnection> } | null;
    return owner?.peers ? [...owner.peers.values()] : [];
  }

  async function sampleQuality(): Promise<void> {
    const seq = ++qualitySeq;
    const connections = peerConnections();
    if (!connections.length) { quality = unknownConnectionQuality(); return; }
    try {
      const next = await collectConnectionQuality(connections);
      if (seq === qualitySeq) quality = next;
    } catch {
      // Ölçüm alınamadıysa "iyi" varsayılmaz — bilinmiyor olarak kalır.
      if (seq === qualitySeq) quality = unknownConnectionQuality();
    }
  }

  function startQualityPolling(): void {
    if (qualityTimer) return;
    void sampleQuality();
    qualityTimer = setInterval(() => { if (inVoice) void sampleQuality(); }, 4_000);
  }

  function stopQualityPolling(): void {
    if (qualityTimer) clearInterval(qualityTimer);
    qualityTimer = null;
    qualitySeq += 1;
    quality = unknownConnectionQuality();
  }

  $effect(() => {
    if (inVoice) startQualityPolling();
    else stopQualityPolling();
  });

  let showScreenShareView = $state(false);
  let ssChannelName       = $state('');
  let sharerName          = $state('');
  let localScreenStream   = $state<MediaStream | null>(null);
  let remoteScreenStream  = $state<MediaStream | null>(null);
  /**
   * socketId -> goruntu tasiyan son uzak akis.
   *
   * `voice:peer-state` (screensharing) track'ten SONRA gelebilir; o an akisa
   * yeniden ulasmak icin saklanir. Ses yolunun sahibi ayridir
   * (`remoteAudioStreams`) — bu harita YALNIZCA goruntu icindir.
   */
  let remoteVideoStreams = $state<Map<string, MediaStream>>(new Map());
  /** Ekrani PAYLASAN katilimcinin soket kimligi — temizlikte sahiplik denetimi. */
  let screenSharerSocketId = $state<string | null>(null);
  let ssMiniMode          = $state(false);
  let ssLoadingVisible    = $state(false);
  let ssStopVisible       = $state(false);
  let ssShareVisible      = $state(true);
  let ssLocalBadge        = $state(false);
  let ssQualityLabel      = $state('');
  let qualityModalOpen    = $state(false);
  let qualityModalEl = $state<HTMLDivElement | null>(null);
  let qualityReturnFocus: HTMLElement | null = null;

  $effect(() => {
    if (!qualityModalOpen || !qualityModalEl) return;
    const modal = qualityModalEl;
    queueMicrotask(() => modal.querySelector<HTMLElement>('button, input')?.focus());
  });

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


  function cssColor(c: string): string {
    return (BridgeRegistry.get('cssColor') as (c: string) => string | undefined)?.(c) ?? c;
  }

  function initials(name: string): string {
    return (BridgeRegistry.get('initials') as (n: string) => string | undefined)?.(name)
      ?? name.slice(0, 2).toUpperCase();
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
    const wasMuted = muted;
    r.setDeafened(!r.deafened);
    deafened = r.deafened;
    // Deafening can mute the canonical RTC instance as a side-effect. Mirror
    // that truth so both the panel and compact shell controls stay honest.
    muted = r.muted;
    document.dispatchEvent(new CustomEvent('bridge:voice-deafen-changed', { detail: { deafened } }));
    if (muted !== wasMuted) {
      document.dispatchEvent(new CustomEvent('bridge:voice-mute-changed', { detail: { muted } }));
    }
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

  function openSoundboard(): void {
    BridgeRegistry.call('openSoundboard');
  }

  let locallySuppressedSoundboardUsers = $state<Set<string>>(new Set());

  function isSoundboardUserSuppressed(userId: string): boolean {
    return locallySuppressedSoundboardUsers.has(userId)
      || BridgeRegistry.call<boolean>('isSoundboardUserSuppressed', userId) === true;
  }

  function toggleSoundboardUserSuppression(userId: string): void {
    if (!userId) return;
    const suppressed = !isSoundboardUserSuppressed(userId);
    BridgeRegistry.call('setSoundboardUserSuppressed', userId, suppressed);
    const next = new Set(locallySuppressedSoundboardUsers);
    if (suppressed) next.add(userId); else next.delete(userId);
    locallySuppressedSoundboardUsers = next;
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
    const label = peer?.displayName || userId || t('adm_user', 'Kullanıcı');
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
    const owner = rtc();
    screenSharing      = true;
    localScreenStream  = owner?.screenStream ?? null;
    showScreenShareView = true;
    ssLoadingVisible   = false;
    ssStopVisible      = true;
    ssShareVisible     = false;
    ssLocalBadge       = true;
    const channel = currentChannel();
    ssChannelName      = channel?.name ?? currentChannelName;
    sharerName         = '';
  }

  function _onSSShareStopped(): void {
    screenSharing    = false;
    localScreenStream = null;
    ssStopVisible    = false;
    ssShareVisible   = true;
    ssLoadingVisible = false;
    ssLocalBadge     = false;
    ssQualityLabel   = '';
    ssMiniMode       = false;
    // A local share owns the full-screen view only while it is active. Keep a
    // concurrently viewed remote share visible, but never leave a blank modal
    // layer after the local capture has stopped.
    if (!remoteScreenStream) showScreenShareView = false;
  }

  export function toggleScreenShare(): void             {
    if (!screenSharing) qualityReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ssController?.toggle();
  }
  export function openScreenShareQualityPicker(): void  {
    qualityReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ssController?.openQualityPicker();
  }
  export async function startScreenShareWithQuality(quality: string): Promise<void> {
    qualityReturnFocus = null;
    ssQualityLabel = quality;
    // Browser capture may remain pending while the user chooses a window or
    // grants permission. The loading surface already existed, but was never
    // activated, so the quality modal disappeared with no visible progress.
    showScreenShareView = true;
    ssLoadingVisible = true;
    ssStopVisible = false;
    ssShareVisible = false;
    try {
      await ssController?.startWithQuality(quality);
    } finally {
      ssLoadingVisible = false;
      // The controller invokes `_onSSShareStarted` only after a successful
      // capture. A denial (or missing controller during teardown) must restore
      // a usable view instead of leaving an empty screen-share layer behind.
      if (!screenSharing) {
        ssShareVisible = true;
        showScreenShareView = Boolean(remoteScreenStream);
      }
    }
  }
  export function stopMyScreenShare(): void             { ssController?.stopShare(); }
  export function toggleSSFullscreen(): void            { ssController?.toggleFullscreen(); }
  export function toggleSSMiniMode(): void              {
    ssMiniMode = !ssMiniMode;
    ssController?.toggleMini();
  }

  // ── Leave Voice ───────────────────────────────────────────────────────────

  export function leaveVoice(): void {
    BridgeRegistry.get<{ clearSession?(): void }>('BridgeVoiceE2E')?.clearSession?.();
    BridgeRegistry.get('_bridgeStopLocalVAD')?.();
    sfuClearAllVideoTiles();
    rtc()?.leaveVoice();
    voiceChannelPeers().clear();
    remoteAudioStreams = new Map();
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
    const audio = new Map(remoteAudioStreams);
    audio.delete(socketId);
    remoteAudioStreams = audio;
    if (remoteVideoStreams.has(socketId)) {
      const vids = new Map(remoteVideoStreams);
      vids.delete(socketId);
      remoteVideoStreams = vids;
    }
    sfuRemoveVideoTile(`${socketId}-video`);
    sfuRemoveVideoTile(`${socketId}-screen`);
    // Paylasirken AYRILDIYSA da kare donup kalmamali.
    clearRemoteScreen(socketId);
  }

  export function updatePeerState(socketId: string, state: PeerState): void {
    peerStates = new Map(peerStates).set(socketId, state);

    // SIRALAMA: `voice:peer-state` track'ten ONCE de SONRA da gelebilir.
    // Sonra geldiginde `attachRemoteStream` paylasimi anlayamamis olur; bu
    // yuzden sakli akis burada yukseltilir. Aksi halde izleyici goruntuyu
    // ALIR ama HIC GORMEZ.
    if (state.screensharing === true && screenSharerSocketId !== socketId) {
      const stored = remoteVideoStreams.get(socketId);
      if (stored) showRemoteScreen(socketId, stored);
    }

    if (state.video === false) sfuRemoveVideoTile(`${socketId}-video`);
    if (state.screensharing === false) {
      sfuRemoveVideoTile(`${socketId}-screen`);
      clearRemoteScreen(socketId);
    }
  }

  /**
   * ════════════════════════════════════════════════════════════════════════
   * DONMUS EKRAN KARESI — UZAK PAYLASIM DURDUGUNDA TEMIZLIK
   * ════════════════════════════════════════════════════════════════════════
   * KAPATILAN GERCEK KUSUR: paylasan taraf durdurdugunda `webrtc.ts`
   * `sender.replaceTrack(null)` cagirir. Bu, alici tarafta YENI bir `ontrack`
   * URETMEZ; `<video>` elemani da son boyanan KAREYI ekranda tutar.
   *
   * `updatePeerState` yalnizca `sfuRemoveVideoTile(...)` cagiriyordu — o ise
   * SFU kutucugunu kaldirir. Ancak uretimde etkin yol P2P'dir (mediasoup
   * kapali) ve P2P gorunumu `remoteScreenStream` ile beslenir. O degisken
   * HICBIR YERDE sifirlanmiyordu.
   *
   * Sonuc: izleyici, paylasim bittikten SONRA donmus bir kareye bakmaya devam
   * ediyordu — Faz 2'nin adiyla "stuck remote frame".
   *
   * Ayni sey paylasirken AYRILAN kullanici icin de gecerlidir; bu yuzden
   * `removeVoicePeer` de burayi cagirir.
   */
  function clearRemoteScreen(socketId: string): void {
    // Paylasim SESI sahiplik kontrolunden ONCE sokulur: X'in paylasim sesini
    // kaldirmak, o an KIMIN goruntusunun gosterildiginden bagimsiz olarak
    // dogrudur. Asagidaki erken cikis yalnizca GORUNUMU korur; ses akisi
    // orada birakilirsa paylasim bittikten sonra da duyulmaya devam ederdi.
    const audioKey = `${socketId}${SCREEN_AUDIO_SUFFIX}`;
    if (remoteAudioStreams.has(audioKey)) {
      const next = new Map(remoteAudioStreams);
      next.delete(audioKey);
      remoteAudioStreams = next;
    }

    // Yalnizca GERCEKTEN o kisinin paylasimi gosteriliyorsa temizle: baska
    // biri paylasiyorken ucuncu bir kisinin durum guncellemesi ekrani
    // kapatmamalidir.
    if (screenSharerSocketId && screenSharerSocketId !== socketId) return;

    remoteScreenStream   = null;
    screenSharerSocketId = null;
    sharerName           = '';
    // Kendi paylasimimiz suruyorsa gorunum ACIK kalir.
    if (!localScreenStream) {
      showScreenShareView = false;
      ssStopVisible  = false;
      ssShareVisible = true;
    }
  }

  /**
   * Faz K2 — uzak katilimcinin konusma durumu.
   * Kaynak: sunucunun `voice:activity` yayini (yalniz gercek oda uyelerine).
   * Burada hicbir tahmin yapilmaz; gelen deger oldugu gibi yansitilir.
   */
  export function updatePeerSpeaking(socketId: string, speaking: boolean): void {
    const prev = peerStates.get(socketId) ?? {};
    if (prev.speaking === speaking) return;
    peerStates = new Map(peerStates).set(socketId, { ...prev, speaking });
  }

  /**
   * Paylasim sesi akis anahtari eki.
   *
   * Mikrofon akisi `socketId` ile, paylasim sesi `socketId + bu ek` ile
   * tutulur. AYNI haritada dururlar; boylece sagirlastirma (`muted={deafened}`)
   * ve hoparlor secimi (`use:remoteAudio`) ikisine de KENDILIGINDEN uygulanir —
   * ikinci bir ses sahibi YOKTUR.
   */
  const SCREEN_AUDIO_SUFFIX = '::screen-audio';

  export function attachRemoteStream(socketId: string, stream: MediaStream, kind?: string): void {
    if (stream.getAudioTracks().length > 0) {
      // ══════════════════════════════════════════════════════════════════
      // MIKROFONU EZME KORUMASI
      // ══════════════════════════════════════════════════════════════════
      // Bu harita yalnizca `socketId` ile anahtarlaniyordu. Paylasim sesi
      // eklendiginde ayni akrandan IKINCI bir ses akisi gelir; eski kod onu
      // ayni anahtara yazip MIKROFON akisini DUSURURDU — karsi tarafin sesi
      // tamamen kesilirdi.
      //
      // Ayirt edici: SFU yolu `kind` gecer ve o YETKILIDIR (paylasim turundeki
      // bir akisin sesi paylasim sesidir). P2P `kind` gecmez; orada mikrofon
      // akisi akran katildiginda kurulur ve ILK gelendir, sonradan gelen FARKLI
      // kimlikli ses akisi paylasim sesidir.
      const existing = remoteAudioStreams.get(socketId);
      const isScreenAudio = kind !== undefined
        ? kind === 'screen-audio' || kind === 'screen'
        : Boolean(existing) && existing!.id !== stream.id;
      const key = isScreenAudio ? `${socketId}${SCREEN_AUDIO_SUFFIX}` : socketId;
      remoteAudioStreams = new Map(remoteAudioStreams).set(key, stream);
    }

    // Görüntü taşıyan akış SAKLANIR: paylaşım durumu track'ten SONRA gelebilir
    // (aşağıya bakınız) ve o an akışa yeniden ulaşmak gerekir. SFU kamera
    // akışı (`kind === 'video'`) paylaşım adayı DEĞİLDİR: saklansaydı paylaşım
    // durumu geldiğinde kamera ekran görünümüne yükselirdi.
    if (stream.getVideoTracks().length > 0 && kind !== 'video') {
      remoteVideoStreams = new Map(remoteVideoStreams).set(socketId, stream);
    }

    // ══════════════════════════════════════════════════════════════════════
    // KAPATILAN GERÇEK KUSUR — UZAK EKRAN HİÇ GÖSTERİLMİYORDU
    // ══════════════════════════════════════════════════════════════════════
    // Ekran paylaşımı tespiti YALNIZCA track etiketine / `contentHint`e
    // bakıyordu. Bu değerler YEREL yakalamaya aittir ve AĞDAN GEÇMEZ: alıcıda
    // `track.label` boş, `contentHint` varsayılandır. `ontrack` da `kind`
    // argümanını GEÇMİYOR (webrtc.ts:878).
    //
    // Sonuç: `hasScreen` alıcıda HER ZAMAN false → `remoteScreenStream` hiç
    // atanmıyor → hiçbir `<video>` çizilmiyor.
    //
    // ÖLÇÜM (iki tarayıcı): izleyici 96 video karesi ÇÖZDÜ, 71920 bayt aldı —
    // ama sayfada SIFIR `<video>` elemanı vardı. Yani ekran paylaşımı
    // iletiliyor ama İZLENEMİYORDU.
    //
    // Doğru kaynak sunucunun yetkilendirdiği `voice:peer-state` yayınıdır
    // (`screensharing`). Yerel sezgiler KORUNUR (SFU yolu `kind` geçebilir),
    // fakat artık tek dayanak değildir.
    //
    // SFU yolu `kind` geçer ve o YETKİLİDİR: paylaşım sürerken açılan kamera
    // (`kind === 'video'`) ekran görünümünü DEVRALMAMALI.
    const peerSharing = peerStates.get(socketId)?.screensharing === true;
    const hasScreen = kind !== undefined ? kind === 'screen' : peerSharing || stream.getVideoTracks().some(t =>
      t.label.toLowerCase().includes('screen') ||
      t.label.toLowerCase().includes('window') ||
      t.label.toLowerCase().includes('tab') ||
      t.contentHint === 'detail',
    );

    if (hasScreen) showRemoteScreen(socketId, stream);
  }

  /**
   * Uzak ekranı göster — TEK giriş noktası.
   *
   * Hem `ontrack` hem de `voice:peer-state` bu yolu kullanır; böylece iki
   * sıralamada da (önce track / önce durum) aynı sonuç oluşur.
   */
  function showRemoteScreen(socketId: string, stream: MediaStream): void {
    remoteScreenStream = stream;
    screenSharerSocketId = socketId;
    showScreenShareView = true;
    ssLocalBadge = false;
    ssQualityLabel = '';
    ssStopVisible  = false;
    ssShareVisible = true;
    const peer = [...voiceChannelPeers().values()].find(p => p.socketId === socketId);
    if (peer) sharerName = t('voice_shared_by', '— {name} paylaşıyor', { name: peer.displayName });
    sfuAddVideoTile(`${socketId}-screen`, stream, peer?.displayName ?? t('adm_user', 'Kullanıcı'), false, true);
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
      pinned: true,
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
  export function stopPttKeyCapture(): void              { pttController?.stopCapture(); }
  export function isPttCapturing(): boolean              { return pttController?.isCapturing() ?? false; }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  function _onFullscreenChange(): void {
    isFullscreen = Boolean(document.fullscreenElement);
  }

  // Medya oturumu kurtarılırken (ICE `failed`, soket kopması; P2: 3–30 sn,
  // en çok 90 sn) arama ekranda CANLI görünüyor ama medya akmıyordu; durum
  // satırı "Bağlı" demeye devam ediyordu. Motor olayları durumu taşır.
  let reconnecting = $state(false);
  function _onVoiceReconnecting(): void { if (inVoice) reconnecting = true; }
  function _onVoiceReconnected(): void { reconnecting = false; }

  // MEDIA-11: the SFU holds camera video while this downlink cannot carry it
  // next to the audio. Without a notice remote video simply froze.
  let videoHeld = $state(false);
  function _onVideoHeld(event: Event): void {
    videoHeld = inVoice && Boolean((event as CustomEvent<{ held?: unknown }>).detail?.held);
  }

  function _onVoiceJoined(): void {
    inVoice = true;
    reconnecting = false;
    videoHeld = false;
    muted = Boolean(rtc()?.muted);
    deafened = Boolean(rtc()?.deafened);
  }

  function getControlState(): { inVoice: boolean; muted: boolean; deafened: boolean } {
    return { inVoice, muted, deafened };
  }

  /** Engine-originated state changes (device lost, session recovered). */
  function _onLocalState(event: Event): void {
    if (!inVoice) return;
    const detail = (event as CustomEvent<{ muted?: unknown; video?: unknown }>).detail ?? {};
    if (typeof detail.muted === 'boolean' && detail.muted !== muted) {
      muted = detail.muted;
      document.dispatchEvent(new CustomEvent('bridge:voice-mute-changed', { detail: { muted } }));
    }
    if (typeof detail.video === 'boolean' && detail.video !== videoOn) {
      videoOn = detail.video;
      if (!videoOn) sfuRemoveVideoTile('local');
    }
  }

  function _onVoiceLeft(): void {
    inVoice = false;
    reconnecting = false;
    videoHeld = false;
    remoteAudioStreams = new Map();
    peers = new Map();
    peerStates = new Map();
    sfuClearAllVideoTiles();
    muted = false;
    deafened = false;
    videoOn = false;
    screenSharing = false;
    showScreenShareView = false;
  }

  function _onChannelSelected(): void {
    const channel = currentChannel();
    currentChannelName = channel?.name ?? '';
    ssChannelName = channel?.name ?? '';
  }

  function rejoinSelectedVoice(): void {
    document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
  }

  function openVoiceCheck(): void {
    BridgeRegistry.get<() => void>('openVoiceCheck')?.();
  }

  // ── Klavye kısayolları (a11y — B1) ──────────────────────────────────────
  function _handleVoiceKeys(e: KeyboardEvent): void {
    if (!e.ctrlKey || !e.shiftKey) return;
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'M' || e.key === 'm') { e.preventDefault(); toggleMute(); }
    if (e.key === 'D' || e.key === 'd') { e.preventDefault(); toggleDeafen(); }
  }

  function closeQualityModal(): void {
    qualityModalOpen = false;
    const target = qualityReturnFocus;
    qualityReturnFocus = null;
    setTimeout(() => { if (target?.isConnected) target.focus(); }, 0);
  }

  function _handleQualityModalKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeQualityModal();
      return;
    }
    // FAZ E — TAB DALI KALDIRILDI; kanonik `use:focusTrap` sahiplenir.
    //
    // Buradaki kopya ayrıca DAHA ZAYIFTI: yalnız `button`/`input` sayıyordu,
    // yani `select` (kalite seçimi bir açılır listedir), `a[href]` ve
    // `[tabindex]` taşıyan öğeler tab sırasına HİÇ girmiyordu. Kanonik ilkel
    // tam odaklanabilir kümesini ve gizli/devre dışı elemeyi uygular.
    //
    // Escape burada KALIR: modalı kapatmak bu bileşenin sözleşmesidir.
  }

  onMount(() => {
    document.addEventListener('keydown', _handleVoiceKeys);
    document.addEventListener('fullscreenchange', _onFullscreenChange);
    document.addEventListener('bridge:voice-joined', _onVoiceJoined);
    document.addEventListener('bridge:voice-left', _onVoiceLeft);
    document.addEventListener('bridge:voice-reconnecting', _onVoiceReconnecting);
    document.addEventListener('bridge:voice-video-held', _onVideoHeld);
    document.addEventListener('bridge:voice-reconnected', _onVoiceReconnected);
    document.addEventListener('bridge:voice-local-state', _onLocalState);
    document.addEventListener('bridge:channel-selected', _onChannelSelected);
    inVoice = Boolean(rtc()?.isInVoice());

    const ch = currentChannel();
    if (ch?.name) {
      currentChannelName = ch.name;
      ssChannelName = ch.name;
    }

    // BridgeRegistry'ye dışarıdan erişim için fonksiyonlar kaydet
    BridgeRegistry.register('voicePanel:toggleMute',          toggleMute);
    BridgeRegistry.register('voicePanel:toggleDeafen',        toggleDeafen);
    BridgeRegistry.register('voicePanel:getControlState',     getControlState);
    BridgeRegistry.register('voicePanel:toggleVideo',         toggleVideo);
    BridgeRegistry.register('voicePanel:toggleScreenShare',   toggleScreenShare);
    BridgeRegistry.register('voicePanel:openScreenShareQualityPicker', openScreenShareQualityPicker);
    BridgeRegistry.register('voicePanel:leaveVoice',          leaveVoice);
    BridgeRegistry.register('voicePanel:renderVoicePeer',     renderVoicePeer);
    BridgeRegistry.register('voicePanel:removeVoicePeer',     removeVoicePeer);
    BridgeRegistry.register('voicePanel:updatePeerState',     updatePeerState);
    BridgeRegistry.register('voicePanel:updatePeerSpeaking',  updatePeerSpeaking);
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
    // `setPttMode` zaten export ediliyordu ama KAYITLI DEGILDI: mod secimi
    // hicbir uretim arayuzunden ERISILEBILIR degildi.
    BridgeRegistry.register('voicePanel:setPttMode',          setPttMode);
    BridgeRegistry.register('voicePanel:setPttReleaseDelay',  setPttReleaseDelay);
    BridgeRegistry.register('voicePanel:stopPttKeyCapture',   stopPttKeyCapture);
    BridgeRegistry.register('voicePanel:isPttCapturing',      isPttCapturing);
    BridgeRegistry.register('voicePanel:startReply',          startReply);
    BridgeRegistry.register('voicePanel:pinMessage',          pinMessage);
  });

  onDestroy(() => {
    document.removeEventListener('keydown', _handleVoiceKeys);
    document.removeEventListener('fullscreenchange', _onFullscreenChange);
    document.removeEventListener('bridge:voice-joined', _onVoiceJoined);
    document.removeEventListener('bridge:voice-left', _onVoiceLeft);
    document.removeEventListener('bridge:voice-reconnecting', _onVoiceReconnecting);
    document.removeEventListener('bridge:voice-video-held', _onVideoHeld);
    document.removeEventListener('bridge:voice-reconnected', _onVoiceReconnected);
    document.removeEventListener('bridge:voice-local-state', _onLocalState);
    document.removeEventListener('bridge:channel-selected', _onChannelSelected);
    remoteAudioStreams = new Map();

    BridgeRegistry.unregister?.('voicePanel:toggleMute');
    BridgeRegistry.unregister?.('voicePanel:toggleDeafen');
    BridgeRegistry.unregister?.('voicePanel:getControlState');
    BridgeRegistry.unregister?.('voicePanel:toggleVideo');
    BridgeRegistry.unregister?.('voicePanel:toggleScreenShare');
    BridgeRegistry.unregister?.('voicePanel:openScreenShareQualityPicker');
    BridgeRegistry.unregister?.('voicePanel:leaveVoice');
    BridgeRegistry.unregister?.('voicePanel:renderVoicePeer');
    BridgeRegistry.unregister?.('voicePanel:removeVoicePeer');
    BridgeRegistry.unregister?.('voicePanel:updatePeerState');
    BridgeRegistry.unregister?.('voicePanel:updatePeerSpeaking');
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
    BridgeRegistry.unregister?.('voicePanel:setPttMode');
    BridgeRegistry.unregister?.('voicePanel:setPttReleaseDelay');
    BridgeRegistry.unregister?.('voicePanel:stopPttKeyCapture');
    BridgeRegistry.unregister?.('voicePanel:isPttCapturing');
    BridgeRegistry.unregister?.('voicePanel:startReply');
    BridgeRegistry.unregister?.('voicePanel:pinMessage');
    stopQualityPolling();
  });

  let isFullscreen = $state(Boolean(document.fullscreenElement));
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
<div id="voice-panel" class="voice-view">

  <header class="voice-stage-header">
    <div class="voice-stage-identity">
      <span class="voice-stage-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 8.5a10 10 0 0 1 14 0"/><path d="M8.2 11.7a5.5 5.5 0 0 1 7.6 0"/><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none"/>
        </svg>
      </span>
      <span class="voice-stage-copy">
        <span class="voice-stage-eyebrow">{t('voice_channel', 'Ses Kanalı')}</span>
        <strong>{currentChannelName || t('voice_channel')}</strong>
      </span>
    </div>
    <div class="voice-stage-actions">
      {#if BridgeRegistry.get('openVoiceCheck')}
        <button type="button" class="voice-check-trigger" onclick={openVoiceCheck}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h3l2-6 4 12 2-6h5"/></svg>
          {t('voice_check', 'Ses Kontrolü')}
        </button>
      {/if}
      <div
        class="voice-connection"
        class:connected={inVoice && !reconnecting}
        class:reconnecting={inVoice && reconnecting}
        role="status"
        aria-live="polite"
      >
        <span class="voice-connection-dot"></span>
        {inVoice
          ? (reconnecting ? t('voice_reconnecting', 'Yeniden bağlanıyor…') : t('voice_connected', 'Bağlı'))
          : t('voice_disconnected', 'Bağlı değil')}
      </div>
      {#if inVoice && videoHeld && !reconnecting}
        <div class="voice-video-held" role="status" aria-live="polite">
          {t('voice_video_held', 'Görüntü duraklatıldı: bağlantı zayıf, ses öncelikli')}
        </div>
      {/if}
      {#if inVoice}
        <!-- Renk TEK BAŞINA anlam taşımaz: rozet kaliteyi METİN olarak da yazar. -->
        <div
          class="voice-quality"
          data-quality={quality.quality}
          role="status"
          aria-live="polite"
          aria-label={t('voice_quality_aria', undefined, { quality: QUALITY_TEXT[quality.quality], detail: qualityDetail })}
          title={qualityDetail}
        >
          <span class="voice-quality-bars" aria-hidden="true"><i></i><i></i><i></i></span>
          {QUALITY_TEXT[quality.quality]}
        </div>
      {/if}
    </div>
  </header>

  <div class="voice-stage-content">
    {#if peers.size === 0 && sfuTiles.size === 0}
      <div class="voice-empty" class:voice-empty-disconnected={!inVoice}>
        <span class="voice-empty-orbit" aria-hidden="true">
          <span></span><span></span><span></span>
        </span>
        <strong>{inVoice ? t('voice_in_room', 'Ses odasındasınız') : t('voice_ready', 'Hazır olduğunuzda ses odasına katılın')}</strong>
        <p>{inVoice
          ? t('voice_alone_hint', 'Katılan diğer kişiler burada görünecek.')
          : t('voice_rejoin_hint', 'Bu ses oturumuna devam etmek için yeniden bağlanın.')}</p>
        {#if !inVoice}
          <button type="button" class="voice-rejoin" onclick={rejoinSelectedVoice}>{t('voice_rejoin', 'Yeniden katıl')}</button>
        {/if}
      </div>
    {/if}

    <!-- Peer Listesi -->
    <div id="voice-peers" class="voice-peers">
      {#each [...peers.entries()] as [key, peer] (key)}
        {@const st = peerStates.get(peer.socketId) ?? {}}
        {@const isLocal = key === 'local'}
        <div
          class="voice-peer"
          class:local={isLocal}
          class:speaking={st.speaking === true && st.muted !== true}
          id="vp-{key}"
          data-socket={peer.socketId ?? 'local'}
          data-speaking={st.speaking === true ? 'true' : 'false'}
        >
          <span class="vp-sr-only" aria-live="polite">
            {st.speaking === true && st.muted !== true ? `${peer.displayName} ${t('voice_speaking', 'konuşuyor')}` : ''}
          </span>
          <div class="voice-peer-video-wrap" id="vpw-{key}">
            <div class="voice-peer-avatar-center">
              <div
                class="voice-peer-big-avatar"
                style={avatarStyleFromResolved(cssColor(peer.avatarColor))}
              >
                {initials(peer.displayName)}
              </div>
            </div>
          </div>
          <div class="voice-peer-name">
            {peer.displayName}{isLocal ? ` (${t('voice_tile_you', 'Sen')})` : ''}
          </div>
          {#if !isLocal && peer.id}
            <label class="peer-volume" title={t('voice_peer_volume', 'Kişi ses seviyesi')}>
              <span>{t('voice_peer_volume_short', 'Ses')}</span>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={Math.round(storedPeerVolume(peer.id) * 100)}
                aria-label={`${peer.displayName} ${t('voice_peer_volume', 'Kişi ses seviyesi')}`}
                oninput={(event) => setPeerVolume(peer.id, Number((event.currentTarget as HTMLInputElement).value) / 100)}
              />
              <output>{Math.round(storedPeerVolume(peer.id) * 100)}%</output>
            </label>
          {/if}
          <div class="voice-peer-icons" id="vpi-{key}">
            {#if !isLocal && peer.id}
              <button
                type="button"
                class="peer-state-icon peer-soundboard-toggle"
                class:active={isSoundboardUserSuppressed(peer.id)}
                aria-pressed={isSoundboardUserSuppressed(peer.id)}
                aria-label={isSoundboardUserSuppressed(peer.id)
                  ? t('voice_soundboard_unsuppress', 'Bu kullanıcının soundboard seslerini aç')
                  : t('voice_soundboard_suppress', 'Bu kullanıcıdan gelen soundboard seslerini sustur')}
                title={isSoundboardUserSuppressed(peer.id)
                  ? t('voice_soundboard_unsuppress', 'Bu kullanıcının soundboard seslerini aç')
                  : t('voice_soundboard_suppress', 'Bu kullanıcıdan gelen soundboard seslerini sustur')}
                onclick={() => toggleSoundboardUserSuppression(peer.id)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15 9a4 4 0 0 1 0 6"/>{#if isSoundboardUserSuppressed(peer.id)}<path d="m4 4 16 16"/>{/if}</svg>
              </button>
            {/if}
            {#if st.muted}
              <span class="peer-muted-icon" aria-label={t('surface_mikrofon_kapal_7a9f4a')} title={t('surface_mikrofon_kapal_7a9f4a')}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16"/><path d="M9 9v3a3 3 0 0 0 4.6 2.5M15 10V6a3 3 0 0 0-5.7-1.3"/><path d="M5 10v2a7 7 0 0 0 11.2 5.6M19 10v2a7 7 0 0 1-.5 2.6M12 19v3"/></svg>
              </span>
            {/if}
            <!--
              KONUSMA ARTIK METIN ROZETI DEGIL.

              Once her katilimcinin yaninda "Konuşuyor" yazan bir cip vardi ve
              ayni bilgiyi zaten kutucugun HALKASI da veriyordu. Ustelik
              "Paylaşıyor" ve "Kamera" da metin cipiydi: tek kisilik bir
              kutucukta uc metin etiketi yan yana duruyordu. Sonuc, insanlarin
              degil DURUM ETIKETLERININ one ciktigi teknik bir gorunumdu.

              Gorsel sinyal halkadir (avatar + kutucuk). Ekran okuyucular icin
              bilgi KAYBOLMAZ: asagidaki gorunmez metin `aria-live` ile
              duyurulur. Paylasim/kamera ise ikonlara indirildi — sessize alma
              gostergesiyle ayni dil.
            -->
            {#if st.screensharing}
              <span class="peer-state-icon" aria-label={t('voice_badge_sharing', 'Paylaşıyor')} title={t('voice_badge_sharing', 'Paylaşıyor')}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
              </span>
            {/if}
            {#if st.video}
              <span class="peer-state-icon" aria-label={t('voice_badge_camera', 'Kamera')} title={t('voice_badge_camera', 'Kamera')}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m23 7-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
              </span>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    <!-- Remote audio playback has a concrete DOM owner. -->
    <div class="remote-audio-host" aria-hidden="true">
      {#each [...remoteAudioStreams.entries()] as [socketId, stream] (socketId)}
        <!-- svelte-ignore a11y_media_has_caption -->
        <!--
          `remoteAudio` hem akisi baglar hem SECILI hoparloru uygular.
          Yalnizca `setSrcObject` kullanilirken, hoparlor degistirildikten
          SONRA katilan kisinin sesi VARSAYILAN cihazdan cikiyordu.
        -->
        <audio
          autoplay
          class="remote-audio"
          data-socket={socketId}
          muted={deafened}
          volume={playbackVolumeForSocket(socketId)}
          use:remoteAudio={stream}
        ></audio>
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
            <!-- svelte-ignore a11y_media_has_caption -->
            <!--
              SES BU ELEMANDAN CIKMAZ — `muted` HER ZAMAN.

              ════════════════════════════════════════════════════════════════
              KAPATILAN GERCEK KUSUR: YANKI
              ════════════════════════════════════════════════════════════════
              `muted={tile.isLocal}` yalnizca YEREL kutucugu susturuyordu.
              Oysa `attachRemoteStream`, ses izi TASIYAN her uzak akisi ONCE
              `remoteAudioStreams`e (yani `<audio autoplay>` elemanina) koyar,
              SONRA ayni akisi ekran paylasimi/kamera kutucugu olarak buraya
              da verir. Sonuc: AYNI ses IKI elemandan, birkac milisaniye
              kaymayla calar — kullanicinin bildirdigi "belirgin yanki" tam
              olarak budur.

              Kural: uzak sesin TEK sahibi `.remote-audio` elemanidir. Video
              kutucuklari yalnizca goruntu cizer.
            -->
            <video
              autoplay
              playsinline
              muted
              use:setSrcObject={tile.stream}
            ></video>
            <div class="sfu-tile-name">
              {tile.isLocal ? `${t('voice_tile_you', 'Sen')} · ` : ''}{tile.isScreen ? `${t('voice_tile_screen', 'Ekran')} · ` : ''}{tile.label}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Canonical voice control dock -->
  <div class="vc-dock-wrap">
  <div class="vc-controls" role="toolbar" aria-label={t('attr_voice_channel_controls_99bc7f5', "Voice channel controls")}>
    <button
      id="vc-mute"
      class="vc-btn"
      class:active={muted}
      onclick={toggleMute}
      title={muted ? t("surface_sesi_ac_ctrl_shift_m_7f6dd2") : t("surface_sesi_kapat_ctrl_shift_m_379036")}
      aria-label={muted ? t("surface_mikrofonu_ac_b26660") : t("surface_mikrofonu_kapat_6f80da")}
      aria-pressed={muted}
      disabled={!inVoice}
    >
      {#if muted}
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16"/><path d="M9 9v3a3 3 0 0 0 4.6 2.5M15 10V6a3 3 0 0 0-5.7-1.3"/><path d="M5 10v2a7 7 0 0 0 11.2 5.6M19 10v2a7 7 0 0 1-.5 2.6M12 19v3"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 10.5V12a7 7 0 0 0 14 0v-1.5M12 19v3"/></svg>
      {/if}
      <span class="vc-label">{muted ? t('voice_unmute', 'Sesi Aç') : t('voice_mute', 'Sustur')}</span>
    </button>

    <button
      id="vc-deafen"
      class="vc-btn"
      class:active={deafened}
      onclick={toggleDeafen}
      title={deafened ? t("surface_dinlemeye_basla_ctrl_shift_d_fa0920") : t("surface_sag_rlas_ctrl_shift_d_de6cd8")}
      aria-label={deafened ? t("surface_sesi_ac_3bbb7e") : t("surface_sesi_kapat_559649")}
      aria-pressed={deafened}
      disabled={!inVoice}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13v-2a8 8 0 0 1 16 0v2"/><path d="M4 13h3v7H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 1-2ZM20 13h-3v7h2a2 2 0 0 0 2-2v-3a2 2 0 0 0-1-2Z"/>{#if deafened}<path d="m5 5 14 14"/>{/if}</svg>
      <span class="vc-label">{deafened ? t('voice_undeafen', 'Dinlemeyi Aç') : t('voice_deafen', 'Sesi Kes')}</span>
    </button>

    <button
      id="vc-video"
      class="vc-btn"
      class:active={videoOn}
      onclick={toggleVideo}
      title={videoOn ? t("surface_kameray_kapat_b02716") : t("surface_kameray_ac_1710fb")}
      aria-label={videoOn ? t("surface_kameray_kapat_5e08cf") : t("surface_kameray_ac_f03da3")}
      aria-pressed={videoOn}
      disabled={!inVoice}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3Z"/>{#if !videoOn}<path d="m4 4 16 16"/>{/if}</svg>
      <span class="vc-label">{t('voice_camera', 'Kamera')}</span>
    </button>

    <button
      id="vc-screen"
      class="vc-btn"
      class:active={screenSharing}
      onclick={toggleScreenShare}
      title={screenSharing ? t("tip_stop_share") : t("tip_screenshare")}
      aria-label={screenSharing ? t("vp_stop_share") : t("vp_share_screen")}
      aria-pressed={screenSharing}
      disabled={!inVoice}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 16.5V21"/>{#if screenSharing}<path d="m9 10 2 2 4-4"/>{/if}</svg>
      <span class="vc-label">{t('voice_share', 'Paylaş')}</span>
    </button>

    <button
      id="vc-soundboard"
      class="vc-btn"
      onclick={openSoundboard}
      title={t('tip_soundboard', 'Soundboard')}
      aria-label={t('tip_soundboard', 'Soundboard')}
      disabled={!inVoice}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>
      <span class="vc-label">{t('soundboard', 'Ses Panosu')}</span>
    </button>

    <button
      class="vc-btn vc-btn-danger"
      onclick={leaveVoice}
      title={t('vp_leave_channel', 'Kanaldan Ayrıl')}
      aria-label={t('vp_leave_voice', 'Ses kanalından ayrıl')}
      disabled={!inVoice}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2a1.5 1.5 0 0 1 1.5-.36c1.1.36 2.3.55 3.5.55a1.5 1.5 0 0 1 1.5 1.5V20a2 2 0 0 1-2 2C10 22 2 14 2 4a2 2 0 0 1 2-2h3.1a1.5 1.5 0 0 1 1.5 1.5c0 1.2.19 2.4.55 3.5a1.5 1.5 0 0 1-.36 1.5Z"/><path d="m4 20 16-16"/></svg>
      <span class="vc-label">{t('voice_leave', 'Ayrıl')}</span>
    </button>
  </div>
  </div>
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
      {#if ssLocalBadge}<span id="ss-local-badge" class="ss-local-badge"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>{t('markup_yerel_455b595', "Yerel")}</span>{/if}
      {#if ssQualityLabel}<span id="ss-quality-label" class="ss-quality-label">{ssQualityLabel}</span>{/if}
    </div>

    {#if ssLoadingVisible}
      <div id="ss-loading" class="ss-loading">{t('vp_starting', 'Başlatılıyor…')}</div>
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
        <button id="ss-stop-btn" class="btn btn-danger" onclick={stopMyScreenShare} aria-label={t('vp_stop_share', t("vp_stop_share"))}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>{t('tip_stop_share')}
        </button>
      {/if}
      {#if ssShareVisible}
        <button id="ss-share-btn" class="btn" onclick={openScreenShareQualityPicker} aria-label={t('vp_share_screen', t("vp_share_screen"))}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>{t('voice_share')}
        </button>
      {/if}
      <button id="ss-mute-btn" class="btn" class:active={muted} onclick={toggleMute} aria-label={muted ? t("surface_mikrofonu_ac_b26660") : t("surface_mikrofonu_kapat_6f80da")} aria-pressed={muted}>
        {#if muted}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16"/><path d="M9 9v3a3 3 0 0 0 4.6 2.5M15 10V6a3 3 0 0 0-5.7-1.3"/><path d="M5 10v2a7 7 0 0 0 11.2 5.6M19 10v2a7 7 0 0 1-.5 2.6M12 19v3"/></svg>{:else}<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 10.5V12a7 7 0 0 0 14 0v-1.5M12 19v3"/></svg>{/if}
      </button>
      <button id="ss-deafen-btn" class="btn" class:active={deafened} onclick={toggleDeafen} aria-label={deafened ? t("surface_sesi_ac_3bbb7e") : t("surface_sesi_kapat_559649")} aria-pressed={deafened}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13v-2a8 8 0 0 1 16 0v2"/><path d="M4 13h3v7H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 1-2ZM20 13h-3v7h2a2 2 0 0 0 2-2v-3a2 2 0 0 0-1-2Z"/>{#if deafened}<path d="m5 5 14 14"/>{/if}</svg>
      </button>
      <button id="ss-fullscreen-btn" class="btn" onclick={toggleSSFullscreen} aria-label={isFullscreen ? t("surface_tam_ekrandan_c_k_5c1fca") : t('ui_tam_ekran')} aria-pressed={isFullscreen}>
        <svg viewBox="0 0 24 24" aria-hidden="true">{#if isFullscreen}<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>{:else}<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>{/if}</svg>
      </button>
      <button class="btn" onclick={toggleSSMiniMode} aria-label={ssMiniMode ? t("surface_tam_boyuta_don_f9b7a0") : t("surface_kucuk_moda_gec_0cfe03")} aria-pressed={ssMiniMode}>
        <svg viewBox="0 0 24 24" aria-hidden="true">{#if ssMiniMode}<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>{:else}<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M13 11h5v5"/>{/if}</svg>
      </button>
      <!--
        ══════════════════════════════════════════════════════════════════
        KANALDAN AYRILMA — PAYLASIM GORUNUMU KULLANICIYI HAPSEDEMEZ
        ══════════════════════════════════════════════════════════════════
        KAPATILAN GERCEK KUSUR (P1): `.screen-share-view` tam ekran sabit bir
        ortudur (`inset: 0; z-index: 1000`) ve bu cubukta AYRILMA kontrolu
        YOKTU. Kabuktaki "her zaman erisilebilir cikis" seridi de dahil olmak
        uzere TUM ayrilma dugmeleri bu ortunun ALTINDA kaliyordu.
        Olcum: `document.elementFromPoint` her ayrilma dugmesi icin
        `VIDEO` donduruyordu — yani paylasim baslatan kullanici sesli kanaldan
        TIKLAYARAK CIKAMIYORDU.

        Bu IKINCI bir sahip degildir: kanonik `leaveVoice` cagrilir — tipki
        mute/deafen'in hem kabukta hem panelde tetiklenebilmesi gibi.
      -->
      <button id="ss-leave-btn" class="btn btn-danger" onclick={leaveVoice} aria-label={t('vp_leave_voice', 'Ses kanalından ayrıl')}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg>
      </button>
    </div>

    <div id="ss-thumbnails" class="ss-thumbnails"></div>
  </div>
{/if}

<!-- ── Ekran Kalite Seçici Modal ───────────────────────────────────────── -->
{#if qualityModalOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    id="ss-quality-modal"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="ss-quality-title"
    tabindex="-1"
    bind:this={qualityModalEl}
    onclick={(event) => { if (event.target === event.currentTarget) closeQualityModal(); }}
    use:focusTrap
    onkeydown={_handleQualityModalKeydown}
  >
    <div class="modal-card ss-quality-card">
      <h3 id="ss-quality-title"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>{t('vp_share_quality', 'Ekran Paylaşımı Kalitesi')}</h3>
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
        <!--
          Sistem sesi opt-in'dir. Tarayici/OS secilen yuzey icin gercek bir
          audio track vermezse VoiceScreenShareController bunu basarili ses
          paylasimi saymaz. P2P ve SFU yollarinda mikrofon ile ekran sesi ayri
          track/producer olarak sahiplenilir; mikrofonun yerini almaz.
        -->
        <label>
          <input type="checkbox" id="ss-include-audio" />
          {t('markup_ses_dahil_c6295f4', "Ses Dahil")} <span class="ss-opt-note">{t('vp_audio_support_varies', '(tarayıcı ve paylaşılan yüzeye bağlı)')}</span>
        </label>
        <label>
          <input type="checkbox" id="ss-save-as-default" /> {t('markup_varsayilan_olarak_kaydet_32f2cf4', "Varsayılan Olarak Kaydet")}
        </label>
      </div>
      <button class="btn" onclick={closeQualityModal}>{t('vp_cancel', 'İptal')}</button>
    </div>
  </div>
{/if}

<!-- ── PTT Durumu (Settings'den gösterilir) ───────────────────────────── -->
<div id="ptt-live-status" class="ptt-status" style="display:none">
  {#if !pttStatus.enabled}
    {t("ui_disabled")}
  {:else if pttStatus.active}
    <span class="ptt-active"><span class="ptt-dot" aria-hidden="true"></span>{t('vp_live_mic_on', 'Yayında — mikrofon açık')}</span>
  {:else}
    <span class="ptt-paused-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M6 4v12M14 4v12"/></svg></span>{t('voice_ptt_waiting_key', undefined, { key: pttStatus.key?.label ?? '—' })}
  {/if}
</div>


<style>
/* FAZ K/2 — canlı bağlantı kalitesi rozeti. */
.voice-quality {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  padding: 5px 11px;
  font-size: var(--text-2xs);
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.voice-quality-bars { display: inline-flex; gap: 2px; align-items: flex-end; height: 11px; }
.voice-quality-bars i { width: 3px; background: currentColor; border-radius: 1px; opacity: .3; }
.voice-quality-bars i:nth-child(1) { height: 5px; }
.voice-quality-bars i:nth-child(2) { height: 8px; }
.voice-quality-bars i:nth-child(3) { height: 11px; }

.voice-quality[data-quality='poor']      { color: var(--danger); border-color: var(--danger); }
.voice-quality[data-quality='poor']      .voice-quality-bars i:nth-child(1) { opacity: 1; }
.voice-quality[data-quality='good']      { color: var(--yellow); border-color: var(--yellow); }
.voice-quality[data-quality='good']      .voice-quality-bars i:nth-child(-n+2) { opacity: 1; }
.voice-quality[data-quality='excellent'] { color: var(--green); border-color: var(--green); }
.voice-quality[data-quality='excellent'] .voice-quality-bars i { opacity: 1; }

  .voice-view {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    min-height: 0;
    height: 100%;
    background:
      radial-gradient(circle at 50% 10%, var(--brand-bg-low) 0, transparent 34%),
      var(--bg-2);
    color: var(--text-primary);
    overflow: hidden;
  }

  .voice-stage-header {
    min-height: 66px;
    padding: 10px clamp(14px, 2vw, 24px);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
  }
  .voice-stage-identity { min-width: 0; display: flex; align-items: center; gap: 11px; }
  .voice-stage-mark {
    width: 38px; height: 38px; flex: 0 0 38px;
    display: grid; place-items: center;
    border: 1px solid var(--brand-border);
    border-radius: var(--radius-surface);
    color: var(--brand);
    background: var(--brand-bg-low);
  }
  .voice-stage-mark svg { width: 21px; height: 21px; }
  .voice-stage-copy { min-width: 0; display: flex; flex-direction: column; }
  .voice-stage-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--type-title); letter-spacing: -.015em; }
  .voice-stage-eyebrow { color: var(--text-muted); font-size: var(--type-caption); font-weight: 730; letter-spacing: .08em; text-transform: uppercase; }
  .voice-stage-actions { flex: none; display: flex; align-items: center; gap: 8px; }
  .voice-check-trigger {
    min-height: 30px; padding: 0 10px;
    display: inline-flex; align-items: center; gap: 7px;
    color: var(--text-secondary); background: transparent;
    border: 1px solid var(--border); border-radius: var(--radius-control);
    font: 700 var(--type-label)/1 var(--font-sans); cursor: pointer;
  }
  .voice-check-trigger svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .voice-check-trigger:hover { color: var(--text-primary); background: var(--surface-hover); border-color: var(--border-strong); }
  .voice-check-trigger:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .voice-connection {
    flex: none; min-height: 28px; padding: 0 10px;
    display: inline-flex; align-items: center; gap: 7px;
    border: 1px solid var(--border); border-radius: var(--radius-pill);
    color: var(--text-muted); background: var(--bg-3);
    font-size: var(--type-label); font-weight: 650;
  }
  .voice-connection-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--status-offline); }
  .voice-connection.connected { color: var(--success-text, var(--green)); border-color: var(--green); background: var(--green-bg); }
  .voice-connection.connected .voice-connection-dot { background: var(--green); box-shadow: 0 0 0 3px var(--green-bg); }
  .voice-connection.reconnecting { color: var(--warning-text, var(--yellow)); border-color: var(--yellow); background: var(--yellow-bg); }
  .voice-video-held { font-size: 12px; color: var(--warning-text, var(--yellow)); }
  .voice-connection.reconnecting .voice-connection-dot { background: var(--yellow); box-shadow: 0 0 0 3px var(--yellow-bg); }

  .voice-stage-content {
    position: relative; flex: 1; min-height: 0;
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .voice-empty {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 32px; text-align: center; pointer-events: none;
  }
  .voice-empty > * { pointer-events: auto; }
  .voice-empty strong { margin-top: 20px; font-size: var(--type-heading); letter-spacing: -.02em; }
  .voice-empty p { max-width: 380px; margin-top: 5px; color: var(--text-muted); font-size: var(--type-body-sm); }
  .voice-empty-orbit { position: relative; width: 84px; height: 84px; border: 1px solid var(--brand-border); border-radius: 50%; background: var(--brand-bg-xlow); }
  .voice-empty-orbit::before, .voice-empty-orbit::after {
    content: ''; position: absolute; inset: 13px; border: 1px solid var(--border); border-radius: 50%;
  }
  .voice-empty-orbit::after { inset: 28px; background: var(--brand); border: 0; box-shadow: 0 0 24px var(--brand-glow); }
  .voice-empty-orbit span { position: absolute; width: 8px; height: 8px; border: 2px solid var(--bg-2); border-radius: 50%; background: var(--text-muted); }
  .voice-empty-orbit span:nth-child(1) { top: 6px; left: 38px; }
  .voice-empty-orbit span:nth-child(2) { right: 8px; bottom: 17px; }
  .voice-empty-orbit span:nth-child(3) { left: 8px; bottom: 17px; }
  .voice-empty-disconnected .voice-empty-orbit { filter: saturate(.35); opacity: .72; }
  .voice-rejoin {
    margin-top: 16px; min-height: 36px; padding: 0 14px;
    border: 1px solid var(--brand-border); border-radius: var(--radius-control);
    background: var(--brand); color: white; font: inherit; font-size: var(--type-body-sm); font-weight: 700; cursor: pointer;
    transition: background var(--duration-fast), transform var(--duration-fast);
  }
  .voice-rejoin:hover { background: var(--brand-hover); }
  .voice-rejoin:active { transform: translateY(1px); }

  .vc-dock-wrap {
    flex: none; padding: 0 16px 16px;
    display: flex; justify-content: center;
  }
  .vc-controls {
    min-height: 62px;
    display: flex; align-items: center; gap: 6px;
    padding: 7px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-surface);
    background: var(--bg-1);
    box-shadow: var(--shadow-md);
  }

  .vc-btn {
    min-width: 58px; min-height: 48px; padding: 5px 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    font: inherit;
    transition: background var(--duration-fast), color var(--duration-fast), border-color var(--duration-fast), transform var(--duration-fast);
  }
  .vc-btn svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .vc-label { font-size: 10px; font-weight: 650; line-height: 1; }
  .vc-btn:hover { background: var(--surface-hover, var(--bg-4)); color: var(--text-primary); }
  .vc-btn:active { transform: translateY(1px); }
  .vc-btn:disabled { cursor: not-allowed; opacity: .45; transform: none; }
  .vc-btn.active { border-color: var(--brand-border); background: var(--brand-subtle); color: var(--brand); }
  .vc-btn-danger { margin-left: 4px; color: var(--danger); background: var(--red-bg); }
  .vc-btn-danger:hover { background: var(--danger); color: white; }

  .remote-audio-host {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .voice-peers {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    align-content: start;
    gap: 10px;
    padding: clamp(16px, 2.5vw, 30px);
    overflow-y: auto;
  }

  .voice-peer {
    min-width: 0; min-height: 148px; padding: 16px 12px 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 7px;
    border: 1px solid var(--border);
    border-radius: var(--radius-surface);
    background: var(--bg-3);
    transition: border-color var(--duration-fast), background var(--duration-fast), transform var(--duration-fast);
  }
  .voice-peer:hover { border-color: var(--border-strong); background: var(--surface-hover, var(--bg-4)); transform: translateY(-1px); }
  .voice-peer.local { border-color: var(--brand-border); background: var(--brand-bg-xlow); }
  .voice-peer-video-wrap {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--bg-4);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 0 0 4px var(--bg-2);
  }
  .voice-peer-big-avatar {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 750;
    font-size: var(--type-heading);
    color: var(--text-on-solid);
  }
  .voice-peer-name {
    width: 100%;
    font-size: var(--type-body-sm);
    font-weight: 650;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-2);
  }
  .peer-volume { width: 100%; display: grid; grid-template-columns: auto minmax(48px, 1fr) 34px; align-items: center; gap: 6px; color: var(--text-muted); font-size: 10px; }
  .peer-volume input { width: 100%; min-width: 0; accent-color: var(--brand); cursor: pointer; }
  .peer-volume output { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-3); }
  .peer-volume:focus-within { color: var(--text-1); }
  .voice-peer-icons { min-height: 18px; display: flex; align-items: center; gap: 4px; color: var(--text-muted); font-size: var(--type-caption); }
  .peer-muted-icon { display: inline-grid; place-items: center; width: 18px; height: 18px; color: var(--danger); }
  .peer-muted-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  /* `.peer-sharing-badge` ve `.peer-video-badge` KALDIRILDI: metin cipleri
     ikonlara donustu (bkz. `.peer-state-icon`). Kullanilmayan secici
     birakmak, sonraki okuyucuya hala metin rozeti varmis izlenimi verirdi. */

  /* ── Faz K2 — GERCEK konusma gostergesi ────────────────────────────────
     Durum kaynagi: sunucunun `voice:activity` yayini; yerelde ise canli
     mikrofon genligi. Zamanlayici taklidi veya varsayilan durum YOKTUR.
     Susturulmus katilimci "konusuyor" gosterilmez — kart, kullanicinin
     duydugu gercekle celismemelidir.                                     */
  .voice-peer.speaking {
    border-color: var(--success);
    box-shadow: 0 0 0 1px var(--success) inset;
  }
  /* Ekran okuyucu metni — gorsel olarak gizli, erisilebilirlik agacinda VAR. */
  .vp-sr-only {
    position: absolute;
    width: 1px; height: 1px;
    margin: -1px; padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  /* Konusma halkasi AVATARIN kendisinde: sosyal sinyal insanin uzerinde
     olmalidir, kenarda bir etikette degil. */
  .voice-peer.speaking .voice-peer-big-avatar {
    box-shadow: 0 0 0 3px var(--success);
  }

  /* Durum ikonlari — sessize alma ikonuyla AYNI dil (metin cipi degil). */
  .peer-state-icon {
    display: inline-grid;
    place-items: center;
    width: 18px; height: 18px;
    color: var(--text-muted);
  }
  .peer-state-icon svg {
    width: 13px; height: 13px;
    fill: none; stroke: currentColor; stroke-width: 1.9;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .peer-soundboard-toggle {
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
  }
  .peer-soundboard-toggle:hover, .peer-soundboard-toggle:focus-visible { color: var(--text); background: var(--bg-hover); }
  .peer-soundboard-toggle:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
  .peer-soundboard-toggle.active { color: var(--danger); }
  /* Hareket hassasiyeti: halka statik kalir, yalnizca gecis yumusatilir. */
  @media (prefers-reduced-motion: no-preference) {
    .voice-peer { transition: border-color 120ms ease, box-shadow 120ms ease; }
  }

  .sfu-video-grid {
    display: grid;
    gap: 10px;
    padding: clamp(16px, 2.5vw, 30px);
    overflow-y: auto;
  }
  .sfu-tile {
    position: relative;
    background: var(--surface-video);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-surface);
    overflow: hidden;
    aspect-ratio: 16/9;
  }
  .sfu-tile video { width: 100%; height: 100%; object-fit: cover; }
  .sfu-tile-name {
    position: absolute;
    bottom: 8px; left: 8px;
    max-width: calc(100% - 16px);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: var(--type-caption);
    background: color-mix(in srgb, var(--bg-0) 76%, transparent);
    color: var(--text-primary);
    border: 1px solid color-mix(in srgb, var(--text-primary) 12%, transparent);
    border-radius: var(--radius-pill);
    padding: 3px 8px;
  }
  .sfu-tile-screen { border-color: var(--brand); }

  .screen-share-view {
    position: fixed;
    inset: 0;
    /* Adlandirilmis sahne katmani — sihirli sayi degil. */
    z-index: var(--z-stage);
    background: var(--bg-0);
    display: flex;
    flex-direction: column;
  }
  .screen-share-view.ss-mini {
    position: fixed;
    right: max(12px, env(safe-area-inset-right));
    bottom: max(12px, env(safe-area-inset-bottom));
    width: min(320px, calc(100vw - 24px));
    height: auto;
    max-height: calc(var(--bridge-visual-viewport-height, 100dvh) - 24px);
    aspect-ratio: 4 / 3;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-surface);
    box-shadow: var(--shadow-xl);
    overflow: hidden;
  }
  .ss-header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 48px;
    padding: 8px 14px;
    background: var(--surface-chrome);
    border-bottom: 1px solid var(--border);
    color: var(--text-primary);
    font-size: var(--type-body-sm);
  }
  .ss-local-badge {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--brand-bg);
    border: 1px solid var(--brand-border);
    color: var(--brand);
    border-radius: var(--radius-pill);
    padding: 2px 7px;
    font-size: var(--type-caption);
  }
  .ss-local-badge svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .ss-quality-label {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    padding: 2px 7px;
    font-size: var(--type-caption);
  }
  .ss-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--bg-0) 72%, transparent);
    color: var(--text-primary);
    font-size: var(--type-title);
    z-index: 2;
  }
  .ss-video-wrap { flex: 1; overflow: hidden; }
  .ss-video-wrap video { width: 100%; height: 100%; object-fit: contain; }
  .ss-controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 60px;
    padding: 8px 12px;
    background: var(--surface-chrome);
    border-top: 1px solid var(--border);
  }
  .ss-controls .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 40px; min-height: 40px; }
  .ss-controls .btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .ss-controls .btn.active { background: var(--brand-bg); border-color: var(--brand-border); color: var(--brand); }
  .ss-thumbnails {
    display: none;
    gap: 6px;
    padding: 6px 12px;
    overflow-x: auto;
    background: var(--surface-chrome);
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--layer-modal);
    padding: 16px;
    overflow: auto;
    background: color-mix(in srgb, var(--bg-0) 72%, transparent);
    backdrop-filter: blur(8px) saturate(110%);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .modal-card { background: var(--surface-overlay); border: 1px solid var(--border-strong); border-radius: var(--radius-modal); box-shadow: var(--shadow-xl); padding: var(--space-6); }
  /* Kalite secici SAHNENIN USTUNDE acilir; aksi halde paylasim gorunumu
     acikken hicbir kalite dugmesine tiklanamiyordu. */
  :global(#ss-quality-modal) { z-index: var(--z-stage-modal); }

  .ss-quality-card { width: min(420px, 100%); }
  .ss-quality-card h3 { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--text-primary); font-size: var(--type-heading); }
  .ss-quality-card h3 svg { width: 20px; height: 20px; fill: none; stroke: var(--brand); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .ss-quality-options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 12px 0;
  }
  .ss-quality-btn {
    padding: 8px;
    min-height: 42px;
    border-radius: var(--radius-control);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    color: var(--text-2);
    cursor: pointer;
    font-size: var(--type-body-sm);
    transition: background var(--duration-fast), border-color var(--duration-fast), color var(--duration-fast);
  }
  .ss-quality-btn:hover { background: var(--brand-bg); border-color: var(--brand-border); color: var(--text-primary); }
  .ss-quality-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .ss-quality-opts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
    color: var(--text-2);
    font-size: var(--type-body-sm);
  }

  .ptt-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--type-label);
    color: var(--text-muted);
    padding: 4px 12px;
  }
  .ptt-active { display: inline-flex; align-items: center; gap: 6px; color: var(--success); }
  .ptt-dot { width: 8px; height: 8px; border-radius: var(--radius-pill); background: var(--success); box-shadow: 0 0 0 3px var(--green-bg); }
  .ptt-paused-icon { display: inline-grid; place-items: center; width: 16px; height: 16px; }
  .ptt-paused-icon svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }

  @media (max-width: 720px) {
    .screen-share-view.ss-mini {
      bottom: calc(12px + env(safe-area-inset-bottom) + 60px);
      max-height: calc(var(--bridge-visual-viewport-height, 100dvh) - 84px - env(safe-area-inset-bottom));
    }
    :global(html.bridge-keyboard-open) .screen-share-view.ss-mini {
      bottom: max(12px, env(safe-area-inset-bottom));
      max-height: calc(var(--bridge-visual-viewport-height, 100dvh) - 24px);
    }
    .voice-stage-header { min-height: 58px; padding: 8px 12px; }
    .voice-stage-mark { width: 34px; height: 34px; flex-basis: 34px; }
    .voice-stage-eyebrow { display: none; }
    .voice-stage-copy strong { font-size: var(--type-title-sm); }
    .voice-check-trigger { width: 34px; padding: 0; justify-content: center; font-size: 0; }
    .voice-check-trigger svg { width: 17px; height: 17px; }
    .voice-connection { min-height: 26px; padding: 0 8px; font-size: var(--type-caption); }
    .voice-peers { grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); padding: 14px; }
    .voice-peer { min-height: 132px; }
    .peer-volume { min-height: 40px; grid-template-columns: auto minmax(56px, 1fr) 38px; }
    .peer-volume input { min-height: 32px; touch-action: manipulation; }
    .peer-volume output { min-width: 38px; }
    .vc-dock-wrap { padding: 0 8px 8px; }
    .vc-controls { width: 100%; justify-content: center; min-height: 56px; padding: 5px; }
    .vc-btn { flex: 1 1 0; min-width: 0; min-height: 44px; padding-inline: 4px; }
    .vc-btn-danger { margin-left: 0; }
  }

  @media (max-width: 480px) {
    .voice-connection { padding: 0 7px; }
    .voice-connection:not(.connected):not(.reconnecting) { max-width: 34px; overflow: hidden; color: transparent; gap: 0; }
    .voice-connection:not(.connected):not(.reconnecting) .voice-connection-dot { flex: none; }
    .vc-label { display: none; }
    .vc-btn { min-height: 42px; }
    .voice-empty { padding: 24px 18px; }
  }
</style>
