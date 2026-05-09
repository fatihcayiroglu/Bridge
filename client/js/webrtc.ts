// Bridge WebRTC Manager
// Handles: voice, video, screen share with Google STUN + optional TURN

// ICE config â€” server'dan dinamik olarak yÃ¼kle (TURN desteÄŸi iÃ§in)
let ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ]
};

// Server'dan TURN bilgisini yÃ¼kle â€” /api/rtc/ice-config endpoint'i
// bridge-v33: sunucu .env'deki TURN_URL varsa ekler
(async () => {
  try {
    const API = window.API || '';
    const token = localStorage.getItem('token');
    if (!token) return;
    const r = await fetch(`${API}/api/rtc/ice-config`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (r.ok) {
      const cfg = await r.json();
      if (cfg?.iceServers?.length) {
        ICE_SERVERS = cfg;
        console.log('[WebRTC] ICE config yÃ¼klendi â€”', cfg.iceServers.length, 'sunucu');
      }
    }
  } catch {}
})();

// ── Socket.io–like interface — imported from shared base ─────────────────────
import type { BridgeSocket } from './webrtc-base';

class BridgeRTC {
  // ── Property declarations ─────────────────────────────────────────────────
  socket!: BridgeSocket;
  peers: Map<string, RTCPeerConnection> = new Map();
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
  _iceServers: RTCIceServer[] = [];
  _iceTransportPolicy: RTCIceTransportPolicy = 'all';
  _socketToUserId: Map<string, string> = new Map();
  _redirectCount = 0;
  _abrIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  _screenQuality = 'hd';
  _mobileAudioOverride = false;
  _p2pPeers: Map<string, unknown> = new Map();
  peerStreams: Map<string, MediaStream> = new Map();

  constructor(socket: BridgeSocket) {
    this.socket = socket;
    this._bindSocketEvents();
  }

  // â”€â”€â”€ GET DEVICES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async getDevices() {
    try {
      // Request permissions first so labels are populated
      await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        microphones: devices.filter(d => d.kind === 'audioinput'),
        speakers:    devices.filter(d => d.kind === 'audiooutput'),
        cameras:     devices.filter(d => d.kind === 'videoinput'),
      };
    } catch (e) {
      console.warn('getDevices error:', e);
      return { microphones: [], speakers: [], cameras: [] };
    }
  }

  // â”€â”€â”€ SET DEAFENED â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  setDeafened(deafened) {
    this.deafened = deafened;
    // Mute/unmute all remote audio elements
    document.querySelectorAll('.remote-audio').forEach(el => {
      el.muted = deafened;
    });
    // SaÄŸÄ±rlaÅŸtÄ±rÄ±ldÄ±ÄŸÄ±nda mikrofonu otomatik kapat
    if (deafened && !this.muted) this.setMuted(true);
    this._broadcastState();
  }

  // â”€â”€â”€ SOCKET EVENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _bindSocketEvents() {
    this.socket.on('voice:existing-peers', async (peers) => {
      for (const peer of peers) {
        await this._createOffer(peer.socketId, peer);
      }
      // Voice E2E: tÃ¼m mevcut peer'lar iÃ§in key exchange baÅŸlat
      if (peers.length > 0 && window.BridgeVoiceE2E) {
        BridgeVoiceE2E.initVoiceE2E(this.currentChannelId, peers)
          .then(ok => { if (ok) BridgeVoiceE2E.renderVoiceE2EBadge(); });
      }
    });

    this.socket.on('voice:peer-joined', async (peer) => {
      // Will receive offer from them, just render placeholder
      window.bridgeApp?.renderVoicePeer(peer, false);
    });

    this.socket.on('voice:peer-left', ({ socketId, userId }) => {
      this._removePeer(socketId);
      window.bridgeApp?.removeVoicePeer(socketId);
    });

    this.socket.on('webrtc:offer', async ({ fromSocketId, offer }) => {
      await this._handleOffer(fromSocketId, offer);
    });

    this.socket.on('webrtc:answer', async ({ fromSocketId, answer }) => {
      const pc = this.peers.get(fromSocketId);
      if (pc && pc.signalingState !== 'stable') {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    this.socket.on('webrtc:ice-candidate', async ({ fromSocketId, candidate }) => {
      const pc = this.peers.get(fromSocketId);
      if (pc && candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
      }
    });

    this.socket.on('voice:peer-state', ({ socketId, muted, deafened, screensharing, video }) => {
      window.bridgeApp?.updatePeerState(socketId, { muted, deafened, screensharing, video });
    });
  }

  // â”€â”€â”€ JOIN VOICE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async joinVoice(channelId, serverId) {
    this.currentChannelId = channelId;
    this.currentServerId  = serverId;

//     kanalÄ±n bitrate ayarÄ±nÄ± al
    this.channelBitrate = 64_000; // default
    if (window.currentServerChannels) {
      const ch = window.currentServerChannels.find(c => c._id === channelId);
      if (ch?.bitrate) this.channelBitrate = ch.bitrate;
    }

    try {
      // TarayÄ±cÄ± native gÃ¼rÃ¼ltÃ¼ bastÄ±rma â€” BridgeNS ayarlarÄ±ndan oku
      const nsEnabled = window.BridgeNS?.enabled !== false;

      // Mobil ses kÄ±sÄ±tlamalarÄ± â€” BridgeMobileUX tarafÄ±ndan ayarlanÄ±r (Capacitor'da)
      const mobileOverride = this._mobileAudioOverride || {};

      const baseConstraints = {
        echoCancellation: nsEnabled,
        noiseSuppression: nsEnabled,
        autoGainControl:  nsEnabled,
        sampleRate:       48000,
//         sampleSize:       16,      16-bit PCM
//         channelCount:     2,       stereo (Opus stereo iÃ§in gerekli)
//         latency:          0.01,    ~10ms hedef gecikme
        ...mobileOverride,  // mobil optimize kÄ±sÄ±tlamalar Ã¼zerine yazar
      };

      const audioConstraints = this.selectedMicId
        ? { deviceId: { exact: this.selectedMicId }, ...baseConstraints }
        : baseConstraints;

      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      });

      // Web Audio / RNNoise katmanÄ± â€” tam entegrasyon
      // BridgeNS.process() rawStream'i alÄ±r ve filtrelenmiÅŸ stream dÃ¶ndÃ¼rÃ¼r
      // Mod: 'basic' | 'advanced' | 'rnnoise' â€” settings modalÄ±ndan yÃ¶netilir
      if (window.BridgeNS && this._mobileAudioOverride === undefined) {
        // Desktop: NS pipeline'dan geÃ§ir
        this.localStream = await window.BridgeNS.process(rawStream);
      } else if (window.BridgeNS && nsEnabled) {
        // Mobil: sadece enabled ise NS pipeline'a sok (performans)
        this.localStream = await window.BridgeNS.process(rawStream);
      } else {
        // NS kapalÄ±: ham stream kullan
        this.localStream = rawStream;
      }

    } catch (e) {
      // No mic â€” create empty stream
      this.localStream = new MediaStream();
      window.bridgeApp?.toast('Microphone not found â€” joining muted', 'error');
    }

    this.socket.emit('voice:join', { channelId, serverId });
  }

  // â”€â”€â”€ LEAVE VOICE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  leaveVoice() {
    if (!this.currentChannelId) return;

    this.socket.emit('voice:leave', {
      channelId: this.currentChannelId,
      serverId: this.currentServerId
    });

    // Close all peer connections
    for (const [id, pc] of this.peers) pc.close();
    this.peers.clear();

    // Stop streams
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.screenStream = null;

    this.currentChannelId = null;
    this.currentServerId = null;
    this.videoOn = false;
    this.screenSharing = false;
  }

  // â”€â”€â”€ MUTE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  setMuted(muted) {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach(t => t.enabled = !muted);
    this._broadcastState();
  }

  // â”€â”€â”€ VIDEO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async enableVideo(enable) {
    if (enable) {
      try {
        // Video kalitesi ayarlarÄ± â€” BridgeVideoQuality modÃ¼lÃ¼nden oku
        const vq = window.BridgeVideoQuality?.getConstraints() || {};
        const baseConstraints = this.selectedCameraId
          ? { deviceId: { exact: this.selectedCameraId }, ...vq }
          : { ...vq };
        const videoConstraints = Object.keys(baseConstraints).length ? baseConstraints : true;
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
        const videoTrack = videoStream.getVideoTracks()[0];
        this.localStream.addTrack(videoTrack);
        // Replace track in all peers
        for (const pc of this.peers.values()) {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video');
          if (sender) sender.replaceTrack(videoTrack);
          else pc.addTrack(videoTrack, this.localStream);
        }
        this.videoOn = true;
      } catch(e) {
        window.bridgeApp?.toast('Camera access denied', 'error');
        return false;
      }
    } else {
      this.localStream?.getVideoTracks().forEach(t => { t.stop(); this.localStream.removeTrack(t); });
      this.videoOn = false;
    }
    this._broadcastState();
    return true;
  }

  // â”€â”€â”€ SCREEN SHARE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async startScreenShare(quality = '1080p60', includeAudio = true) {
    const presets = {
      '4k60':    { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60, max: 60 }, cursor: 'always' },
      '1440p60': { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 60, max: 60 }, cursor: 'always' },
      '1440p':   { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30, max: 30 }, cursor: 'always' },
      '1080p60': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 }, cursor: 'always' },
      '1080p':   { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 }, cursor: 'always' },
      '720p':    { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30, max: 30 }, cursor: 'always' },
      'hd':      { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30           }, cursor: 'always' },
    };
    const videoConstraints = presets[quality] || presets['1080p60'];
    this._screenQuality = quality;
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: includeAudio
          ? { echoCancellation: false, noiseSuppression: false, sampleRate: 48000 }
          : false,
      });

      const screenTrack = this.screenStream.getVideoTracks()[0];
      screenTrack.onended = () => this.stopScreenShare();

      // Replace/add video track in all peers with high bitrate encoding
      for (const pc of this.peers.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(screenTrack);
        } else {
          pc.addTrack(screenTrack, this.screenStream);
        }
        // Set high bitrate for quality
        const params = sender ? sender.getParameters() : null;
        if (params && params.encodings) {
          const bitrateMap = { '4k60': 20_000_000, '1440p60': 12_000_000, '1440p': 10_000_000, '1080p60': 8_000_000, '1080p': 5_000_000, '720p': 3_000_000 };
          const fpsMap = { '4k60': 60, '1440p60': 60, '1440p': 30, '1080p60': 60, '1080p': 30, '720p': 30 };
          params.encodings[0].maxBitrate = bitrateMap[quality] || 3_000_000;
          params.encodings[0].maxFramerate = fpsMap[quality] || 30;
          try { await sender.setParameters(params); } catch(e) { console.warn('setParameters:', e); }
        }
      }

      this.screenSharing = true;
      this._broadcastState();
      return true;
    } catch(e) {
      window.bridgeApp?.toast('Screen share cancelled', 'error');
      return false;
    }
  }

  stopScreenShare() {
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.screenStream = null;
    this.screenSharing = false;
    this._broadcastState();

    // Revert to camera or nothing
    if (this.videoOn) {
      this.enableVideo(true);
    } else {
      for (const pc of this.peers.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(null);
      }
    }
  }

  // â”€â”€â”€ CREATE OFFER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async _createOffer(targetSocketId, peerInfo) {
    const pc = this._createPeerConnection(targetSocketId, peerInfo);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('webrtc:offer', {
        targetSocketId, offer: pc.localDescription, channelId: this.currentChannelId
      });
    } catch(e) { console.error('Offer error:', e); }
  }

  // â”€â”€â”€ HANDLE OFFER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async _handleOffer(fromSocketId, offer) {
    const peerInfo = { socketId: fromSocketId };
    const pc = this.peers.get(fromSocketId) || this._createPeerConnection(fromSocketId, peerInfo);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('webrtc:answer', { targetSocketId: fromSocketId, answer: pc.localDescription });
    } catch(e) { console.error('Answer error:', e); }
  }

  // â”€â”€â”€ CREATE PEER CONNECTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _createPeerConnection(socketId, peerInfo) {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    this.peers.set(socketId, pc);

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
    }

//     audio bitrate â€” kanalÄ±n bitrate ayarÄ±na gÃ¶re maxBitrate uygula
    const applyAudioBitrate = async () => {
      const bitrate = this.channelBitrate || 64_000;
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (!sender) return;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = bitrate;
        await sender.setParameters(params);
      } catch { /* non-fatal */ }
    };

//     prefer VP9 codec for better quality/compression
    this.preferVP9(pc);

//     Opus codec tercih â€” yÃ¼ksek kaliteli ses
    this._preferOpus(pc);

    // ICE candidates
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.socket.emit('webrtc:ice-candidate', { targetSocketId: socketId, candidate });
      }
    };

    // Remote stream
    pc.ontrack = ({ streams }) => {
      if (streams[0]) {
        window.bridgeApp?.attachRemoteStream(socketId, streams[0]);
//         KullanÄ±cÄ± baÅŸÄ±na ses seviyesi uygula
        const userId = peerInfo?.userId;
        if (userId) {
          const saved = parseFloat(localStorage.getItem(`bridge-vol-${userId}`));
          if (!isNaN(saved)) {
            setTimeout(() => BridgeVoiceVolume.applyVolume(socketId, saved), 500);
          }
        }
      }
    };

    // Connection state
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
//         Opus parametreleri (FEC, DTX, stereo, bitrate)
        const opusBitrate = this.channelBitrate || 128_000;
        this._applyOpusParams(pc, opusBitrate);
//         start adaptive bitrate monitoring
        this.startAdaptiveBitrate(pc);
      }
      if (['disconnected','failed','closed'].includes(pc.connectionState)) {
        this.stopAdaptiveBitrate(pc);
        this._removePeer(socketId);
        window.bridgeApp?.removeVoicePeer(socketId);
      }
    };

    return pc;
  }

  _removePeer(socketId) {
    const pc = this.peers.get(socketId);
    if (pc) { pc.close(); this.peers.delete(socketId); }
  }

  _broadcastState() {
    if (!this.currentChannelId) return;
    this.socket.emit('voice:state-update', {
      channelId: this.currentChannelId,
      muted: this.muted,
      deafened: this.deafened,
      screensharing: this.screenSharing,
      video: this.videoOn
    });
  }

  getLocalStream() { return this.localStream; }
  isInVoice() { return !!this.currentChannelId; }

  // â”€â”€â”€ DEVICE SELECTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Ses kanalÄ± bitrate'ini tÃ¼m aktif peer'lara uygula
  async setChannelBitrate(bitrate) {
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

  async setMicDevice(deviceId) {
    this.selectedMicId = deviceId;
    localStorage.setItem("bridge-mic", deviceId);
    if (!this.isInVoice() || !this.localStream) return;
    try {
      const nsEnabled = window.BridgeNS?.enabled !== false;
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId:        { exact: deviceId },
          echoCancellation: nsEnabled,
          noiseSuppression: nsEnabled,
          autoGainControl:  nsEnabled,
          sampleRate:       48000,
        },
        video: false,
      });
      // NS pipeline'dan geÃ§ir
      const cleanStream = window.BridgeNS
        ? await window.BridgeNS.process(rawStream)
        : rawStream;
      const newTrack = cleanStream.getAudioTracks()[0];
      this.localStream.getAudioTracks().forEach(t => { t.stop(); this.localStream.removeTrack(t); });
      this.localStream.addTrack(newTrack);
      for (const pc of this.peers.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === "audio");
        if (sender) sender.replaceTrack(newTrack);
      }
      window.bridgeApp?.toast("Mikrofon deÄŸiÅŸtirildi âœ“", "success");
    } catch (e) {
      window.bridgeApp?.toast("Mikrofon deÄŸiÅŸtirilemedi", "error");
    }
  }

  async setCameraDevice(deviceId) {
    this.selectedCameraId = deviceId;
    localStorage.setItem("bridge-camera", deviceId);
    if (!this.videoOn || !this.localStream) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      const newTrack = newStream.getVideoTracks()[0];
      this.localStream.getVideoTracks().forEach(t => { t.stop(); this.localStream.removeTrack(t); });
      this.localStream.addTrack(newTrack);
      for (const pc of this.peers.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === "video");
        if (sender) sender.replaceTrack(newTrack);
      }
      window.bridgeApp?.toast("Kamera deÄŸiÅŸtirildi âœ“", "success");
    } catch (e) {
      window.bridgeApp?.toast("Kamera deÄŸiÅŸtirilemedi", "error");
    }
  }

  async setSpeakerDevice(deviceId) {
    this.selectedSpeakerId = deviceId;
    localStorage.setItem("bridge-speaker", deviceId);
    document.querySelectorAll(".remote-audio, audio").forEach(el => {
      if (typeof el.setSinkId === "function") el.setSinkId(deviceId).catch(() => {});
    });
    window.bridgeApp?.toast("HoparlÃ¶r deÄŸiÅŸtirildi âœ“", "success");
  }

  // â”€â”€ Voice E2E socket events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  registerVoiceE2EEvents(myUserId) {
    if (window.BridgeVoiceE2E) {
      BridgeVoiceE2E.registerSocketEvents(this.socket, myUserId);
    }
  }

  loadSavedDevices() {
    const mic    = localStorage.getItem("bridge-mic");
    const camera = localStorage.getItem("bridge-camera");
    const speaker = localStorage.getItem("bridge-speaker");
    if (mic)    this.selectedMicId    = mic;
    if (camera) this.selectedCameraId = camera;
    if (speaker) this.selectedSpeakerId = speaker;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   ADAPTIF BITRATE (ABR)
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  startAdaptiveBitrate(pc) {
    if (this._abrIntervals) this._abrIntervals.set(pc, null);
    else this._abrIntervals = new Map();

    let lastPacketsLost = 0;
    let lastPacketsSent = 0;
    let currentKbps = 1500; // baÅŸlangÄ±Ã§

    const interval = setInterval(async () => {
      if (!pc || pc.connectionState === 'closed') {
        clearInterval(interval);
        return;
      }
      try {
        const stats = await pc.getStats();
        stats.forEach(report => {
          if (report.type !== 'outbound-rtp' || report.kind !== 'video') return;
          const lostDelta = (report.packetsLost || 0) - lastPacketsLost;
          const sentDelta = (report.packetsSent || 0) - lastPacketsSent;
          lastPacketsLost = report.packetsLost || 0;
          lastPacketsSent = report.packetsSent || 0;
          if (sentDelta <= 0) return;

          const lossRate = lostDelta / sentDelta;

          // Adaptif hedef belirleme
          let targetKbps;
          if (lossRate > 0.10) targetKbps = Math.max(200,  currentKbps * 0.5);  // %10+ loss â†’ bÃ¼yÃ¼k dÃ¼ÅŸÃ¼ÅŸ
          else if (lossRate > 0.05) targetKbps = Math.max(300, currentKbps * 0.75); // %5-10 â†’ orta dÃ¼ÅŸÃ¼ÅŸ
          else if (lossRate < 0.01) targetKbps = Math.min(4000, currentKbps * 1.1); // <%1 â†’ artÄ±ÅŸ
          else return; // stable

          if (Math.abs(targetKbps - currentKbps) < 50) return; // kÃ¼Ã§Ã¼k deÄŸiÅŸimleri atla
          currentKbps = targetKbps;
          this._setVideoBitrate(pc, currentKbps);
        });
      } catch { /* stats hatasÄ± kritik deÄŸil */ }
    }, 3000); // her 3 saniyede Ã¶lÃ§

    this._abrIntervals.set(pc, interval);
  }

  async _setVideoBitrate(pc, kbps) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = kbps * 1000;
      await sender.setParameters(params);
    } catch { /* setParameters hatasÄ± Ã¶nemsiz */ }
  }

  stopAdaptiveBitrate(pc) {
    const interval = this._abrIntervals?.get(pc);
    if (interval) clearInterval(interval);
    this._abrIntervals?.delete(pc);
  }

  // â”€â”€ v68: Opus codec â€” yÃ¼ksek kaliteli ses â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Opus/48000/2 (stereo, 48kHz) tercih edilir; DTX + FEC aktif.
  // SDP'de maxaveragebitrate=128000 + stereo=1 + sprop-stereo=1 header eklenir.
  _preferOpus(pc) {
    try {
      const transceivers = pc.getTransceivers();
      for (const transceiver of transceivers) {
        if (transceiver.receiver.track?.kind !== 'audio') continue;
        const caps = RTCRtpSender.getCapabilities?.('audio')?.codecs || [];
        // Opus'u Ã¶ne al â€” tarayÄ±cÄ± Opus'u her zaman destekler
        const ordered = [
          ...caps.filter(c => c.mimeType.toLowerCase() === 'audio/opus'),
          ...caps.filter(c => c.mimeType.toLowerCase() !== 'audio/opus'),
        ];
        if (ordered.length && transceiver.setCodecPreferences) {
          transceiver.setCodecPreferences(ordered);
        }
      }
    } catch { /* setCodecPreferences desteklenmiyor â€” eski tarayÄ±cÄ±, Ã¶nemsiz */ }
  }

//   Opus parametrelerini sender Ã¼zerinde uygula
  // stereo=1, useinbandfec=1, maxaveragebitrate
  async _applyOpusParams(pc, bitrate = 128_000) {
    try {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (!sender) return;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];

      // maxBitrate â€” Opus iÃ§in 64k (voice-only) veya 128k (music/hi-fi)
      params.encodings[0].maxBitrate = bitrate;

      // SDP codecParams Ã¼zerinden Opus FEC + DTX
      if (params.codecs) {
        for (const codec of params.codecs) {
          if (codec.mimeType?.toLowerCase() === 'audio/opus') {
            codec.sdpFmtpLine = [
              codec.sdpFmtpLine || '',
              'useinbandfec=1',   // Forward Error Correction â€” paket kaybÄ±na karÅŸÄ±
              'usedtx=1',         // Discontinuous Transmission â€” sessizlikte bant geniÅŸliÄŸi tasarrufu
              'stereo=1',         // Stereo stream
              'sprop-stereo=1',
              `maxaveragebitrate=${bitrate}`,
            ].filter(Boolean).join(';');
          }
        }
      }
      await sender.setParameters(params);
    } catch { /* setParameters non-fatal */ }
  }

  // â”€â”€ Preferred codec: VP9 > VP8 > H264 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  preferVP9(pc) {
    try {
      const transceivers = pc.getTransceivers();
      for (const transceiver of transceivers) {
        if (transceiver.receiver.track?.kind !== 'video') continue;
        const caps = RTCRtpSender.getCapabilities?.('video')?.codecs || [];
        const ordered = [
          ...caps.filter(c => c.mimeType.toLowerCase() === 'video/vp9'),
          ...caps.filter(c => c.mimeType.toLowerCase() === 'video/vp8'),
          ...caps.filter(c => !['video/vp9','video/vp8'].includes(c.mimeType.toLowerCase())),
        ];
        if (ordered.length && transceiver.setCodecPreferences) {
          transceiver.setCodecPreferences(ordered);
        }
      }
    } catch { /* codec preference not supported */ }
  }
}

