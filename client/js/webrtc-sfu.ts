// client/js/webrtc-sfu.js (Mediasoup SFU Client)
//
// Bu dosya webrtc.js'in (P2P) yerini alÄ±r.
// Mediasoup SFU kullanarak:
//   - Eski: 8 kullanÄ±cÄ± â†’ 56 RTCPeerConnection
//   - Yeni: 8 kullanÄ±cÄ± â†’ 2 transport (1 send + 1 recv) = sabit
//
// BaÄŸÄ±mlÄ±lÄ±k: mediasoup-client
//   <script src="https://cdn.jsdelivr.net/npm/mediasoup-client@3/dist/mediasoup-client.min.js"></script>
// VEYA:  npm install mediasoup-client  (build pipeline iÃ§in)

'use strict';

// ── Socket.io–like interface — imported from shared base ─────────────────────
import type { BridgeSocket } from './webrtc-base';

// ── Mediasoup client type stubs ───────────────────────────────────────────────
interface MediasoupTransport {
  on(event: string, fn: (...args: unknown[]) => void): void;
  close(): void;
  produce(opts: unknown): Promise<MediasoupProducer>;
  consume(opts: unknown): Promise<MediasoupConsumer>;
  createSendTransport?: never; // type discriminator
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
declare var mediasoupClient: { Device: new () => MediasoupDevice } | undefined;

class BridgeRTC {
  // ── Property declarations ─────────────────────────────────────────────────
  socket!: BridgeSocket;
  device: MediasoupDevice | null = null;
  sendTransport: MediasoupTransport | null = null;
  recvTransport: MediasoupTransport | null = null;
  producers: Map<string, MediasoupProducer> = new Map();
  consumers: Map<string, MediasoupConsumer> = new Map();
  peerStreams: Map<string, { audio: MediaStream; video: MediaStream }> = new Map();
  localStream: MediaStream | null = null;
  screenStream: MediaStream | null = null;
  currentChannelId: string | null = null;
  currentServerId: string | null = null;
  muted = false;
  deafened = false;
  videoOn = false;
  screenSharing = false;
  selectedMicId: string | null = null;
  selectedCameraId: string | null = null;
  selectedSpeakerId: string | null = null;
  channelBitrate = 64_000;
  _sfuAvailable = false;
  _iceServers: unknown[] = [];
  _iceTransportPolicy = 'all';
  _socketToUserId: Map<string, string> = new Map();
  _redirectCount = 0;
  _abrIntervals: Map<string, unknown> = new Map();
  _screenQuality = 'hd';
  _mobileAudioOverride = false;
  peers: Map<string, unknown> = new Map();
  _p2pPeers: Map<string, unknown> = new Map();

  constructor(socket: BridgeSocket) {
    this.socket = socket;

    // â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€



    // â”€â”€ Device selection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // Mediasoup-client library varlÄ±k kontrolÃ¼
    this._sfuAvailable = typeof mediasoupClient !== 'undefined';

    this._bindSocketEvents();
  }

  // â”€â”€â”€ PUBLIC API (voice.js ile tam uyumlu) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  isInVoice() { return !!this.currentChannelId; }
  getLocalStream() { return this.localStream; }

  // â”€â”€â”€ DEVICES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async getDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        microphones: devices.filter(d => d.kind === 'audioinput'),
        speakers:    devices.filter(d => d.kind === 'audiooutput'),
        cameras:     devices.filter(d => d.kind === 'videoinput'),
      };
    } catch {
      return { microphones: [], speakers: [], cameras: [] };
    }
  }

  loadSavedDevices(): void {
    this.selectedMicId     = localStorage.getItem('bridge-mic')     || null;
    this.selectedCameraId  = localStorage.getItem('bridge-camera')  || null;
    this.selectedSpeakerId = localStorage.getItem('bridge-speaker') || null;
  }

  // â”€â”€â”€ JOIN VOICE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async joinVoice(channelId: string, serverId: string) {
    this.currentChannelId = channelId;
    this.currentServerId  = serverId;

    // Bitrate kanaldan oku (eski sistemle uyumluluk)
    this.channelBitrate = 64_000;
    if (window.currentServerChannels) {
      const ch = window.currentServerChannels.find(c => c._id === channelId);
      if (ch?.bitrate) this.channelBitrate = ch.bitrate as number;
    }

    // Mikrofon aÃ§
    try {
      const nsEnabled = window.BridgeNS?.enabled !== false;
      const audioConstraints = {
        ...(this.selectedMicId ? { deviceId: { exact: this.selectedMicId } } : {}),
        echoCancellation: nsEnabled,
        noiseSuppression: nsEnabled,
        autoGainControl:  nsEnabled,
        sampleRate: 48000,
        channelCount: 2,
      };
      const rawStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      this.localStream = window.BridgeNS ? await window.BridgeNS.process(rawStream) : rawStream;
    } catch {
      this.localStream = new MediaStream();
      window.bridgeApp?.toast('Mikrofon bulunamadÄ± â€” sessiz katÄ±lÄ±ndÄ±', 'error');
    }

    if (this._sfuAvailable) {
      await this._sfuJoin(channelId, serverId);
    } else {
      // Fallback: eski P2P sistemi (mediasoup-client CDN yÃ¼klenemezse)
      console.warn('[BridgeRTC] mediasoup-client bulunamadÄ± â€” P2P moda geÃ§iliyor');
      this.socket.emit('voice:join', { channelId, serverId });
    }
  }

  // â”€â”€â”€ SFU JOIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async _sfuJoin(channelId: string, serverId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      // 1. Sunucudan RTP capabilities al
      this.socket.emit('sfu:get-rtp-capabilities', { channelId });
      this.socket.once('sfu:rtp-capabilities', async (payload: unknown) => {
        const { rtpCapabilities } = payload as { rtpCapabilities: unknown };
        try {
          // 2. Mediasoup Device oluÅŸtur
          this.device = new mediasoupClient!.Device();
          await this.device.load({ routerRtpCapabilities: rtpCapabilities });

          // 3. Sunucuya katÄ±l
          this.socket.emit('sfu:join', {
            channelId,
            serverId,
            rtpCapabilities: this.device.rtpCapabilities,
          });

          // 4. Transport'larÄ± oluÅŸtur
          await this._createSendTransport(channelId);
          await this._createRecvTransport(channelId);

          resolve();
        } catch (e) {
          console.error('[SFU] join error:', e);
          resolve();
        }
      });
    });
  }

  // â”€â”€â”€ SEND TRANSPORT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async _createSendTransport(channelId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.socket.emit('sfu:create-transport', { channelId, direction: 'send' });
      this.socket.once('sfu:transport-created', async (payload: unknown) => {
        const data = payload as { direction: string; id: string; iceParameters: unknown; iceCandidates: unknown; dtlsParameters: unknown };
        if (data.direction !== 'send') return;

        this.sendTransport = this.device!.createSendTransport({
          id:             data.id,
          iceParameters:  data.iceParameters,
          iceCandidates:  data.iceCandidates,
          dtlsParameters: data.dtlsParameters,
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
          this.socket.once('sfu:produced', (res: unknown) => { const { producerId } = res as { producerId: string; kind: string }; (cb as (opts: unknown) => void)({ id: producerId }); });
        });

        // Mikrofon producer'Ä± hemen baÅŸlat
        await this._produceAudio();
        resolve();
      });
    });
  }

  // â”€â”€â”€ RECV TRANSPORT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async _createRecvTransport(channelId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.socket.emit('sfu:create-transport', { channelId, direction: 'recv' });
      this.socket.once('sfu:transport-created', async (payload: unknown) => {
        const data = payload as { direction: string; id: string; iceParameters: unknown; iceCandidates: unknown; dtlsParameters: unknown };
        if (data.direction !== 'recv') return;

        this.recvTransport = this.device!.createRecvTransport({
          id:             data.id,
          iceParameters:  data.iceParameters,
          iceCandidates:  data.iceCandidates,
          dtlsParameters: data.dtlsParameters,
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

  // â”€â”€â”€ PRODUCE AUDIO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async _produceAudio() {
    if (!this.sendTransport || !this.localStream) return;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (!audioTrack) return;

    try {
      const producer = await this.sendTransport.produce({
        track: audioTrack,
        codecOptions: {
          opusStereo:    true,
          opusDtx:       true,  // Sessizlikte paket gÃ¶nderme â€” bant tasarrufu
          opusFec:       true,  // Hata dÃ¼zeltme
          opusPtime:     20,
          opusMaxPlaybackRate: 48000,
        },
      });
      producer.on('trackended', () => this._closeProducer('audio'));
      this.producers.set('audio', producer);
    } catch (e) {
      console.error('[SFU] audio produce error:', e);
    }
  }

  // â”€â”€â”€ CONSUME (baÅŸka peer'Ä±n track'i) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async _consume(producerId, socketId, kind) {
    if (!this.recvTransport || !this.device) return;

    this.socket.emit('sfu:consume', {
      channelId:       this.currentChannelId,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });

    return new Promise((resolve) => {
      this.socket.once('sfu:consumed', async (data) => {
        if (data.producerId !== producerId) return;
        try {
          const consumer = await this.recvTransport.consume({
            id:            data.consumerId,
            producerId:    data.producerId,
            kind:          data.kind,
            rtpParameters: data.rtpParameters,
          });

          this.consumers.set(producerId, consumer);

          // Peer stream'i gÃ¼ncelle
          if (!this.peerStreams.has(socketId)) {
            this.peerStreams.set(socketId, { audio: new MediaStream(), video: new MediaStream() });
          }
          const streams = this.peerStreams.get(socketId);
          const targetStream = (kind === 'video' || kind === 'screen') ? streams.video : streams.audio;
          targetStream.addTrack(consumer.track);

          // UI'a baÄŸla
          window.bridgeApp?.attachRemoteStream(socketId, targetStream, kind);

//           video/screen tile'Ä± video grid'e ekle
          if (kind === 'video' || kind === 'screen') {
            const peerUserId = this._socketToUserId?.get(socketId);
            if (typeof sfuHandleNewProducer === 'function') {
              sfuHandleNewProducer(socketId, peerUserId, targetStream, kind);
            }
          }

          // KiÅŸiye Ã¶zel ses seviyesi
          const peerUserId = this._socketToUserId?.get(socketId);
          if (peerUserId) {
            const saved = parseFloat(localStorage.getItem(`bridge-vol-${peerUserId}`));
            if (!isNaN(saved)) {
              setTimeout(() => BridgeVoiceVolume?.applyVolume(socketId, saved), 500);
            }
          }

          // Consumer'Ä± baÅŸlat â€” sunucu paused baÅŸlatÄ±yor
          this.socket.emit('sfu:resume-consumer', { producerId });
          await consumer.resume?.();

          resolve(consumer);
        } catch (e) {
          console.error('[SFU] consume error:', e);
          resolve(null);
        }
      });
    });
  }

  // â”€â”€â”€ LEAVE VOICE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  leaveVoice() {
    if (!this.currentChannelId) return;

    if (this._sfuAvailable) {
      this.socket.emit('sfu:leave', {
        channelId: this.currentChannelId,
        serverId:  this.currentServerId,
      });
      this._sfuCleanup();
    } else {
      this.socket.emit('voice:leave', {
        channelId: this.currentChannelId,
        serverId:  this.currentServerId,
      });
    }

    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.screenStream = null;

    this.currentChannelId = null;
    this.currentServerId  = null;
    this.videoOn          = false;
    this.screenSharing    = false;
  }

  _sfuCleanup() {
    for (const consumer of this.consumers.values()) consumer.close?.();
    for (const producer of this.producers.values()) producer.close?.();
    this.consumers.clear();
    this.producers.clear();
    this.peerStreams.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.device        = null;
  }

  _closeProducer(kind) {
    const producer = this.producers.get(kind);
    if (!producer) return;
    producer.close();
    this.producers.delete(kind);
    this.socket.emit('sfu:close-producer', { kind });
  }

  // â”€â”€â”€ MUTE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  setMuted(muted) {
    this.muted = muted;
    // Yerel stream track'ini durdur
    this.localStream?.getAudioTracks().forEach(t => t.enabled = !muted);
    // SFU modda producer'Ä± pause/resume et â€” bant geniÅŸliÄŸinden tasarruf
    const audioProducer = this.producers.get('audio');
    if (audioProducer) {
      muted ? audioProducer.pause() : audioProducer.resume();
    }
    this._broadcastState();
  }

  setDeafened(deafened) {
    this.deafened = deafened;
    document.querySelectorAll('.remote-audio').forEach(el => { el.muted = deafened; });
    if (deafened && !this.muted) this.setMuted(true);
    this._broadcastState();
  }

  // â”€â”€â”€ VIDEO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async enableVideo(enable) {
    if (enable) {
      try {
        const videoConstraints = this.selectedCameraId
          ? { deviceId: { exact: this.selectedCameraId } }
          : true;
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
        const videoTrack  = videoStream.getVideoTracks()[0];
        this.localStream?.addTrack(videoTrack);

        if (this._sfuAvailable && this.sendTransport) {
          const producer = await this.sendTransport.produce({
            track: videoTrack,
            encodings: [
              { maxBitrate: 100_000, scaleResolutionDownBy: 4 },  // simulcast katman 1
              { maxBitrate: 300_000, scaleResolutionDownBy: 2 },  // simulcast katman 2
              { maxBitrate: 900_000 },                             // simulcast katman 3 (full)
            ],
            codecOptions: { videoGoogleStartBitrate: 1000 },
          });
          producer.on('trackended', () => this.enableVideo(false));
          this.producers.set('video', producer);
        }
        this.videoOn = true;
      } catch {
        window.bridgeApp?.toast('Kamera eriÅŸimi reddedildi', 'error');
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

  // â”€â”€â”€ SCREEN SHARE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async startScreenShare(quality = 'hd', includeAudio = true) {
    const presets = {
      '4k60':    { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60 } },
      '1440p60': { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 60 } },
      '1440p':   { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } },
      '1080p60': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
      '1080p':   { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      '720p':    { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30 } },
      'hd':      { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30 } },
    };
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { ...presets[quality] || presets['hd'], cursor: 'always' },
        audio: includeAudio ? { echoCancellation: false, noiseSuppression: false } : false,
      });

      const screenTrack = this.screenStream.getVideoTracks()[0];
      screenTrack.onended = () => this.stopScreenShare();

      if (this._sfuAvailable && this.sendTransport) {
        const bitrateMap = {
          '4k60': 20_000_000, '1440p60': 12_000_000, '1440p': 10_000_000,
          '1080p60': 8_000_000, '1080p': 5_000_000, '720p': 3_000_000, 'hd': 2_000_000,
        };
        const producer = await this.sendTransport.produce({
          track:     screenTrack,
          appData:   { screen: true },
          encodings: [{ maxBitrate: bitrateMap[quality] || 2_000_000 }],
          codecOptions: { videoGoogleStartBitrate: 1000 },
        });
        producer.on('trackended', () => this.stopScreenShare());
        this.producers.set('screen', producer);
      }

      this.screenSharing = true;
      this._broadcastState();
      return true;
    } catch {
      window.bridgeApp?.toast('Ekran paylaÅŸÄ±mÄ± iptal edildi', 'error');
      return false;
    }
  }

  stopScreenShare() {
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.screenStream = null;
    this._closeProducer('screen');
    this.screenSharing = false;
    this._broadcastState();
    if (this.videoOn) this.enableVideo(true);
  }

  // â”€â”€â”€ DEVICE SWITCHING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async setMicDevice(deviceId: string) {
    this.selectedMicId = deviceId;
    localStorage.setItem('bridge-mic', deviceId);
    if (!this.isInVoice() || !this.localStream) return;
    try {
      const nsEnabled = window.BridgeNS?.enabled !== false;
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: nsEnabled, noiseSuppression: nsEnabled, autoGainControl: nsEnabled, sampleRate: 48000 },
        video: false,
      });
      const cleanStream = window.BridgeNS ? await window.BridgeNS.process(rawStream) : rawStream;
      const newTrack = cleanStream.getAudioTracks()[0];
      this.localStream.getAudioTracks().forEach(t => { t.stop(); this.localStream.removeTrack(t); });
      this.localStream.addTrack(newTrack);
      // SFU: producer track'ini deÄŸiÅŸtir
      const audioProducer = this.producers.get('audio');
      if (audioProducer) await audioProducer.replaceTrack({ track: newTrack });
      window.bridgeApp?.toast('Mikrofon deÄŸiÅŸtirildi âœ“', 'success');
    } catch {
      window.bridgeApp?.toast('Mikrofon deÄŸiÅŸtirilemedi', 'error');
    }
  }

  async setCameraDevice(deviceId: string) {
    this.selectedCameraId = deviceId;
    localStorage.setItem('bridge-camera', deviceId);
    if (!this.videoOn || !this.localStream) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      const newTrack  = newStream.getVideoTracks()[0];
      this.localStream.getVideoTracks().forEach(t => { t.stop(); this.localStream.removeTrack(t); });
      this.localStream.addTrack(newTrack);
      const videoProducer = this.producers.get('video');
      if (videoProducer) await videoProducer.replaceTrack({ track: newTrack });
      window.bridgeApp?.toast('Kamera deÄŸiÅŸtirildi âœ“', 'success');
    } catch {
      window.bridgeApp?.toast('Kamera deÄŸiÅŸtirilemedi', 'error');
    }
  }

  async setSpeakerDevice(deviceId: string) {
    this.selectedSpeakerId = deviceId;
    localStorage.setItem('bridge-speaker', deviceId);
    document.querySelectorAll('.remote-audio, audio').forEach(el => {
      if (typeof el.setSinkId === 'function') el.setSinkId(deviceId).catch(() => {});
    });
    window.bridgeApp?.toast('HoparlÃ¶r deÄŸiÅŸtirildi âœ“', 'success');
  }

  async setChannelBitrate(bitrate) {
    this.channelBitrate = bitrate;
    // SFU modda codec seÃ§eneÄŸini gÃ¼ncellemek iÃ§in producer kapatÄ±p yeniden aÃ§mak gerekir
    // Åimdilik sadece kaydediyoruz â€” sonraki produce'da uygulanÄ±r
  }

  // â”€â”€â”€ SOCKET EVENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _bindSocketEvents(): void {
    // â”€ SFU events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this.socket.on('sfu:joined', async ({ existingPeers, iceServers, iceTransportPolicy }) => {
      // Sunucudan gelen TURN/STUN listesini sakla â€” transport'larda kullanÄ±lÄ±r
      if (iceServers && iceServers.length) {
        this._iceServers         = iceServers;
        this._iceTransportPolicy = iceTransportPolicy || 'all';
        console.log('[SFU] ICE sunucularÄ± gÃ¼ncellendi:', iceServers.map(s => s.urls).flat().join(', '));
      }
      this._socketToUserId = this._socketToUserId || new Map();
      for (const peer of existingPeers) {
        this._socketToUserId.set(peer.socketId, peer.userId);
        window.bridgeApp?.renderVoicePeer(peer, false);
        // Mevcut peer'larÄ±n producer'larÄ±nÄ± consume et
        for (const { producerId, kind } of (peer.producers || [])) {
          await this._consume(producerId, peer.socketId, kind);
        }
      }
      // Voice E2E uyumluluÄŸu
      if (existingPeers.length > 0 && window.BridgeVoiceE2E) {
        BridgeVoiceE2E.initVoiceE2E(this.currentChannelId, existingPeers)
          .then(ok => { if (ok) BridgeVoiceE2E.renderVoiceE2EBadge(); });
      }
    });

    this.socket.on('sfu:peer-joined', (peer) => {
      this._socketToUserId = this._socketToUserId || new Map();
      this._socketToUserId.set(peer.socketId, peer.userId);
      window.bridgeApp?.renderVoicePeer(peer, false);
    });

    this.socket.on('sfu:new-producer', async ({ socketId, userId, producerId, kind }) => {
      // Yeni bir peer track gÃ¶ndermeye baÅŸladÄ± â€” tÃ¼ket
      await this._consume(producerId, socketId, kind);
    });

    this.socket.on('sfu:producer-closed', ({ producerId }) => {
      const consumer = this.consumers.get(producerId);
      if (consumer) {
        consumer.close?.();
        this.consumers.delete(producerId);
      }
    });

    this.socket.on('sfu:peer-left', ({ socketId, userId }) => {
      this._cleanupPeerStreams(socketId);
      window.bridgeApp?.removeVoicePeer(socketId);
    });

    // â”€ P2P fallback events (mediasoup-client yoksa) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this.socket.on('voice:existing-peers', async (peers) => {
      if (this._sfuAvailable) return; // SFU modda bu eventler gÃ¶rmezden gel
      for (const peer of peers) await this._p2pCreateOffer(peer.socketId, peer);
      if (peers.length > 0 && window.BridgeVoiceE2E) {
        BridgeVoiceE2E.initVoiceE2E(this.currentChannelId, peers)
          .then(ok => { if (ok) BridgeVoiceE2E.renderVoiceE2EBadge(); });
      }
    });

    this.socket.on('voice:peer-joined', (peer) => {
      if (this._sfuAvailable) return;
      window.bridgeApp?.renderVoicePeer(peer, false);
    });

    this.socket.on('voice:peer-left', ({ socketId }) => {
      if (this._sfuAvailable) return;
      this._p2pRemovePeer(socketId);
      window.bridgeApp?.removeVoicePeer(socketId);
    });

    // â”€ Ortak events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this.socket.on('voice:peer-state', ({ socketId, muted, deafened, screensharing, video }) => {
      window.bridgeApp?.updatePeerState(socketId, { muted, deafened, screensharing, video });
    });

    // P2P sinyalizasyon (fallback mod iÃ§in)
    this.socket.on('webrtc:offer',         async ({ fromSocketId, offer })    => { if (!this._sfuAvailable) await this._p2pHandleOffer(fromSocketId, offer); });
    this.socket.on('webrtc:answer',        async ({ fromSocketId, answer })   => { if (!this._sfuAvailable) { const pc = this._p2pPeers?.get(fromSocketId); if (pc && pc.signalingState !== 'stable') await pc.setRemoteDescription(new RTCSessionDescription(answer)); } });
    this.socket.on('webrtc:ice-candidate', async ({ fromSocketId, candidate }) => { if (!this._sfuAvailable) { const pc = this._p2pPeers?.get(fromSocketId); if (pc && candidate) { try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {} } } });

    // â”€â”€ sfu:redirect â€” Cluster modda oda baÅŸka node'da â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Sunucu, bu kanalÄ±n baÅŸka bir node'da olduÄŸunu bildiriyor.
    // 600ms bekleyip tekrar join dene (load balancer yeniden yÃ¶nlendirmeli).
    this.socket.on('sfu:redirect', ({ channelId, ownerNodeId, message }) => {
      console.warn(`[SFU] Redirect: channel=${channelId} owner=${ownerNodeId}`, message);
      this._redirectCount = (this._redirectCount || 0) + 1;
      if (this._redirectCount > 3) {
        console.error('[SFU] Redirect dÃ¶ngÃ¼sÃ¼ algÄ±landÄ±, vazgeÃ§iliyor');
        this._redirectCount = 0;
        window.bridgeApp?.showToast?.('Ses kanalÄ±na baÄŸlanÄ±lamadÄ±. LÃ¼tfen tekrar deneyin.', 'error');
        return;
      }
      setTimeout(() => {
        if (this.currentChannelId === channelId) {
          console.log('[SFU] Yeniden join deneniyorâ€¦');
          this.socket.emit('sfu:join', {
            channelId,
            serverId:        this.currentServerId,
            rtpCapabilities: this.device?.rtpCapabilities,
          });
        }
      }, 600);
    });
  }

  _broadcastState() {
    if (!this.currentChannelId) return;
    this.socket.emit('voice:state-update', {
      channelId: this.currentChannelId,
      muted: this.muted, deafened: this.deafened,
      screensharing: this.screenSharing, video: this.videoOn,
    });
  }

  _cleanupPeerStreams(socketId) {
    const streams = this.peerStreams.get(socketId);
    if (streams) {
      streams.audio?.getTracks().forEach(t => t.stop());
      streams.video?.getTracks().forEach(t => t.stop());
      this.peerStreams.delete(socketId);
    }
    // Bu peer'Ä±n consumer'larÄ±nÄ± bul ve kapat
    for (const [producerId, consumer] of this.consumers) {
      if (consumer._socketId === socketId) {
        consumer.close?.();
        this.consumers.delete(producerId);
      }
    }
  }

  // â”€â”€â”€ P2P FALLBACK (mediasoup-client yoksa) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Mevcut webrtc.js mantÄ±ÄŸÄ±nÄ±n kopyasÄ± â€” tam uyumluluk iÃ§in korundu

  _p2pGetPeers() {
    if (!this._p2pPeers) this._p2pPeers = new Map();
    return this._p2pPeers;
  }

  async _p2pCreateOffer(targetSocketId, peerInfo) {
    const pc = this._p2pCreatePeer(targetSocketId, peerInfo);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('webrtc:offer', { targetSocketId, offer: pc.localDescription, channelId: this.currentChannelId });
    } catch (e) { console.error('[P2P] Offer error:', e); }
  }

  async _p2pHandleOffer(fromSocketId, offer) {
    const pc = this._p2pGetPeers().get(fromSocketId) || this._p2pCreatePeer(fromSocketId, { socketId: fromSocketId });
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('webrtc:answer', { targetSocketId: fromSocketId, answer: pc.localDescription });
    } catch (e) { console.error('[P2P] Answer error:', e); }
  }

  _p2pCreatePeer(socketId, peerInfo) {
    // Sunucudan gelen ICE listesi varsa kullan; yoksa Google STUN fallback
    const iceServers = this._iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
    const ICE_SERVERS = {
      iceServers,
      iceTransportPolicy: this._iceTransportPolicy || 'all',
    };
    const pc = new RTCPeerConnection(ICE_SERVERS);
    this._p2pGetPeers().set(socketId, pc);
    if (this.localStream) this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.socket.emit('webrtc:ice-candidate', { targetSocketId: socketId, candidate }); };
    pc.ontrack = ({ streams }) => { if (streams[0]) window.bridgeApp?.attachRemoteStream(socketId, streams[0]); };
    pc.onconnectionstatechange = () => { if (['disconnected','failed','closed'].includes(pc.connectionState)) { this._p2pRemovePeer(socketId); window.bridgeApp?.removeVoicePeer(socketId); } };
    return pc;
  }

  _p2pRemovePeer(socketId) {
    const pc = this._p2pPeers?.get(socketId);
    if (pc) { pc.close(); this._p2pPeers.delete(socketId); }
  }

  // V2E uyumluluk
  registerVoiceE2EEvents(myUserId: string) {
    if (window.BridgeVoiceE2E) BridgeVoiceE2E.registerSocketEvents(this.socket, myUserId);
  }
}

