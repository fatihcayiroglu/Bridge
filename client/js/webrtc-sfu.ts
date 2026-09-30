// client/js/webrtc-sfu.ts
// Bridge WebRTC SFU Client — Mediasoup
// Sprint 33: Full TypeScript migration — strict types, no implicit any
//
// P2P yerine SFU (Selective Forwarding Unit) kullanır:
//   8 kullanıcı → 2 transport (1 send + 1 recv) = sabit, P2P'de 56 RTCPeerConnection

'use strict';

import type { BridgeSocket } from './webrtc-base';
// mediasoup-client is loaded on demand; the loader also unwraps the CommonJS
// namespace shape the production bundle produces (see the loader module).
import { loadMediasoupClient } from './core/mediasoup-client-loader.ts';
import { voicePanelAdapter, type VoicePanelAdapter } from './core/voice-panel-adapter.ts';
import { BridgeRegistry } from './core/bridge-registry.ts';
import { getAPI } from './core/globals.ts';
import { readToken } from './core/auth-compat.ts';
import { t } from './core/i18n/index';
import { SFU_SCREEN_PRESETS as SCREEN_PRESETS, SCREEN_BITRATES, normalizeScreenQuality, type ScreenQuality } from './core/rtc-screen-quality.ts';

import { createLogger } from './core/logger.ts';
const log = createLogger('SFU');


type ConnectableBridgeSocket = BridgeSocket & { connect(): BridgeSocket };
type IoFactory = (url: string, opts: Record<string, unknown>) => ConnectableBridgeSocket;
const SFU_SIGNAL_TIMEOUT_MS = 10_000;
const SFU_CAPABILITY_TIMEOUT_MS = 1_500;
// How long a lost media session keeps retrying before the call is ended.
// It must outlive an SFU owner's liveness lease (SFU_NODE_LEASE_MS, 30 s)
// plus the registry settle window so a surviving node can take the room over.
const SFU_RECOVERY_WINDOW_MS = 90_000;
const SFU_RECOVERY_MAX_BACKOFF_MS = 8_000;
// A session that the server refused (authorization, invalid room) is never
// retried: recovery goes through the same checks as a manual join.
const SFU_TERMINAL_CODES = new Set(['FORBIDDEN', 'INVALID_ROOM', 'INVALID_JOIN', 'SESSION_MISMATCH']);
// Only transport-level socket losses are recovered. A server- or client-
// initiated disconnect (revocation, logout, replacement) ends the call.
const TRANSIENT_DISCONNECT_REASONS = new Set(['transport close', 'transport error', 'ping timeout']);

/**
 * Simulcast layers for a camera track, sized to what libwebrtc will actually
 * send. libwebrtc limits the layer count by capture resolution (fewer than
 * 960x540 pixels -> 2 layers, fewer than 480x270 -> 1) and, with explicit
 * scale factors, drops the TOP layers. The old fixed /4 /2 /1 set therefore
 * never sent the full-resolution layer of a default 640x480 camera:
 * receivers topped out at 320x240 (measured in the P2 media lab).
 */
export function cameraSimulcastEncodings(track: Pick<MediaStreamTrack, 'getSettings'>): RTCRtpEncodingParameters[] {
  const { width = 640, height = 480 } = track.getSettings?.() ?? {};
  const pixels = width * height;
  if (pixels >= 960 * 540) {
    return [
      { maxBitrate: 100_000, scaleResolutionDownBy: 4 },
      { maxBitrate: 300_000, scaleResolutionDownBy: 2 },
      { maxBitrate: 900_000 },
    ];
  }
  if (pixels >= 480 * 270) {
    return [
      { maxBitrate: 200_000, scaleResolutionDownBy: 2 },
      { maxBitrate: 900_000 },
    ];
  }
  return [{ maxBitrate: 900_000 }];
}

/** An `sfu:error` as an Error whose name carries the server's code. */
function sfuError(data: { message?: unknown; code?: unknown }, fallback: string): Error {
  const error = new Error(typeof data.message === 'string' ? data.message : fallback);
  if (typeof data.code === 'string') error.name = `SfuError:${data.code}`;
  return error;
}

function isSignalingTimeout(err: unknown): boolean {
  return err instanceof Error && /timed out|timeout/i.test(err.message) && !err.name.startsWith('SfuError:');
}

function isTerminalSfuError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  return name.startsWith('SfuError:') && SFU_TERMINAL_CODES.has(name.slice('SfuError:'.length));
}

class SfuRedirectSignal extends Error {
  constructor(public readonly ownerNodeId: string | null, public readonly channelId: string) {
    super(`SFU room ${channelId} is owned by ${ownerNodeId ?? 'unknown'}`);
    this.name = 'SfuRedirectSignal';
  }
}



// ── Typed registry accessors (window.* yerine) ────────────────────────────────
interface BridgeNSModule { enabled?: boolean; process(stream: MediaStream): Promise<MediaStream>; }
interface BridgeVoiceE2EModule {
  initVoiceE2E(channelId: string | null, peers: PeerInfo[]): Promise<boolean>;
  renderVoiceE2EBadge(): void;
  registerSocketEvents(socket: BridgeSocket, userId: string): void;
}
interface VoiceActivityUIModule { init(socket: BridgeSocket): void; }
function _reg<T>(name: string): T | null {
  return BridgeRegistry.get<(...args: unknown[]) => unknown>(name) as T | null;
}
// Voice UI owner shared with the P2P engine; `bridgeApp` is never registered.
function _app(): VoicePanelAdapter { return voicePanelAdapter; }
function _ns(): BridgeNSModule | null         { return _reg<BridgeNSModule>('BridgeNS'); }
function _voiceE2E(): BridgeVoiceE2EModule | null  { return _reg<BridgeVoiceE2EModule>('BridgeVoiceE2E'); }
function _vaui(): VoiceActivityUIModule | null       { return _reg<VoiceActivityUIModule>('VoiceActivityUI'); }
function _startVAD(): ((stream: MediaStream, channelId: string) => void) | null {
  return _reg<(stream: MediaStream, channelId: string) => void>('_bridgeStartLocalVAD');
}
function _stopVAD(): (() => void) | null { return _reg<() => void>('_bridgeStopLocalVAD'); }
function _currentServerChannels(): Array<{ _id: string; bitrate?: number }> | null {
  const fn = BridgeRegistry.get<() => Array<{ _id: string; bitrate?: number }>>('currentServerChannels');
  return fn ? fn() : null;
}

// ── Domain types ──────────────────────────────────────────────────────────────
export interface PeerInfo {
  socketId: string;
  userId?: string;
  producers?: Array<{ producerId: string; kind: string }>;
}

/**
 * Remote media of one peer, one MediaStream per producer kind. The UI keys its
 * elements by stream: microphone and system audio are separate `<audio>`
 * elements, camera and screen separate views. Sharing one audio and one video
 * stream per peer merged system audio into the microphone element and let the
 * camera stand in for the screen (P2 voice-media suite).
 */
interface PeerStreams {
  audio: MediaStream;
  video: MediaStream;
  screen?: MediaStream;
  screenAudio?: MediaStream;
}

const peerStreamList = (streams: PeerStreams): MediaStream[] =>
  [streams.audio, streams.video, streams.screen, streams.screenAudio]
    .filter((stream): stream is MediaStream => Boolean(stream));

interface PeerState {
  muted?: boolean;
  deafened?: boolean;
  screensharing?: boolean;
  video?: boolean;
}

// ── Mediasoup client type stubs ───────────────────────────────────────────────
interface MediasoupTransport {
  on(event: string, fn: (...args: unknown[]) => void): void;
  close(): void;
  produce(opts: unknown): Promise<MediasoupProducer>;
  consume(opts: unknown): Promise<MediasoupConsumer>;
}

interface MediasoupProducer {
  on(event: string, fn: (...args: unknown[]) => void): void;
  close(): void;
  pause(): void;
  resume(): void;
  replaceTrack(opts: { track: MediaStreamTrack }): Promise<void>;
  readonly rtpParameters?: unknown;
}

interface MediasoupConsumer {
  on(event: string, fn: (...args: unknown[]) => void): void;
  close(): void;
  resume(): Promise<void> | void;
  track: MediaStreamTrack;
  readonly id: string;
  _socketId?: string;
}

interface MediasoupDevice {
  load(opts: { routerRtpCapabilities: unknown }): Promise<void>;
  createSendTransport(opts: unknown): MediasoupTransport;
  createRecvTransport(opts: unknown): MediasoupTransport;
  rtpCapabilities: unknown;
}


// ══════════════════════════════════════════════════════════════════════════════
// BridgeRTC — SFU WebRTC Manager (drop-in replacement for webrtc.ts)
// ══════════════════════════════════════════════════════════════════════════════
class BridgeRTC {
  /** Main application socket. P2P mode always uses this connection. */
  readonly socket: BridgeSocket;
  /** Canonical SFU signaling socket. It may be a node-targeted connection. */
  private _sfuSocket: BridgeSocket;
  private _dedicatedSfuSocket: BridgeSocket | null = null;
  device: MediasoupDevice | null           = null;
  sendTransport: MediasoupTransport | null = null;
  recvTransport: MediasoupTransport | null = null;
  producers: Map<string, MediasoupProducer>          = new Map();
  consumers: Map<string, MediasoupConsumer>          = new Map();
  peerStreams: Map<string, PeerStreams> = new Map();
  localStream: MediaStream | null          = null;
  screenStream: MediaStream | null         = null;
  currentChannelId: string | null          = null;
  currentServerId: string | null           = null;
  muted                                    = false;
  deafened                                 = false;
  videoOn                                  = false;
  screenSharing                            = false;
  /** True only when getDisplayMedia returned a live audio track that Bridge is actually publishing. */
  screenAudioActive                        = false;
  selectedMicId: string | null             = null;
  selectedCameraId: string | null          = null;
  selectedSpeakerId: string | null         = null;
  channelBitrate                           = 64_000;

  // P2P fallback state
  peers: Map<string, RTCPeerConnection>    = new Map();

  private _sfuAvailable                                              = false;
  echoCancellation                                                    = true;
  noiseSuppression                                                    = true;
  autoGainControl                                                     = true;
  private _iceServers: RTCIceServer[]                                = [];
  private _iceTransportPolicy: RTCIceTransportPolicy                 = 'all';
  private _socketToUserId: Map<string, string>                       = new Map();
  private _redirectCount                                             = 0;
  private _screenQuality: ScreenQuality                              = 'hd';
  private _mobileAudioOverride: Partial<MediaTrackConstraints> | false = false;
  private _sessionGeneration                                         = 0;
  private _videoGeneration                                           = 0;
  private _screenGeneration                                          = 0;
  private _sfuRequestSeq                                             = 0;
  private _socketHandlers: Array<{ socket: BridgeSocket; event: string; handler: (...args: unknown[]) => void }> = [];
  // Producers announced before this client's receive transport exists: the
  // existing peers listed in `sfu:joined`, or a `sfu:new-producer` that races
  // transport setup. They are consumed as soon as the transport is ready.
  private _pendingConsumes: Array<{ producerId: string; socketId: string; kind: string }> = [];
  // Media session recovery: a lost SFU session (ICE failure, or the socket
  // carrying SFU signaling dropped) is re-established through the normal,
  // fully re-authorized join path instead of leaving a dead call on screen.
  private _recovery: Promise<void> | null = null;
  // Set while we deliberately close a stale signaling transport: Socket.IO
  // reports that as 'forced close', which must not end the call.
  private _forcedSignalingClose = false;
  // Socket id that carried the current SFU session; a recovery join names it
  // so the owner drops that (same-user) peer instead of keeping a ghost.
  private _sfuSessionSocketId: string | null = null;

  constructor(socket: BridgeSocket) {
    this.socket = socket;
    this._sfuSocket = socket;
    // Do not activate SFU merely because a client library happens to exist.
    // The server may intentionally run without the optional mediasoup runtime.
    // `joinVoice()` negotiates the capability first and otherwise stays P2P.
    this._sfuAvailable = false;
    this._bindSocketEvents(socket);
  }

  private _resetDedicatedSfuSocket(): void {
    if (this._dedicatedSfuSocket) {
      this._detachSocketHandlers(this._dedicatedSfuSocket);
      try { this._dedicatedSfuSocket.disconnect(); } catch { /* already closed */ }
    }
    this._dedicatedSfuSocket = null;
    this._sfuSocket = this.socket;
  }

  private _onSocket(socket: BridgeSocket, event: string, handler: (...args: unknown[]) => void): void {
    socket.on(event, handler);
    this._socketHandlers.push({ socket, event, handler });
  }

  private _detachSocketHandlers(target?: BridgeSocket): void {
    const keep: typeof this._socketHandlers = [];
    for (const owned of this._socketHandlers) {
      if (!target || owned.socket === target) owned.socket.off(owned.event, owned.handler);
      else keep.push(owned);
    }
    this._socketHandlers = keep;
  }

  private _assertSessionGeneration(generation: number): void {
    if (generation === this._sessionGeneration) return;
    const error = new Error('SFU join cancelled: voice session changed');
    error.name = 'AbortError';
    throw error;
  }

  private _nextSfuRequestId(operation: string): string {
    this._sfuRequestSeq = (this._sfuRequestSeq + 1) % 1_000_000_000;
    return `${operation}:${this._sessionGeneration}:${this._sfuRequestSeq}`;
  }

  private _waitForEvent<T>(
    socket: BridgeSocket,
    event: string,
    predicate: (payload: T) => boolean = () => true,
    timeoutMs = SFU_SIGNAL_TIMEOUT_MS,
    scope?: { requestId?: string; operation?: string },
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        socket.off(event, onEvent as (...args: unknown[]) => void);
        socket.off('sfu:error', onError as (...args: unknown[]) => void);
      };
      const onEvent = (raw: unknown): void => {
        const payload = raw as T;
        if (!predicate(payload)) return;
        cleanup();
        resolve(payload);
      };
      const onError = (raw: unknown): void => {
        const data = raw as { requestId?: unknown; operation?: unknown; message?: unknown; code?: unknown };
        // New servers scope errors to the request that caused them. Ignore a
        // sibling consume/transport failure instead of rejecting the wrong
        // waiter. Unscoped legacy errors are still accepted for compatibility.
        if (scope?.requestId && typeof data.requestId === 'string' && data.requestId !== scope.requestId) return;
        if (scope?.operation && typeof data.operation === 'string' && data.operation !== scope.operation) return;
        cleanup();
        const message = typeof data.message === 'string' && data.message.length <= 180
          ? data.message
          : 'Ses bağlantısı tamamlanamadı.';
        const error = new Error(message);
        error.name = typeof data.code === 'string' ? `SfuError:${data.code}` : 'SfuError';
        reject(error);
      };
      socket.on(event, onEvent as (...args: unknown[]) => void);
      socket.on('sfu:error', onError as (...args: unknown[]) => void);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`SFU signaling timeout: ${event}`));
      }, timeoutMs);
    });
  }

  private _waitForRtpCapabilities(
    socket: BridgeSocket,
    channelId: string,
  ): Promise<{ rtpCapabilities: unknown }> {
    const requestId = this._nextSfuRequestId('capabilities');
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        socket.off('sfu:rtp-capabilities', onCaps as (...args: unknown[]) => void);
        socket.off('sfu:redirect', onRedirect as (...args: unknown[]) => void);
        socket.off('sfu:error', onError as (...args: unknown[]) => void);
      };
      const onCaps = (raw: unknown): void => {
        const data = raw as { requestId?: unknown; rtpCapabilities: unknown };
        if (typeof data.requestId === 'string' && data.requestId !== requestId) return;
        cleanup();
        resolve({ rtpCapabilities: data.rtpCapabilities });
      };
      const onRedirect = (raw: unknown): void => {
        const data = raw as { channelId?: string; ownerNodeId?: string | null };
        if (data.channelId && data.channelId !== channelId) return;
        if (typeof (raw as { requestId?: unknown }).requestId === 'string' && (raw as { requestId: string }).requestId !== requestId) return;
        cleanup();
        reject(new SfuRedirectSignal(data.ownerNodeId ?? null, channelId));
      };
      const onError = (raw: unknown): void => {
        const data = raw as { requestId?: unknown; operation?: unknown; message?: unknown; code?: unknown };
        if (typeof data.requestId === 'string' && data.requestId !== requestId) return;
        if (typeof data.operation === 'string' && data.operation !== 'capabilities') return;
        cleanup();
        reject(sfuError(data, 'Ses altyapısı kullanılamıyor.'));
      };
      socket.on('sfu:rtp-capabilities', onCaps as (...args: unknown[]) => void);
      socket.on('sfu:redirect', onRedirect as (...args: unknown[]) => void);
      socket.on('sfu:error', onError as (...args: unknown[]) => void);
      timer = setTimeout(() => { cleanup(); reject(new Error('SFU RTP capability request timed out')); }, SFU_SIGNAL_TIMEOUT_MS);
      socket.emit('sfu:get-rtp-capabilities', { channelId, requestId });
    });
  }

  private _waitForSfuJoin(
    socket: BridgeSocket,
    channelId: string,
    requestId: string,
  ): Promise<{ existingPeers: PeerInfo[] }> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        socket.off('sfu:joined', onJoined as (...args: unknown[]) => void);
        socket.off('sfu:redirect', onRedirect as (...args: unknown[]) => void);
        socket.off('sfu:error', onError as (...args: unknown[]) => void);
      };
      const onJoined = (raw: unknown): void => {
        const data = raw as { requestId?: unknown; existingPeers: PeerInfo[] };
        if (typeof data.requestId === 'string' && data.requestId !== requestId) return;
        cleanup();
        resolve({ existingPeers: data.existingPeers });
      };
      const onRedirect = (raw: unknown): void => {
        const data = raw as { channelId?: string; ownerNodeId?: string | null };
        if (data.channelId && data.channelId !== channelId) return;
        if (typeof (raw as { requestId?: unknown }).requestId === 'string' && (raw as { requestId: string }).requestId !== requestId) return;
        cleanup();
        reject(new SfuRedirectSignal(data.ownerNodeId ?? null, channelId));
      };
      const onError = (raw: unknown): void => {
        const data = raw as { requestId?: unknown; operation?: unknown; message?: unknown; code?: unknown };
        if (typeof data.requestId === 'string' && data.requestId !== requestId) return;
        if (typeof data.operation === 'string' && data.operation !== 'join') return;
        cleanup();
        reject(sfuError(data, 'Ses kanalına katılım tamamlanamadı.'));
      };
      socket.on('sfu:joined', onJoined as (...args: unknown[]) => void);
      socket.on('sfu:redirect', onRedirect as (...args: unknown[]) => void);
      socket.on('sfu:error', onError as (...args: unknown[]) => void);
      timer = setTimeout(() => { cleanup(); reject(new Error('SFU join timed out')); }, SFU_SIGNAL_TIMEOUT_MS);
    });
  }

  private async _connectSfuOwner(ownerNodeId: string | null): Promise<void> {
    if (!ownerNodeId || !/^[A-Za-z0-9._-]{1,64}$/.test(ownerNodeId)) {
      throw new Error('SFU owner node id is missing or invalid');
    }
    const io = (globalThis as { io?: IoFactory }).io;
    const token = readToken();
    if (typeof io !== 'function' || !token) throw new Error('SFU owner connection cannot be authenticated');

    this._resetDedicatedSfuSocket();
    const targeted = io(getAPI(), {
      auth: { token },
      transports: ['websocket', 'polling'],
      forceNew: true,
      // Register auth/error listeners before opening the transport. A fast
      // owner node can otherwise emit userAuthenticated synchronously enough
      // for this redirect flow to miss it and time out despite being connected.
      autoConnect: false,
      // HAProxy only routes a closed set of INSTANCE_ID values; the server also
      // verifies this query against its own INSTANCE_ID before JWT auth.
      query: { bridgeNode: ownerNodeId },
    });
    this._dedicatedSfuSocket = targeted;
    this._sfuSocket = targeted;
    this._bindSocketEvents(targeted);

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        targeted.off('userAuthenticated', onReady as (...args: unknown[]) => void);
        targeted.off('connect_error', onError as (...args: unknown[]) => void);
      };
      const onReady = (): void => { cleanup(); resolve(); };
      const onError = (raw: unknown): void => {
        cleanup();
        reject(raw instanceof Error ? raw : new Error('SFU owner socket connection failed'));
      };
      targeted.on('userAuthenticated', onReady as (...args: unknown[]) => void);
      targeted.on('connect_error', onError as (...args: unknown[]) => void);
      timer = setTimeout(() => { cleanup(); reject(new Error('SFU owner socket authentication timed out')); }, SFU_SIGNAL_TIMEOUT_MS);
      targeted.connect();
    }).catch(err => {
      this._resetDedicatedSfuSocket();
      throw err;
    });
  }

  private _negotiateSfuCapability(): Promise<boolean> {
    if (!this.socket.connected) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        this.socket.off('voice:capabilities', onCapabilities as (...args: unknown[]) => void);
        this.socket.off('disconnect', onDisconnect as (...args: unknown[]) => void);
      };
      const finish = (available: boolean): void => { cleanup(); resolve(available); };
      const onCapabilities = (raw: unknown): void => {
        const data = raw as { sfu?: unknown };
        finish(data?.sfu === true);
      };
      const onDisconnect = (): void => finish(false);
      this.socket.on('voice:capabilities', onCapabilities as (...args: unknown[]) => void);
      this.socket.on('disconnect', onDisconnect as (...args: unknown[]) => void);
      timer = setTimeout(() => finish(false), SFU_CAPABILITY_TIMEOUT_MS);
      this.socket.emit('voice:get-capabilities', {});
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  isInVoice(): boolean                  { return !!this.currentChannelId; }
  getLocalStream(): MediaStream | null  { return this.localStream; }

  async getDevices(): Promise<{ microphones: MediaDeviceInfo[]; speakers: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }> {
    let permissionStream: MediaStream | null = null;
    try {
      permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        microphones: devices.filter(d => d.kind === 'audioinput'),
        speakers:    devices.filter(d => d.kind === 'audiooutput'),
        cameras:     devices.filter(d => d.kind === 'videoinput'),
      };
    } catch { return { microphones: [], speakers: [], cameras: [] }; }
    finally { permissionStream?.getTracks().forEach(track => track.stop()); }
  }

  loadSavedDevices(): void {
    const read = (canonical: string, legacy: string): string | null =>
      localStorage.getItem(canonical) || localStorage.getItem(legacy);
    this.selectedMicId     = read('bridge:device:mic', 'bridge-mic');
    this.selectedCameraId  = read('bridge:device:camera', 'bridge-camera');
    this.selectedSpeakerId = read('bridge:device:speaker', 'bridge-speaker');
    this.echoCancellation  = localStorage.getItem('bridge:device:echo')  !== 'false';
    this.noiseSuppression  = localStorage.getItem('bridge:device:noise') !== 'false';
    this.autoGainControl   = localStorage.getItem('bridge:device:gain')  !== 'false';
  }

  audioProcessingConstraints(): MediaTrackConstraints {
    return {
      echoCancellation: this.echoCancellation,
      noiseSuppression: this.noiseSuppression,
      autoGainControl: this.autoGainControl,
      sampleRate: 48_000,
    };
  }

  // ── Join voice ────────────────────────────────────────────────────────────
  async joinVoice(channelId: string, serverId: string): Promise<void> {
    if (this.currentChannelId === channelId) return;
    if (this.currentChannelId) this.leaveVoice();
    if (!this.socket.connected) {
      const error = new Error('Voice join cancelled: socket disconnected');
      error.name = 'AbortError';
      throw error;
    }

    const generation = ++this._sessionGeneration;
    this._resetDedicatedSfuSocket();
    this.currentChannelId = channelId;
    this.currentServerId  = serverId;
    this.channelBitrate   = 64_000;

    const _channels = _currentServerChannels();
    if (_channels) {
      const ch = _channels.find(c => c._id === channelId);
      if (ch?.bitrate) this.channelBitrate = ch.bitrate as number;
    }

    // Capability negotiation is intentionally fail-open to P2P: an older
    // server, a server without mediasoup, or a transient capability timeout
    // must never turn a working P2P call into a dead SFU join.
    this._sfuAvailable = await this._negotiateSfuCapability();
    if (generation !== this._sessionGeneration || !this.socket.connected) return;

    let rawStream: MediaStream | null = null;
    try {
      const _nsModule = _ns();
      const nsEnabled = _nsModule?.enabled !== false;
      const audioConstraints: MediaTrackConstraints = {
        ...(this.selectedMicId ? { deviceId: { exact: this.selectedMicId } } : {}),
        echoCancellation: this.echoCancellation && nsEnabled,
        noiseSuppression: this.noiseSuppression && nsEnabled,
        autoGainControl: this.autoGainControl, sampleRate: 48000, channelCount: 2,
      };
      rawStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      const stream = _nsModule ? await _nsModule.process(rawStream) : rawStream;
      if (generation !== this._sessionGeneration) {
        stream.getTracks().forEach(track => track.stop());
        if (stream !== rawStream) rawStream.getTracks().forEach(track => track.stop());
        return;
      }
      this.localStream = stream;
    } catch {
      rawStream?.getTracks().forEach(track => track.stop());
      if (generation !== this._sessionGeneration) return;
      this.localStream = new MediaStream();
      _app()?.toast(t('rtc_no_mic', 'Mikrofon bulunamadı — sessiz katılındı'), 'error');
    }

    if (this._sfuAvailable) {
      try {
        await this._sfuJoin(channelId, serverId, generation);
        if (generation !== this._sessionGeneration) {
          // An explicit leave has already cleaned this attempt. Clean once more
          // only when it is still departed, because a replacement join owns the
          // shared state now and must not be torn down by the older promise.
          if (!this.currentChannelId) this._cleanupVoiceState();
          return;
        }
      } catch (err) {
        if (generation !== this._sessionGeneration) return;
        this._cleanupVoiceState();
        throw err;
      }
    } else {
      log.info('[BridgeRTC] SFU sunucuda kullanılamıyor — P2P moda geçiliyor');
      this.socket.emit('voice:join', { channelId, serverId });
    }

    _vaui()?.init(this._sfuAvailable ? this._sfuSocket : this.socket);
    if (this.localStream) _startVAD()?.(this.localStream, channelId);
  }

  // ── SFU join flow ─────────────────────────────────────────────────────────
  private async _sfuJoin(
    channelId: string,
    serverId: string,
    sessionGeneration = this._sessionGeneration,
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      this._assertSessionGeneration(sessionGeneration);
      const signalingSocket = this._sfuSocket;
      try {
        const { rtpCapabilities } = await this._waitForRtpCapabilities(signalingSocket, channelId);
        this._assertSessionGeneration(sessionGeneration);
        // A redirect swaps `_sfuSocket`; never continue a stale attempt on the
        // previous node after awaiting network work.
        if (signalingSocket !== this._sfuSocket) continue;

        const { Device } = await loadMediasoupClient();
        this._assertSessionGeneration(sessionGeneration);
        const device = new Device() as unknown as MediasoupDevice;
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        this._assertSessionGeneration(sessionGeneration);
        this.device = device;

        // Server join performs async permission/membership checks. Wait until
        // the peer exists before asking for transports; the previous fire-and-
        // immediately-create flow could lose the transport request.
        const joinRequestId = this._nextSfuRequestId('join');
        const joined = this._waitForSfuJoin(signalingSocket, channelId, joinRequestId);
        const replaces = this._sfuSessionSocketId && this._sfuSessionSocketId !== signalingSocket.id
          ? this._sfuSessionSocketId : undefined;
        signalingSocket.emit('sfu:join', {
          channelId, serverId, rtpCapabilities: this.device.rtpCapabilities, requestId: joinRequestId,
          ...(replaces ? { replaces } : {}),
        });
        await joined;
        this._assertSessionGeneration(sessionGeneration);
        if (signalingSocket !== this._sfuSocket) continue;

        await this._createSendTransport(channelId, sessionGeneration);
        this._assertSessionGeneration(sessionGeneration);
        await this._createRecvTransport(channelId, sessionGeneration);
        this._assertSessionGeneration(sessionGeneration);
        await this._consumePending(sessionGeneration);
        this._sfuSessionSocketId = signalingSocket.id ?? null;
        this._redirectCount = 0;
        return;
      } catch (e) {
        if (e instanceof SfuRedirectSignal) {
          this._redirectCount++;
          log.warn(`[SFU] Oda ${channelId} ${e.ownerNodeId ?? '?'} node'unda; targeted signaling açılıyor`);
          await this._connectSfuOwner(e.ownerNodeId);
          continue;
        }
        log.error('[SFU] join error:', e);
        throw e;
      }
    }
    this._redirectCount = 0;
    throw new Error('Ses kanalı yönlendirmesi tamamlanamadı.');
  }

  /**
   * STUN/TURN servers and the relay policy the server issued in `sfu:joined`
   * (FORCE_TURN -> 'relay'). mediasoup is ICE-lite: a client whose network
   * cannot reach the SFU's media ports directly only gets media through a
   * TURN relay candidate of its own. The transports used to be created
   * without these, so TURN was never used for SFU media (P2 media lab).
   */
  private _transportIceOptions(): { iceServers?: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy } {
    return {
      ...(this._iceServers.length ? { iceServers: this._iceServers } : {}),
      iceTransportPolicy: this._iceTransportPolicy,
    };
  }

  private async _createSendTransport(channelId: string, sessionGeneration?: number): Promise<void> {
    const socket = this._sfuSocket;
    const device = this.device;
    const createRequestId = this._nextSfuRequestId('create-transport');
    const created = this._waitForEvent<{
      direction: string; id: string; iceParameters: unknown; iceCandidates: unknown; dtlsParameters: unknown;
    }>(socket, 'sfu:transport-created', d => d.direction === 'send', SFU_SIGNAL_TIMEOUT_MS, {
      requestId: createRequestId, operation: 'create-transport',
    });
    socket.emit('sfu:create-transport', { channelId, direction: 'send', requestId: createRequestId });
    const data = await created;
    if (socket !== this._sfuSocket) throw new Error('SFU signaling socket changed during send transport creation');
    if (sessionGeneration !== undefined) this._assertSessionGeneration(sessionGeneration);

    const sendTransport = device!.createSendTransport({
      id: data.id, iceParameters: data.iceParameters,
      iceCandidates: data.iceCandidates, dtlsParameters: data.dtlsParameters,
      ...this._transportIceOptions(),
    });
    this.sendTransport = sendTransport;
    this._watchTransport(sendTransport, sessionGeneration);

    sendTransport.on('connect', async (args: unknown, cb: unknown, errback: unknown) => {
      try {
        const { dtlsParameters } = args as { dtlsParameters: unknown };
        const requestId = this._nextSfuRequestId('connect-transport');
        const connected = this._waitForEvent<{ direction: string }>(
          socket, 'sfu:transport-connected', d => d.direction === 'send', SFU_SIGNAL_TIMEOUT_MS,
          { requestId, operation: 'connect-transport' },
        );
        socket.emit('sfu:connect-transport', { channelId, direction: 'send', dtlsParameters, requestId });
        await connected;
        (cb as () => void)();
      } catch (e) {
        if (typeof errback === 'function') (errback as (err: Error) => void)(e instanceof Error ? e : new Error(String(e)));
      }
    });

    sendTransport.on('produce', async (args: unknown, cb: unknown, errback: unknown) => {
      try {
        const { kind, rtpParameters, appData } = args as { kind: string; rtpParameters: unknown; appData?: Record<string, unknown> };
        const expectedKind = appData?.screenAudio ? 'screen-audio' : (appData?.screen ? 'screen' : kind);
        const requestId = this._nextSfuRequestId('produce');
        const produced = this._waitForEvent<{ producerId: string; kind?: string }>(
          socket, 'sfu:produced', d => !d.kind || d.kind === expectedKind, SFU_SIGNAL_TIMEOUT_MS,
          { requestId, operation: 'produce' },
        );
        socket.emit('sfu:produce', { channelId, kind, rtpParameters, appData, requestId });
        const { producerId } = await produced;
        (cb as (opts: { id: string }) => void)({ id: producerId });
      } catch (e) {
        if (typeof errback === 'function') (errback as (err: Error) => void)(e instanceof Error ? e : new Error(String(e)));
      }
    });

    await this._produceAudio(sessionGeneration, sendTransport);
    if (sessionGeneration !== undefined && sessionGeneration !== this._sessionGeneration) {
      sendTransport.close();
      if (this.sendTransport === sendTransport) this.sendTransport = null;
      this._assertSessionGeneration(sessionGeneration);
    }
  }

  private async _createRecvTransport(channelId: string, sessionGeneration?: number): Promise<void> {
    const socket = this._sfuSocket;
    const device = this.device;
    const createRequestId = this._nextSfuRequestId('create-transport');
    const created = this._waitForEvent<{
      direction: string; id: string; iceParameters: unknown; iceCandidates: unknown; dtlsParameters: unknown;
    }>(socket, 'sfu:transport-created', d => d.direction === 'recv', SFU_SIGNAL_TIMEOUT_MS, {
      requestId: createRequestId, operation: 'create-transport',
    });
    socket.emit('sfu:create-transport', { channelId, direction: 'recv', requestId: createRequestId });
    const data = await created;
    if (socket !== this._sfuSocket) throw new Error('SFU signaling socket changed during receive transport creation');
    if (sessionGeneration !== undefined) this._assertSessionGeneration(sessionGeneration);

    const recvTransport = device!.createRecvTransport({
      id: data.id, iceParameters: data.iceParameters,
      iceCandidates: data.iceCandidates, dtlsParameters: data.dtlsParameters,
      ...this._transportIceOptions(),
    });
    this.recvTransport = recvTransport;
    this._watchTransport(recvTransport, sessionGeneration);

    recvTransport.on('connect', async (args: unknown, cb: unknown, errback: unknown) => {
      try {
        const { dtlsParameters } = args as { dtlsParameters: unknown };
        const requestId = this._nextSfuRequestId('connect-transport');
        const connected = this._waitForEvent<{ direction: string }>(
          socket, 'sfu:transport-connected', d => d.direction === 'recv', SFU_SIGNAL_TIMEOUT_MS,
          { requestId, operation: 'connect-transport' },
        );
        socket.emit('sfu:connect-transport', { channelId, direction: 'recv', dtlsParameters, requestId });
        await connected;
        (cb as () => void)();
      } catch (e) {
        if (typeof errback === 'function') (errback as (err: Error) => void)(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private async _produceAudio(
    sessionGeneration?: number,
    sendTransport = this.sendTransport,
  ): Promise<void> {
    const localStream = this.localStream;
    if (!sendTransport || !localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return;
    try {
      const producer = await sendTransport.produce({
        track: audioTrack,
        // The app owns capture tracks (leave, device switch and camera/screen
        // stop all stop them explicitly). mediasoup-client's default would
        // stop the microphone whenever its producer or transport closes, so a
        // session recovery had nothing left to publish (P2 media lab).
        stopTracks: false,
        codecOptions: {
          opusStereo: true, opusDtx: true, opusFec: true,
          opusPtime: 20, opusMaxPlaybackRate: 48000,
        },
      });
      if ((sessionGeneration !== undefined && sessionGeneration !== this._sessionGeneration) ||
          sendTransport !== this.sendTransport || localStream !== this.localStream) {
        producer.close();
        return;
      }
      producer.on('trackended', () => this._onMicrophoneLost());
      this.producers.set('audio', producer);
    } catch (e) { log.error('[SFU] audio produce error:', e); }
  }

  // ── Consume ───────────────────────────────────────────────────────────────
  private async _consume(producerId: string, socketId: string, kind: string): Promise<MediasoupConsumer | null> {
    if (!this.recvTransport || !this.device) {
      // The join flow creates the receive transport only AFTER `sfu:joined`.
      // Dropping these producers made a late joiner deaf to everyone already
      // in the room (measured with real browsers in the P2 media lab).
      if (this.currentChannelId && !this._pendingConsumes.some(p => p.producerId === producerId)) {
        this._pendingConsumes.push({ producerId, socketId, kind });
      }
      return null;
    }
    const socket = this._sfuSocket;

    try {
      const requestId = this._nextSfuRequestId('consume');
      const consumed = this._waitForEvent<{
        producerId: string; consumerId: string; kind: string; rtpParameters: unknown;
      }>(socket, 'sfu:consumed', d => d.producerId === producerId, SFU_SIGNAL_TIMEOUT_MS, {
        requestId, operation: 'consume',
      });
      socket.emit('sfu:consume', {
        channelId: this.currentChannelId, producerId,
        rtpCapabilities: this.device.rtpCapabilities, requestId,
      });
      const d = await consumed;
      if (socket !== this._sfuSocket || !this.recvTransport) return null;

      const consumer = await this.recvTransport.consume({
        id: d.consumerId, producerId: d.producerId,
        kind: d.kind, rtpParameters: d.rtpParameters,
      });
      consumer._socketId = socketId;
      this.consumers.set(producerId, consumer);

      const targetStream = this._peerStream(socketId, kind, consumer.track.kind);
      targetStream.addTrack(consumer.track);

      _app()?.attachRemoteStream(socketId, targetStream, kind);

      if (kind === 'video' || kind === 'screen') {
        const peerUserId = this._socketToUserId.get(socketId);
        _app().sfuHandleNewProducer(socketId, peerUserId, targetStream, kind);
      }

      socket.emit('sfu:resume-consumer', { producerId, requestId: this._nextSfuRequestId('resume-consumer') });
      await consumer.resume?.();
      return consumer;
    } catch (e) {
      log.error('[SFU] consume error:', e);
      return null;
    }
  }

  private async _consumePending(sessionGeneration: number): Promise<void> {
    const pending = this._pendingConsumes.splice(0);
    for (const { producerId, socketId, kind } of pending) {
      if (sessionGeneration !== this._sessionGeneration) return;
      await this._consume(producerId, socketId, kind);
    }
  }

  // ── Media session recovery ────────────────────────────────────────────────
  /**
   * ICE on a transport that reaches `failed` does not come back by itself
   * (it did not in the P2 media lab: TURN restart, long WAN loss, worker or
   * owner death). The call used to stay on screen with no media.
   */
  private _watchTransport(transport: MediasoupTransport, sessionGeneration?: number): void {
    transport.on('connectionstatechange', (state: unknown) => {
      if (state !== 'failed') return;
      if (sessionGeneration !== undefined && sessionGeneration !== this._sessionGeneration) return;
      if (transport !== this.sendTransport && transport !== this.recvTransport) return;
      this._recoverSession('transport-failed');
    });
  }

  private _recoverSession(reason: string): void {
    if (this._recovery || !this.currentChannelId || !this._sfuAvailable) return;
    const channelId = this.currentChannelId;
    const serverId = this.currentServerId ?? '';
    const generation = this._sessionGeneration;
    log.warn(`[SFU] media session lost (${reason}); re-establishing`);
    document.dispatchEvent(new CustomEvent('bridge:voice-reconnecting', { detail: { reason } }));
    this._recovery = this._runRecovery(channelId, serverId, generation)
      .catch(err => log.error('[SFU] recovery error:', err))
      .finally(() => { this._recovery = null; });
  }

  private async _runRecovery(channelId: string, serverId: string, generation: number): Promise<void> {
    const deadline = Date.now() + SFU_RECOVERY_WINDOW_MS;
    let backoff = 0;
    for (let attempt = 1; Date.now() < deadline; attempt++) {
      if (backoff) await new Promise(r => setTimeout(r, backoff));
      if (generation !== this._sessionGeneration) return;
      backoff = Math.min(SFU_RECOVERY_MAX_BACKOFF_MS, backoff ? backoff * 2 : 1_000);
      if (!await this._waitForMainSocket(deadline - Date.now())) break;
      if (generation !== this._sessionGeneration) return;
      try {
        this._teardownMediaForRecovery();
        const known = new Set(this.peerStreams.keys());
        await this._sfuJoin(channelId, serverId, generation);
        // Peers that were not in the fresh roster left while we were away.
        for (const socketId of known) {
          if (this._socketToUserId.has(socketId)) continue;
          this._cleanupPeerStreams(socketId);
          _app().removeVoicePeer(socketId);
        }
        await this._restoreLocalMedia(generation);
        _vaui()?.init(this._sfuSocket);
        log.info(`[SFU] media session re-established (attempt ${attempt})`);
        document.dispatchEvent(new CustomEvent('bridge:voice-reconnected', { detail: { attempt } }));
        return;
      } catch (err) {
        if (generation !== this._sessionGeneration) return;
        if (isTerminalSfuError(err)) {
          log.warn('[SFU] recovery refused by the server; leaving the call', err);
          break;
        }
        log.warn(`[SFU] recovery attempt ${attempt} failed`, err);
        if (isSignalingTimeout(err)) this._reconnectStaleSignaling();
      }
    }
    if (generation !== this._sessionGeneration) return;
    this._cleanupVoiceState();
    document.dispatchEvent(new CustomEvent('bridge:voice-left', { detail: { reason: 'media-session-lost' } }));
    _app().toast(t('rtc_session_lost', 'Ses bağlantısı kurtarılamadı — kanaldan çıkıldı.'), 'error');
  }

  /**
   * A signaling request that times out on a socket that still reports
   * `connected` means its transport is dead — typically the client's address
   * changed (Wi-Fi -> cellular). Close that transport so Socket.IO reconnects
   * now instead of after its ~45 s ping timeout (measured in the P2 lab: a
   * handoff took ~55 s to recover without this).
   */
  private _reconnectStaleSignaling(): void {
    if (this._dedicatedSfuSocket) this._resetDedicatedSfuSocket();
    const engine = (this.socket as unknown as { io?: { engine?: { close?: () => void } } }).io?.engine;
    if (this.socket.connected && engine?.close) {
      this._forcedSignalingClose = true;
      engine.close();
    }
  }

  /** Resolves true once the main socket is connected and authenticated. */
  private _waitForMainSocket(timeoutMs: number): Promise<boolean> {
    if (this.socket.connected) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        this.socket.off('userAuthenticated', onReady as (...args: unknown[]) => void);
        resolve(ok);
      };
      const onReady = (): void => done(true);
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      this.socket.on('userAuthenticated', onReady as (...args: unknown[]) => void);
    });
  }

  /**
   * Drop the SFU state (transports, producers, consumers) but keep the local
   * capture tracks and the remote MediaStream objects the UI already renders,
   * so a re-established consumer lands in the same element.
   */
  private _teardownMediaForRecovery(): void {
    this._pendingConsumes = [];
    for (const c of this.consumers.values()) c.close?.();
    for (const p of this.producers.values()) p.close?.();
    this.consumers.clear();
    this.producers.clear();
    for (const streams of this.peerStreams.values()) {
      for (const stream of peerStreamList(streams)) {
        for (const track of stream.getTracks()) { track.stop(); stream.removeTrack(track); }
      }
    }
    this._socketToUserId.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;
    if (this._dedicatedSfuSocket && !this._dedicatedSfuSocket.connected) this._resetDedicatedSfuSocket();
  }

  /** Re-publish what the user was publishing before the session was lost. */
  private async _restoreLocalMedia(generation: number): Promise<void> {
    const transport = this.sendTransport;
    if (!transport) return;
    if (this.muted) this.producers.get('audio')?.pause();
    const camera = this.localStream?.getVideoTracks().find(track => track.readyState === 'live');
    if (this.videoOn && camera) {
      const producer = await this._produceCamera(transport, camera);
      if (generation !== this._sessionGeneration) { producer.close(); return; }
      producer.on('trackended', () => { void this.enableVideo(false); });
      this.producers.set('video', producer);
    } else {
      this.videoOn = false;
    }
    const screen = this.screenStream?.getVideoTracks().find(track => track.readyState === 'live');
    if (this.screenSharing && screen) {
      const producer = await this._produceScreen(transport, screen);
      if (generation !== this._sessionGeneration) { producer.close(); return; }
      producer.on('trackended', () => this.stopScreenShare());
      this.producers.set('screen', producer);
      const screenAudio = this.screenAudioActive
        ? this.screenStream?.getAudioTracks().find(track => track.readyState === 'live')
        : undefined;
      if (screenAudio) {
        const audioProducer = await this._produceScreenAudio(transport, screenAudio);
        if (generation !== this._sessionGeneration) { audioProducer.close(); return; }
        audioProducer.on('trackended', () => { this._closeProducer('screen-audio'); this.screenAudioActive = false; });
        this.producers.set('screen-audio', audioProducer);
      } else {
        this.screenAudioActive = false;
      }
    } else if (this.screenSharing) {
      this.stopScreenShare();
    }
    this._broadcastState();
  }

  // ── Leave voice ───────────────────────────────────────────────────────────
  leaveVoice(): void {
    if (!this.currentChannelId) return;

    if (this._sfuAvailable) {
      this._sfuSocket.emit('sfu:leave', { channelId: this.currentChannelId, serverId: this.currentServerId });
    } else {
      this.socket.emit('voice:leave', { channelId: this.currentChannelId, serverId: this.currentServerId });
    }

    this._cleanupVoiceState();
  }

  destroy(): void {
    const hadVoiceState = Boolean(this.currentChannelId || this.localStream || this.peers.size || this.producers.size || this.consumers.size);
    // Socket replacement is local teardown, not an explicit user leave. Do not
    // emit on an obsolete socket; the server already observes its disconnect.
    this._cleanupVoiceState();
    this._detachSocketHandlers();
    if (hadVoiceState) {
      document.dispatchEvent(new CustomEvent('bridge:voice-left', {
        detail: { reason: 'socket-replaced' },
      }));
    }
  }

  private _cleanupVoiceState(): void {
    this._sfuSessionSocketId = null;
    this._sessionGeneration += 1;
    this._videoGeneration += 1;
    this._screenGeneration += 1;
    this._sfuCleanup();
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.screenStream    = null;
    this.currentChannelId = null;
    this.currentServerId  = null;
    this.videoOn          = false;
    this.screenSharing    = false;
    this.screenAudioActive = false;
    this.muted            = false;
    this.deafened         = false;
    this._socketToUserId.clear();
    this._resetDedicatedSfuSocket();
    _stopVAD()?.();
  }

  private _sfuCleanup(): void {
    this._pendingConsumes = [];
    for (const c of this.consumers.values()) c.close?.();
    for (const p of this.producers.values()) p.close?.();
    this.consumers.clear();
    this.producers.clear();
    for (const streams of this.peerStreams.values()) {
      for (const stream of peerStreamList(streams)) stream.getTracks().forEach(track => track.stop());
    }
    this.peerStreams.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.device        = null;
  }

  private _closeProducer(kind: string): void {
    const producer = this.producers.get(kind);
    if (!producer) return;
    producer.close();
    this.producers.delete(kind);
    this._sfuSocket.emit('sfu:close-producer', { kind });
  }

  // ── Mute / deafen ─────────────────────────────────────────────────────────
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
    const audioProducer = this.producers.get('audio');
    if (audioProducer) { muted ? audioProducer.pause() : audioProducer.resume(); }
    this._broadcastState();
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    document.querySelectorAll<HTMLMediaElement>('.remote-audio').forEach(el => { el.muted = deafened; });
    if (deafened && !this.muted) this.setMuted(true);
    this._broadcastState();
  }

  // ── Video ─────────────────────────────────────────────────────────────────
  async enableVideo(enable: boolean): Promise<boolean> {
    if (!enable) {
      this._videoGeneration += 1;
      this.localStream?.getVideoTracks().forEach(track => {
        track.stop();
        this.localStream?.removeTrack(track);
      });
      this._closeProducer('video');
      this.videoOn = false;
      this._broadcastState();
      return true;
    }
    if (this.videoOn) return true;
    if (!this.currentChannelId || !this.localStream) return false;

    const generation = ++this._videoGeneration;
    let videoStream: MediaStream | null = null;
    let videoTrack: MediaStreamTrack | null = null;
    let producer: MediasoupProducer | null = null;
    try {
      const videoConstraints = this.selectedCameraId
        ? { deviceId: { exact: this.selectedCameraId } } : true;
      videoStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
      videoTrack = videoStream.getVideoTracks()[0] ?? null;
      if (!videoTrack) throw new Error('Camera returned no video track');
      if (generation !== this._videoGeneration) {
        videoStream.getTracks().forEach(track => track.stop());
        return false;
      }
      this.localStream.addTrack(videoTrack);

      if (this._sfuAvailable && this.sendTransport) {
        producer = await this._produceCamera(this.sendTransport, videoTrack);
        if (generation !== this._videoGeneration) {
          producer.close();
          videoStream.getTracks().forEach(track => track.stop());
          return false;
        }
        producer.on('trackended', () => { void this.enableVideo(false); });
        this.producers.set('video', producer);
      }
      this.videoOn = true;
    } catch {
      producer?.close();
      if (videoTrack) this.localStream?.removeTrack(videoTrack);
      videoStream?.getTracks().forEach(track => track.stop());
      _app()?.toast(t('rtc_cam_denied', 'Kamera erişimi reddedildi'), 'error');
      return false;
    }
    this._broadcastState();
    return true;
  }

  private _produceCamera(transport: MediasoupTransport, track: MediaStreamTrack): Promise<MediasoupProducer> {
    return transport.produce({
      track,
      stopTracks: false,
      encodings: cameraSimulcastEncodings(track),
      codecOptions: { videoGoogleStartBitrate: 1000 },
    });
  }

  private _produceScreen(transport: MediasoupTransport, track: MediaStreamTrack): Promise<MediasoupProducer> {
    return transport.produce({
      track,
      stopTracks: false,
      appData:   { screen: true },
      encodings: [{ maxBitrate: SCREEN_BITRATES[this._screenQuality] }],
      codecOptions: { videoGoogleStartBitrate: 1000 },
    });
  }

  private _produceScreenAudio(transport: MediasoupTransport, track: MediaStreamTrack): Promise<MediasoupProducer> {
    return transport.produce({
      track,
      stopTracks: false,
      appData: { screenAudio: true },
      codecOptions: {
        opusStereo: true, opusDtx: false, opusFec: true,
        opusPtime: 20, opusMaxPlaybackRate: 48000,
      },
    });
  }

  // ── Screen share ──────────────────────────────────────────────────────────
  /**
   * System audio is opt-in and is considered active only if the browser
   * actually returned an audio track AND the active media path publishes it.
   * A checked box is never treated as proof of remote audio delivery.
   */
  async startScreenShare(quality: ScreenQuality = 'hd', includeAudio = false): Promise<boolean> {
    if (this.screenSharing) return true;
    if (!this.currentChannelId) return false;
    const selectedQuality = normalizeScreenQuality(quality, 'hd');
    const preset = SCREEN_PRESETS[selectedQuality];
    const generation = ++this._screenGeneration;
    this._screenQuality = selectedQuality;
    this.screenAudioActive = false;
    let stream: MediaStream | null = null;
    let producer: MediasoupProducer | null = null;
    let audioProducer: MediasoupProducer | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { ...preset, cursor: 'always' } as MediaTrackConstraints,
        audio: includeAudio
          ? { echoCancellation: false, noiseSuppression: false } as MediaTrackConstraints
          : false,
      });
      const screenTrack = stream.getVideoTracks()[0];
      if (!screenTrack) throw new Error('Screen capture returned no video track');
      if (generation !== this._screenGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return false;
      }
      screenTrack.onended = () => this.stopScreenShare();

      if (this._sfuAvailable && this.sendTransport) {
        producer = await this._produceScreen(this.sendTransport, screenTrack);
        if (generation !== this._screenGeneration) {
          producer.close();
          stream.getTracks().forEach(track => track.stop());
          return false;
        }
        producer.on('trackended', () => this.stopScreenShare());
        this.producers.set('screen', producer);

        const screenAudioTrack = includeAudio ? stream.getAudioTracks()[0] : undefined;
        if (screenAudioTrack) {
          try {
            audioProducer = await this._produceScreenAudio(this.sendTransport, screenAudioTrack);
            if (generation !== this._screenGeneration) {
              audioProducer.close();
              this._closeProducer('screen');
              stream.getTracks().forEach(track => track.stop());
              return false;
            }
            audioProducer.on('trackended', () => {
              this._closeProducer('screen-audio');
              this.screenAudioActive = false;
            });
            this.producers.set('screen-audio', audioProducer);
            this.screenAudioActive = true;
          } catch (e) {
            // Screen video remains useful. Stop the unpublished capture so an
            // audio permission never leaves an unused live system-audio track.
            screenAudioTrack.stop();
            this.screenAudioActive = false;
            log.warn('[SFU] screen audio produce error:', e);
          }
        }
      } else {
        // P2P fallback owns the same captured MediaStream. Attach video and,
        // when the browser really supplied it, system audio as distinct tracks
        // and renegotiate every live peer. The microphone sender is untouched.
        this.screenStream = stream;
        for (const [socketId, pc] of this.peers) {
          this._p2pAttachScreenTracks(pc);
          void this._p2pRenegotiate(pc, socketId);
        }
        this.screenAudioActive = Boolean(includeAudio && stream.getAudioTracks()[0]);
      }
      this.screenStream = stream;
      this.screenSharing = true;
      this._broadcastState();
      return true;
    } catch {
      audioProducer?.close();
      producer?.close();
      stream?.getTracks().forEach(track => track.stop());
      if (this.screenStream === stream) this.screenStream = null;
      this.screenAudioActive = false;
      _app()?.toast(t('rtc_share_cancel', 'Ekran paylaşımı iptal edildi'), 'error');
      return false;
    }
  }

  stopScreenShare(): void {
    this._screenGeneration += 1;
    const closingStream = this.screenStream;
    if (closingStream && !this._sfuAvailable) {
      const closingTracks = new Set(closingStream.getTracks());
      for (const [socketId, pc] of this.peers) {
        for (const sender of pc.getSenders()) {
          if (sender.track && closingTracks.has(sender.track)) {
            try { pc.removeTrack(sender); } catch { /* peer may be closing */ }
          }
        }
        void this._p2pRenegotiate(pc, socketId);
      }
    }
    closingStream?.getTracks().forEach(t => t.stop());
    this.screenStream = null;
    this._closeProducer('screen-audio');
    this._closeProducer('screen');
    this.screenAudioActive = false;
    this.screenSharing = false;
    this._broadcastState();
  }

  // ── Device switching ──────────────────────────────────────────────────────
  async setAudioProcessing(opts: {
    echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean;
  }): Promise<void> {
    if (typeof opts.echoCancellation === 'boolean') this.echoCancellation = opts.echoCancellation;
    if (typeof opts.noiseSuppression === 'boolean') this.noiseSuppression = opts.noiseSuppression;
    if (typeof opts.autoGainControl === 'boolean') this.autoGainControl = opts.autoGainControl;

    localStorage.setItem('bridge:device:echo', String(this.echoCancellation));
    localStorage.setItem('bridge:device:noise', String(this.noiseSuppression));
    localStorage.setItem('bridge:device:gain', String(this.autoGainControl));
    if (!this.isInVoice() || !this.localStream) return;

    const generation = this._sessionGeneration;
    const targetStream = this.localStream;
    let rawStream: MediaStream | null = null;
    let cleanStream: MediaStream | null = null;
    try {
      const nsModule = _ns();
      const nsEnabled = nsModule?.enabled !== false;
      const constraints: MediaTrackConstraints = {
        ...this.audioProcessingConstraints(),
        echoCancellation: this.echoCancellation && nsEnabled,
        noiseSuppression: this.noiseSuppression && nsEnabled,
        ...(this.selectedMicId ? { deviceId: { exact: this.selectedMicId } } : {}),
      };
      rawStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
      cleanStream = nsModule ? await nsModule.process(rawStream) : rawStream;
      const newTrack = cleanStream.getAudioTracks()[0];
      if (!newTrack) throw new Error('Microphone returned no audio track');
      if (generation !== this._sessionGeneration || targetStream !== this.localStream) {
        cleanStream.getTracks().forEach(track => track.stop());
        if (cleanStream !== rawStream) rawStream.getTracks().forEach(track => track.stop());
        return;
      }

      const previousTracks = targetStream.getAudioTracks();
      const audioProducer = this.producers.get('audio');
      if (audioProducer) await audioProducer.replaceTrack({ track: newTrack });
      if (!this._sfuAvailable) {
        for (const pc of this.peers.values()) {
          const sender = pc.getSenders().find(candidate => candidate.track?.kind === 'audio');
          if (sender) await sender.replaceTrack(newTrack);
        }
      }
      if (generation !== this._sessionGeneration || targetStream !== this.localStream) {
        cleanStream.getTracks().forEach(track => track.stop());
        if (cleanStream !== rawStream) rawStream.getTracks().forEach(track => track.stop());
        return;
      }
      previousTracks.forEach(track => { track.stop(); targetStream.removeTrack(track); });
      targetStream.addTrack(newTrack);
    } catch (err) {
      cleanStream?.getTracks().forEach(track => track.stop());
      if (rawStream && cleanStream !== rawStream) rawStream.getTracks().forEach(track => track.stop());
      log.warn({ voice: 'audio_processing_failed', err });
    }
  }

  async setMicDevice(deviceId: string): Promise<void> {
    this.selectedMicId = deviceId;
    localStorage.setItem('bridge:device:mic', deviceId);
    localStorage.setItem('bridge-mic', deviceId);
    if (!this.isInVoice() || !this.localStream) return;
    const generation = this._sessionGeneration;
    const targetStream = this.localStream;
    let rawStream: MediaStream | null = null;
    let cleanStream: MediaStream | null = null;
    try {
      const _nsModule = _ns();
      const nsEnabled = _nsModule?.enabled !== false;
      rawStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, ...this.audioProcessingConstraints(),
                 echoCancellation: this.echoCancellation && nsEnabled,
                 noiseSuppression: this.noiseSuppression && nsEnabled },
        video: false,
      });
      cleanStream = _nsModule ? await _nsModule.process(rawStream) : rawStream;
      const newTrack = cleanStream.getAudioTracks()[0];
      if (!newTrack) throw new Error('Microphone returned no audio track');
      if (generation !== this._sessionGeneration) {
        cleanStream.getTracks().forEach(track => track.stop());
        if (cleanStream !== rawStream) rawStream.getTracks().forEach(track => track.stop());
        return;
      }
      const previousTracks = targetStream.getAudioTracks();
      const audioProducer = this.producers.get('audio');
      if (audioProducer) await audioProducer.replaceTrack({ track: newTrack });
      if (generation !== this._sessionGeneration) {
        cleanStream.getTracks().forEach(track => track.stop());
        if (cleanStream !== rawStream) rawStream.getTracks().forEach(track => track.stop());
        return;
      }
      previousTracks.forEach(t => { t.stop(); targetStream.removeTrack(t); });
      targetStream.addTrack(newTrack);
      _app()?.toast(t('rtc_mic_changed', 'Mikrofon değiştirildi ✓'), 'success');
    } catch {
      cleanStream?.getTracks().forEach(track => track.stop());
      if (rawStream && cleanStream !== rawStream) rawStream.getTracks().forEach(track => track.stop());
      if (generation === this._sessionGeneration) {
        _app()?.toast(t('rtc_mic_failed', 'Mikrofon değiştirilemedi'), 'error');
      }
    }
  }

  async setCameraDevice(deviceId: string): Promise<void> {
    this.selectedCameraId = deviceId;
    localStorage.setItem('bridge:device:camera', deviceId);
    localStorage.setItem('bridge-camera', deviceId);
    if (!this.videoOn || !this.localStream) return;
    const generation = this._sessionGeneration;
    const targetStream = this.localStream;
    let newStream: MediaStream | null = null;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) throw new Error('Camera returned no video track');
      if (generation !== this._sessionGeneration) {
        newStream.getTracks().forEach(track => track.stop());
        return;
      }
      const previousTracks = targetStream.getVideoTracks();
      const videoProducer = this.producers.get('video');
      if (videoProducer) await videoProducer.replaceTrack({ track: newTrack });
      if (generation !== this._sessionGeneration) {
        newStream.getTracks().forEach(track => track.stop());
        return;
      }
      previousTracks.forEach(t => { t.stop(); targetStream.removeTrack(t); });
      targetStream.addTrack(newTrack);
      _app()?.toast(t('rtc_cam_changed', 'Kamera değiştirildi ✓'), 'success');
    } catch {
      newStream?.getTracks().forEach(track => track.stop());
      if (generation === this._sessionGeneration) {
        _app()?.toast(t('rtc_cam_failed', 'Kamera değiştirilemedi'), 'error');
      }
    }
  }

  async setSpeakerDevice(deviceId: string): Promise<void> {
    this.selectedSpeakerId = deviceId;
    localStorage.setItem('bridge:device:speaker', deviceId);
    localStorage.setItem('bridge-speaker', deviceId);
    type AudioEl = HTMLMediaElement & { setSinkId?(id: string): Promise<void> };
    document.querySelectorAll<AudioEl>('.remote-audio, audio').forEach(el => {
      el.setSinkId?.(deviceId).catch(() => {});
    });
    _app()?.toast(t('rtc_spk_changed', 'Hoparlör değiştirildi ✓'), 'success');
  }

  setChannelBitrate(bitrate: number): void {
    this.channelBitrate = bitrate;
    // SFU modda codec seçeneğini güncellemek için producer kapatıp yeniden açmak gerekir
    // Şimdilik sadece kaydediyoruz — sonraki produce'da uygulanır
  }

  // ── Socket events ─────────────────────────────────────────────────────────
  private _bindSocketEvents(socket: BridgeSocket): void {
    // ─ SFU events ─────────────────────────────────────────────────────────
    this._onSocket(socket, 'sfu:joined', async (raw: unknown) => {
      const { existingPeers, iceServers, iceTransportPolicy } =
        raw as { existingPeers: PeerInfo[]; iceServers?: RTCIceServer[]; iceTransportPolicy?: RTCIceTransportPolicy };

      if (iceServers?.length) {
        this._iceServers         = iceServers;
        this._iceTransportPolicy = iceTransportPolicy ?? 'all';
        log.log('[SFU] ICE sunucuları güncellendi:', iceServers.map(s => s.urls).flat().join(', '));
      }

      for (const peer of existingPeers) {
        this._socketToUserId.set(peer.socketId, peer.userId ?? '');
        _app()?.renderVoicePeer(peer, false);
        for (const { producerId, kind } of peer.producers ?? []) {
          await this._consume(producerId, peer.socketId, kind);
        }
      }

      const _e2e1 = _voiceE2E();
      if (existingPeers.length > 0 && _e2e1) {
        _e2e1.initVoiceE2E(this.currentChannelId, existingPeers)
          .then(ok => { if (ok) _e2e1.renderVoiceE2EBadge(); });
      }
    });

    this._onSocket(socket, 'sfu:peer-joined', (raw: unknown) => {
      const peer = raw as PeerInfo;
      this._socketToUserId.set(peer.socketId, peer.userId ?? '');
      _app()?.renderVoicePeer(peer, false);
    });

    this._onSocket(socket, 'sfu:new-producer', async (raw: unknown) => {
      const { socketId, producerId, kind } = raw as { socketId: string; userId?: string; producerId: string; kind: string };
      await this._consume(producerId, socketId, kind);
    });

    this._onSocket(socket, 'sfu:producer-closed', (raw: unknown) => {
      const { producerId } = raw as { producerId: string };
      this._pendingConsumes = this._pendingConsumes.filter(p => p.producerId !== producerId);
      const consumer = this.consumers.get(producerId);
      if (consumer) {
        consumer.close?.();
        this.consumers.delete(producerId);
        // Otherwise the peer's stream keeps the ended track and a restarted
        // camera or share adds its new track next to it; a <video> element
        // renders only one video track of a stream.
        const streams = consumer._socketId ? this.peerStreams.get(consumer._socketId) : undefined;
        if (streams) for (const stream of peerStreamList(streams)) stream.removeTrack(consumer.track);
      }
    });

    this._onSocket(socket, 'sfu:peer-left', (raw: unknown) => {
      const { socketId } = raw as { socketId: string };
      this._pendingConsumes = this._pendingConsumes.filter(p => p.socketId !== socketId);
      this._cleanupPeerStreams(socketId);
      _app()?.removeVoicePeer(socketId);
    });

    // ─ P2P fallback events ────────────────────────────────────────────────
    this._onSocket(socket, 'voice:existing-peers', async (raw: unknown) => {
      if (this._sfuAvailable) return;
      const peers = raw as PeerInfo[];
      for (const peer of peers) await this._p2pCreateOffer(peer.socketId, peer);
      const _e2e2 = _voiceE2E();
      if (peers.length > 0 && _e2e2) {
        _e2e2.initVoiceE2E(this.currentChannelId, peers)
          .then(ok => { if (ok) _e2e2.renderVoiceE2EBadge(); });
      }
    });

    this._onSocket(socket, 'voice:peer-joined', (raw: unknown) => {
      if (this._sfuAvailable) return;
      _app()?.renderVoicePeer(raw as PeerInfo, false);
    });

    this._onSocket(socket, 'voice:peer-left', (raw: unknown) => {
      if (this._sfuAvailable) return;
      const { socketId } = raw as { socketId: string };
      this._p2pRemovePeer(socketId);
      _app()?.removeVoicePeer(socketId);
    });

    // ─ Common events ──────────────────────────────────────────────────────
    this._onSocket(socket, 'voice:peer-state', (raw: unknown) => {
      const { socketId, ...state } = raw as { socketId: string } & PeerState;
      _app()?.updatePeerState(socketId, state);
    });

    // P2P signalling (fallback)
    this._onSocket(socket, 'webrtc:offer', async (raw: unknown) => {
      if (this._sfuAvailable) return;
      const { fromSocketId, offer } = raw as { fromSocketId: string; offer: RTCSessionDescriptionInit };
      await this._p2pHandleOffer(fromSocketId, offer);
    });
    this._onSocket(socket, 'webrtc:answer', async (raw: unknown) => {
      if (this._sfuAvailable) return;
      const { fromSocketId, answer } = raw as { fromSocketId: string; answer: RTCSessionDescriptionInit };
      const pc = this.peers.get(fromSocketId);
      if (pc && pc.signalingState !== 'stable') await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });
    this._onSocket(socket, 'webrtc:ice-candidate', async (raw: unknown) => {
      if (this._sfuAvailable) return;
      const { fromSocketId, candidate } = raw as { fromSocketId: string; candidate: RTCIceCandidateInit };
      const pc = this.peers.get(fromSocketId);
      if (pc && candidate) { try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* non-fatal */ } }
    });

    // Request-scoped listeners in `_sfuJoin` own redirect handling. This
    // observer is intentionally side-effect free so an owner response can never
    // cause the old socket to retry itself and loop.
    // The server evicted this voice session (kick, ban, access or connect
    // permission revoked, timeout). End the call now instead of waiting for
    // ICE to fail — or showing a live call that never recovers.
    this._onSocket(socket, 'voice:evicted', (raw: unknown) => {
      const { channelId } = (raw ?? {}) as { channelId?: unknown };
      if (!this.currentChannelId || channelId !== this.currentChannelId) return;
      this._cleanupVoiceState();
      document.dispatchEvent(new CustomEvent('bridge:voice-left', { detail: { reason: 'evicted' } }));
      _app().toast(t('rtc_voice_evicted', 'Bu ses kanalına erişimin kaldırıldı.'), 'warning');
    });

    this._onSocket(socket, 'sfu:redirect', (raw: unknown) => {
      const { channelId, ownerNodeId, message } = raw as { channelId: string; ownerNodeId: string; message?: string };
      log.warn(`[SFU] Redirect: channel=${channelId} owner=${ownerNodeId}`, message);
    });

    this._onSocket(socket, 'disconnect', (reason: unknown) => {
      const forced = reason === 'forced close' && socket === this.socket && this._forcedSignalingClose;
      if (socket === this.socket) this._forcedSignalingClose = false;
      const transient = forced || (typeof reason === 'string' && TRANSIENT_DISCONNECT_REASONS.has(reason));
      if (socket === this._dedicatedSfuSocket) {
        // The owner node discards our peer when this socket drops.
        if (transient && this.currentChannelId && this._sfuAvailable) this._recoverSession('sfu-socket-lost');
        return;
      }
      if (socket !== this.socket) return;
      if (!this.currentChannelId && !this.localStream && this.peers.size === 0) return;
      if (transient && this.currentChannelId && this._sfuAvailable) {
        // Media signaling on a live dedicated owner socket is unaffected by
        // the loss of the app socket (e.g. a non-owner node died).
        if (this._dedicatedSfuSocket?.connected) return;
        this._recoverSession('socket-lost');
        return;
      }
      this._cleanupVoiceState();
      document.dispatchEvent(new CustomEvent('bridge:voice-left', {
        detail: { reason: 'socket-disconnect' },
      }));
    });
  }

  private _broadcastState(): void {
    if (!this.currentChannelId) return;
    (this._sfuAvailable ? this._sfuSocket : this.socket).emit('voice:state-update', {
      channelId: this.currentChannelId, muted: this.muted,
      deafened: this.deafened, screensharing: this.screenSharing, video: this.videoOn,
    });
    // The voice UI keeps its own copy of these flags. Changes that start in
    // the engine — a camera or microphone that disappeared, a recovered
    // session that could not re-publish the camera — must reach it too; the
    // P2 media lab measured a UI still showing the camera on after the device
    // ended.
    document.dispatchEvent(new CustomEvent('bridge:voice-local-state', {
      detail: { muted: this.muted, deafened: this.deafened, video: this.videoOn, screensharing: this.screenSharing },
    }));
  }

  /**
   * The microphone track ended underneath the call (device unplugged,
   * permission revoked). Stop publishing, show the user as muted and say why:
   * before, the call silently kept going with nothing being sent.
   */
  private _onMicrophoneLost(): void {
    this._closeProducer('audio');
    this.muted = true;
    _app().toast(t('rtc_mic_lost', 'Mikrofon bağlantısı kesildi — sesin iletilmiyor.'), 'error');
    this._broadcastState();
  }

  /** The stream a consumer of `kind` belongs to; created on first use. */
  private _peerStream(socketId: string, kind: string, trackKind: string): MediaStream {
    let streams = this.peerStreams.get(socketId);
    if (!streams) {
      streams = { audio: new MediaStream(), video: new MediaStream() };
      this.peerStreams.set(socketId, streams);
    }
    if (kind === 'screen') return streams.screen ??= new MediaStream();
    if (kind === 'screen-audio') return streams.screenAudio ??= new MediaStream();
    if (kind === 'video' || kind === 'audio') return streams[kind];
    return trackKind === 'video' ? streams.video : streams.audio;
  }

  private _cleanupPeerStreams(socketId: string): void {
    const streams = this.peerStreams.get(socketId);
    if (streams) {
      for (const stream of peerStreamList(streams)) stream.getTracks().forEach(t => t.stop());
      this.peerStreams.delete(socketId);
    }
    for (const [producerId, consumer] of this.consumers) {
      if (consumer._socketId === socketId) { consumer.close?.(); this.consumers.delete(producerId); }
    }
  }

  // ── P2P fallback ──────────────────────────────────────────────────────────
  private _p2pAttachScreenTracks(pc: RTCPeerConnection): void {
    const stream = this.screenStream;
    if (!stream) return;
    const attached = new Set(pc.getSenders().map(sender => sender.track).filter(Boolean));
    for (const track of stream.getTracks()) {
      if (!attached.has(track)) pc.addTrack(track, stream);
    }
  }

  private async _p2pRenegotiate(pc: RTCPeerConnection, targetSocketId: string): Promise<void> {
    if (pc.signalingState === 'closed' || this.peers.get(targetSocketId) !== pc) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.peers.get(targetSocketId) !== pc || (pc.signalingState as string) === 'closed') return;
      this.socket.emit('webrtc:offer', {
        targetSocketId, offer: pc.localDescription, channelId: this.currentChannelId,
      });
    } catch (e) {
      log.warn('[P2P] Screen-share renegotiation failed:', e);
    }
  }

  private async _p2pCreateOffer(targetSocketId: string, peerInfo: PeerInfo): Promise<void> {
    const pc = this._p2pCreatePeer(targetSocketId, peerInfo);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('webrtc:offer', {
        targetSocketId, offer: pc.localDescription, channelId: this.currentChannelId,
      });
    } catch (e) { log.error('[P2P] Offer error:', e); }
  }

  private async _p2pHandleOffer(fromSocketId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.peers.get(fromSocketId) ?? this._p2pCreatePeer(fromSocketId, { socketId: fromSocketId });
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('webrtc:answer', { targetSocketId: fromSocketId, answer: pc.localDescription });
    } catch (e) { log.error('[P2P] Answer error:', e); }
  }

  private _p2pCreatePeer(socketId: string, _peerInfo: PeerInfo): RTCPeerConnection {
    const iceServers = this._iceServers.length
      ? this._iceServers
      : [{ urls: 'stun:stun.l.google.com:19302' }];
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: this._iceTransportPolicy });
    this.peers.set(socketId, pc);
    if (this.localStream) this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream!));
    // A peer joining after screen-share started must receive the same display
    // tracks as existing peers; otherwise late joiners see no share until the
    // presenter restarts it.
    this._p2pAttachScreenTracks(pc);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('webrtc:ice-candidate', { targetSocketId: socketId, candidate });
    };
    pc.ontrack = ({ streams }) => {
      if (streams[0]) _app()?.attachRemoteStream(socketId, streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        this._p2pRemovePeer(socketId);
        _app()?.removeVoicePeer(socketId);
      }
    };
    return pc;
  }

  private _p2pRemovePeer(socketId: string): void {
    const pc = this.peers.get(socketId);
    if (pc) { pc.close(); this.peers.delete(socketId); }
  }

  // ── Voice E2E ─────────────────────────────────────────────────────────────
  registerVoiceE2EEvents(myUserId: string): void {
    _voiceE2E()?.registerSocketEvents(this._sfuAvailable ? this._sfuSocket : this.socket, myUserId);
  }
}

export type SfuRtcFactory = (socket: BridgeSocket) => BridgeRTC;

// The P2P module owns singleton/registry lifecycle. This module contributes the
// SFU-capable engine factory only, avoiding two simultaneous RTC owners.
BridgeRegistry.register('rtc:sfu-factory', ((socket: BridgeSocket) => new BridgeRTC(socket)) as unknown as (...args: unknown[]) => unknown);

export { BridgeRTC };
export type { ScreenQuality };
