// server/socket/handlers/mediasoup.js (Mediasoup SFU)
//
// WebRTC P2P → SFU geçişi.
// Eski sistem: N kullanıcı → N*(N-1) bağlantı  (8 kişi = 56 bağlantı)
// Yeni sistem: N kullanıcı → N bağlantı (hepsi sunucuya, sunucu yönlendirir)
//
// Bağımlılık: npm install mediasoup  (server/package.json'a eklenmeli)

'use strict';

let mediasoup;
try {
  mediasoup = require('mediasoup');
} catch (e) {
  console.warn('[SFU] mediasoup paketi yüklü değil — ses kanalları P2P modda çalışır.');
  console.warn('[SFU] Etkinleştirmek için: cd server && npm install mediasoup');
  mediasoup = null;
}

// ── Ölçekleme modülleri ───────────────────────────────────────────────────────
const sfuRegistry = require('../../lib/sfuRegistry');   // cluster: oda → node sahipliği
const turnConfig   = require('../../lib/turnConfig');    // TURN/STUN ICE sunucu listesi

// ─── Yapılandırma ────────────────────────────────────────────────────────────

const config = {
  // Sunucunun genel IP'si — .env'den al
  // Docker/VPS için zorunlu. localhost'ta otomatik algılanır.
  // null → mediasoup otomatik algılar (localhost geliştirme ortamı için)
  announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,

  // RTP port aralığı — güvenlik duvarında açık olmalı
  rtcMinPort: parseInt(process.env.MEDIASOUP_RTC_MIN_PORT ?? "") || 40000,
  rtcMaxPort: parseInt(process.env.MEDIASOUP_RTC_MAX_PORT ?? "") || 49999,

  // Worker sayısı — CPU core sayısı kadar (max 4 yeterli)
  numWorkers: Math.min(parseInt(process.env.MEDIASOUP_WORKERS ?? "") || 1, 4),

  // Codec'ler — Opus (ses, optimize profil) + VP8/VP9/H264 (video, simulcast)
  mediaCodecs: [
    {
      // ── Opus ses codec — üretim profili ──────────────────────────────────
      // useinbandfec: bant içi FEC — paket kayıplarında ses kalitesini korur
      // usedtx       : DTX (ağ trafiğini ~%50 azaltır, sessizlikte paket göndermez)
      // maxplaybackrate: 48kHz — tam bant genişliği (Discord de 48kHz kullanır)
      // stereo / sprop-stereo: stereo Opus kanalı (müzik odaları için kritik)
      // minptime     : 10ms çerçeve — düşük gecikme için optimum
      kind:      'audio',
      mimeType:  'audio/opus',
      clockRate: 48000,
      channels:  2,
      parameters: {
        'useinbandfec':    1,       // paket kaybı koruması (FEC)
        'usedtx':          1,       // discontinuous transmission — ses yokken paket gönderme
        'maxplaybackrate': 48000,   // 48kHz tam kalite
        'stereo':          1,       // stereo encode
        'sprop-stereo':    1,       // stereo SDP sinyali
        'minptime':        10,      // 10ms çerçeve boyutu
        'ptime':           20,      // 20ms varsayılan paket süresi
        // maxaveragebitrate: ses kanalı için 64kbps yeterli; müzik odaları için 128kbps
        // ENV ile override: MEDIASOUP_OPUS_BITRATE (kbps)
        'maxaveragebitrate': parseInt(process.env.MEDIASOUP_OPUS_BITRATE || '64') * 1000,
      },
    },
    {
      // ── VP8 — simulcast destekli ─────────────────────────────────────────
      // Simulcast: aynı stream'i farklı kalitelerde gönderir (low/mid/high)
      // Sunucu, alıcının bant genişliğine göre doğru katmanı seçer
      kind:       'video',
      mimeType:   'video/VP8',
      clockRate:  90000,
      parameters: {
        'x-google-start-bitrate':  1000,
        'x-google-min-bitrate':    100,
        'x-google-max-bitrate':    parseInt(process.env.MEDIASOUP_VIDEO_MAX_BITRATE || '3000'),
      },
    },
    {
      // ── VP9 — SVC (Scalable Video Coding) profili 2 ──────────────────────
      // profile-id 2: otomatik adaptif video — tek stream, birden fazla kalite katmanı
      kind:       'video',
      mimeType:   'video/VP9',
      clockRate:  90000,
      parameters: {
        'profile-id':              2,
        'x-google-start-bitrate':  1000,
        'x-google-min-bitrate':    100,
        'x-google-max-bitrate':    parseInt(process.env.MEDIASOUP_VIDEO_MAX_BITRATE || '3000'),
      },
    },
    {
      // ── H264 — yüksek profil, donanım hızlandırma destekli ───────────────
      // profile-level-id 42e01f: Baseline 3.1 → geniş uyumluluk
      // 4d0032 yerine 42e01f: mobil cihazlarda donanım decode daha geniş
      kind:       'video',
      mimeType:   'video/H264',
      clockRate:  90000,
      parameters: {
        'packetization-mode':      1,
        'profile-level-id':        '42e01f',   // Constrained Baseline 3.1
        'level-asymmetry-allowed': 1,
        'x-google-start-bitrate':  1000,
        'x-google-min-bitrate':    100,
        'x-google-max-bitrate':    parseInt(process.env.MEDIASOUP_VIDEO_MAX_BITRATE || '3000'),
      },
    },
    {
      // ── H264 yüksek profil (isteğe bağlı — destekleyen client'lar için) ──
      kind:       'video',
      mimeType:   'video/H264',
      clockRate:  90000,
      parameters: {
        'packetization-mode':      1,
        'profile-level-id':        '4d0032',   // Main 5.0 — yüksek kalite
        'level-asymmetry-allowed': 1,
        'x-google-start-bitrate':  1000,
        'x-google-min-bitrate':    100,
        'x-google-max-bitrate':    parseInt(process.env.MEDIASOUP_VIDEO_MAX_BITRATE || '3000'),
      },
    },
  ],

  // WebRTC transport ayarları
  webRtcTransport: {
    listenIps: [
      {
        ip:          '0.0.0.0',
        // null → mediasoup otomatik algılar; Docker'da MEDIASOUP_ANNOUNCED_IP zorunlu
        announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,
      },
    ],
    initialAvailableOutgoingBitrate: 1_000_000,
    minimumAvailableOutgoingBitrate: 600_000,
    maxSctpMessageSize:              262144,
    maxIncomingBitrate:              1_500_000,
  },
};

// ─── Global state ────────────────────────────────────────────────────────────

const sfuWorkers: any[] = [];   // mediasoup Worker[]
let   workerIndex = 0;

// channelId → { router, peers: Map<socketId, PeerState> }
const sfuRooms = new Map();

// socketId → { channelId, transports, producers, consumers }
const sfuPeers = new Map();

// ─── Init ────────────────────────────────────────────────────────────────────

async function initMediasoup() {
  if (!mediasoup) return false;
  try {
    for (let i = 0; i < config.numWorkers; i++) {
      const worker = await mediasoup.createWorker({
        logLevel:   process.env.NODE_ENV === 'development' ? 'warn' : 'error',
        logTags:    ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
        rtcMinPort: config.rtcMinPort,
        rtcMaxPort: config.rtcMaxPort,
      });
      worker.on('died', (error) => {
        console.error(`[SFU] Worker ${i} öldü, 2 sn sonra yeniden başlatılıyor:`, error);
        setTimeout(() => _restartWorker(i), 2000);
      });
      sfuWorkers.push(worker);
    }
    console.log(`[SFU] Mediasoup başlatıldı — ${config.numWorkers} worker, portlar: ${config.rtcMinPort}-${config.rtcMaxPort}`);
    return true;
  } catch (e) {
    console.error('[SFU] Mediasoup başlatılamadı:', e.message);
    return false;
  }
}

async function _restartWorker(index) {
  try {
    const worker = await mediasoup.createWorker({
      logLevel:   'error',
      rtcMinPort: config.rtcMinPort,
      rtcMaxPort: config.rtcMaxPort,
    });
    worker.on('died', (error) => {
      console.error(`[SFU] Worker ${index} tekrar öldü:`, error);
      setTimeout(() => _restartWorker(index), 2000);
    });
    sfuWorkers[index] = worker;
  } catch (e) {
    console.error('[SFU] Worker yeniden başlatılamadı:', e.message);
  }
}

function _getNextWorker() {
  const worker = sfuWorkers[workerIndex % sfuWorkers.length];
  workerIndex++;
  return worker;
}

// ─── Room yönetimi ────────────────────────────────────────────────────────────

// Race condition koruması: aynı channelId için eş zamanlı oluşturma istekleri
// tek bir promise'e bağlanır — router iki kez oluşturulmaz.
const _roomCreating = new Map(); // channelId → Promise<room>

async function getOrCreateRoom(channelId) {
  // 1. Oda zaten var mı?
  if (sfuRooms.has(channelId)) return sfuRooms.get(channelId);

  // 2. Şu an başka bir coroutine oluşturuyor mu?
  if (_roomCreating.has(channelId)) {
    return _roomCreating.get(channelId);
  }

  // 3. Bu coroutine oluşturuyor — promise'i kaydet ki diğerleri beklesin
  const creationPromise = (async () => {
    try {
      const worker = _getNextWorker();
      const router = await worker.createRouter({ mediaCodecs: config.mediaCodecs });

      const room: { router: any; peers: Map<any,any>; createdAt: number; channelId: any; _refreshInterval?: any } = {
        router,
        peers: new Map(),
        createdAt: Date.now(),
        channelId,
      };
      sfuRooms.set(channelId, room);

      // Cluster: bu odanın bu node'a ait olduğunu Redis'e kaydet
      sfuRegistry.claimRoom(channelId).catch(err =>
        console.warn('[SFU] Registry claimRoom hatası:', err.message)
      );

      // 10 dakikada bir TTL yenile
      room._refreshInterval = setInterval(
        () => sfuRegistry.refreshRoom(channelId).catch(() => {}),
        10 * 60 * 1000
      );

      // Router kapanma olayı — beklenmedik mediasoup worker crash
      router.on('workerclose', () => {
        console.warn(`[SFU] Worker kapandı, room temizleniyor — channel: ${channelId}`);
        clearInterval(room._refreshInterval);
        sfuRooms.delete(channelId);
        sfuRegistry.releaseRoom(channelId).catch(() => {});
      });

      console.log(`[SFU] Room oluşturuldu — channel: ${channelId}, node: ${sfuRegistry.INSTANCE_ID}`);
      return room;
    } finally {
      // Oluşturma tamamlandı (başarılı ya da hatalı), map'ten kaldır
      _roomCreating.delete(channelId);
    }
  })();

  _roomCreating.set(channelId, creationPromise);
  return creationPromise;
}

function cleanupRoom(channelId) {
  const room = sfuRooms.get(channelId);
  if (!room) return;
  if (room.peers.size === 0) {
    clearInterval(room._refreshInterval);
    room.router.close();
    sfuRooms.delete(channelId);
    // Cluster: Redis'teki oda kaydını sil
    sfuRegistry.releaseRoom(channelId).catch(() => {});
    console.log(`[SFU] Boş room temizlendi — channel: ${channelId}`);
  }
}

// ─── Transport ────────────────────────────────────────────────────────────────

async function createWebRtcTransport(router) {
  const transport = await router.createWebRtcTransport({
    ...config.webRtcTransport,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  if (config.webRtcTransport.maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(config.webRtcTransport.maxIncomingBitrate);
    } catch { /* eski mediasoup versiyonlarında yok */ }
  }

  return transport;
}

// ─── Socket handler kaydı ─────────────────────────────────────────────────────

function registerSFUHandlers(socket, io, user) {
  // ── sfu:get-rtp-capabilities ──────────────────────────────────────────────
  // Client ilk bağlandığında codec kapasitesini sorar
  socket.on('sfu:get-rtp-capabilities', async ({ channelId }) => {
    try {
      const room = await getOrCreateRoom(channelId);
      socket.emit('sfu:rtp-capabilities', {
        rtpCapabilities: room.router.rtpCapabilities,
      });
    } catch (e) {
      socket.emit('sfu:error', { message: e.message });
    }
  });

  // ── sfu:join ──────────────────────────────────────────────────────────────
  // Kullanıcı ses kanalına katılıyor (sunucu ses kanalı — serverId gerekli)
  socket.on('sfu:join', ({ channelId, serverId, rtpCapabilities }) => {
    sfuJoinHandler({ channelId, serverId, rtpCapabilities });
  });

  // sfu:group-join — Grup DM ses kanalı (serverId olmadan)
  // Alias: sfu:join ile aynı handler, serverId opsiyonel
  socket.on('sfu:group-join', async (payload) => {
    // serverId olmayan grup DM voice için yönlendir
    socket.emit('_sfu:join-routed');
    return sfuJoinHandler({ ...payload, serverId: payload.serverId || null });
  });

  async function sfuJoinHandler({ channelId, serverId, rtpCapabilities }) {
    try {
      // ── Cluster: Cross-node yönlendirme ─────────────────────────────────
      // Bu oda başka bir node'da çalışıyorsa istemciyi o node'a yönlendir.
      // Socket.io Redis adapter sayesinde emit tüm node'lara iletilir.
      const isLocal = await sfuRegistry.isLocalRoom(channelId);
      if (!isLocal) {
        const owner = await sfuRegistry.getRoomOwner(channelId);
        console.log(`[SFU] Channel ${channelId} → node ${owner} üzerinde, yönlendiriliyor`);
        socket.emit('sfu:redirect', {
          channelId,
          ownerNodeId: owner,
          message: 'Bu ses odası başka bir sunucu node\'unda çalışıyor. Yeniden bağlanılıyor…',
        });
        // İstemci sfu:redirect alınca 500ms bekleyip tekrar sfu:join atar.
        // Sticky session olmayan ortamlarda bu döngüyü kırmak için
        // ownerNodeId'yi load balancer cookie/header olarak kullanın.
        return;
      }

      const room = await getOrCreateRoom(channelId);

      // Peer zaten varsa temizle
      if (sfuPeers.has(socket.id)) {
        await _cleanupPeer(socket.id, io, undefined as any, undefined as any);
      }

      const peer = {
        channelId,
        serverId,
        userId:      user._id,
        displayName: user.displayName,
        avatarColor: user.avatarColor,
        rtpCapabilities,
        sendTransport:    null,
        recvTransport:    null,
        producers:        new Map(), // kind → Producer
        consumers:        new Map(), // producerId → Consumer
        muted:            false,
        deafened:         false,
        screensharing:    false,
        video:            false,
      };

      sfuPeers.set(socket.id, peer);
      room.peers.set(socket.id, peer);

      socket.join(`voice:${channelId}`);
      socket.currentVoiceChannel = channelId;
      socket.currentVoiceServer  = serverId;

      // Mevcut peer'ları bildir
      const existingPeers: any[] = [];
      for (const [sid, p] of room.peers) {
        if (sid === socket.id) continue;
        existingPeers.push({
          socketId:    sid,
          userId:      p.userId,
          displayName: p.displayName,
          avatarColor: p.avatarColor,
          producers: [...p.producers.entries()].map(([kind, prod]) => ({
            kind,
            producerId: prod.id,
          })),
        });
      }

      // ICE sunucu listesini (STUN + TURN) istemciye gönder
      const iceServers          = turnConfig.getIceServers(String(user._id));
      const iceTransportPolicy  = turnConfig.getIceTransportPolicy();

      socket.emit('sfu:joined', { existingPeers, iceServers, iceTransportPolicy });

      // Diğerlerine bildir
      socket.to(`voice:${channelId}`).emit('sfu:peer-joined', {
        socketId:    socket.id,
        userId:      user._id,
        displayName: user.displayName,
        avatarColor: user.avatarColor,
      });

      // Grup DM voice için serverId olmayabilir — sadece varsa broadcast et
      if (serverId) {
        io.to(`server:${serverId}`).emit('voice:room-update', {
          channelId,
          peers: _getRoomPeerList(channelId),
        });
      }
      // Grup DM voice: kanal odasına bildir
      io.to(`channel:${channelId}`).emit('voice:room-update', {
        channelId,
        peers: _getRoomPeerList(channelId),
      });

    } catch (e) {
      console.error('[SFU] join error:', e);
      socket.emit('sfu:error', { message: e.message });
    }
  }

  // ── sfu:create-transport ──────────────────────────────────────────────────
  // Client send veya recv transport oluşturmak istiyor
  socket.on('sfu:create-transport', async ({ channelId, direction }) => {
    try {
      const room = sfuRooms.get(channelId);
      if (!room) return socket.emit('sfu:error', { message: 'Room bulunamadı' });

      const peer = sfuPeers.get(socket.id);
      if (!peer) return socket.emit('sfu:error', { message: 'Peer bulunamadı' });

      const transport = await createWebRtcTransport(room.router);

      if (direction === 'send') {
        peer.sendTransport = transport;
      } else {
        peer.recvTransport = transport;
      }

      // Transport bağlantısı kopunca temizle
      transport.on('dtlsstatechange', (state) => {
        if (state === 'closed' || state === 'failed') {
          transport.close();
        }
      });

      socket.emit('sfu:transport-created', {
        direction,
        id:             transport.id,
        iceParameters:  transport.iceParameters,
        iceCandidates:  transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });

    } catch (e) {
      console.error('[SFU] create-transport error:', e);
      socket.emit('sfu:error', { message: e.message });
    }
  });

  // ── sfu:connect-transport ─────────────────────────────────────────────────
  socket.on('sfu:connect-transport', async ({ channelId, direction, dtlsParameters }) => {
    try {
      const peer = sfuPeers.get(socket.id);
      if (!peer) return;

      const transport = direction === 'send' ? peer.sendTransport : peer.recvTransport;
      if (!transport) return;

      await transport.connect({ dtlsParameters });
      socket.emit('sfu:transport-connected', { direction });

    } catch (e) {
      console.error('[SFU] connect-transport error:', e);
      socket.emit('sfu:error', { message: e.message });
    }
  });

  // ── sfu:produce ───────────────────────────────────────────────────────────
  // Client bir track göndermeye başlıyor (mic, kamera veya ekran)
  // Simulcast için client rtpParameters içinde encodings dizisi gönderir:
  //   encodings: [{ rid: 'low', ... }, { rid: 'mid', ... }, { rid: 'high', ... }]
  socket.on('sfu:produce', async ({ channelId, kind, rtpParameters, appData }) => {
    try {
      const peer = sfuPeers.get(socket.id);
      if (!peer || !peer.sendTransport) return;

      // ── Simulcast encoding katmanlarını normalize et ──────────────────────
      // Video ve ekran paylaşımı için sunucu tarafında da katman listesini
      // doğrula/varsayılan değerleri ekle. Ses için simulcast yoktur.
      if (kind === 'video' && rtpParameters.encodings?.length > 0) {
        const isScreen = !!appData?.screen;

        // Ekran paylaşımı: yüksek bitrate, tek katman (degradasyon yok)
        // Kamera: 3 katman (low/mid/high)
        const defaultEncodings = isScreen
          ? [{ rid: 'main', maxBitrate: parseInt(process.env.MEDIASOUP_SCREEN_BITRATE || '2500') * 1000, scalabilityMode: 'S1T3' }]
          : [
              { rid: 'low',  maxBitrate: 150_000,  scalabilityMode: 'S1T3' },
              { rid: 'mid',  maxBitrate: 500_000,  scalabilityMode: 'S1T3' },
              { rid: 'high', maxBitrate: parseInt(process.env.MEDIASOUP_VIDEO_MAX_BITRATE || '3000') * 1000, scalabilityMode: 'S1T3' },
            ];

        const hasRid = rtpParameters.encodings.some(e => e.rid);
        if (!hasRid) {
          rtpParameters = { ...rtpParameters, encodings: defaultEncodings };
        } else {
          rtpParameters = {
            ...rtpParameters,
            encodings: rtpParameters.encodings.map((enc, i) => ({
              ...enc,
              maxBitrate:      enc.maxBitrate      || (defaultEncodings[i]?.maxBitrate ?? 500_000),
              scalabilityMode: enc.scalabilityMode || 'S1T3',
            })),
          };
        }
      }

      const producer = await peer.sendTransport.produce({
        kind,
        rtpParameters,
        appData: appData || {},
      });

      const trackKind = appData?.screen ? 'screen' : kind;
      peer.producers.set(trackKind, producer);

      // ── Adaptif bitrate score takibi ─────────────────────────────────────
      producer.on('score', (scores) => {
        socket.emit('sfu:producer-score', {
          producerId: producer.id,
          kind:       trackKind,
          scores,    // [{ ssrc, rid, score (0-10) }]
        });
      });

      producer.on('videoorientationchange', (orientation) => {
        socket.to(`voice:${channelId}`).emit('sfu:video-orientation', { producerId: producer.id, orientation });
      });

      producer.on('transportclose', () => { peer.producers.delete(trackKind); });

      socket.emit('sfu:produced', { producerId: producer.id, kind: trackKind });

      // Aynı kanaldaki diğer peer'lara bildir — onlar consume edecek
      socket.to(`voice:${channelId}`).emit('sfu:new-producer', {
        socketId:    socket.id,
        userId:      user._id,
        producerId:  producer.id,
        kind:        trackKind,
        hasSimulcast: kind === 'video' && (rtpParameters.encodings?.length ?? 0) > 1,
      });

    } catch (e) {
      console.error('[SFU] produce error:', e);
      socket.emit('sfu:error', { message: e.message });
    }
  });

  // ── sfu:set-preferred-layer ───────────────────────────────────────────────
  // Alıcı, simulcast katmanını manuel olarak seçmek istediğinde çağırır
  socket.on('sfu:set-preferred-layer', async ({ producerId, spatialLayer, temporalLayer }) => {
    try {
      const peer = sfuPeers.get(socket.id);
      if (!peer) return;
      const consumer = peer.consumers.get(producerId);
      if (!consumer || consumer.type !== 'simulcast') return;
      await consumer.setPreferredLayers({ spatialLayer, temporalLayer });
    } catch (e) {
      console.warn('[SFU] set-preferred-layer error:', e.message);
    }
  });

  // ── sfu:consume ───────────────────────────────────────────────────────────
  // Client başka bir peer'ın producer'ını consume etmek istiyor
  socket.on('sfu:consume', async ({ channelId, producerId, rtpCapabilities }) => {
    try {
      const room = sfuRooms.get(channelId);
      const peer = sfuPeers.get(socket.id);
      if (!room || !peer || !peer.recvTransport) return;

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        console.warn('[SFU] canConsume false — uyumsuz kodek?');
        return socket.emit('sfu:error', { message: 'Bu producer consume edilemiyor' });
      }

      const consumer = await peer.recvTransport.consume({
        producerId,
        rtpCapabilities,
        paused: true, // client hazır olunca resume edecek
      });

      peer.consumers.set(producerId, consumer);

      consumer.on('transportclose', () => peer.consumers.delete(producerId));
      consumer.on('producerclose', () => {
        peer.consumers.delete(producerId);
        socket.emit('sfu:producer-closed', { producerId });
      });

      socket.emit('sfu:consumed', {
        consumerId:     consumer.id,
        producerId,
        kind:           consumer.kind,
        rtpParameters:  consumer.rtpParameters,
      });

    } catch (e) {
      console.error('[SFU] consume error:', e);
      socket.emit('sfu:error', { message: e.message });
    }
  });

  // ── sfu:resume-consumer ───────────────────────────────────────────────────
  // Client consumer hazır, akışı başlat
  socket.on('sfu:resume-consumer', async ({ producerId }) => {
    try {
      const peer = sfuPeers.get(socket.id);
      if (!peer) return;
      const consumer = peer.consumers.get(producerId);
      if (consumer) await consumer.resume();
    } catch (e) {
      console.error('[SFU] resume-consumer error:', e);
    }
  });

  // ── sfu:close-producer ────────────────────────────────────────────────────
  // Kullanıcı video/ekran paylaşımını kapattı
  socket.on('sfu:close-producer', ({ kind }) => {
    const peer = sfuPeers.get(socket.id);
    if (!peer) return;
    const producer = peer.producers.get(kind);
    if (producer) {
      producer.close();
      peer.producers.delete(kind);
    }
  });

  // ── sfu:leave ─────────────────────────────────────────────────────────────
  socket.on('sfu:leave', async ({ channelId, serverId }) => {
    await _cleanupPeer(socket.id, io, channelId, serverId);
  });

  // ── voice:state-update (mute/deafen/screensharing durumu) ─────────────────
  socket.on('voice:state-update', ({ channelId, muted, deafened, screensharing, video }) => {
    const peer = sfuPeers.get(socket.id);
    if (peer) {
      peer.muted         = muted;
      peer.deafened      = deafened;
      peer.screensharing = screensharing;
      peer.video         = video;
    }
    socket.to(`voice:${channelId}`).emit('voice:peer-state', {
      socketId: socket.id,
      userId:   user._id,
      muted, deafened, screensharing, video,
    });
  });

  // ── voice:activity ────────────────────────────────────────────────────────
  socket.on('voice:activity', ({ channelId, speaking }) => {
    socket.to(`voice:${channelId}`).emit('voice:activity', {
      socketId: socket.id,
      userId:   user._id,
      speaking,
    });
  });

  // ── Bağlantı koptu ────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    const peer = sfuPeers.get(socket.id);
    if (peer) {
      await _cleanupPeer(socket.id, io, peer.channelId, peer.serverId);
    }
  });
}

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

async function _cleanupPeer(socketId, io, channelId, serverId) {
  const peer = sfuPeers.get(socketId);
  if (!peer) return;

  const ch = channelId || peer.channelId;
  const sv = serverId  || peer.serverId;

  // Tüm consumer'ları kapat
  for (const consumer of peer.consumers.values()) consumer.close();
  // Tüm producer'ları kapat
  for (const producer of peer.producers.values()) producer.close();
  // Transport'ları kapat
  peer.sendTransport?.close();
  peer.recvTransport?.close();

  sfuPeers.delete(socketId);

  const room = sfuRooms.get(ch);
  if (room) {
    room.peers.delete(socketId);
    io.to(`voice:${ch}`).emit('sfu:peer-left', { socketId, userId: peer.userId });
    if (sv) {
      io.to(`server:${sv}`).emit('voice:room-update', {
        channelId: ch,
        peers: _getRoomPeerList(ch),
      });
    }
    // Oda boşsa temizle
    setTimeout(() => cleanupRoom(ch), 5000);
  }
}

function _getRoomPeerList(channelId) {
  const room = sfuRooms.get(channelId);
  if (!room) return [];
  return [...room.peers.entries()].map(([sid, p]) => ({
    socketId:    sid,
    userId:      p.userId,
    displayName: p.displayName,
    avatarColor: p.avatarColor,
  }));
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  initMediasoup,
  registerSFUHandlers,
  sfuRooms,
  sfuPeers,
  isSFUReady: () => sfuWorkers.length > 0,
};
export {};
