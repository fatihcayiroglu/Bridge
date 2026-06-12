// client/js/webrtc.ts
// Bridge WebRTC Manager — P2P Voice, Video, Screen Share
// Sprint 33: window.* temizliği — BridgeRegistry + typed imports

import type { BridgeSocket } from './webrtc-base';
import { BridgeRegistry } from './core/bridge-registry.ts';
import { getAPI, currentServerChannels as _getServerChannels } from './core/globals.ts';

import { createLogger } from './core/logger.ts';
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

(async (): Promise<void> => {
  try {
    const API   = getAPI();
    const token = localStorage.getItem('token');
    if (!token) return;
    const r = await fetch(`${API}/api/rtc/ice-config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
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

// ── Screen quality presets ────────────────────────────────────────────────────
type ScreenQuality = '4k60' | '1440p60' | '1440p' | '1080p60' | '1080p' | '720p' | 'hd';

const SCREEN_PRESETS: Record<ScreenQuality, MediaTrackConstraints & { cursor?: string }> = {
  '4k60':    { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60, max: 60 }, cursor: 'always' },
  '1440p60': { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 60, max: 60 }, cursor: 'always' },
  '1440p':   { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30, max: 30 }, cursor: 'always' },
  '1080p60': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 }, cursor: 'always' },
  '1080p':   { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 }, cursor: 'always' },
  '720p':    { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30, max: 30 }, cursor: 'always' },
  'hd':      { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30           }, cursor: 'always' },
};

const SCREEN_BITRATES: Record<ScreenQuality, number> = {
  '4k60': 20_000_000, '1440p60': 12_000_000, '1440p': 10_000_000,
  '1080p60': 8_000_000, '1080p': 5_000_000, '720p': 3_000_000, 'hd': 2_000_000,
};

const SCREEN_FPS: Record<ScreenQuality, number> = {
  '4k60': 60, '1440p60': 60, '1440p': 30, '1080p60': 60, '1080p': 30, '720p': 30, 'hd': 30,
};

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
interface BridgeVoiceVolumeModule {
  applyVolume(socketId: string, volume: number): void;
}
interface VoiceActivityUIModule {
  init(socket: BridgeSocket): void;
}
interface BridgeAppModule {
  toast(msg: string, type: string): void;
  showToast?(msg: string, type: string): void;
  renderVoicePeer(peer: PeerInfo, initiator: boolean): void;
  removeVoicePeer(socketId: string): void;
  attachRemoteStream(socketId: string, stream: MediaStream, kind?: string): void;
  updatePeerState(socketId: string, state: PeerState): void;
}

// Helper: registry'den null-safe al
function reg<T>(name: string): T | null {
  return BridgeRegistry.get<(...args: unknown[]) => unknown>(name) as T | null;
}

function app(): BridgeAppModule | null       { return reg<BridgeAppModule>('bridgeApp'); }
function ns(): BridgeNSModule | null         { return reg<BridgeNSModule>('BridgeNS'); }
function voiceE2E(): BridgeVoiceE2EModule | null  { return reg<BridgeVoiceE2EModule>('BridgeVoiceE2E'); }
function videoQuality(): BridgeVideoQualityModule | null { return reg<BridgeVideoQualityModule>('BridgeVideoQuality'); }
function voiceVolume(): BridgeVoiceVolumeModule | null   { return reg<BridgeVoiceVolumeModule>('BridgeVoiceVolume'); }
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
  videoOn                                   = false;
  screenSharing                             = false;
  selectedMicId: string | null              = null;
  selectedCameraId: string | null           = null;
  selectedSpeakerId: string | null          = null;
  channelBitrate                            = 64_000;
  peerStreams: Map<string, MediaStream>     = new Map();

  private _abrIntervals: Map<RTCPeerConnection, ReturnType<typeof setInterval>> = new Map();
  private _screenQuality: ScreenQuality                        = 'hd';
  private _mobileAudioOverride: Partial<MediaTrackConstraints> | false = false;

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

  loadSavedDevices(): void {
    const mic    = localStorage.getItem('bridge-mic');
    const camera = localStorage.getItem('bridge-camera');
    const speaker = localStorage.getItem('bridge-speaker');
    if (mic)    this.selectedMicId     = mic;
    if (camera) this.selectedCameraId  = camera;
    if (speaker) this.selectedSpeakerId = speaker;
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    document.querySelectorAll<HTMLMediaElement>('.remote-audio').forEach(el => { el.muted = deafened; });
    if (deafened && !this.muted) this.setMuted(true);
    this._broadcastState();
  }

  private _bindSocketEvents(): void {
    this.socket.on('voice:existing-peers', async (rawPeers: unknown) => {
      const peers = rawPeers as PeerInfo[];
      for (const peer of peers) await this._createOffer(peer.socketId, peer);
      const e2e = voiceE2E();
      if (peers.length > 0 && e2e) {
        e2e.initVoiceE2E(this.currentChannelId, peers)
          .then(ok => { if (ok) e2e.renderVoiceE2EBadge(); });
      }
    });

    this.socket.on('voice:peer-joined', (rawPeer: unknown) => {
      app()?.renderVoicePeer(rawPeer as PeerInfo, false);
    });

    this.socket.on('voice:peer-left', (raw: unknown) => {
      const { socketId } = raw as { socketId: string };
      this._removePeer(socketId);
      app()?.removeVoicePeer(socketId);
    });

    this.socket.on('webrtc:offer', async (raw: unknown) => {
      const { fromSocketId, offer } = raw as { fromSocketId: string; offer: RTCSessionDescriptionInit };
      await this._handleOffer(fromSocketId, offer);
    });

    this.socket.on('webrtc:answer', async (raw: unknown) => {
      const { fromSocketId, answer } = raw as { fromSocketId: string; answer: RTCSessionDescriptionInit };
      const pc = this.peers.get(fromSocketId);
      if (pc && pc.signalingState !== 'stable') {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    this.socket.on('webrtc:ice-candidate', async (raw: unknown) => {
      const { fromSocketId, candidate } = raw as { fromSocketId: string; candidate: RTCIceCandidateInit };
      const pc = this.peers.get(fromSocketId);
      if (pc && candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* non-fatal */ }
      }
    });

    this.socket.on('voice:peer-state', (raw: unknown) => {
      const { socketId, ...state } = raw as { socketId: string } & PeerState;
      app()?.updatePeerState(socketId, state);
    });
  }

  async joinVoice(channelId: string, serverId: string): Promise<void> {
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
      const nsEnabled = nsModule?.enabled !== false;
      const mobileOverride = typeof this._mobileAudioOverride === 'object' ? this._mobileAudioOverride : {};
      const baseConstraints: MediaTrackConstraints = {
        echoCancellation: nsEnabled, noiseSuppression: nsEnabled,
        autoGainControl: nsEnabled, sampleRate: 48000, ...mobileOverride,
      };
      const audioConstraints = this.selectedMicId
        ? { deviceId: { exact: this.selectedMicId }, ...baseConstraints }
        : baseConstraints;

      const rawStream  = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      this.localStream = nsModule ? await nsModule.process(rawStream) : rawStream;
    } catch {
      this.localStream = new MediaStream();
      app()?.toast('Microphone not found — joining muted', 'error');
    }

    this.socket.emit('voice:join', { channelId, serverId });
    vauiMod()?.init(this.socket);
    if (this.localStream) startVAD()?.(this.localStream, channelId);
  }

  leaveVoice(): void {
    if (!this.currentChannelId) return;
    this.socket.emit('voice:leave', { channelId: this.currentChannelId, serverId: this.currentServerId });
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
    stopVAD()?.();
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
      } catch {
        app()?.toast('Camera access denied', 'error');
        return false;
      }
    } else {
      this.localStream?.getVideoTracks().forEach(t => { t.stop(); this.localStream?.removeTrack(t); });
      this.videoOn = false;
    }
    this._broadcastState();
    return true;
  }

  async startScreenShare(quality: ScreenQuality = '1080p60', includeAudio = true): Promise<boolean> {
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
      }
      this.screenSharing = true;
      this._broadcastState();
      return true;
    } catch {
      app()?.toast('Screen share cancelled', 'error');
      return false;
    }
  }

  stopScreenShare(): void {
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

  async setMicDevice(deviceId: string): Promise<void> {
    this.selectedMicId = deviceId;
    localStorage.setItem('bridge-mic', deviceId);
    if (!this.isInVoice() || !this.localStream) return;
    try {
      const nsModule  = ns();
      const nsEnabled = nsModule?.enabled !== false;
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: nsEnabled,
                 noiseSuppression: nsEnabled, autoGainControl: nsEnabled, sampleRate: 48000 },
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
      app()?.toast('Mikrofon değiştirildi ✓', 'success');
    } catch { app()?.toast('Mikrofon değiştirilemedi', 'error'); }
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
      app()?.toast('Kamera değiştirildi ✓', 'success');
    } catch { app()?.toast('Kamera değiştirilemedi', 'error'); }
  }

  async setSpeakerDevice(deviceId: string): Promise<void> {
    this.selectedSpeakerId = deviceId;
    localStorage.setItem('bridge-speaker', deviceId);
    type AudioEl = HTMLMediaElement & { setSinkId?(id: string): Promise<void> };
    document.querySelectorAll<AudioEl>('.remote-audio, audio').forEach(el => {
      el.setSinkId?.(deviceId).catch(() => {});
    });
    app()?.toast('Hoparlör değiştirildi ✓', 'success');
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

  private async _handleOffer(fromSocketId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.peers.get(fromSocketId) ?? this._createPeerConnection(fromSocketId, { socketId: fromSocketId });
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('webrtc:answer', { targetSocketId: fromSocketId, answer: pc.localDescription });
    } catch (e) { log.error('[WebRTC] Answer error:', e); }
  }

  private _createPeerConnection(socketId: string, peerInfo: PeerInfo): RTCPeerConnection {
    // Sprint 120: I7 — iceTransportPolicy sunucudan gelir; FORCE_TURN=true ise 'relay'
    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS.iceServers,
      iceTransportPolicy: ICE_SERVERS.iceTransportPolicy ?? 'all',
    });
    this.peers.set(socketId, pc);

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream!));
    }

    this._preferOpus(pc);
    this.preferVP9(pc);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('webrtc:ice-candidate', { targetSocketId: socketId, candidate });
    };

    pc.ontrack = ({ streams }) => {
      if (!streams[0]) return;
      app()?.attachRemoteStream(socketId, streams[0]);
      const userId = peerInfo.userId;
      if (userId) {
        const saved = parseFloat(localStorage.getItem(`bridge-vol-${userId}`) ?? '');
        if (!isNaN(saved)) {
          setTimeout(() => voiceVolume()?.applyVolume(socketId, saved), 500);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        void this._applyOpusParams(pc, this.channelBitrate || 128_000);
        this.startAdaptiveBitrate(pc);
      }
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        this.stopAdaptiveBitrate(pc);
        this._removePeer(socketId);
        app()?.removeVoicePeer(socketId);
      }
    };

    return pc;
  }

  private _removePeer(socketId: string): void {
    const pc = this.peers.get(socketId);
    if (pc) { pc.close(); this.peers.delete(socketId); }
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

// BridgeRTC'yi registry'ye kaydet — diğer modüller BridgeRegistry.get('BridgeRTC') ile erişebilir
BridgeRegistry.register('BridgeRTC', BridgeRTC as unknown as (...args: unknown[]) => unknown);

export { BridgeRTC };
export type { ScreenQuality };
