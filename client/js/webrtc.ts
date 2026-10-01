// client/js/webrtc.ts
// Bridge WebRTC Manager — P2P Voice, Video, Screen Share
// Sprint 33: window.* temizliği — BridgeRegistry + typed imports

import type { BridgeSocket } from './webrtc-base';
import { BridgeRegistry } from './core/bridge-registry.ts';
import { t } from './core/i18n/index';
// Faz 8.3: kanonik bildirim yolu. `app()?.toast` legacy `bridgeApp` global
// sözleşmesini arıyordu ve o anahtarı HİÇBİR ŞEY kaydetmiyor → tüm ses
// hataları sessizce yutuluyordu (mikrofon reddi dahil).
import { toast } from './core/utils.ts';
import { voicePanelAdapter, type VoicePanelAdapter } from './core/voice-panel-adapter.ts';
import { getAPI, currentServerChannels as _getServerChannels } from './core/globals.ts';
import { apiFetch } from './core/api-fetch.ts';
import { P2P_SCREEN_PRESETS as SCREEN_PRESETS, SCREEN_BITRATES, SCREEN_FPS, type ScreenQuality } from './core/rtc-screen-quality.ts';

import { createLogger } from './core/logger.ts';
import { micErrorMessage } from './core/mic-error.ts';
const log = createLogger('WebRTC');


// ── Domain types ──────────────────────────────────────────────────────────────
export interface PeerInfo {
  socketId: string;
  userId?: string;
  producers?: Array<{ producerId: string; kind: string }>;
}

interface PeerState {
  muted?: boolean;
  deafened?: boolean;
  screensharing?: boolean;
  video?: boolean;
}

interface IceConfig {
  iceServers: RTCIceServer[];
  // Sprint 120: I7 — FORCE_TURN sunucu yanıtından gelen iceTransportPolicy
  iceTransportPolicy?: RTCIceTransportPolicy;
}

// ── ICE configuration ─────────────────────────────────────────────────────────
let ICE_SERVERS: IceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
  iceTransportPolicy: 'all',
};

const iceConfigReady: Promise<void> = (async (): Promise<void> => {
  try {
    const API   = getAPI();
    const r = await apiFetch(`${API}/api/rtc/ice-config`);
    if (r.ok) {
      const cfg: IceConfig = await r.json();
      if (cfg?.iceServers?.length) {
        ICE_SERVERS = {
          iceServers: cfg.iceServers,
          iceTransportPolicy: cfg.iceTransportPolicy ?? 'all',
        };
        log.log('[WebRTC] ICE config yüklendi —', cfg.iceServers.length, 'sunucu, policy:', ICE_SERVERS.iceTransportPolicy);
      }
    }
  } catch { /* silent — Google STUN fallback */ }
})();

// A WebRTC `disconnected` state is often transient (Wi-Fi roam, brief mobile
// handoff, ICE pair re-check). Do not tear a participant down immediately.
const PEER_DISCONNECT_GRACE_MS = 8_000;
const MAX_ICE_RESTART_ATTEMPTS = 1;
const VOICE_JOIN_ACK_TIMEOUT_MS = 10_000;

// ── Typed registry accessors (window.* yerine) ────────────────────────────────
// Her modül kendi init() içinde BridgeRegistry.register() çağırır.
// webrtc.ts yalnızca tüketir — window'a dokunmaz.

interface BridgeNSModule {
  enabled?: boolean;
  process(stream: MediaStream): Promise<MediaStream>;
}
interface BridgeVoiceE2EModule {
  initVoiceE2E(channelId: string | null, peers: PeerInfo[]): Promise<boolean>;
  renderVoiceE2EBadge(): void;
  registerSocketEvents(socket: BridgeSocket, userId: string): void;
}
interface BridgeVideoQualityModule {
  getConstraints(): MediaTrackConstraints;
}
interface VoiceActivityUIModule {
  init(socket: BridgeSocket): void;
}
// Voice UI: the canonical adapter shared with the SFU engine (core/voice-panel-adapter.ts).
type BridgeAppModule = VoicePanelAdapter;

// Helper: registry'den null-safe al
function reg<T>(name: string): T | null {
  return BridgeRegistry.get<(...args: unknown[]) => unknown>(name) as T | null;
}

function app(): BridgeAppModule { return voicePanelAdapter; }

// Shared with the SFU path (core/mic-error.ts); re-exported for existing importers.
export { micErrorMessage };
function ns(): BridgeNSModule | null         { return reg<BridgeNSModule>('BridgeNS'); }
function voiceE2E(): BridgeVoiceE2EModule | null  { return reg<BridgeVoiceE2EModule>('BridgeVoiceE2E'); }
function videoQuality(): BridgeVideoQualityModule | null { return reg<BridgeVideoQualityModule>('BridgeVideoQuality'); }
function vauiMod(): VoiceActivityUIModule | null         { return reg<VoiceActivityUIModule>('VoiceActivityUI'); }
function startVAD(): ((stream: MediaStream, channelId: string) => void) | null {
  return reg<(stream: MediaStream, channelId: string) => void>('_bridgeStartLocalVAD');
}
function stopVAD(): (() => void) | null {
  return reg<() => void>('_bridgeStopLocalVAD');
}
// currentServerChannels — globals.ts'den direkt import edilir (registry gereksiz)

// ══════════════════════════════════════════════════════════════════════════════
// BridgeRTC — P2P WebRTC Manager
// ══════════════════════════════════════════════════════════════════════════════
class BridgeRTC {
  readonly socket: BridgeSocket;
  peers: Map<string, RTCPeerConnection>     = new Map();
  localStream: MediaStream | null           = null;
  screenStream: MediaStream | null          = null;
  currentChannelId: string | null           = null;
  currentServerId: string | null            = null;
  muted                                     = false;
  deafened                                  = false;
  /**
   * Paylasim sesi GERCEKTEN yakalandi mi?
   *
   * Kutu isaretli olmasi YETMEZ: tarayici/platform/secilen yuzey ses track'i
   * vermeyebilir. Arayuz bu bayragi okur, kullanicinin niyetini DEGIL.
   */
  screenAudioActive                         = false;
  private _screenAudioTrack: MediaStreamTrack | null = null;
  /** Akran -> paylasim sesi gondericisi. Cift ekleme ve sizinti korumasi. */
  private _screenAudioSenders = new Map<RTCPeerConnection, RTCRtpSender>();
  videoOn                                   = false;
  screenSharing                             = false;
  selectedMicId: string | null              = null;
  selectedCameraId: string | null           = null;
  selectedSpeakerId: string | null          = null;

  /**
   * ════════════════════════════════════════════════════════════════════════
   * SES ISLEME — UC AYRI ANAHTAR (eskiden TEK anahtar)
   * ════════════════════════════════════════════════════════════════════════
   * KAPATILAN GERCEK KUSUR: kisitlar `echoCancellation: nsEnabled`,
   * `noiseSuppression: nsEnabled`, `autoGainControl: nsEnabled` seklindeydi —
   * UCU DE AYNI degiskene bagliydi. Yani kullanici GURULTU BASTIRMAYI
   * kapattiginda YANKI GIDERME de sessizce kapaniyordu. Bunlar farkli
   * islemcilerdir ve yankinin gurultu bastirmayla ilgisi yoktur.
   *
   * IKINCI KUSUR: Ayarlar -> Cihazlar ekraninda AYRI bir "Eko giderme"
   * anahtari VAR, kaydediliyor ve sunucuya yaziliyordu; ama canli ses
   * oturumuna HIC ULASMIYORDU (`voice:applyDeviceSettings` payload'dan
   * yalnizca `micDeviceId` okuyup gerisini atiyordu). Kullanicinin actigi
   * yankı gidermenin uygulandigina dair hicbir yol yoktu.
   *
   * VARSAYILAN: yankı giderme ACIK. Kullanici acikca kapatmadikca
   * kapanmaz — hoparlorle konusan iki kisi icin tek koruma budur.
   */
  echoCancellation                          = true;
  noiseSuppression                          = true;
  autoGainControl                           = true;
  channelBitrate                            = 64_000;
  peerStreams: Map<string, MediaStream>     = new Map();
  /** ICE may legally arrive before the peer/remote SDP because Socket.IO and
   * WebRTC signalling are asynchronous. Keep a bounded per-peer queue so a
   * valid candidate is not silently lost during that race. */
  private _pendingIce = new Map<string, RTCIceCandidateInit[]>();

  private _abrIntervals: Map<RTCPeerConnection, ReturnType<typeof setInterval>> = new Map();
  private _peerDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _iceRestartAttempts = new Map<string, number>();
  private _screenQuality: ScreenQuality                        = 'hd';
  private _mobileAudioOverride: Partial<MediaTrackConstraints> | false = false;
  private _socketHandlers: Array<[string, (...args: unknown[]) => void]> = [];
  private _sessionGeneration = 0;
  private _voiceJoinSeq = 0;

  constructor(socket: BridgeSocket) {
    this.socket = socket;
    this._bindSocketEvents();
  }

  // ── Device enumeration ────────────────────────────────────────────────────
  async getDevices(): Promise<{ microphones: MediaDeviceInfo[]; speakers: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }> {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        microphones: devices.filter(d => d.kind === 'audioinput'),
        speakers:    devices.filter(d => d.kind === 'audiooutput'),
        cameras:     devices.filter(d => d.kind === 'videoinput'),
      };
    } catch (e) {
      log.warn('[WebRTC] getDevices error:', e);
      return { microphones: [], speakers: [], cameras: [] };
    }
  }

  /**
   * DÜZELTİLEN GERÇEK SORUN — DEPOLAMA ANAHTARI UYUŞMAZLIĞI.
   *
   * Ayarlar → Cihazlar sekmesi seçimi şu anahtarlarla yazıyor
   * (`settings/tabs/DevicesTab.svelte`):
   *     bridge:device:mic · bridge:device:camera · bridge:device:speaker
   * Burada ise ESKİ adlar okunuyordu:
   *     bridge-mic · bridge-camera · bridge-speaker
   *
   * Adlar hiç örtüşmediği için kaydedilen seçim ASLA yüklenmiyor,
   * `selectedMicId` null kalıyor ve görüşmeler daima VARSAYILAN cihazı
   * kullanıyordu: kullanıcı mikrofon seçiyor, kaydediliyor, hiçbir etkisi
   * olmuyordu. Ayarlar yüzeyi ulaşılabilir ve üretim paketinde olduğu için
   * bu CANLI bir işlev hatasıydı.
   *
   * Kanonik anahtarlar önce okunur; eski anahtarlar geriye dönük uyumluluk
   * için yedek olarak kalır (daha önce ayar yapmış kullanıcılar kaybetmesin).
   */
  loadSavedDevices(): void {
    const read = (canonical: string, legacy: string): string | null =>
      localStorage.getItem(canonical) || localStorage.getItem(legacy);

    const mic     = read('bridge:device:mic',     'bridge-mic');
    const camera  = read('bridge:device:camera',  'bridge-camera');
    const speaker = read('bridge:device:speaker', 'bridge-speaker');
    if (mic)     this.selectedMicId     = mic;
    if (camera)  this.selectedCameraId  = camera;
    if (speaker) this.selectedSpeakerId = speaker;

    // Ayarlar -> Cihazlar ile AYNI anahtarlar. Yalnizca acik 'false' kapatir;
    // eksik/bozuk deger guvenli tarafa (ACIK) duser.
    this.echoCancellation = localStorage.getItem('bridge:device:echo')  !== 'false';
    this.noiseSuppression = localStorage.getItem('bridge:device:noise') !== 'false';
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    document.querySelectorAll<HTMLMediaElement>('.remote-audio').forEach(el => { el.muted = deafened; });
    if (deafened && !this.muted) this.setMuted(true);
    this._broadcastState();
  }

  private _onSocket(event: string, handler: (...args: unknown[]) => void): void {
    this._socketHandlers.push([event, handler]);
    this.socket.on(event, handler);
  }

  private _bindSocketEvents(): void {
    this._onSocket('voice:existing-peers', async (rawPeers: unknown) => {
      const peers = rawPeers as PeerInfo[];
      for (const peer of peers) await this._createOffer(peer.socketId, peer);
      const e2e = voiceE2E();
      if (peers.length > 0 && e2e) {
        e2e.initVoiceE2E(this.currentChannelId, peers)
          .then(ok => { if (ok) e2e.renderVoiceE2EBadge(); });
      }
    });

    this._onSocket('voice:peer-joined', (rawPeer: unknown) => {
      app()?.renderVoicePeer(rawPeer as PeerInfo, false);
    });

    this._onSocket('voice:peer-left', (raw: unknown) => {
      const { socketId } = raw as { socketId: string };
      this._removePeer(socketId);
      app()?.removeVoicePeer(socketId);
    });

    this._onSocket('webrtc:offer', async (raw: unknown) => {
      const { fromSocketId, offer } = raw as { fromSocketId: string; offer: RTCSessionDescriptionInit };
      await this._handleOffer(fromSocketId, offer);
    });

    this._onSocket('webrtc:answer', async (raw: unknown) => {
      const { fromSocketId, answer } = raw as { fromSocketId?: unknown; answer?: unknown };
      if (typeof fromSocketId !== 'string' || !fromSocketId || !answer || typeof answer !== 'object') return;
      const pc = this.peers.get(fromSocketId);
      if (pc && pc.signalingState !== 'stable') {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer as RTCSessionDescriptionInit));
          await this._flushPendingIce(fromSocketId, pc);
        } catch (err) { log.warn('[WebRTC] Answer apply error:', err); }
      }
    });

    this._onSocket('webrtc:ice-candidate', async (raw: unknown) => {
      const { fromSocketId, candidate } = raw as { fromSocketId?: unknown; candidate?: unknown };
      if (typeof fromSocketId !== 'string' || !fromSocketId || !candidate || typeof candidate !== 'object') return;
      const candidateInit = candidate as RTCIceCandidateInit;
      const pc = this.peers.get(fromSocketId);
      if (!pc || !pc.remoteDescription) {
        const pending = this._pendingIce.get(fromSocketId) ?? [];
        if (pending.length < 128) pending.push(candidateInit);
        this._pendingIce.set(fromSocketId, pending);
        return;
      }
      try { await pc.addIceCandidate(new RTCIceCandidate(candidateInit)); }
      catch (err) { log.warn('[WebRTC] ICE candidate rejected:', err); }
    });

    this._onSocket('voice:peer-state', (raw: unknown) => {
      const { socketId, ...state } = raw as { socketId: string } & PeerState;
      app()?.updatePeerState(socketId, state);
    });

    // Faz K2 — sunucu (voice.ts:218) konusma sinyalini yalniz GERCEK odaya
    // yayar. Istemcide karsiligi yoktu; katilimci kartlari bu yuzden hicbir
    // zaman konusma durumu gostermiyordu.
    this._onSocket('voice:activity', (raw: unknown) => {
      const { socketId, speaking } = raw as { socketId?: unknown; speaking?: unknown };
      if (typeof socketId !== 'string') return;
      app()?.updatePeerSpeaking?.(socketId, speaking === true);
    });

    // Socket.IO transient reconnects reuse this same socket object, but the
    // server removes voice-room membership on every disconnect.  Keeping the
    // old local stream/channel here would make `isInVoice()` lie and would
    // suppress a later user-initiated join of the same channel.
    this._onSocket('disconnect', () => {
      if (!this.currentChannelId && !this.localStream && this.peers.size === 0) return;
      this._cleanupVoiceState();
      document.dispatchEvent(new CustomEvent('bridge:voice-left', {
        detail: { reason: 'socket-disconnect' },
      }));
    });
  }

  private _nextVoiceJoinRequestId(): string {
    this._voiceJoinSeq = (this._voiceJoinSeq + 1) % 1_000_000_000;
    return `voice-join:${this._sessionGeneration}:${this._voiceJoinSeq}`;
  }

  private _waitForVoiceJoinAck(channelId: string, requestId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        this.socket.off('voice:joined', onJoined as (...args: unknown[]) => void);
        this.socket.off('voice:join-rejected', onRejected as (...args: unknown[]) => void);
        this.socket.off('voice:full', onFull as (...args: unknown[]) => void);
        this.socket.off('disconnect', onDisconnect as (...args: unknown[]) => void);
      };
      const matches = (raw: unknown): boolean => {
        const data = raw as { channelId?: unknown; requestId?: unknown };
        if (data.channelId !== channelId) return false;
        // Legacy `voice:full` did not carry a request id. Accept it only for
        // this channel; modern events are request-correlated.
        return typeof data.requestId !== 'string' || data.requestId === requestId;
      };
      const onJoined = (raw: unknown): void => {
        if (!matches(raw)) return;
        cleanup();
        resolve();
      };
      const rejectWith = (name: string, max?: number): void => {
        cleanup();
        const error = new Error('Voice join rejected') as Error & { max?: number };
        error.name = name;
        if (typeof max === 'number' && Number.isFinite(max)) error.max = max;
        reject(error);
      };
      const onRejected = (raw: unknown): void => {
        if (!matches(raw)) return;
        const data = raw as { code?: unknown; max?: unknown };
        if (data.code === 'FULL') {
          rejectWith('VoiceChannelFullError', typeof data.max === 'number' ? data.max : undefined);
          return;
        }
        rejectWith(data.code === 'FORBIDDEN' ? 'VoiceJoinForbiddenError' : 'VoiceJoinUnavailableError');
      };
      const onFull = (raw: unknown): void => {
        if (!matches(raw)) return;
        const data = raw as { max?: unknown };
        rejectWith('VoiceChannelFullError', typeof data.max === 'number' ? data.max : undefined);
      };
      const onDisconnect = (): void => rejectWith('AbortError');

      this.socket.on('voice:joined', onJoined as (...args: unknown[]) => void);
      this.socket.on('voice:join-rejected', onRejected as (...args: unknown[]) => void);
      this.socket.on('voice:full', onFull as (...args: unknown[]) => void);
      this.socket.on('disconnect', onDisconnect as (...args: unknown[]) => void);
      timer = setTimeout(() => rejectWith('VoiceJoinUnavailableError'), VOICE_JOIN_ACK_TIMEOUT_MS);
    });
  }

  async joinVoice(channelId: string, serverId: string): Promise<void> {
    // First peer creation must not race the authenticated ICE policy fetch.
    // In particular, FORCE_TURN may be a privacy requirement; using the static
    // STUN fallback merely because the user clicked quickly would violate it.
    await iceConfigReady;
    // Both ChannelStage and the engine enforce idempotency: callers outside the
    // stage router must not acquire a second microphone stream or emit a second
    // join for the active channel.
    if (this.currentChannelId === channelId) return;
    if (this.currentChannelId) this.leaveVoice();
    if (!this.socket.connected) {
      const error = new Error('Voice join cancelled: socket disconnected');
      error.name = 'AbortError';
      throw error;
    }

    const generation = ++this._sessionGeneration;
    this.currentChannelId = channelId;
    this.currentServerId  = serverId;
    this.channelBitrate   = 64_000;

    const channels = _getServerChannels as Array<{ _id: string; bitrate?: number }> | null;
    if (channels) {
      const ch = channels.find(c => c._id === channelId);
      if (ch?.bitrate) this.channelBitrate = ch.bitrate;
    }

    try {
      const nsModule  = ns();
      const mobileOverride = typeof this._mobileAudioOverride === 'object' ? this._mobileAudioOverride : {};
      const baseConstraints: MediaTrackConstraints = {
        ...this.audioProcessingConstraints(), ...mobileOverride,
      };
      const audioConstraints = this.selectedMicId
        ? { deviceId: { exact: this.selectedMicId }, ...baseConstraints }
        : baseConstraints;

      const rawStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      const stream = nsModule ? await nsModule.process(rawStream) : rawStream;
      // A disconnect/leave may happen while the permission prompt is open.
      // Never resurrect that cancelled session or queue a stale voice:join for
      // Socket.IO to send after reconnect.
      if (generation !== this._sessionGeneration || this.currentChannelId !== channelId || !this.socket.connected) {
        stream.getTracks().forEach(track => track.stop());
        const error = new Error('Voice join cancelled');
        error.name = 'AbortError';
        throw error;
      }
      this.localStream = stream;
    } catch (err) {
      if (generation !== this._sessionGeneration || this.currentChannelId !== channelId || !this.socket.connected) {
        if (generation === this._sessionGeneration && this.currentChannelId === channelId) this._cleanupVoiceState();
        throw err;
      }
      // Mikrofon alınamadı → sessize alınmış olarak yine katılınır (kullanıcı
      // dinleyebilir). Hata TÜRÜNE göre güvenli, teknik olmayan mesaj gösterilir;
      // stack/SDP/cihaz iç bilgisi ASLA kullanıcıya basılmaz.
      this.localStream = new MediaStream();
      toast(micErrorMessage(err), 'error');
    }

    const requestId = this._nextVoiceJoinRequestId();
    const admitted = this._waitForVoiceJoinAck(channelId, requestId);
    this.socket.emit('voice:join', { channelId, serverId, requestId });
    try {
      await admitted;
    } catch (err) {
      // The microphone/optimistic local state is not proof of server room
      // membership. Roll it back whenever authoritative admission fails.
      if (generation === this._sessionGeneration && this.currentChannelId === channelId) this._cleanupVoiceState();
      throw err;
    }
    if (generation !== this._sessionGeneration || this.currentChannelId !== channelId || !this.socket.connected) {
      if (generation === this._sessionGeneration && this.currentChannelId === channelId) this._cleanupVoiceState();
      return;
    }
    vauiMod()?.init(this.socket);
    if (this.localStream) startVAD()?.(this.localStream, channelId);
  }

  leaveVoice(): void {
    if (!this.currentChannelId) return;
    this.socket.emit('voice:leave', { channelId: this.currentChannelId, serverId: this.currentServerId });
    this._cleanupVoiceState();
  }

  /** Local-only cleanup shared by explicit leave, disconnect and replacement. */
  private _cleanupVoiceState(): void {
    this._sessionGeneration += 1;
    for (const timer of this._peerDisconnectTimers.values()) clearTimeout(timer);
    this._peerDisconnectTimers.clear();
    this._iceRestartAttempts.clear();
    for (const pc of this.peers.values()) {
      this.stopAdaptiveBitrate(pc);
      pc.close();
    }
    this.peers.clear();
    this.peerStreams.clear();
    this._pendingIce.clear();
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.screenStream     = null;
    this.currentChannelId = null;
    this.currentServerId  = null;
    this.muted            = false;
    this.deafened         = false;
    this.videoOn          = false;
    this.screenSharing    = false;
    stopVAD()?.();
  }

  /** Detach only this RTC owner's listeners before swapping socket objects. */
  destroy(): void {
    const hadVoiceState = Boolean(this.currentChannelId || this.localStream || this.peers.size);
    this._cleanupVoiceState();
    for (const [event, handler] of this._socketHandlers) this.socket.off(event, handler);
    this._socketHandlers = [];
    if (hadVoiceState) {
      document.dispatchEvent(new CustomEvent('bridge:voice-left', {
        detail: { reason: 'socket-replaced' },
      }));
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
    this._broadcastState();
  }

  async enableVideo(enable: boolean): Promise<boolean> {
    if (enable) {
      try {
        const vq = videoQuality()?.getConstraints() ?? {};
        const baseConstraints = this.selectedCameraId
          ? { deviceId: { exact: this.selectedCameraId }, ...vq } : { ...vq };
        const videoConstraints = Object.keys(baseConstraints).length ? baseConstraints : true;
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
        const videoTrack  = videoStream.getVideoTracks()[0];
        if (!this.localStream) this.localStream = new MediaStream();
        this.localStream.addTrack(videoTrack);
        for (const pc of this.peers.values()) {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video');
          if (sender) await sender.replaceTrack(videoTrack);
          else pc.addTrack(videoTrack, this.localStream!);
        }
        this.videoOn = true;
        // Cagri SIRASINDA acilan kamera da yeni bir track'tir: pazarlik
        // yapilmazsa karsi taraf goruntuyu HIC gormezdi.
        await this._renegotiateAll();
      } catch {
        toast(t('rtc_camera_permission_denied', 'Kamera izni verilmedi.'), 'error');
        return false;
      }
    } else {
      this.localStream?.getVideoTracks().forEach(t => { t.stop(); this.localStream?.removeTrack(t); });
      this.videoOn = false;
    }
    this._broadcastState();
    return true;
  }

  /**
   * @param includeAudio VARSAYILAN: false.
   *
   * Sistem sesi YAKALANIP ATILIYORDU: bu fonksiyon yalnizca
   * `getVideoTracks()[0]` kullanir, ses track'i hicbir eslesmeye/producer'a
   * eklenmez. `true` varsayilani, her paylasimda kullaniciya gereksiz bir
   * sistem sesi izni sorduruyor ve paylasim boyunca kullanilmayan canli bir
   * yakalama tutuyordu.
   *
   * NOT: bu ayni zamanda "uzak konusmacinin sesi hoparlorden cikip sistem
   * sesi olarak geri gonderiliyor" turu bir DIJITAL YANKI yolunun Bridge'de
   * BULUNMADIGINI da gosterir — ses hicbir zaman iletilmiyor.
   */
  async startScreenShare(quality: ScreenQuality = '1080p60', includeAudio = false): Promise<boolean> {
    const preset = SCREEN_PRESETS[quality] ?? SCREEN_PRESETS['1080p60'];
    this._screenQuality = quality;
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: preset as MediaTrackConstraints,
        audio: includeAudio
          ? { echoCancellation: false, noiseSuppression: false, sampleRate: 48000 } as MediaTrackConstraints
          : false,
      });
      const screenTrack   = this.screenStream.getVideoTracks()[0];
      screenTrack.onended = () => this.stopScreenShare();

      // ══════════════════════════════════════════════════════════════════
      // PAYLASIM SESI (SISTEM SESI) — GERCEK YAKALANAN DURUM
      // ══════════════════════════════════════════════════════════════════
      // KAPATILAN GERCEK OZELLIK BOSLUGU: `includeAudio` yalnizca
      // `getDisplayMedia`ya iletiliyordu. Tarayici bir ses track'i verse BILE
      // yalnizca `getVideoTracks()[0]` akranlara baglaniyordu; ses track'i
      // sessizce DUSURULUYORDU. Kullanici "sesi de paylas" kutusunu
      // isaretliyor, tarayici izin istiyor, karsi taraf HICBIR SEY duymuyordu.
      //
      // Ayrica: ses track'inin varligi PLATFORMA BAGLIDIR. Chrome sekme
      // paylasiminda verir, cogu durumda tum ekranda vermez, Firefox/Safari
      // buyuk olcude hic vermez. Bu yuzden urun, KUTU ISARETLI diye ses
      // paylasildigini IDDIA ETMEZ; yalnizca GERCEKTEN yakalanani bildirir.
      this._screenAudioTrack = this.screenStream.getAudioTracks()[0] ?? null;
      this.screenAudioActive = Boolean(this._screenAudioTrack);
      if (this._screenAudioTrack) {
        // Tarayici arayuzunden ses paylasimi tek basina durdurulabilir.
        this._screenAudioTrack.onended = () => this._detachScreenAudio();
      }

      for (const pc of this.peers.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(screenTrack);
          const params = sender.getParameters();
          if (params?.encodings?.length) {
            params.encodings[0].maxBitrate  = SCREEN_BITRATES[quality] ?? 3_000_000;
            params.encodings[0].maxFramerate = SCREEN_FPS[quality] ?? 30;
            try { await sender.setParameters(params); } catch { /* non-fatal */ }
          }
        } else {
          pc.addTrack(screenTrack, this.screenStream!);
        }
        this._attachScreenAudioTo(pc);
      }
      this.screenSharing = true;
      // Track'ler eklendi; uzak taraf ancak yeniden pazarlikla ogrenir.
      await this._renegotiateAll();
      this._broadcastState();
      return true;
    } catch {
      toast(t('rtc_share_cancel2', 'Ekran paylaşımı iptal edildi.'), 'error');
      return false;
    }
  }

  /**
   * Paylasim sesini TEK bir akrana baglar.
   *
   * AYRI bir transceiver kullanilir; mikrofon gondericisine DOKUNULMAZ.
   * Mikrofonun yerine sistem sesi koymak (ya da ikisini karistirmak) hem
   * sagirlastirma anlamini hem de "kim konusuyor" bilgisini bozardi.
   */
  private _attachScreenAudioTo(pc: RTCPeerConnection): void {
    if (!this._screenAudioTrack || !this.screenStream) return;
    if (this._screenAudioSenders.has(pc)) return;          // cift ekleme YOK
    try {
      const sender = pc.addTrack(this._screenAudioTrack, this.screenStream);
      this._screenAudioSenders.set(pc, sender);
    } catch { /* akran kapaniyor olabilir — olumcul degil */ }
  }

  /** Yalnizca paylasim sesini kaldirir; video paylasimi surer. */
  private _detachScreenAudio(): void {
    for (const [pc, sender] of this._screenAudioSenders) {
      try { pc.removeTrack(sender); } catch { /* akran kapali olabilir */ }
    }
    this._screenAudioSenders.clear();
    try { this._screenAudioTrack?.stop(); } catch { /* zaten durmus */ }
    this._screenAudioTrack = null;
    this.screenAudioActive = false;
    void this._renegotiateAll();
    this._broadcastState();
  }

  stopScreenShare(): void {
    // Ses yolu ONCE sokulur: aksi halde `screenStream` null'landiktan sonra
    // gondericiler sahipsiz kalir ve alicida ASILI bir ses akisi kalirdi.
    this._detachScreenAudio();
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.screenStream  = null;
    this.screenSharing = false;
    this._broadcastState();
    if (this.videoOn) { void this.enableVideo(true); }
    else {
      for (const pc of this.peers.values()) {
        pc.getSenders().find(s => s.track?.kind === 'video')?.replaceTrack(null);
      }
    }
    // `replaceTrack(null)` pazarlik gerektirmez ama `removeTrack` (paylasim
    // sesi) gerektirir; tek yerden yurutulur.
    void this._renegotiateAll();
  }

  async setChannelBitrate(bitrate: number): Promise<void> {
    this.channelBitrate = bitrate;
    for (const pc of this.peers.values()) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (!sender) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = bitrate;
        await sender.setParameters(params);
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Ses isleme kisitlari — TEK KAYNAK.
   *
   * `getUserMedia` cagiran her yol bunu kullanir; boylece "ses kanalina
   * katilma" ve "mikrofon degistirme" yollari birbirinden AYRILAMAZ. Onceden
   * iki ayri yerde elle yaziliyordu ve ikisi de ayni tek-anahtar kusurunu
   * tasiyordu.
   */
  audioProcessingConstraints(): MediaTrackConstraints {
    return {
      echoCancellation: this.echoCancellation,
      noiseSuppression: this.noiseSuppression,
      autoGainControl:  this.autoGainControl,
      sampleRate:       48000,
    };
  }

  /**
   * Ses isleme tercihlerini CANLI oturuma uygular.
   *
   * `echoCancellation` gibi kisitlar bir track UZERINDE `applyConstraints`
   * ile degistirilemez guvenilir bicimde — tarayicilar bunlari yakalama
   * aninda baglar. Bu yuzden track YENIDEN alinir ve gonderenlerde
   * degistirilir; `setMicDevice` ile AYNI yol.
   */
  async setAudioProcessing(opts: {
    echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean;
  }): Promise<void> {
    if (typeof opts.echoCancellation === 'boolean') this.echoCancellation = opts.echoCancellation;
    if (typeof opts.noiseSuppression === 'boolean') this.noiseSuppression = opts.noiseSuppression;
    if (typeof opts.autoGainControl  === 'boolean') this.autoGainControl  = opts.autoGainControl;

    if (!this.isInVoice() || !this.localStream) return;

    try {
      const nsModule  = ns();
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: this.selectedMicId
          ? { deviceId: { exact: this.selectedMicId }, ...this.audioProcessingConstraints() }
          : this.audioProcessingConstraints(),
        video: false,
      });
      const cleanStream = nsModule ? await nsModule.process(rawStream) : rawStream;
      const newTrack    = cleanStream.getAudioTracks()[0];
      if (!newTrack) return;

      this.localStream.getAudioTracks().forEach(t => { t.stop(); this.localStream!.removeTrack(t); });
      this.localStream.addTrack(newTrack);
      for (const pc of this.peers.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) await sender.replaceTrack(newTrack);
      }

      // UYGULANDI MI? Kisit yalnizca ISTEKTIR. Kullanici yanki gidermeyi
      // acik biraktigi halde tarayici uygulamadiysa bu SESSIZ kalmamali —
      // hoparlorle konusan iki kisi icin dogrudan yanki demektir.
      const applied = newTrack.getSettings?.() as MediaTrackSettings | undefined;
      if (this.echoCancellation && applied && applied.echoCancellation === false) {
        log.warn({ voice: 'aec_not_applied', applied });
      }
    } catch (err) {
      log.warn({ voice: 'audio_processing_failed', err });
    }
  }

  async setMicDevice(deviceId: string): Promise<void> {
    this.selectedMicId = deviceId;
    // Kanonik anahtar (Ayarlar → Cihazlar ile AYNI). Eski ad da yazılır ki
    // sürüm geçişinde geriye dönük okuma bozulmasın.
    localStorage.setItem('bridge:device:mic', deviceId);
    localStorage.setItem('bridge-mic', deviceId);
    if (!this.isInVoice() || !this.localStream) return;
    try {
      const nsModule  = ns();
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, ...this.audioProcessingConstraints() },
        video: false,
      });
      const cleanStream = nsModule ? await nsModule.process(rawStream) : rawStream;
      const newTrack    = cleanStream.getAudioTracks()[0];
      this.localStream.getAudioTracks().forEach(t => { t.stop(); this.localStream!.removeTrack(t); });
      this.localStream.addTrack(newTrack);
      for (const pc of this.peers.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) await sender.replaceTrack(newTrack);
      }
      toast(t('rtc_mic_changed', 'Mikrofon değiştirildi ✓'), 'success');
    } catch { toast(t('rtc_mic_failed', 'Mikrofon değiştirilemedi'), 'error'); }
  }

  async setCameraDevice(deviceId: string): Promise<void> {
    this.selectedCameraId = deviceId;
    localStorage.setItem('bridge-camera', deviceId);
    if (!this.videoOn || !this.localStream) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      const newTrack  = newStream.getVideoTracks()[0];
      this.localStream.getVideoTracks().forEach(t => { t.stop(); this.localStream!.removeTrack(t); });
      this.localStream.addTrack(newTrack);
      for (const pc of this.peers.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(newTrack);
      }
      toast(t('rtc_cam_changed', 'Kamera değiştirildi ✓'), 'success');
    } catch { toast(t('rtc_cam_failed', 'Kamera değiştirilemedi'), 'error'); }
  }

  async setSpeakerDevice(deviceId: string): Promise<void> {
    this.selectedSpeakerId = deviceId;
    localStorage.setItem('bridge-speaker', deviceId);
    type AudioEl = HTMLMediaElement & { setSinkId?(id: string): Promise<void> };
    document.querySelectorAll<AudioEl>('.remote-audio, audio').forEach(el => {
      el.setSinkId?.(deviceId).catch(() => {});
    });
    toast(t('rtc_spk_changed', 'Hoparlör değiştirildi ✓'), 'success');
  }

  registerVoiceE2EEvents(myUserId: string): void {
    voiceE2E()?.registerSocketEvents(this.socket, myUserId);
  }

  // ── Signalling ────────────────────────────────────────────────────────────
  private async _createOffer(targetSocketId: string, peerInfo: PeerInfo): Promise<void> {
    const pc = this._createPeerConnection(targetSocketId, peerInfo);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('webrtc:offer', {
        targetSocketId, offer: pc.localDescription, channelId: this.currentChannelId,
      });
    } catch (e) { log.error('[WebRTC] Offer error:', e); }
  }

  /**
   * ════════════════════════════════════════════════════════════════════════
   * YENIDEN PAZARLIK (RENEGOTIATION)
   * ════════════════════════════════════════════════════════════════════════
   * KAPATILAN GERCEK KUSUR (P0): kod tabaninda `onnegotiationneeded` ya da
   * herhangi bir yeniden pazarlik yolu YOKTU. Ilk teklif/yanit turundan SONRA
   * `pc.addTrack(...)` cagiran her yol track'i YALNIZCA YEREL olarak ekliyordu;
   * uzak taraf onu HIC ogrenmiyordu.
   *
   * OLCULEN ETKI (iki tarayici, gercek cagri):
   *   paylasimdan ONCE  A: gonderen=audio        B: alan=audio
   *   paylasimdan SONRA A: gonderen=audio,video  B: alan=audio   ← DEGISMEDI
   *   iki taraf da `signalingState = "stable"`   ← pazarlik HIC olmadi
   *
   * Yani EKRAN PAYLASIMI karsi tarafa HIC ULASMIYORDU: paylasan kisi
   * tarayicinin "paylasiyorsun" gostergesini gorur, izleyici HICBIR SEY gormez.
   * Ayni kusur cagri sirasinda acilan KAMERA icin de gecerliydi.
   *
   * Burada teklifi YALNIZCA track EKLEYEN taraf baslatir; karsi taraf mevcut
   * `_handleOffer` yoluyla yanitlar (o yol zaten var olan baglantiyi yeniden
   * kullaniyordu — alma tarafi hazirdi, baslatma tarafi eksikti).
   */
  private async _renegotiate(pc: RTCPeerConnection, targetSocketId: string): Promise<void> {
    // Pazarlik zaten surerken ikinci teklif YAPILMAZ.
    if (pc.signalingState !== 'stable') return;
    try {
      const offer = await pc.createOffer();
      // `createOffer` beklerken karsi taraftan teklif gelmis olabilir.
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      this.socket.emit('webrtc:offer', {
        targetSocketId, offer: pc.localDescription, channelId: this.currentChannelId,
      });
    } catch (e) { log.error('[WebRTC] Renegotiation error:', e); }
  }

  /** Track ekleyen/kaldiran akislar sonrasi TUM akranlarla yeniden pazarlik. */
  private async _renegotiateAll(): Promise<void> {
    for (const [socketId, pc] of this.peers) await this._renegotiate(pc, socketId);
  }

  private async _handleOffer(fromSocketId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.peers.get(fromSocketId) ?? this._createPeerConnection(fromSocketId, { socketId: fromSocketId });
    try {
      // CAKISMA (glare): iki taraf ayni anda teklif ederse bu taraf GERI ALIR
      // ve yanitlayan olur. Boylece kilitlenme yerine belirlenimci bir sonuc
      // olusur — aksi halde `setRemoteDescription` "wrong state" ile patlar ve
      // paylasim sessizce baslamazdi.
      if (pc.signalingState === 'have-local-offer') {
        await pc.setLocalDescription({ type: 'rollback' } as RTCLocalSessionDescriptionInit);
      }
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await this._flushPendingIce(fromSocketId, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('webrtc:answer', { targetSocketId: fromSocketId, answer: pc.localDescription });
    } catch (e) { log.error('[WebRTC] Answer error:', e); }
  }

  private async _flushPendingIce(socketId: string, pc: RTCPeerConnection): Promise<void> {
    if (!pc.remoteDescription) return;
    const pending = this._pendingIce.get(socketId);
    if (!pending?.length) return;
    this._pendingIce.delete(socketId);
    for (const candidate of pending) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (err) { log.warn('[WebRTC] Queued ICE candidate rejected:', err); }
    }
  }

  private _createPeerConnection(socketId: string, _peerInfo: PeerInfo): RTCPeerConnection {
    // ════════════════════════════════════════════════════════════════════════
    // AYNI KATILIMCI ICIN IKINCI BAGLANTI KURULMADAN ONCE ESKISI KAPATILIR.
    //
    // `this.peers.set(socketId, pc)` eskisini SESSIZCE degistiriyordu ama
    // KAPATMIYORDU. Yetim `RTCPeerConnection` yasamaya devam eder: medya
    // almayi surdurur, `ontrack` yeniden tetiklenebilir ve CPU/agi bosuna
    // tuketir. Yeniden pazarlik ya da yeniden katilim sirasinda ayni kisi
    // icin iki canli baglanti olusabiliyordu.
    const existing = this.peers.get(socketId);
    if (existing) {
      this._clearPeerDisconnectTimer(socketId);
      this._iceRestartAttempts.delete(socketId);
      this.stopAdaptiveBitrate(existing);
      existing.close();
      this.peers.delete(socketId);
    }

    // Sprint 120: I7 — iceTransportPolicy sunucudan gelir; FORCE_TURN=true ise 'relay'
    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS.iceServers,
      iceTransportPolicy: ICE_SERVERS.iceTransportPolicy ?? 'all',
    });
    this.peers.set(socketId, pc);

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream!));
    }

    // Paylasim SURERKEN katilan akran da sesi almalidir; aksi halde sonradan
    // gelen kisi goruntuyu gorup sesi HIC duymazdi.
    this._attachScreenAudioTo(pc);

    this._preferOpus(pc);
    this.preferVP9(pc);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('webrtc:ice-candidate', { targetSocketId: socketId, candidate });
    };

    // Faz 12 — kişi-bazlı ses seviyesi ARTIK YOK (uçtan uca kaldırılmış özellik).
    // Buradaki eski kod `bridge-vol-${userId}` okuyup `BridgeVoiceVolume`
    // modülüne uygulatıyordu; ancak üretimde o anahtarı YAZAN kod, uygulayıcıyı
    // KAYDEDEN kod ve bir kullanıcı arayüzü yoktu — yalnız bu okuma kalmıştı.
    // Vestigial bağımlılık kaldırıldı; uzak ses akışının bağlanması değişmedi.
    pc.ontrack = ({ streams }) => {
      if (!streams[0]) return;
      app()?.attachRemoteStream(socketId, streams[0]);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        this._clearPeerDisconnectTimer(socketId);
        this._iceRestartAttempts.delete(socketId);
        void this._applyOpusParams(pc, this.channelBitrate || 128_000);
        this.startAdaptiveBitrate(pc);
        return;
      }

      if (state === 'disconnected') {
        this.stopAdaptiveBitrate(pc);
        this._schedulePeerDisconnect(socketId, pc, PEER_DISCONNECT_GRACE_MS);
        return;
      }

      if (state === 'failed') {
        this.stopAdaptiveBitrate(pc);
        const attempts = this._iceRestartAttempts.get(socketId) ?? 0;
        if (attempts < MAX_ICE_RESTART_ATTEMPTS && this.peers.get(socketId) === pc && this.socket.connected) {
          this._iceRestartAttempts.set(socketId, attempts + 1);
          try {
            pc.restartIce?.();
            void this._renegotiate(pc, socketId);
            this._schedulePeerDisconnect(socketId, pc, PEER_DISCONNECT_GRACE_MS);
            return;
          } catch (err) {
            log.warn('[WebRTC] ICE restart could not be started:', err);
          }
        }
        this._removePeer(socketId);
        app()?.removeVoicePeer(socketId);
        return;
      }

      if (state === 'closed') {
        this._removePeer(socketId);
        app()?.removeVoicePeer(socketId);
      }
    };

    return pc;
  }

  private _clearPeerDisconnectTimer(socketId: string): void {
    const timer = this._peerDisconnectTimers.get(socketId);
    if (timer !== undefined) clearTimeout(timer);
    this._peerDisconnectTimers.delete(socketId);
  }

  private _schedulePeerDisconnect(socketId: string, pc: RTCPeerConnection, delayMs: number): void {
    this._clearPeerDisconnectTimer(socketId);
    const timer = setTimeout(() => {
      this._peerDisconnectTimers.delete(socketId);
      if (this.peers.get(socketId) !== pc) return;
      if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') return;
      this._removePeer(socketId);
      app()?.removeVoicePeer(socketId);
    }, delayMs);
    this._peerDisconnectTimers.set(socketId, timer);
  }

  private _removePeer(socketId: string): void {
    this._clearPeerDisconnectTimer(socketId);
    this._iceRestartAttempts.delete(socketId);
    const pc = this.peers.get(socketId);
    if (pc) {
      this.stopAdaptiveBitrate(pc);
      pc.close();
      this.peers.delete(socketId);
    }
    this._pendingIce.delete(socketId);
  }

  private _broadcastState(): void {
    if (!this.currentChannelId) return;
    this.socket.emit('voice:state-update', {
      channelId: this.currentChannelId, muted: this.muted,
      deafened: this.deafened, screensharing: this.screenSharing, video: this.videoOn,
    });
  }

  getLocalStream(): MediaStream | null { return this.localStream; }
  isInVoice(): boolean                 { return !!this.currentChannelId; }

  // ── Adaptive bitrate ──────────────────────────────────────────────────────
  startAdaptiveBitrate(pc: RTCPeerConnection): void {
    // `connected` can fire again after an ICE recovery. Keep exactly one ABR
    // sampler per peer instead of leaking a second 3s interval each time.
    this.stopAdaptiveBitrate(pc);
    let lastPacketsLost = 0, lastPacketsSent = 0, currentKbps = 1500;

    const interval = setInterval(async () => {
      if (!pc || pc.connectionState === 'closed') { clearInterval(interval); return; }
      try {
        const stats = await pc.getStats();
        stats.forEach(report => {
          if (report.type !== 'outbound-rtp' || report.kind !== 'video') return;
          const lostDelta  = ((report as Record<string, number>).packetsLost ?? 0) - lastPacketsLost;
          const sentDelta  = ((report as Record<string, number>).packetsSent ?? 0) - lastPacketsSent;
          lastPacketsLost  = (report as Record<string, number>).packetsLost  ?? 0;
          lastPacketsSent  = (report as Record<string, number>).packetsSent  ?? 0;
          if (sentDelta <= 0) return;
          const lossRate = lostDelta / sentDelta;
          let target: number;
          if      (lossRate > 0.10) target = Math.max(200,  currentKbps * 0.5);
          else if (lossRate > 0.05) target = Math.max(300,  currentKbps * 0.75);
          else if (lossRate < 0.01) target = Math.min(4000, currentKbps * 1.1);
          else return;
          if (Math.abs(target - currentKbps) < 50) return;
          currentKbps = target;
          void this._setVideoBitrate(pc, currentKbps);
        });
      } catch { /* non-critical */ }
    }, 3000);

    this._abrIntervals.set(pc, interval);
  }

  private async _setVideoBitrate(pc: RTCPeerConnection, kbps: number): Promise<void> {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = kbps * 1000;
      await sender.setParameters(params);
    } catch { /* non-fatal */ }
  }

  stopAdaptiveBitrate(pc: RTCPeerConnection): void {
    const iv = this._abrIntervals.get(pc);
    if (iv) clearInterval(iv);
    this._abrIntervals.delete(pc);
  }

  // ── Codec preferences ─────────────────────────────────────────────────────
  private _preferOpus(pc: RTCPeerConnection): void {
    try {
      for (const t of pc.getTransceivers()) {
        if (t.receiver.track?.kind !== 'audio') continue;
        const caps    = RTCRtpSender.getCapabilities?.('audio')?.codecs ?? [];
        const ordered = [
          ...caps.filter(c => c.mimeType.toLowerCase() === 'audio/opus'),
          ...caps.filter(c => c.mimeType.toLowerCase() !== 'audio/opus'),
        ];
        if (ordered.length && t.setCodecPreferences) t.setCodecPreferences(ordered);
      }
    } catch { /* old browser — non-critical */ }
  }

  private async _applyOpusParams(pc: RTCPeerConnection, bitrate = 128_000): Promise<void> {
    try {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (!sender) return;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = bitrate;
      if (params.codecs) {
        for (const codec of params.codecs) {
          if (codec.mimeType?.toLowerCase() === 'audio/opus') {
            codec.sdpFmtpLine = [codec.sdpFmtpLine ?? '',
              'useinbandfec=1', 'usedtx=1', 'stereo=1', 'sprop-stereo=1',
              `maxaveragebitrate=${bitrate}`,
            ].filter(Boolean).join(';');
          }
        }
      }
      await sender.setParameters(params);
    } catch { /* non-fatal */ }
  }

  preferVP9(pc: RTCPeerConnection): void {
    try {
      for (const t of pc.getTransceivers()) {
        if (t.receiver.track?.kind !== 'video') continue;
        const caps    = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
        const ordered = [
          ...caps.filter(c => c.mimeType.toLowerCase() === 'video/vp9'),
          ...caps.filter(c => c.mimeType.toLowerCase() === 'video/vp8'),
          ...caps.filter(c => !['video/vp9', 'video/vp8'].includes(c.mimeType.toLowerCase())),
        ];
        if (ordered.length && t.setCodecPreferences) t.setCodecPreferences(ordered);
      }
    } catch { /* codec preference not supported */ }
  }
}

// BridgeRTC SINIFINI registry'ye kaydet (geriye dönük uyumluluk).
BridgeRegistry.register('BridgeRTC', BridgeRTC as unknown as (...args: unknown[]) => unknown);

// ─────────────────────────────────────────────────────────────────────────────
// Faz 8.3 — SESSİZ ARIZANIN KÖK NEDENİ VE DÜZELTMESİ
//
// Yukarıdaki satır yıllardır SINIFIN KENDİSİNİ kaydediyordu, örneğini değil.
// `BridgeRTC` bir class ve `joinVoice`/`leaveVoice`/`setMuted` prototip
// metotları — static değil. Dolayısıyla:
//
//   const api = BridgeRegistry.get('BridgeRTC');   // → constructor
//   api.joinVoice?.(channelId, serverId);          // → undefined, SESSİZCE hiçbir şey
//
// Çağıran taraf `?.` kullandığı için hata bile fırlamıyordu. Ölçülen sonuç:
// ses kanalı seçildiğinde getUserMedia 0, RTCPeerConnection 0, hata 0.
// Motor hiçbir zaman ÖRNEKLENMEMİŞTİ.
//
// Düzeltme: socket hazır olduğunda tek bir örnek kurulur ve `rtc` adıyla
// kaydedilir — `globals.ts:getRtc()` zaten önce bu adı arıyor.
// Yeni kütüphane yok, ikinci ses yığını yok, WebRTC yeniden yazılmadı.
// ─────────────────────────────────────────────────────────────────────────────

let _rtcInstance: BridgeRTC | null = null;

/** Tek örnek — socket hazırsa kurar, kuruluysa aynısını döndürür. */
export function ensureRtc(): BridgeRTC | null {
  const socket = BridgeRegistry.get<BridgeSocket>('socket');
  if (!socket) return null;

  // Socket.IO reconnects normally reuse the same object. Auth recovery is the
  // deliberate exception: SocketManager tears the rejected socket down and
  // creates a fresh object with the refreshed token. Replace the RTC owner in
  // that case so it never emits or listens on a stale socket.
  if (_rtcInstance && _rtcInstance.socket !== socket) {
    _rtcInstance.destroy();
    _rtcInstance = null;
    // A replacement constructor can fail (malformed transport adapter or a
    // partially initialized browser). Never leave the destroyed old engine
    // reachable while recovery is still pending.
    BridgeRegistry.unregister('rtc');
  }

  if (_rtcInstance) {
    // Kayıt bir şekilde düşmüşse geri koy — motor tek, erişim yolu da tek kalsın.
    if (!BridgeRegistry.has('rtc')) {
      BridgeRegistry.register('rtc', _rtcInstance as unknown as (...args: unknown[]) => unknown);
    }
    return _rtcInstance;
  }
  try {
    const sfuFactory = BridgeRegistry.get<(socket: BridgeSocket) => BridgeRTC>('rtc:sfu-factory');
    _rtcInstance = sfuFactory ? sfuFactory(socket) : new BridgeRTC(socket);
  } catch (err) {
    log.error('BridgeRTC kurulamadı', err);
    return null;
  }
  BridgeRegistry.register('rtc', _rtcInstance as unknown as (...args: unknown[]) => unknown);

  /**
   * Ayarlar → Cihazlar sekmesi kaydettiğinde bunu çağırır
   * (`settings/tabs/DevicesTab.svelte`). Kayıt sayısı SIFIRDI: çağrı sessizce
   * hiçbir şey yapmıyor, cihaz değişikliği AKTİF görüşmeye uygulanmıyordu.
   *
   * İKİNCİ bir RTC sahibi kurulmaz — iş, kanonik motorun mevcut
   * `setMicDevice` yoluna devredilir (o da canlı track değişimini yapar).
   */
  BridgeRegistry.register('voice:applyDeviceSettings', ((payload: unknown) => {
    const p = (payload ?? {}) as {
      micDeviceId?: unknown; echoCancellation?: unknown; noiseSuppression?: unknown;
    };

    // ════════════════════════════════════════════════════════════════════════
    // KAPATILAN GERCEK KUSUR — AYAR CANLI OTURUMA ULASMIYORDU
    // ════════════════════════════════════════════════════════════════════════
    // Bu isleyici payload'dan YALNIZCA `micDeviceId` okuyordu; kullanicinin
    // Ayarlar -> Cihazlar ekraninda actigi/kapattigi YANKI GIDERME ve GURULTU
    // BASTIRMA degerleri sessizce atiliyordu. Ust tarafta bu degerler
    // localStorage'a ve sunucuya yaziliyordu, yani arayuz "kaydedildi" diyor,
    // ses yolu ise eski ayarla calismaya devam ediyordu.
    //
    // AYRICA: `if (!micId) return;` satiri, kullanici belirli bir mikrofon
    // SECMEMISSE (sistem varsayilani) isleyiciyi bastan cikariyordu — bu
    // durumda HICBIR ayar uygulanmiyordu. Varsayilan mikrofon en yaygin
    // durumdur.
    const micId = String(p.micDeviceId ?? '');
    const processing: { echoCancellation?: boolean; noiseSuppression?: boolean } = {};
    if (typeof p.echoCancellation === 'boolean') processing.echoCancellation = p.echoCancellation;
    if (typeof p.noiseSuppression === 'boolean') processing.noiseSuppression = p.noiseSuppression;

    // Tercihler ONCE yazilir: `setMicDevice` track'i yeniden alirken
    // `audioProcessingConstraints()` uzerinden bunlari okur, boylece iki
    // ayri getUserMedia cagrisi yapilmaz.
    if (Object.keys(processing).length && _rtcInstance) {
      if (typeof processing.echoCancellation === 'boolean') {
        _rtcInstance.echoCancellation = processing.echoCancellation;
      }
      if (typeof processing.noiseSuppression === 'boolean') {
        _rtcInstance.noiseSuppression = processing.noiseSuppression;
      }
    }

    if (micId) {
      void _rtcInstance?.setMicDevice(micId);
    } else if (Object.keys(processing).length) {
      void _rtcInstance?.setAudioProcessing(processing);
    }
  }) as unknown as (...args: unknown[]) => unknown);

  log.info('RTC motoru hazır');
  return _rtcInstance;
}

// Socket yaşam döngüsünün sahibi SocketManager'dır; burada yalnız hazır
// olduğu an yakalanır. Zaten bağlıysa hemen kurulur.
// Modül yüklenirken bir kez denenir (socket zaten bağlıysa hemen kurulur),
// değilse socket hazır olduğunda kurulur. `_rtcInstance` guard'ı sayesinde
// olay tekrarlansa da ikinci örnek oluşmaz.
if (typeof document !== 'undefined') {
  ensureRtc();
  // Remains installed for the auth-refresh path, where SocketManager creates a
  // new socket object later in the same application lifetime.
  document.addEventListener('bridge:socket-ready', () => { ensureRtc(); });
}

export { BridgeRTC };
export type { ScreenQuality };
