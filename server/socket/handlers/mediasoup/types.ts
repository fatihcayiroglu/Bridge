// server/socket/handlers/mediasoup/types.ts
// Tüm mediasoup tip tanımları — merkezi kaynak
//
// NOT: mediasoup SDK paketi opsiyonel bağımlılık olduğundan SDK'nın
// kendi tiplerini import etmek yerine burada eşdeğer interface'ler
// tanımlanmıştır. Bu sayede mediasoup kurulu olmayan ortamlarda da
// TypeScript derleme hataları oluşmaz.

import type { Socket } from 'socket.io';

// ── WebRTC / RTP yapı tipleri ─────────────────────────────────────────────────

export interface RtpCodecCapability {
  kind:                 'audio' | 'video';
  mimeType:             string;
  clockRate:            number;
  channels?:            number;
  parameters?:          Record<string, number | string | boolean>;
  rtcpFeedback?:        RtcpFeedback[];
}

export interface RtcpFeedback {
  type:      string;
  parameter?: string;
}

export interface RtpCapabilities {
  codecs?:           RtpCodecCapability[];
  headerExtensions?: RtpHeaderExtension[];
}

export interface RtpHeaderExtension {
  kind?:             'audio' | 'video';
  uri:               string;
  preferredId:       number;
  preferredEncrypt?: boolean;
  direction?:        'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';
}

export interface RtpParameters {
  mid?:              string;
  codecs:            RtpCodecParameters[];
  headerExtensions?: RtpHeaderExtensionParameters[];
  encodings?:        RtpEncodingParameters[];
  rtcp?:             RtcpParameters;
}

export interface RtpCodecParameters {
  mimeType:     string;
  payloadType:  number;
  clockRate:    number;
  channels?:    number;
  parameters?:  Record<string, number | string | boolean>;
  rtcpFeedback?: RtcpFeedback[];
}

export interface RtpHeaderExtensionParameters {
  uri:        string;
  id:         number;
  encrypt?:   boolean;
  parameters?: Record<string, number | string | boolean>;
}

export interface RtpEncodingParameters {
  ssrc?:             number;
  rid?:              string;
  codecPayloadType?: number;
  rtx?:              { ssrc: number };
  dtx?:              boolean;
  scalabilityMode?:  string;
  maxBitrate?:       number;
}

export interface RtcpParameters {
  cname?:       string;
  reducedSize?: boolean;
}

// ── DTLS / ICE yapı tipleri ───────────────────────────────────────────────────

export type DtlsRole = 'auto' | 'client' | 'server';
export type DtlsState = 'new' | 'connecting' | 'connected' | 'failed' | 'closed';
export type IceCandidateType = 'host' | 'srflx' | 'prflx' | 'relay';
export type IceCandidateTcpType = 'active' | 'passive' | 'so';
export type IceState = 'new' | 'connected' | 'completed' | 'disconnected' | 'closed';

export interface DtlsParameters {
  role?:         DtlsRole;
  fingerprints:  DtlsFingerprint[];
}

export interface DtlsFingerprint {
  algorithm: string;
  value:     string;
}

export interface IceParameters {
  usernameFragment: string;
  password:         string;
  iceLite?:         boolean;
}

export interface IceCandidate {
  foundation: string;
  priority:   number;
  address:    string;
  protocol:   'udp' | 'tcp';
  port:       number;
  type:       IceCandidateType;
  tcpType?:   IceCandidateTcpType;
}

// ── Producer / Consumer score tipleri ────────────────────────────────────────

export interface ProducerScore {
  encodingIdx: number;
  ssrc:        number;
  rid?:        string;
  score:       number;
}

export interface ConsumerScore {
  score:         number;
  producerScore: number;
  producerScores: number[];
}

export interface ConsumerLayers {
  spatialLayer:  number;
  temporalLayer?: number;
}

export interface VideoOrientation {
  camera:   boolean;
  flip:     boolean;
  rotation: 0 | 90 | 180 | 270;
}

// ── WebRTC transport config ───────────────────────────────────────────────────

export interface MediasoupCodec {
  kind:        'audio' | 'video';
  mimeType:    string;
  clockRate:   number;
  channels?:   number;
  parameters?: Record<string, number | string>;
}

export interface WebRtcTransportConfig {
  listenIps:          Array<{ ip: string; announcedIp?: string | null }>;
  enableUdp:          boolean;
  enableTcp:          boolean;
  preferUdp:          boolean;
  initialAvailableOutgoingBitrate: number;
  maxIncomingBitrate?: number;
}

export interface SfuConfig {
  announcedIp:     string | null;
  rtcMinPort:      number;
  rtcMaxPort:      number;
  numWorkers:      number;
  mediaCodecs:     MediasoupCodec[];
  webRtcTransport: WebRtcTransportConfig;
}

// ── Worker options ────────────────────────────────────────────────────────────

export type WorkerLogLevel = 'debug' | 'warn' | 'error' | 'none';
export type WorkerLogTag   = 'info' | 'ice' | 'dtls' | 'rtp' | 'srtp' | 'rtcp' | 'rtx' | 'bwe' | 'score' | 'simulcast' | 'svc' | 'sctp' | 'message';

export interface WorkerOptions {
  logLevel?:   WorkerLogLevel;
  logTags?:    WorkerLogTag[];
  rtcMinPort?: number;
  rtcMaxPort?: number;
}

// ── Mediasoup nesne interface'leri ────────────────────────────────────────────

export interface MediasoupWorker {
  createRouter(opts: { mediaCodecs: MediasoupCodec[] }): Promise<MediasoupRouter>;
  close(): void;
  on(event: 'died', cb: (err: Error) => void): void;
}

export interface MediasoupRouter {
  rtpCapabilities: RtpCapabilities;
  canConsume(opts: { producerId: string; rtpCapabilities: RtpCapabilities }): boolean;
  createWebRtcTransport(opts: WebRtcTransportConfig): Promise<MediasoupTransport>;
  close(): void;
  on(event: 'workerclose', cb: () => void): void;
}

export interface MediasoupTransport {
  id:             string;
  iceParameters:  IceParameters;
  iceCandidates:  IceCandidate[];
  dtlsParameters: DtlsParameters;
  connect(opts: { dtlsParameters: DtlsParameters }): Promise<void>;
  produce(opts: {
    kind:          'audio' | 'video';
    rtpParameters: RtpParameters;
    appData?:      Record<string, unknown>;
  }): Promise<MediasoupProducer>;
  consume(opts: {
    producerId:      string;
    rtpCapabilities: RtpCapabilities;
    paused?:         boolean;
  }): Promise<MediasoupConsumer>;
  close(): void;
  on(event: 'dtlsstatechange', cb: (state: DtlsState) => void): void;
  setMaxIncomingBitrate?(bitrate: number): Promise<void>;
}

export interface MediasoupProducer {
  id:   string;
  kind: 'audio' | 'video';
  type: 'simple' | 'simulcast' | 'svc' | 'pipe';
  close(): void;
  on(event: 'score',                  cb: (scores: ProducerScore[]) => void): void;
  on(event: 'videoorientationchange', cb: (orientation: VideoOrientation) => void): void;
  on(event: 'transportclose',         cb: () => void): void;
}

export interface MediasoupConsumer {
  id:            string;
  producerId:    string;
  kind:          'audio' | 'video';
  rtpParameters: RtpParameters;
  type:          'simple' | 'simulcast' | 'svc' | 'pipe';
  close(): void;
  resume(): Promise<void>;
  setPreferredLayers(layers: { spatialLayer: number; temporalLayer: number }): Promise<void>;
  on(event: 'transportclose', cb: () => void): void;
  on(event: 'producerclose',  cb: () => void): void;
}

// ── SFU oda / peer modeli ─────────────────────────────────────────────────────

export interface SfuRoom {
  router:            MediasoupRouter;
  peers:             Map<string, SfuPeer>;
  createdAt:         number;
  channelId:         string;
  _refreshInterval?: ReturnType<typeof setInterval>;
  /** Dinamik ölçekleme için: bu room'u yöneten worker'ın sfuWorkers dizisindeki indeksi */
  _workerIndex?:     number;
}

export interface SfuPeer {
  channelId:       string;
  serverId:        string | null;
  userId:          string;
  displayName:     string;
  avatarColor:     string;
  rtpCapabilities: RtpCapabilities;
  sendTransport:   MediasoupTransport | null;
  recvTransport:   MediasoupTransport | null;
  producers:       Map<string, MediasoupProducer>;
  consumers:       Map<string, MediasoupConsumer>;
  muted:           boolean;
  deafened:        boolean;
  screensharing:   boolean;
  video:           boolean;
}

export interface BridgeUser {
  _id:         string;
  displayName: string;
  avatarColor: string;
}

export interface BridgeSocket extends Socket {
  userId?:              string;
  currentVoiceChannel?: string | null;
  currentVoiceServer?:  string | null;
}

/**
 * BridgeIO — socket.io Server referansı.
 * Mediasoup handler'ları yalnızca .to(room).emit(event, data) kullanır;
 * bu minimal interface Socket.IO Server'ın gerçek metodlarıyla uyumludur.
 * Tam Server tipi için: import type { Server } from 'socket.io'
 */
export interface BridgeIO {
  to(room: string): {
    emit(event: string, data: unknown): boolean | void;
  };
}


export interface MediasoupModule {
  createWorker(opts?: WorkerOptions): Promise<MediasoupWorker>;
}
