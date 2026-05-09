// client/js/webrtc-sfu.js (Mediasoup SFU Client)
//
// Bu dosya webrtc.js'in (P2P) yerini alır.
// Mediasoup SFU kullanarak:
//   - Eski: 8 kullanıcı → 56 RTCPeerConnection
//   - Yeni: 8 kullanıcı → 2 transport (1 send + 1 recv) = sabit
//
// Bağımlılık: mediasoup-client
//   <script src="https://cdn.jsdelivr.net/npm/mediasoup-client@3/dist/mediasoup-client.min.js"></script>
// VEYA:  npm install mediasoup-client  (build pipeline için)

'use strict';

class BridgeRTC {
  constructor(socket) {
    this.socket = socket;

    // ── State ──────────────────────────────────────────────────
    this.device          = null;   // mediasoup.Device
    this.sendTransport   = null;   // MediasoupTransport (send)
    this.recvTransport   = null;   // MediasoupTransport (recv)
    this.producers       = new Map();  // kind ('audio'|'video'|'screen') → Producer
    this.consumers       = new Map();  // producerId → Consumer
    this.peerStreams      = new Map();  // socketId → { audio: MediaStream, video: MediaStream }

    this.localStream     = null;
    this.screenStream    = null;
    this.currentChannelId = null;
    this.currentServerId  = null;

    this.muted        = false;
    this.deafened     = false;
    this.videoOn      = false;
    this.screenSharing = false;

    // ── Device selection ──────────────────────────────────────
    this.selectedMicId     = null;
    this.selectedCameraId  = null;
    this.selectedSpeakerId = null;

    // Mediasoup-client library varlık kontrolü
    this._sfuAvailable = typeof mediasoupClient !== 'undefined';

    this._bindSocketEvents();
  }

  // ─── PUBLIC API (voice.js ile tam uyumlu) ─────────────────────

  isInVoice() { return !!this.currentChannelId; }
  getLocalStream() { return this.localStream; }

  // ─── DEVICES ────────────────────────────────────────────────
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

  loadSavedDevices() {
    this.selectedMicId     = localStorage.getItem('bridge-mic')     || null;
    this.selectedCameraId  = localStorage.getItem('bridge-camera')  || null;
    this.selectedSpeakerId = localStorage.getItem('bridge-speaker') || null;
  }

  // ─── JOIN VOICE ───────────────────────────────────────────────
  async joinVoice(channelId, serverId) {
    this.currentChannelId = channelId;
    this.currentServerId  = serverId;

    // Bitrate kanaldan oku (eski sistemle uyumluluk)
    this.channelBitrate = 64_000;
    if (window.currentServerChannels) {
      const ch = window.currentServerChannels.find(c => c._id === channelId);
      if (ch?.bitrate) this.channelBitrate = ch.bitrate;
    }

    // Mikrofon aç
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
      window.bridgeApp?.toast('Mikrofon bulunamadı — sessiz katılındı', 'error');
    }

    if (this._sfuAvailable) {
      await this._sfuJoin(channelId, serverId);
    } else {
      // Fallback: eski P2P sistemi (mediasoup-client CDN yüklenemezse)
      console.warn('[BridgeRTC] mediasoup-client bulunamadı — P2P moda geçiliyor');
      this.socket.emit('voice:join', { channelId, serverId });
    }
  }

  // ─── SFU JOIN ────────────────────────────────────────────────
  async _sfuJoin(channelId, serverId) {
    return new Promise((resolve) => {
      // 1. Sunucudan RTP capabilities al
      this.socket.emit('sfu:get-rtp-capabilities', { channelId });
      this.socket.once('sfu:rtp-capabilities', async ({ rtpCapabilities }) => {
        try {
          // 2. Mediasoup Device oluştur
          this.device = new mediasoupClient.Device();
          await this.device.load({ routerRtpCapabilities: rtpCapabilities });

          // 3. Sunucuya katıl
          this.socket.emit('sfu:join', {
            channelId,
            serverId,
            rtpCapabilities: this.device.rtpCapabilities,
          });

          // 4. Transport'ları oluştur
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

  // ─── SEND TRANSPORT ──────────────────────────────────────────
  async _createSendTransport(channelId) {
    return new Promise((resolve) => {
      this.socket.emit('sfu:create-transport', { channelId, direction: 'send' });
      this.socket.once('sfu:transport-created', async (data) => {
        if (data.direction !== 'send') return;

        this.sendTransport = this.device.createSendTransport({
          id:             data.id,
          iceParameters:  data.iceParameters,
          iceCandidates:  data.iceCandidates,
          dtlsParameters: data.dtlsParameters,
        });

        this.sendTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
          this.socket.emit('sfu:connect-transport', { channelId, direction: 'send', dtlsParameters });
          this.socket.once('sfu:transport-connected', (d) => {
            if (d.direction === 'send') cb();
          });
        });

        this.sendTransport.on('produce', async ({ kind, rtpParameters, appData }, cb, eb) => {
          this.socket.emit('sfu:produce', { channelId, kind, rtpParameters, appData });
          this.socket.once('sfu:produced', ({ producerId, kind: k }) => cb({ id: producerId }));
        });

        // Mikrofon producer'ı hemen başlat
        await this._produceAudio();
        resolve();
      });
    });
  }

  // ─── RECV TRANSPORT ──────────────────────────────────────────
  async _createRecvTransport(channelId) {
    return new Promise((resolve) => {
      this.socket.emit('sfu:create-transport', { channelId, direction: 'recv' });
      this.socket.once('sfu:transport-created', async (data) => {
        if (data.direction !== 'recv') return;

        this.recvTransport = this.device.createRecvTransport({
          id:             data.id,
          iceParameters:  data.iceParameters,
          iceCandidates:  data.iceCandidates,
          dtlsParameters: data.dtlsParameters,
        });

        this.recvTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
          this.socket.emit('sfu:connect-transport', { channelId, direction: 'recv', dtlsParameters });
          this.socket.once('sfu:transport-connected', (d) => {
            if (d.direction === 'recv') cb();
          });
        });

        resolve();
      });
    });
  }

  // ─── PRODUCE AUDIO ───────────────────────────────────────────
  async _produceAudio() {
    if (!this.sendTransport || !this.localStream) return;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (!audioTrack) return;

    try {
      const producer = await this.sendTransport.produce({
        track: audioTrack,
        codecOptions: {
          opusStereo:    true,
          opusDtx:       true,  // Sessizlikte paket gönderme — bant tasarrufu
          opusFec:       true,  // Hata düzeltme
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

  // ─── CONSUME (başka peer'ın track'i) ─────────────────────────
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

          // Peer stream'i güncelle
          if (!this.peerStreams.has(socketId)) {
            this.peerStreams.set(socketId, { audio: new MediaStream(), video: new MediaStream() });
          }
          const streams = this.peerStreams.get(socketId);
          const targetStream = (kind === 'video' || kind === 'screen') ? streams.video : streams.audio;
          targetStream.addTrack(consumer.track);

          // UI'a bağla
          window.bridgeApp?.attachRemoteStream(socketId, targetStream, kind);

//           video/screen tile'ı video grid'e ekle
          if (kind === 'video' || kind === 'screen') {
            const peerUserId = this._socketToUserId?.get(socketId);
            if (typeof sfuHandleNewProducer === 'function') {
              sfuHandleNewProducer(socketId, peerUserId, targetStream, kind);
            }
          }

          // Kişiye özel ses seviyesi
          const peerUserId = this._socketToUserId?.get(socketId);
          if (peerUserId) {
            const saved = parseFloat(localStorage.getItem(`bridge-vol-${peerUserId}`));
            if (!isNaN(saved)) {
              setTimeout(() => BridgeVoiceVolume?.applyVolume(socketId, saved), 500);
            }
          }

          // Consumer'ı başlat — sunucu paused başlatıyor
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

  // ─── LEAVE VOICE ─────────────────────────────────────────────
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

  // ─── MUTE ─────────────────────────────────────────────────────
  setMuted(muted) {
    this.muted = muted;
    // Yerel stream track'ini durdur
    this.localStream?.getAudioTracks().forEach(t => t.enabled = !muted);
    // SFU modda producer'ı pause/resume et — bant genişliğinden tasarruf
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

  // ─── VIDEO ────────────────────────────────────────────────────
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
        window.bridgeApp?.toast('Kamera erişimi reddedildi', 'error');
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

  // ─── SCREEN SHARE ─────────────────────────────────────────────
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
      window.bridgeApp?.toast('Ekran paylaşımı iptal edildi', 'error');
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

  // ─── DEVICE SWITCHING ─────────────────────────────────────────
  async setMicDevice(deviceId) {
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
      // SFU: producer track'ini değiştir
      const audioProducer = this.producers.get('audio');
      if (audioProducer) await audioProducer.replaceTrack({ track: newTrack });
      window.bridgeApp?.toast('Mikrofon değiştirildi ✓', 'success');
    } catch {
      window.bridgeApp?.toast('Mikrofon değiştirilemedi', 'error');
    }
  }

  async setCameraDevice(deviceId) {
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
      window.bridgeApp?.toast('Kamera değiştirildi ✓', 'success');
    } catch {
      window.bridgeApp?.toast('Kamera değiştirilemedi', 'error');
    }
  }

  async setSpeakerDevice(deviceId) {
    this.selectedSpeakerId = deviceId;
    localStorage.setItem('bridge-speaker', deviceId);
    document.querySelectorAll('.remote-audio, audio').forEach(el => {
      if (typeof el.setSinkId === 'function') el.setSinkId(deviceId).catch(() => {});
    });
    window.bridgeApp?.toast('Hoparlör değiştirildi ✓', 'success');
  }

  async setChannelBitrate(bitrate) {
    this.channelBitrate = bitrate;
    // SFU modda codec seçeneğini güncellemek için producer kapatıp yeniden açmak gerekir
    // Şimdilik sadece kaydediyoruz — sonraki produce'da uygulanır
  }

  // ─── SOCKET EVENTS ────────────────────────────────────────────
  _bindSocketEvents() {
    // ─ SFU events ─────────────────────────────────────────────
    this.socket.on('sfu:joined', async ({ existingPeers, iceServers, iceTransportPolicy }) => {
      // Sunucudan gelen TURN/STUN listesini sakla — transport'larda kullanılır
      if (iceServers && iceServers.length) {
        this._iceServers         = iceServers;
        this._iceTransportPolicy = iceTransportPolicy || 'all';
        console.log('[SFU] ICE sunucuları güncellendi:', iceServers.map(s => s.urls).flat().join(', '));
      }
      this._socketToUserId = this._socketToUserId || new Map();
      for (const peer of existingPeers) {
        this._socketToUserId.set(peer.socketId, peer.userId);
        window.bridgeApp?.renderVoicePeer(peer, false);
        // Mevcut peer'ların producer'larını consume et
        for (const { producerId, kind } of (peer.producers || [])) {
          await this._consume(producerId, peer.socketId, kind);
        }
      }
      // Voice E2E uyumluluğu
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
      // Yeni bir peer track göndermeye başladı — tüket
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

    // ─ P2P fallback events (mediasoup-client yoksa) ───────────
    this.socket.on('voice:existing-peers', async (peers) => {
      if (this._sfuAvailable) return; // SFU modda bu eventler görmezden gel
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

    // ─ Ortak events ───────────────────────────────────────────
    this.socket.on('voice:peer-state', ({ socketId, muted, deafened, screensharing, video }) => {
      window.bridgeApp?.updatePeerState(socketId, { muted, deafened, screensharing, video });
    });

    // P2P sinyalizasyon (fallback mod için)
    this.socket.on('webrtc:offer',         async ({ fromSocketId, offer })    => { if (!this._sfuAvailable) await this._p2pHandleOffer(fromSocketId, offer); });
    this.socket.on('webrtc:answer',        async ({ fromSocketId, answer })   => { if (!this._sfuAvailable) { const pc = this._p2pPeers?.get(fromSocketId); if (pc && pc.signalingState !== 'stable') await pc.setRemoteDescription(new RTCSessionDescription(answer)); } });
    this.socket.on('webrtc:ice-candidate', async ({ fromSocketId, candidate }) => { if (!this._sfuAvailable) { const pc = this._p2pPeers?.get(fromSocketId); if (pc && candidate) { try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {} } } });

    // ── sfu:redirect — Cluster modda oda başka node'da ────────────────────
    // Sunucu, bu kanalın başka bir node'da olduğunu bildiriyor.
    // 600ms bekleyip tekrar join dene (load balancer yeniden yönlendirmeli).
    this.socket.on('sfu:redirect', ({ channelId, ownerNodeId, message }) => {
      console.warn(`[SFU] Redirect: channel=${channelId} owner=${ownerNodeId}`, message);
      this._redirectCount = (this._redirectCount || 0) + 1;
      if (this._redirectCount > 3) {
        console.error('[SFU] Redirect döngüsü algılandı, vazgeçiliyor');
        this._redirectCount = 0;
        window.bridgeApp?.showToast?.('Ses kanalına bağlanılamadı. Lütfen tekrar deneyin.', 'error');
        return;
      }
      setTimeout(() => {
        if (this.currentChannelId === channelId) {
          console.log('[SFU] Yeniden join deneniyor…');
          this.socket.emit('sfu:join', {
            channelId,
            serverId:        this.currentServerId,
            rtpCapabilities: this._device?.rtpCapabilities,
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
    // Bu peer'ın consumer'larını bul ve kapat
    for (const [producerId, consumer] of this.consumers) {
      if (consumer._socketId === socketId) {
        consumer.close?.();
        this.consumers.delete(producerId);
      }
    }
  }

  // ─── P2P FALLBACK (mediasoup-client yoksa) ────────────────────
  // Mevcut webrtc.js mantığının kopyası — tam uyumluluk için korundu

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
  registerVoiceE2EEvents(myUserId) {
    if (window.BridgeVoiceE2E) BridgeVoiceE2E.registerSocketEvents(this.socket, myUserId);
  }
}

export const webrtc_sfuReady = true;
