// client/js/webrtc-sfu.ts
// Bridge WebRTC SFU Client — Mediasoup
// Sprint 33: Full TypeScript migration — strict types, no implicit any
//
// P2P yerine SFU (Selective Forwarding Unit) kullanır:
//   8 kullanıcı → 2 transport (1 send + 1 recv) = sabit, P2P'de 56 RTCPeerConnection

'use strict';

import type { BridgeSocket } from './webrtc-base';
import { BridgeRegistry } from './core/bridge-registry.ts';
import { getAPI } from './core/globals.ts';

import { createLogger } from './core/logger.ts';
const log = createLogger('SFU');



// ── Typed registry accessors (window.* yerine) ────────────────────────────────
interface BridgeNSModule { enabled?: boolean; process(stream: MediaStream): Promise<MediaStream>; }
interface BridgeVoiceE2EModule {
  initVoiceE2E(channelId: string | null, peers: PeerInfo[]): Promise<boolean>;
  renderVoiceE2EBadge(): void;
  registerSocketEvents(socket: BridgeSocket, userId: string): void;
}
interface BridgeVoiceVolumeModule { applyVolume(socketId: string, volume: number): void; }
interface VoiceActivityUIModule { init(socket: BridgeSocket): void; }
interface BridgeAppModule {
  toast(msg: string, type: string): void;
  showToast?(msg: string, type: string): void;
  renderVoicePeer(peer: PeerInfo, initiator: boolean): void;
  removeVoicePeer(socketId: string): void;
  attachRemoteStream(socketId: string, stream: MediaStream, kind?: string): void;
  updatePeerState(socketId: string, state: PeerState): void;
}

function _reg<T>(name: string): T | null {
  return BridgeRegistry.get<(...args: unknown[]) => unknown>(name) as T | null;
}
function _app(): BridgeAppModule | null       { return _reg<BridgeAppModule>('bridgeApp'); }
function _ns(): BridgeNSModule | null         { return _reg<BridgeNSModule>('BridgeNS'); }
function _voiceE2E(): BridgeVoiceE2EModule | null  { return _reg<BridgeVoiceE2EModule>('BridgeVoiceE2E'); }
function _voiceVolume(): BridgeVoiceVolumeModule | null { return _reg<BridgeVoiceVolumeModule>('BridgeVoiceVolume'); }
function _vaui(): VoiceActivityUIModule | null       { return _reg<VoiceActivityUIModule>('VoiceActivityUI'); }
function _startVAD(): ((stream: MediaStream, channelId: string) => void) | null {
  return _reg<(stream: MediaStream, channelId: string) => void>('_bridgeStartLocalVAD');
}
function _stopVAD(): (() => void) | null { return _reg<() => void>('_bridgeStopLocalVAD'); }
function _sfuHandleNewProducer(): ((socketId: string, userId: string | undefined, stream: MediaStream, kind: string) => void) | null {
  return _reg<(socketId: string, userId: string | undefined, stream: MediaStream, kind: string) => void>('sfuHandleNewProducer');
}
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

declare const mediasoupClient: { Device: new () => MediasoupDevice } | undefined;

// ── Screen quality ────────────────────────────────────────────────────────────
type ScreenQuality = '4k60' | '1440p60' | '1440p' | '1080p60' | '1080p' | '720p' | 'hd';

const SCREEN_PRESETS: Record<ScreenQuality, MediaTrackConstraints> = {
  '4k60':    { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60 } },
  '1440p60': { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 60 } },
  '1440p':   { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } },
  '1080p60': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
  '1080p':   { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  '720p':    { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30 } },
  'hd':      { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30 } },
};

const SCREEN_BITRATES: Record<ScreenQuality, number> = {
  '4k60': 20_000_000, '1440p60': 12_000_000, '1440p': 10_000_000,
  '1080p60': 8_000_000, '1080p': 5_000_000, '720p': 3_000_000, 'hd': 2_000_000,
};

// ══════════════════════════════════════════════════════════════════════════════
// BridgeRTC — SFU WebRTC Manager (drop-in replacement for webrtc.ts)
// ══════════════════════════════════════════════════════════════════════════════
class BridgeRTC {
  readonly socket: BridgeSocket;
  device: MediasoupDevice | null           = null;
  sendTransport: MediasoupTransport | null = null;
  recvTransport: MediasoupTransport | null = null;
  producers: Map<string, MediasoupProducer>          = new Map();
  consumers: Map<string, MediasoupConsumer>          = new Map();
  peerStreams: Map<string, { audio: MediaStream; video: MediaStream }> = new Map();
  localStream: MediaStream | null          = null;
  screenStream: MediaStream | null         = null;
  currentChannelId: string | null          = null;
  currentServerId: string | null           = null;
  muted                                    = false;
  deafened                                 = false;
  videoOn                                  = false;
  screenSharing                            = false;
  selectedMicId: string | null             = null;
  selectedCameraId: string | null          = null;
  selectedSpeakerId: string | null         = null;
  channelBitrate                           = 64_000;

  // P2P fallback state
  peers: Map<string, RTCPeerConnection>    = new Map();
  private _p2pPeers: Map<string, RTCPeerConnection> = new Map();

  private _sfuAvailable                                              = false;
  private _iceServers: RTCIceServer[]                                = [];
  private _iceTransportPolicy: RTCIceTransportPolicy                 = 'all';
  private _socketToUserId: Map<string, string>                       = new Map();
  private _redirectCount                                             = 0;
  private _screenQuality: ScreenQuality                              = 'hd';
  private _mobileAudioOverride: Partial<MediaTrackConstraints> | false = false;

  constructor(socket: BridgeSocket) {
    this.socket = socket;
    this._sfuAvailable = typeof mediasoupClient !== 'undefined';
    this._bindSocketEvents();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  isInVoice(): boolean                  { return !!this.currentChannelId; }
  getLocalStream(): MediaStream | null  { return this.localStream; }

  async getDevices(): Promise<{ microphones: MediaDeviceInfo[]; speakers: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }> {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        microphones: devices.filter(d => d.kind === 'audioinput'),
        speakers:    devices.filter(d => d.kind === 'audiooutput'),
        cameras:     devices.filter(d => d.kind === 'videoinput'),
      };
    } catch { return { microphones: [], speakers: [], cameras: [] }; }
  }

  loadSavedDevices(): void {
    this.selectedMicId     = localStorage.getItem('bridge-mic')     ?? null;
    this.selectedCameraId  = localStorage.getItem('bridge-camera')  ?? null;
    this.selectedSpeakerId = localStorage.getItem('bridge-speaker') ?? null;
  }

  // ── Join voice ────────────────────────────────────────────────────────────
  async joinVoice(channelId: string, serverId: string): Promise<void> {
    this.currentChannelId = channelId;
    this.currentServerId  = serverId;
    this.channelBitrate   = 64_000;

    const _channels = _currentServerChannels();
    if (_channels) {
      const ch = _channels.find(c => c._id === channelId);
      if (ch?.bitrate) this.channelBitrate = ch.bitrate as number;
    }

    try {
      const _nsModule = _ns();
      const nsEnabled = _nsModule?.enabled !== false;
      const audioConstraints: MediaTrackConstraints = {
        ...(this.selectedMicId ? { deviceId: { exact: this.selectedMicId } } : {}),
        echoCancellation: nsEnabled, noiseSuppression: nsEnabled,
        autoGainControl: nsEnabled, sampleRate: 48000, channelCount: 2,
      };
      const rawStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      this.localStream = _nsModule ? await _nsModule.process(rawStream) : rawStream;
    } catch {
      this.localStream = new MediaStream();
      _app()?.toast('Mikrofon bulunamadı — sessiz katılındı', 'error');
    }

    if (this._sfuAvailable) {
      await this._sfuJoin(channelId, serverId);
    } else {
      log.warn('[BridgeRTC] mediasoup-client bulunamadı — P2P moda geçiliyor');
      this.socket.emit('voice:join', { channelId, serverId });
    }

    _vaui()?.init(this.socket);
    if (this.localStream) _startVAD()?.(this.localStream, channelId);
  }

  // ── SFU join flow ─────────────────────────────────────────────────────────
  private _sfuJoin(channelId: string, serverId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.socket.emit('sfu:get-rtp-capabilities', { channelId });
      this.socket.once('sfu:rtp-capabilities', async (payload: unknown) => {
        const { rtpCapabilities } = payload as { rtpCapabilities: unknown };
        try {
          this.device = new mediasoupClient!.Device();
          await this.device.load({ routerRtpCapabilities: rtpCapabilities });
          this.socket.emit('sfu:join', {
            channelId, serverId, rtpCapabilities: this.device.rtpCapabilities,
          });
          await this._createSendTransport(channelId);
          await this._createRecvTransport(channelId);
          resolve();
        } catch (e) { log.error('[SFU] join error:', e); resolve(); }
      });
    });
  }

  private _createSendTransport(channelId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.socket.emit('sfu:create-transport', { channelId, direction: 'send' });
      this.socket.once('sfu:transport-created', async (payload: unknown) => {
        const data = payload as { direction: string; id: string; iceParameters: unknown; iceCandidates: unknown; dtlsParameters: unknown };
        if (data.direction !== 'send') return;

        this.sendTransport = this.device!.createSendTransport({
          id: data.id, iceParameters: data.iceParameters,
          iceCandidates: data.iceCandidates, dtlsParameters: data.dtlsParameters,
        });

        this.sendTransport.on('connect', (args: unknown, cb: unknown) => {
          const { dtlsParameters } = args as { dtlsParameters: unknown };
          this.socket.emit('sfu:connect-transport', { channelId, direction: 'send', dtlsParameters });
          this.socket.once('sfu:transport-connected', (d: unknown) => {
            if ((d as { direction: string }).direction === 'send') (cb as () => void)();
          });
        });

        this.sendTransport.on('produce', async (args: unknown, cb: unknown) => {
          const { kind, rtpParameters, appData } = args as { kind: string; rtpParameters: unknown; appData: unknown };
          this.socket.emit('sfu:produce', { channelId, kind, rtpParameters, appData });
          this.socket.once('sfu:produced', (res: unknown) => {
            const { producerId } = res as { producerId: string };
            (cb as (opts: { id: string }) => void)({ id: producerId });
          });
        });

        await this._produceAudio();
        resolve();
      });
    });
  }

  private _createRecvTransport(channelId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.socket.emit('sfu:create-transport', { channelId, direction: 'recv' });
      this.socket.once('sfu:transport-created', async (payload: unknown) => {
        const data = payload as { direction: string; id: string; iceParameters: unknown; iceCandidates: unknown; dtlsParameters: unknown };
        if (data.direction !== 'recv') return;

        this.recvTransport = this.device!.createRecvTransport({
          id: data.id, iceParameters: data.iceParameters,
          iceCandidates: data.iceCandidates, dtlsParameters: data.dtlsParameters,
        });

        this.recvTransport.on('connect', (args: unknown, cb: unknown) => {
          const { dtlsParameters } = args as { dtlsParameters: unknown };
          this.socket.emit('sfu:connect-transport', { channelId, direction: 'recv', dtlsParameters });
          this.socket.once('sfu:transport-connected', (d: unknown) => {
            if ((d as { direction: string }).direction === 'recv') (cb as () => void)();
          });
        });
        resolve();
      });
    });
  }

  private async _produceAudio(): Promise<void> {
    if (!this.sendTransport || !this.localStream) return;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (!audioTrack) return;
    try {
      const producer = await this.sendTransport.produce({
        track: audioTrack,
        codecOptions: {
          opusStereo: true, opusDtx: true, opusFec: true,
          opusPtime: 20, opusMaxPlaybackRate: 48000,
        },
      });
      producer.on('trackended', () => this._closeProducer('audio'));
      this.producers.set('audio', producer);
    } catch (e) { log.error('[SFU] audio produce error:', e); }
  }

  // ── Consume ───────────────────────────────────────────────────────────────
  private async _consume(producerId: string, socketId: string, kind: string): Promise<MediasoupConsumer | null> {
    if (!this.recvTransport || !this.device) return null;

    this.socket.emit('sfu:consume', {
      channelId: this.currentChannelId, producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });

    return new Promise((resolve) => {
      this.socket.once('sfu:consumed', async (data: unknown) => {
        const d = data as { producerId: string; consumerId: string; kind: string; rtpParameters: unknown };
        if (d.producerId !== producerId) { resolve(null); return; }
        try {
          const consumer = await this.recvTransport!.consume({
            id: d.consumerId, producerId: d.producerId,
            kind: d.kind, rtpParameters: d.rtpParameters,
          });
          this.consumers.set(producerId, consumer);

          if (!this.peerStreams.has(socketId)) {
            this.peerStreams.set(socketId, { audio: new MediaStream(), video: new MediaStream() });
          }
          const streams      = this.peerStreams.get(socketId)!;
          const targetStream = (kind === 'video' || kind === 'screen') ? streams.video : streams.audio;
          targetStream.addTrack(consumer.track);

          _app()?.attachRemoteStream(socketId, targetStream, kind);

          if (kind === 'video' || kind === 'screen') {
            const peerUserId = this._socketToUserId.get(socketId);
            _sfuHandleNewProducer()?.(socketId, peerUserId, targetStream, kind);
            if (false) {
            }
          }

          const peerUserId = this._socketToUserId.get(socketId);
          if (peerUserId) {
            const saved = parseFloat(localStorage.getItem(`bridge-vol-${peerUserId}`) ?? '');
            if (!isNaN(saved)) {
              setTimeout(() => _voiceVolume()?.applyVolume(socketId, saved), 500);
            }
          }

          this.socket.emit('sfu:resume-consumer', { producerId });
          await consumer.resume?.();
          resolve(consumer);
        } catch (e) { log.error('[SFU] consume error:', e); resolve(null); }
      });
    });
  }

  // ── Leave voice ───────────────────────────────────────────────────────────
  leaveVoice(): void {
    if (!this.currentChannelId) return;

    if (this._sfuAvailable) {
      this.socket.emit('sfu:leave', { channelId: this.currentChannelId, serverId: this.currentServerId });
      this._sfuCleanup();
    } else {
      this.socket.emit('voice:leave', { channelId: this.currentChannelId, serverId: this.currentServerId });
    }

    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.screenStream    = null;
    this.currentChannelId = null;
    this.currentServerId  = null;
    this.videoOn          = false;
    this.screenSharing    = false;
    _stopVAD()?.();
  }

  private _sfuCleanup(): void {
    for (const c of this.consumers.values()) c.close?.();
    for (const p of this.producers.values()) p.close?.();
    this.consumers.clear();
    this.producers.clear();
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
    this.socket.emit('sfu:close-producer', { kind });
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
    if (enable) {
      try {
        const videoConstraints = this.selectedCameraId
          ? { deviceId: { exact: this.selectedCameraId } } : true;
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
        const videoTrack  = videoStream.getVideoTracks()[0];
        this.localStream?.addTrack(videoTrack);

        if (this._sfuAvailable && this.sendTransport) {
          const producer = await this.sendTransport.produce({
            track: videoTrack,
            encodings: [
              { maxBitrate: 100_000, scaleResolutionDownBy: 4 },
              { maxBitrate: 300_000, scaleResolutionDownBy: 2 },
              { maxBitrate: 900_000 },
            ],
            codecOptions: { videoGoogleStartBitrate: 1000 },
          });
          producer.on('trackended', () => this.enableVideo(false));
          this.producers.set('video', producer);
        }
        this.videoOn = true;
      } catch {
        _app()?.toast('Kamera erişimi reddedildi', 'error');
        return false;
      }
    } else {
      this.localStream?.getVideoTracks().forEach(t => t.stop());
      this._closeProducer('video');
      this.videoOn = false;
    }
    this._broadcastState();
    return true;
  }

  // ── Screen share ──────────────────────────────────────────────────────────
  async startScreenShare(quality: ScreenQuality = 'hd', includeAudio = true): Promise<boolean> {
    const preset = SCREEN_PRESETS[quality] ?? SCREEN_PRESETS['hd'];
    this._screenQuality = quality;
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { ...preset, cursor: 'always' } as MediaTrackConstraints,
        audio: includeAudio
          ? { echoCancellation: false, noiseSuppression: false } as MediaTrackConstraints
          : false,
      });
      const screenTrack      = this.screenStream.getVideoTracks()[0];
      screenTrack.onended    = () => this.stopScreenShare();

      if (this._sfuAvailable && this.sendTransport) {
        const producer = await this.sendTransport.produce({
          track:     screenTrack,
          appData:   { screen: true },
          encodings: [{ maxBitrate: SCREEN_BITRATES[quality] ?? 2_000_000 }],
          codecOptions: { videoGoogleStartBitrate: 1000 },
        });
        producer.on('trackended', () => this.stopScreenShare());
        this.producers.set('screen', producer);
      }
      this.screenSharing = true;
      this._broadcastState();
      return true;
    } catch {
      _app()?.toast('Ekran paylaşımı iptal edildi', 'error');
      return false;
    }
  }

  stopScreenShare(): void {
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.screenStream = null;
    this._closeProducer('screen');
    this.screenSharing = false;
    this._broadcastState();
    if (this.videoOn) void this.enableVideo(true);
  }

  // ── Device switching ──────────────────────────────────────────────────────
  async setMicDevice(deviceId: string): Promise<void> {
    this.selectedMicId = deviceId;
    localStorage.setItem('bridge-mic', deviceId);
    if (!this.isInVoice() || !this.localStream) return;
    try {
      const _nsModule = _ns();
      const nsEnabled = _nsModule?.enabled !== false;
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: nsEnabled,
                 noiseSuppression: nsEnabled, autoGainControl: nsEnabled, sampleRate: 48000 },
        video: false,
      });
      const cleanStream = _nsM.process ? await _nsM.process(rawStream) : rawStream;
      const newTrack      = cleanStream.getAudioTracks()[0];
      this.localStream.getAudioTracks().forEach(t => { t.stop(); this.localStream!.removeTrack(t); });
      this.localStream.addTrack(newTrack);
      const audioProducer = this.producers.get('audio');
      if (audioProducer) await audioProducer.replaceTrack({ track: newTrack });
      _app()?.toast('Mikrofon değiştirildi ✓', 'success');
    } catch { _app()?.toast('Mikrofon değiştirilemedi', 'error'); }
  }

  async setCameraDevice(deviceId: string): Promise<void> {
    this.selectedCameraId = deviceId;
    localStorage.setItem('bridge-camera', deviceId);
    if (!this.videoOn || !this.localStream) return;
    try {
      const newStream     = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      const newTrack      = newStream.getVideoTracks()[0];
      this.localStream.getVideoTracks().forEach(t => { t.stop(); this.localStream!.removeTrack(t); });
      this.localStream.addTrack(newTrack);
      const videoProducer = this.producers.get('video');
      if (videoProducer) await videoProducer.replaceTrack({ track: newTrack });
      _app()?.toast('Kamera değiştirildi ✓', 'success');
    } catch { _app()?.toast('Kamera değiştirilemedi', 'error'); }
  }

  async setSpeakerDevice(deviceId: string): Promise<void> {
    this.selectedSpeakerId = deviceId;
    localStorage.setItem('bridge-speaker', deviceId);
    type AudioEl = HTMLMediaElement & { setSinkId?(id: string): Promise<void> };
    document.querySelectorAll<AudioEl>('.remote-audio, audio').forEach(el => {
      el.setSinkId?.(deviceId).catch(() => {});
    });
    _app()?.toast('Hoparlör değiştirildi ✓', 'success');
  }

  setChannelBitrate(bitrate: number): void {
    this.channelBitrate = bitrate;
    // SFU modda codec seçeneğini güncellemek için producer kapatıp yeniden açmak gerekir
    // Şimdilik sadece kaydediyoruz — sonraki produce'da uygulanır
  }

  // ── Socket events ─────────────────────────────────────────────────────────
  private _bindSocketEvents(): void {
    // ─ SFU events ─────────────────────────────────────────────────────────
    this.socket.on('sfu:joined', async (raw: unknown) => {
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

    this.socket.on('sfu:peer-joined', (raw: unknown) => {
      const peer = raw as PeerInfo;
      this._socketToUserId.set(peer.socketId, peer.userId ?? '');
      _app()?.renderVoicePeer(peer, false);
    });

    this.socket.on('sfu:new-producer', async (raw: unknown) => {
      const { socketId, producerId, kind } = raw as { socketId: string; userId?: string; producerId: string; kind: string };
      await this._consume(producerId, socketId, kind);
    });

    this.socket.on('sfu:producer-closed', (raw: unknown) => {
      const { producerId } = raw as { producerId: string };
      const consumer = this.consumers.get(producerId);
      if (consumer) { consumer.close?.(); this.consumers.delete(producerId); }
    });

    this.socket.on('sfu:peer-left', (raw: unknown) => {
      const { socketId } = raw as { socketId: string };
      this._cleanupPeerStreams(socketId);
      _app()?.removeVoicePeer(socketId);
    });

    // ─ P2P fallback events ────────────────────────────────────────────────
    this.socket.on('voice:existing-peers', async (raw: unknown) => {
      if (this._sfuAvailable) return;
      const peers = raw as PeerInfo[];
      for (const peer of peers) await this._p2pCreateOffer(peer.socketId, peer);
      const _e2e2 = _voiceE2E();
      if (peers.length > 0 && _e2e2) {
        _e2e2.initVoiceE2E(this.currentChannelId, peers)
          .then(ok => { if (ok) _e2e2.renderVoiceE2EBadge(); });
      }
    });

    this.socket.on('voice:peer-joined', (raw: unknown) => {
      if (this._sfuAvailable) return;
      _app()?.renderVoicePeer(raw as PeerInfo, false);
    });

    this.socket.on('voice:peer-left', (raw: unknown) => {
      if (this._sfuAvailable) return;
      const { socketId } = raw as { socketId: string };
      this._p2pRemovePeer(socketId);
      _app()?.removeVoicePeer(socketId);
    });

    // ─ Common events ──────────────────────────────────────────────────────
    this.socket.on('voice:peer-state', (raw: unknown) => {
      const { socketId, ...state } = raw as { socketId: string } & PeerState;
      _app()?.updatePeerState(socketId, state);
    });

    // P2P signalling (fallback)
    this.socket.on('webrtc:offer', async (raw: unknown) => {
      if (this._sfuAvailable) return;
      const { fromSocketId, offer } = raw as { fromSocketId: string; offer: RTCSessionDescriptionInit };
      await this._p2pHandleOffer(fromSocketId, offer);
    });
    this.socket.on('webrtc:answer', async (raw: unknown) => {
      if (this._sfuAvailable) return;
      const { fromSocketId, answer } = raw as { fromSocketId: string; answer: RTCSessionDescriptionInit };
      const pc = this._p2pPeers.get(fromSocketId);
      if (pc && pc.signalingState !== 'stable') await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });
    this.socket.on('webrtc:ice-candidate', async (raw: unknown) => {
      if (this._sfuAvailable) return;
      const { fromSocketId, candidate } = raw as { fromSocketId: string; candidate: RTCIceCandidateInit };
      const pc = this._p2pPeers.get(fromSocketId);
      if (pc && candidate) { try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* non-fatal */ } }
    });

    // ─ sfu:redirect — Cluster modda oda başka node'da ─────────────────────
    this.socket.on('sfu:redirect', (raw: unknown) => {
      const { channelId, ownerNodeId, message } = raw as { channelId: string; ownerNodeId: string; message?: string };
      log.warn(`[SFU] Redirect: channel=${channelId} owner=${ownerNodeId}`, message);
      this._redirectCount = (this._redirectCount ?? 0) + 1;
      if (this._redirectCount > 3) {
        log.error('[SFU] Redirect döngüsü algılandı, vazgeçiliyor');
        this._redirectCount = 0;
        _app()?.showToast?.('Ses kanalına bağlanılamadı. Lütfen tekrar deneyin.', 'error');
        return;
      }
      setTimeout(() => {
        if (this.currentChannelId === channelId) {
          log.log('[SFU] Yeniden join deneniyor…');
          this.socket.emit('sfu:join', {
            channelId, serverId: this.currentServerId,
            rtpCapabilities: this.device?.rtpCapabilities,
          });
        }
      }, 600);
    });
  }

  private _broadcastState(): void {
    if (!this.currentChannelId) return;
    this.socket.emit('voice:state-update', {
      channelId: this.currentChannelId, muted: this.muted,
      deafened: this.deafened, screensharing: this.screenSharing, video: this.videoOn,
    });
  }

  private _cleanupPeerStreams(socketId: string): void {
    const streams = this.peerStreams.get(socketId);
    if (streams) {
      streams.audio?.getTracks().forEach(t => t.stop());
      streams.video?.getTracks().forEach(t => t.stop());
      this.peerStreams.delete(socketId);
    }
    for (const [producerId, consumer] of this.consumers) {
      if (consumer._socketId === socketId) { consumer.close?.(); this.consumers.delete(producerId); }
    }
  }

  // ── P2P fallback ──────────────────────────────────────────────────────────
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
    const pc = this._p2pPeers.get(fromSocketId) ?? this._p2pCreatePeer(fromSocketId, { socketId: fromSocketId });
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
    this._p2pPeers.set(socketId, pc);
    if (this.localStream) this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream!));
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
    const pc = this._p2pPeers.get(socketId);
    if (pc) { pc.close(); this._p2pPeers.delete(socketId); }
  }

  // ── Voice E2E ─────────────────────────────────────────────────────────────
  registerVoiceE2EEvents(myUserId: string): void {
    _voiceE2E()?.registerSocketEvents(this.socket, myUserId);
  }
}

export { BridgeRTC };
export type { ScreenQuality };
