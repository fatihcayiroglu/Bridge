// client/tests/voice-rtc-lifecycle.test.ts
// Faz 8.3 — Ses motorunun (BridgeRTC) yaşam döngüsü.
//
// NEDEN VAR: Beş tur boyunca ses hiç çalışmadı ve nedeni İKİ KATMANLI bir
// hataydı:
//   1) webrtc.ts BridgeRTC SINIFINI registry'ye kaydediyordu, örneğini değil.
//      `joinVoice` prototip metodu olduğu için `api.joinVoice?.()` sessiz
//      no-op'a dönüşüyordu — hata bile fırlamıyordu.
//   2) Düzeltmeden sonra ChannelStagePanel `get('BridgeRTC') ?? get('rtc')`
//      yazıyordu; sınıf truthy olduğu için ÖRNEK hiç görülmüyordu.
// Bu testler o iki katmanın da geri gelmesini engeller.
//
// GERÇEK ÜRÜN KODU kullanılır: BridgeRTC sınıfı doğrudan import edilir.
// Yalnızca tarayıcı sınırı olan `navigator.mediaDevices.getUserMedia`
// kontrollü şekilde stub'lanır — donanım CI'da yok. Üretim mantığı test
// içinde YENİDEN YAZILMAZ.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BridgeRTC, ensureRtc, micErrorMessage } from '../js/webrtc.ts';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

const CHANNEL = 'ch-voice-1';
const SERVER = 'srv-1';

interface Emit { event: string; payload: Record<string, unknown> }

let emitted: Emit[];
let handlers: Record<string, Array<(...a: unknown[]) => void>>;

/** Socket.IO benzeri test çifti — gerçek sözleşme yüzeyi (on/emit/off). */
function makeSocket(
  eventHandlers = handlers,
  output = emitted,
  ackVoiceJoin = true,
) {
  const socket = {
    connected: true,
    id: 'sock-1',
    emit: (event: string, payload: Record<string, unknown>) => {
      output.push({ event, payload });
      // `joinVoice()` no longer treats "emitted" as "joined": it waits for the
      // server's request-correlated `voice:joined` acknowledgement and rejects
      // with VoiceJoinUnavailableError after VOICE_JOIN_ACK_TIMEOUT_MS (10 s).
      // A double that never acknowledges made every join in this file burn that
      // timeout and blow the test budget. A real server answers; model that.
      // Tests that need a rejection dispatch `voice:join-rejected`/`voice:full`
      // themselves, and `ackVoiceJoin = false` models a silent server.
      if (event === 'voice:join' && ackVoiceJoin) {
        for (const fn of eventHandlers['voice:joined'] ?? []) {
          fn({ channelId: payload?.channelId, requestId: payload?.requestId });
        }
      }
    },
    on: (event: string, fn: (...a: unknown[]) => void) => { (eventHandlers[event] ??= []).push(fn); },
    off: (event: string, fn: (...a: unknown[]) => void) => {
      eventHandlers[event] = (eventHandlers[event] ?? []).filter(h => h !== fn);
    },
  };
  return socket;
}

/** Gerçekçi MediaStream çifti — track durumu izlenebilir. */
function makeStream(kind = 'audio') {
  const track = {
    kind,
    enabled: true,
    readyState: 'live' as string,
    stop() { this.readyState = 'ended'; },
    getSettings: () => ({}),
  };
  return {
    _track: track,
    getTracks: () => [track],
    getAudioTracks: () => (kind === 'audio' ? [track] : []),
    getVideoTracks: () => (kind === 'video' ? [track] : []),
    addTrack: () => {},
    removeTrack: () => {},
  };
}

let gumCalls: number;
let currentStream: ReturnType<typeof makeStream>;

function stubGetUserMedia(behaviour: 'ok' | Error = 'ok') {
  gumCalls = 0;
  vi.stubGlobal('navigator', {
    ...globalThis.navigator,
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        gumCalls += 1;
        if (behaviour !== 'ok') throw behaviour;
        currentStream = makeStream();
        return currentStream as unknown as MediaStream;
      }),
      enumerateDevices: vi.fn(async () => []),
    },
  });
}

function rtcFor(socket = makeSocket()): BridgeRTC {
  return new BridgeRTC(socket as never);
}

beforeEach(() => {
  emitted = [];
  handlers = {};
  stubGetUserMedia('ok');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  BridgeRegistry.unregister('socket');
  BridgeRegistry.unregister('rtc');
  BridgeRegistry.unregister('voicePanel:renderVoicePeer');
  BridgeRegistry.unregister('voicePanel:removeVoicePeer');
  BridgeRegistry.unregister('voicePanel:attachRemoteStream');
  BridgeRegistry.unregister('voicePanel:updatePeerState');
  BridgeRegistry.unregister('voicePanel:updatePeerSpeaking');
  BridgeRegistry.unregister('BridgeNS');
  BridgeRegistry.unregister('BridgeVoiceE2E');
  BridgeRegistry.unregister('BridgeVideoQuality');
  BridgeRegistry.unregister('VoiceActivityUI');
  BridgeRegistry.unregister('_bridgeStartLocalVAD');
  BridgeRegistry.unregister('_bridgeStopLocalVAD');
  BridgeRegistry.unregister('currentServerChannels');
  BridgeRegistry.unregister('voice:applyDeviceSettings');
});

// ── Sınıf / örnek sözleşmesi ────────────────────────────────────────────────

describe('RTC singleton — sınıf/örnek ayrımı', () => {
  it('registry\'deki `BridgeRTC` SINIFTIR; prototip metotları üzerinde yoktur', () => {
    // Regresyon kilidi (katman 1): sınıfın üzerinde joinVoice YOK.
    expect(typeof (BridgeRTC as unknown as { joinVoice?: unknown }).joinVoice).toBe('undefined');
    expect(typeof BridgeRTC.prototype.joinVoice).toBe('function');
  });

  it('ensureRtc socket yokken örnek kurmaz', () => {
    expect(ensureRtc()).toBeNull();
    expect(BridgeRegistry.has('rtc')).toBe(false);
  });

  it('socket hazırsa ensureRtc örneği kurar ve `rtc` anahtarına yazar', () => {
    BridgeRegistry.register('socket', makeSocket() as unknown as AnyFn);

    const instance = ensureRtc();

    expect(instance).toBeInstanceOf(BridgeRTC);
    expect(BridgeRegistry.has('rtc')).toBe(true);
  });

  it('tekrar çağrılınca AYNI örneği döndürür (çift motor yok)', () => {
    BridgeRegistry.register('socket', makeSocket() as unknown as AnyFn);

    expect(ensureRtc()).toBe(ensureRtc());
  });

  it('rtc registry kaydı kaybolursa aynı socket/instance ile self-heal eder', () => {
    const socket = makeSocket();
    BridgeRegistry.register('socket', socket as unknown as AnyFn);
    const instance = ensureRtc();
    BridgeRegistry.unregister('rtc');

    expect(ensureRtc()).toBe(instance);
    expect(BridgeRegistry.get('rtc')).toBe(instance);
  });

  it('registry\'den okunan `rtc` gerçek örnektir — joinVoice çağrılabilir', () => {
    BridgeRegistry.register('socket', makeSocket() as unknown as AnyFn);
    ensureRtc();

    const api = BridgeRegistry.get<BridgeRTC>('rtc')!;

    // Regresyon kilidi (katman 2): burada sınıf gelirse bu assertion düşer.
    expect(typeof api.joinVoice).toBe('function');
    expect(typeof api.leaveVoice).toBe('function');
    expect(typeof api.setMuted).toBe('function');
  });
});

// ── Katılım ─────────────────────────────────────────────────────────────────

describe('joinVoice', () => {
  it('mikrofonu ister, kanala katılır ve yerel akışı sahiplenir', async () => {
    const rtc = rtcFor();

    await rtc.joinVoice(CHANNEL, SERVER);

    expect(gumCalls).toBe(1);
    expect(emitted.filter(e => e.event === 'voice:join')).toHaveLength(1);
    expect(emitted.find(e => e.event === 'voice:join')!.payload)
      .toMatchObject({ channelId: CHANNEL, serverId: SERVER });
    expect(rtc.currentChannelId).toBe(CHANNEL);
    expect(rtc.localStream!.getAudioTracks()).toHaveLength(1);
  });

  it('isInVoice katılım sonrası true döner', async () => {
    const rtc = rtcFor();
    expect(rtc.isInVoice()).toBe(false);

    await rtc.joinVoice(CHANNEL, SERVER);

    expect(rtc.isInVoice()).toBe(true);
  });

  it('socket bağlı değilse media istemez, state/voice:join üretmez ve açıkça reddeder', async () => {
    const socket = makeSocket();
    socket.connected = false;
    const rtc = rtcFor(socket);

    await expect(rtc.joinVoice(CHANNEL, SERVER)).rejects.toMatchObject({ name: 'AbortError' });

    expect(gumCalls).toBe(0);
    expect(rtc.currentChannelId).toBeNull();
    expect(rtc.localStream).toBeNull();
    expect(emitted.filter(e => e.event === 'voice:join')).toHaveLength(0);
  });
});

describe('RTC → VoicePanel production adapter', () => {
  it('socket peer olayı absent bridgeApp yerine erişilebilir VoicePanel ownerına gider', () => {
    const renderPeer = vi.fn();
    BridgeRegistry.register('voicePanel:renderVoicePeer', renderPeer as unknown as AnyFn);
    rtcFor();
    const peer = { socketId: 'remote-1', userId: 'user-1' };

    handlers['voice:peer-joined'][0](peer);

    expect(renderPeer).toHaveBeenCalledWith(peer, false);
  });

  it('RTCPeerConnection track olayı remote streami VoicePanel playback ownerına iletir', () => {
    const attach = vi.fn();
    BridgeRegistry.register('voicePanel:attachRemoteStream', attach as unknown as AnyFn);
    class FakePeerConnection {
      connectionState = 'new';
      ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
      onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      getTransceivers() { return []; }
      close() { this.connectionState = 'closed'; }
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    const rtc = rtcFor();
    const createPeer = (rtc as unknown as {
      _createPeerConnection(socketId: string, peer: { socketId: string }): FakePeerConnection;
    })._createPeerConnection.bind(rtc);
    const pc = createPeer('remote-2', { socketId: 'remote-2' });
    const stream = makeStream() as unknown as MediaStream;

    pc.ontrack?.({ streams: [stream] });

    expect(attach).toHaveBeenCalledWith('remote-2', stream, undefined);
  });
});

// ── Hata yolları ────────────────────────────────────────────────────────────

describe('mikrofon hataları — sessiz arıza yok', () => {
  const cases: Array<[string, string]> = [
    ['NotAllowedError', 'izni verilmedi'],
    ['NotFoundError', 'bulunamadı'],
    ['NotReadableError', 'erişilemiyor'],
  ];

  for (const [name, fragment] of cases) {
    it(`${name} güvenli ve teknik olmayan metne çevrilir`, () => {
      const err = new Error('ham teknik ayrıntı /dev/snd/pcm0');
      err.name = name;

      const message = micErrorMessage(err);

      expect(message.toLowerCase()).toContain(fragment);
      // Ham hata içeriği kullanıcıya SIZMAZ.
      expect(message).not.toContain('/dev/snd');
      expect(message).not.toContain(name);
    });
  }

  it('bilinmeyen hata da güvenli genel metne düşer', () => {
    expect(micErrorMessage(new Error('boom'))).toContain('Mikrofon');
  });

  it('mikrofon reddedilse bile kanala SESSİZ katılınır (kilitlenme yok)', async () => {
    const denied = new Error('denied'); denied.name = 'NotAllowedError';
    stubGetUserMedia(denied);
    const rtc = rtcFor();

    await rtc.joinVoice(CHANNEL, SERVER);

    // Katılım gerçekleşir, yalnız ses gönderilmez.
    expect(emitted.filter(e => e.event === 'voice:join')).toHaveLength(1);
    expect(rtc.isInVoice()).toBe(true);
    expect(rtc.localStream!.getAudioTracks()).toHaveLength(0);
  });

  it('reddedilen katılımdan sonra yeniden denenebilir', async () => {
    const denied = new Error('denied'); denied.name = 'NotAllowedError';
    stubGetUserMedia(denied);
    const rtc = rtcFor();
    await rtc.joinVoice(CHANNEL, SERVER);
    rtc.leaveVoice();

    stubGetUserMedia('ok');
    await rtc.joinVoice(CHANNEL, SERVER);

    expect(rtc.localStream!.getAudioTracks()).toHaveLength(1);
  });
});

// ── Sustur / aç ─────────────────────────────────────────────────────────────

describe('mute / unmute', () => {
  it('setMuted(true) yerel ses parçasını KAPATIR', async () => {
    const rtc = rtcFor();
    await rtc.joinVoice(CHANNEL, SERVER);

    rtc.setMuted(true);

    expect(rtc.muted).toBe(true);
    expect(rtc.localStream!.getAudioTracks()[0].enabled).toBe(false);
  });

  it('setMuted(false) geri açar', async () => {
    const rtc = rtcFor();
    await rtc.joinVoice(CHANNEL, SERVER);
    rtc.setMuted(true);

    rtc.setMuted(false);

    expect(rtc.muted).toBe(false);
    expect(rtc.localStream!.getAudioTracks()[0].enabled).toBe(true);
  });
});

// ── Deafen / undeafen ───────────────────────────────────────────────────────

describe('deafen / undeafen — gerçek playback sonucu', () => {
  it('remote audio elementlerini susturur ve güvenlik için yerel mikrofonu da kapatır', async () => {
    const rtc = rtcFor();
    await rtc.joinVoice(CHANNEL, SERVER);
    const first = document.createElement('audio'); first.className = 'remote-audio';
    const second = document.createElement('audio'); second.className = 'remote-audio';
    document.body.append(first, second);

    rtc.setDeafened(true);

    expect(rtc.deafened).toBe(true);
    expect(first.muted).toBe(true);
    expect(second.muted).toBe(true);
    expect(rtc.muted).toBe(true);
    expect(rtc.localStream!.getAudioTracks()[0].enabled).toBe(false);
    expect(emitted.filter(e => e.event === 'voice:state-update').at(-1)?.payload)
      .toMatchObject({ deafened: true, muted: true });
    first.remove(); second.remove();
  });

  it('undeafen remote playbacki geri açar; deafen tarafından konan mic mute güvenli biçimde kalır', async () => {
    const rtc = rtcFor();
    await rtc.joinVoice(CHANNEL, SERVER);
    const audio = document.createElement('audio'); audio.className = 'remote-audio';
    document.body.append(audio);
    rtc.setDeafened(true);

    rtc.setDeafened(false);

    expect(rtc.deafened).toBe(false);
    expect(audio.muted).toBe(false);
    expect(rtc.muted).toBe(true);
    expect(rtc.localStream!.getAudioTracks()[0].enabled).toBe(false);
    audio.remove();
  });
});

// ── Ayrılma ve temizlik ─────────────────────────────────────────────────────

describe('leaveVoice — temizlik', () => {
  it('ayrılınca sunucuya bildirir, parçaları DURDURUR ve durumu sıfırlar', async () => {
    const rtc = rtcFor();
    await rtc.joinVoice(CHANNEL, SERVER);
    const track = rtc.localStream!.getAudioTracks()[0];

    rtc.leaveVoice();

    expect(emitted.filter(e => e.event === 'voice:leave')).toHaveLength(1);
    expect(track.readyState).toBe('ended');   // mikrofon gerçekten bırakıldı
    expect(rtc.localStream).toBeNull();
    expect(rtc.currentChannelId).toBeNull();
    expect(rtc.isInVoice()).toBe(false);
    expect(rtc.peers.size).toBe(0);
  });

  it('katılmadan leaveVoice çağrısı sunucuya gereksiz mesaj göndermez', () => {
    const rtc = rtcFor();

    rtc.leaveVoice();

    expect(emitted.filter(e => e.event === 'voice:leave')).toHaveLength(0);
  });
});

// ── Kanal döngüsü ───────────────────────────────────────────────────────────

describe('voice → text → voice döngüsü', () => {
  it('her tur temiz başlar; eski parça canlı kalmaz, sayaçlar büyümez', async () => {
    const rtc = rtcFor();

    await rtc.joinVoice(CHANNEL, SERVER);
    const firstTrack = rtc.localStream!.getAudioTracks()[0];
    rtc.leaveVoice();                       // metin kanalına geçiş

    await rtc.joinVoice(CHANNEL, SERVER);   // ses kanalına dönüş
    const secondTrack = rtc.localStream!.getAudioTracks()[0];

    expect(firstTrack.readyState).toBe('ended');  // ilk mikrofon bırakıldı
    expect(secondTrack.readyState).toBe('live');
    expect(secondTrack).not.toBe(firstTrack);
    expect(emitted.filter(e => e.event === 'voice:join')).toHaveLength(2);
    expect(emitted.filter(e => e.event === 'voice:leave')).toHaveLength(1);
    expect(rtc.peers.size).toBe(0);
  });

  it('üç tur sonunda canlı parça sayısı 1\'i geçmez (sızıntı yok)', async () => {
    const rtc = rtcFor();
    const tracks: Array<{ readyState: string }> = [];

    for (let i = 0; i < 3; i += 1) {
      await rtc.joinVoice(CHANNEL, SERVER);
      tracks.push(rtc.localStream!.getAudioTracks()[0]);
      rtc.leaveVoice();
    }

    expect(tracks.filter(t => t.readyState === 'live')).toHaveLength(0);
  });
});

// ── Socket disconnect / reconnect ───────────────────────────────────────────

describe('socket disconnect / reconnect contract', () => {
  it('disconnect local streami, peerleri ve joined statei temizler; voice:leave kuyruğa yazmaz', async () => {
    const socket = makeSocket();
    const rtc = rtcFor(socket);
    await rtc.joinVoice(CHANNEL, SERVER);
    const track = rtc.localStream!.getAudioTracks()[0];
    const close = vi.fn();
    rtc.peers.set('peer-1', { close } as unknown as RTCPeerConnection);
    const left = vi.fn();
    document.addEventListener('bridge:voice-left', left, { once: true });

    socket.connected = false;
    expect(() => handlers.disconnect[0]('transport close')).not.toThrow();

    expect(track.readyState).toBe('ended');
    expect(close).toHaveBeenCalledOnce();
    expect(rtc.localStream).toBeNull();
    expect(rtc.peers.size).toBe(0);
    expect(rtc.currentChannelId).toBeNull();
    expect(rtc.isInVoice()).toBe(false);
    expect(emitted.filter(e => e.event === 'voice:leave')).toHaveLength(0);
    expect(left).toHaveBeenCalledOnce();
  });

  it('aynı Socket.IO object reconnect olduğunda aynı RTC ile yeniden seçim leak olmadan çalışır', async () => {
    const socket = makeSocket();
    const rtc = rtcFor(socket);
    await rtc.joinVoice(CHANNEL, SERVER);
    const firstTrack = rtc.localStream!.getAudioTracks()[0];

    socket.connected = false;
    handlers.disconnect[0]('transport close');
    socket.connected = true;
    await rtc.joinVoice(CHANNEL, SERVER);

    const secondTrack = rtc.localStream!.getAudioTracks()[0];
    expect(firstTrack.readyState).toBe('ended');
    expect(secondTrack.readyState).toBe('live');
    expect(secondTrack).not.toBe(firstTrack);
    expect(emitted.filter(e => e.event === 'voice:join')).toHaveLength(2);
    expect(rtc.peers.size).toBe(0);
  });

  it('permission prompt açıkken disconnect olursa geç gelen stream durdurulur ve stale join gönderilmez', async () => {
    const socket = makeSocket();
    let release!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>(resolve => { release = resolve; });
    // `joinVoice` awaits the authenticated ICE policy fetch BEFORE the
    // socket-connected guard, so flipping `connected` synchronously after the
    // call aborts before the prompt ever opens. Wait until the prompt is
    // genuinely pending — that is the race this test pins.
    let promptOpened!: () => void;
    const prompt = new Promise<void>(resolve => { promptOpened = resolve; });
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      mediaDevices: {
        getUserMedia: vi.fn(() => { promptOpened(); return pending; }),
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const rtc = rtcFor(socket);
    const stream = makeStream();
    const join = rtc.joinVoice(CHANNEL, SERVER);
    await prompt;

    socket.connected = false;
    handlers.disconnect[0]('transport close');
    release(stream as unknown as MediaStream);

    await expect(join).rejects.toMatchObject({ name: 'AbortError' });
    expect(stream._track.readyState).toBe('ended');
    expect(rtc.currentChannelId).toBeNull();
    expect(rtc.localStream).toBeNull();
    expect(emitted.filter(e => e.event === 'voice:join')).toHaveLength(0);
  });

  it('aktif aynı kanala duplicate join çağrısı ikinci stream veya emit üretmez', async () => {
    const rtc = rtcFor();
    await rtc.joinVoice(CHANNEL, SERVER);
    const stream = rtc.localStream;

    await rtc.joinVoice(CHANNEL, SERVER);

    expect(gumCalls).toBe(1);
    expect(rtc.localStream).toBe(stream);
    expect(emitted.filter(e => e.event === 'voice:join')).toHaveLength(1);
  });

  it('ensureRtc aynı socket için instance ve listener sayılarını çoğaltmaz', () => {
    const socketHandlers: typeof handlers = {};
    const socket = makeSocket(socketHandlers, []);
    BridgeRegistry.register('socket', socket as unknown as AnyFn);

    const first = ensureRtc();
    const counts = Object.fromEntries(Object.entries(socketHandlers).map(([event, fns]) => [event, fns.length]));
    const second = ensureRtc();

    expect(second).toBe(first);
    expect(Object.fromEntries(Object.entries(socketHandlers).map(([event, fns]) => [event, fns.length])))
      .toEqual(counts);
    expect(counts.disconnect).toBe(1);
  });

  it('auth recovery yeni socket object üretirse stale RTC/listener bırakmadan ownerı değiştirir', async () => {
    const oldHandlers: typeof handlers = {};
    const newHandlers: typeof handlers = {};
    const oldSocket = makeSocket(oldHandlers, []);
    const newSocket = makeSocket(newHandlers, []);
    newSocket.id = 'sock-2';
    BridgeRegistry.register('socket', oldSocket as unknown as AnyFn);
    const oldRtc = ensureRtc()!;
    await oldRtc.joinVoice(CHANNEL, SERVER);
    const oldTrack = oldRtc.localStream!.getAudioTracks()[0];

    BridgeRegistry.register('socket', newSocket as unknown as AnyFn);
    const newRtc = ensureRtc()!;

    expect(newRtc).not.toBe(oldRtc);
    expect(newRtc.socket).toBe(newSocket);
    expect(BridgeRegistry.get('rtc')).toBe(newRtc);
    expect(oldTrack.readyState).toBe('ended');
    expect(Object.values(oldHandlers).flat()).toHaveLength(0);
    expect(newHandlers.disconnect).toHaveLength(1);
  });
});

// ── Signalling ordering ─────────────────────────────────────────────────────

describe('WebRTC signalling ordering — early ICE is not lost', () => {
  class FakeSessionDescription {
    type: string;
    sdp?: string;
    constructor(init: { type?: string; sdp?: string }) {
      this.type = init?.type ?? 'offer';
      this.sdp = init?.sdp;
    }
  }
  class FakeIceCandidate {
    candidate: string;
    constructor(init: { candidate?: string }) { this.candidate = init?.candidate ?? ''; }
  }
  class FakePeerConnection {
    signalingState = 'stable';
    connectionState = 'new';
    remoteDescription: unknown = null;
    localDescription: unknown = null;
    ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
    onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    readonly addedIce: unknown[] = [];
    getTransceivers() { return []; }
    getSenders() { return []; }
    addTrack() { return {}; }
    close() { this.connectionState = 'closed'; }
    async setRemoteDescription(desc: unknown) { this.remoteDescription = desc; this.signalingState = 'stable'; }
    async setLocalDescription(desc: unknown) { this.localDescription = desc; }
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async addIceCandidate(candidate: unknown) { this.addedIce.push(candidate); }
  }

  beforeEach(() => {
    vi.stubGlobal('RTCSessionDescription', FakeSessionDescription);
    vi.stubGlobal('RTCIceCandidate', FakeIceCandidate);
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  });

  it('flushes queued ICE on the actual peer before sending the answer', async () => {
    const rtc = rtcFor();
    const iceHandler = handlers['webrtc:ice-candidate'][0] as (payload: unknown) => Promise<void>;
    const offerHandler = handlers['webrtc:offer'][0] as (payload: unknown) => Promise<void>;

    await iceHandler({ fromSocketId: 'remote-1', candidate: { candidate: 'candidate:early' } });
    await offerHandler({ fromSocketId: 'remote-1', offer: { type: 'offer', sdp: 'offer-sdp' } });

    const pc = rtc.peers.get('remote-1') as unknown as FakePeerConnection;
    expect(pc).toBeTruthy();
    expect(pc.addedIce).toHaveLength(1);
    expect((pc.addedIce[0] as FakeIceCandidate).candidate).toBe('candidate:early');
    expect(emitted.some(e => e.event === 'webrtc:answer')).toBe(true);
  });

  it('queues ICE for an existing peer until an answer installs the remote description', async () => {
    const rtc = rtcFor();
    const createPeer = (rtc as unknown as {
      _createPeerConnection(socketId: string, peer: { socketId: string }): FakePeerConnection;
    })._createPeerConnection.bind(rtc);
    const pc = createPeer('remote-answer', { socketId: 'remote-answer' });
    pc.signalingState = 'have-local-offer';

    const iceHandler = handlers['webrtc:ice-candidate'][0] as (payload: unknown) => Promise<void>;
    const answerHandler = handlers['webrtc:answer'][0] as (payload: unknown) => Promise<void>;
    await iceHandler({ fromSocketId: 'remote-answer', candidate: { candidate: 'candidate:queued' } });
    expect(pc.addedIce).toHaveLength(0);

    await answerHandler({ fromSocketId: 'remote-answer', answer: { type: 'answer', sdp: 'answer-sdp' } });
    expect(pc.addedIce).toHaveLength(1);
    expect((pc.addedIce[0] as FakeIceCandidate).candidate).toBe('candidate:queued');
  });

  it('bounds hostile early ICE and ignores malformed signalling payloads', async () => {
    const rtc = rtcFor();
    const iceHandler = handlers['webrtc:ice-candidate'][0] as (payload: unknown) => Promise<void>;
    const offerHandler = handlers['webrtc:offer'][0] as (payload: unknown) => Promise<void>;

    await iceHandler({ fromSocketId: 42, candidate: { candidate: 'bad-id' } });
    await iceHandler({ fromSocketId: 'remote-bounded', candidate: null });
    for (let i = 0; i < 140; i++) {
      await iceHandler({ fromSocketId: 'remote-bounded', candidate: { candidate: `candidate:${i}` } });
    }
    await offerHandler({ fromSocketId: 'remote-bounded', offer: { type: 'offer', sdp: 'remote' } });

    const pc = rtc.peers.get('remote-bounded') as unknown as FakePeerConnection;
    expect(pc.addedIce).toHaveLength(128);
  });

  it('clears queued ICE when voice state is torn down', async () => {
    const rtc = rtcFor();
    const iceHandler = handlers['webrtc:ice-candidate'][0] as (payload: unknown) => Promise<void>;
    await iceHandler({ fromSocketId: 'stale-peer', candidate: { candidate: 'candidate:stale' } });

    // destroy() shares the same local cleanup owner used by disconnect/leave.
    rtc.destroy();

    const pending = (rtc as unknown as { _pendingIce: Map<string, unknown[]> })._pendingIce;
    expect(pending.size).toBe(0);
  });
});

// ── Public device/media owner coverage ──────────────────────────────────────
describe('RTC device/media public owner branches', () => {
  it('enumerates device classes even when permission warm-up is rejected and fails safely when enumeration fails', async () => {
    const getUserMedia = vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); });
    const enumerateDevices = vi.fn(async () => [
      { kind: 'audioinput', deviceId: 'mic-1' },
      { kind: 'audiooutput', deviceId: 'spk-1' },
      { kind: 'videoinput', deviceId: 'cam-1' },
      { kind: 'unknown', deviceId: 'other' },
    ] as unknown as MediaDeviceInfo[]);
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia, enumerateDevices } });
    const rtc = rtcFor();
    await expect(rtc.getDevices()).resolves.toEqual({
      microphones: [expect.objectContaining({ deviceId: 'mic-1' })],
      speakers: [expect.objectContaining({ deviceId: 'spk-1' })],
      cameras: [expect.objectContaining({ deviceId: 'cam-1' })],
    });
    enumerateDevices.mockRejectedValueOnce(new Error('enumeration failed'));
    await expect(rtc.getDevices()).resolves.toEqual({ microphones: [], speakers: [], cameras: [] });
  });

  it('loads canonical device preferences before legacy aliases and keeps processing defaults fail-safe', () => {
    localStorage.clear();
    localStorage.setItem('bridge:device:mic', 'canonical-mic');
    localStorage.setItem('bridge-mic', 'legacy-mic');
    localStorage.setItem('bridge-camera', 'legacy-camera');
    localStorage.setItem('bridge:device:speaker', 'canonical-speaker');
    localStorage.setItem('bridge:device:echo', 'false');
    localStorage.setItem('bridge:device:noise', 'garbage');
    const rtc = rtcFor();
    rtc.loadSavedDevices();
    expect(rtc.selectedMicId).toBe('canonical-mic');
    expect(rtc.selectedCameraId).toBe('legacy-camera');
    expect(rtc.selectedSpeakerId).toBe('canonical-speaker');
    expect(rtc.echoCancellation).toBe(false);
    expect(rtc.noiseSuppression).toBe(true);
    expect(rtc.audioProcessingConstraints()).toEqual(expect.objectContaining({
      echoCancellation: false, noiseSuppression: true, autoGainControl: true, sampleRate: 48000,
    }));
  });

  it('reacquires and replaces the live microphone when processing settings change in voice, while containing acquisition failure', async () => {
    const old = makeStream('audio');
    const next = makeStream('audio');
    next._track.getSettings = () => ({ echoCancellation: false });
    const gum = vi.fn(async () => next as unknown as MediaStream);
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: gum, enumerateDevices: vi.fn(async () => []) } });
    const replaceTrack = vi.fn(async () => undefined);
    const rtc = rtcFor(); rtc.currentChannelId = 'ch-live'; rtc.localStream = old as unknown as MediaStream; rtc.selectedMicId = 'mic-live';
    rtc.peers.set('peer-live', { getSenders: () => [{ track: { kind: 'audio' }, replaceTrack }] } as unknown as RTCPeerConnection);
    await rtc.setAudioProcessing({ echoCancellation: true, noiseSuppression: false });
    expect(gum).toHaveBeenCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'mic-live' }, echoCancellation: true, noiseSuppression: false }), video: false });
    expect(replaceTrack).toHaveBeenCalledWith(next._track);
    expect(old._track.readyState).toBe('ended');

    gum.mockRejectedValueOnce(new Error('device busy'));
    await expect(rtc.setAudioProcessing({ autoGainControl: false })).resolves.toBeUndefined();
    expect(rtc.autoGainControl).toBe(false);
  });

  it('persists device/processing choices without acquiring new media outside an active voice session', async () => {
    const gum = vi.fn(async () => makeStream() as unknown as MediaStream);
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: gum, enumerateDevices: vi.fn(async () => []) } });
    const rtc = rtcFor();
    await rtc.setAudioProcessing({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    await rtc.setMicDevice('mic-z');
    await rtc.setCameraDevice('cam-z');
    expect(gum).not.toHaveBeenCalled();
    expect(localStorage.getItem('bridge:device:mic')).toBe('mic-z');
    expect(localStorage.getItem('bridge-mic')).toBe('mic-z');
    expect(localStorage.getItem('bridge-camera')).toBe('cam-z');
    expect(rtc.audioProcessingConstraints()).toEqual(expect.objectContaining({
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    }));
  });

  it('applies speaker routing opportunistically and bitrate only to audio senders', async () => {
    const sinkOk = vi.fn(async () => undefined); const sinkFail = vi.fn(async () => { throw new Error('unsupported'); });
    const a = document.createElement('audio') as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    const b = document.createElement('audio') as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    a.className = 'remote-audio'; a.setSinkId = sinkOk; b.setSinkId = sinkFail;
    document.body.append(a, b);
    const rtc = rtcFor();
    await rtc.setSpeakerDevice('sink-1');
    expect(localStorage.getItem('bridge-speaker')).toBe('sink-1');
    expect(sinkOk).toHaveBeenCalledWith('sink-1'); expect(sinkFail).toHaveBeenCalledWith('sink-1');

    const params: RTCRtpSendParameters = { encodings: [] } as RTCRtpSendParameters;
    const setParameters = vi.fn(async () => undefined);
    const audioSender = { track: { kind: 'audio' }, getParameters: () => params, setParameters };
    const pc = { getSenders: () => [audioSender] } as unknown as RTCPeerConnection;
    rtc.peers.set('peer-a', pc);
    await rtc.setChannelBitrate(96_000);
    expect(params.encodings[0]?.maxBitrate).toBe(96_000);
    expect(setParameters).toHaveBeenCalledWith(params);
  });

  it('starts/stops camera capture on the existing local stream and contains denied capture', async () => {
    const local = makeStream('audio');
    const video = makeStream('video');
    const gum = vi.fn(async () => video as unknown as MediaStream);
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: gum, enumerateDevices: vi.fn(async () => []) } });
    const rtc = rtcFor();
    rtc.localStream = local as unknown as MediaStream;
    rtc.selectedCameraId = 'cam-1';
    await expect(rtc.enableVideo(true)).resolves.toBe(true);
    expect(gum).toHaveBeenCalledWith({ video: expect.objectContaining({ deviceId: { exact: 'cam-1' } }) });
    expect(rtc.videoOn).toBe(true);
    await expect(rtc.enableVideo(false)).resolves.toBe(true);
    expect(rtc.videoOn).toBe(false);

    gum.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await expect(rtc.enableVideo(true)).resolves.toBe(false);
  });

  it('tracks actual screen-audio capture rather than requested intent and cleans all captured tracks', async () => {
    const videoTrack = { kind: 'video', onended: null as null | (() => void), stop: vi.fn() };
    const audioTrack = { kind: 'audio', onended: null as null | (() => void), stop: vi.fn() };
    const screen = {
      getTracks: () => [videoTrack, audioTrack],
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => [audioTrack],
    } as unknown as MediaStream;
    const getDisplayMedia = vi.fn(async () => screen);
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getDisplayMedia, getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) } });
    const rtc = rtcFor();
    await expect(rtc.startScreenShare('720p', true)).resolves.toBe(true);
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.objectContaining({ echoCancellation: false }) }));
    expect(rtc.screenSharing).toBe(true); expect(rtc.screenAudioActive).toBe(true);
    audioTrack.onended?.(); await Promise.resolve(); expect(rtc.screenAudioActive).toBe(false);
    rtc.stopScreenShare();
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(rtc.screenSharing).toBe(false);

    getDisplayMedia.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await expect(rtc.startScreenShare('1080p60', false)).resolves.toBe(false);
  });

  it('delegates E2E registration only when the canonical registry owner exists', () => {
    const registerSocketEvents = vi.fn();
    BridgeRegistry.register('BridgeVoiceE2E', (() => undefined) as unknown as AnyFn);
    // Registry values are function-typed by design; object-style owners use the same bridge cast as production.
    BridgeRegistry.register('BridgeVoiceE2E', ({ registerSocketEvents } as unknown) as AnyFn);
    const rtc = rtcFor();
    rtc.registerVoiceE2EEvents('user-x');
    expect(registerSocketEvents).toHaveBeenCalledWith(rtc.socket, 'user-x');
    BridgeRegistry.unregister('BridgeVoiceE2E');
    expect(() => rtc.registerVoiceE2EEvents('user-x')).not.toThrow();
  });
});

// ── Deep signalling/media branches ──────────────────────────────────────────

/** Browser-owned WebRTC boundary with observable state, not a replacement for
 * BridgeRTC. The production manager still owns every transition/assertion. */
class DeepPeerConnection {
  static instances: DeepPeerConnection[] = [];
  static configs: RTCConfiguration[] = [];

  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  senders: Array<Record<string, any>> = [];
  transceivers: Array<Record<string, any>> = [];
  stats = new Map<string, Record<string, unknown>>();
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'deep-offer' }) as RTCSessionDescriptionInit);
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'deep-answer' }) as RTCSessionDescriptionInit);
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    if (description.type === 'rollback') {
      this.localDescription = null;
      this.signalingState = 'stable';
      return;
    }
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
  });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = description;
    this.signalingState = 'stable';
  });
  addIceCandidate = vi.fn(async () => undefined);
  addTrack = vi.fn((track: MediaStreamTrack) => {
    const sender = {
      track,
      replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => { sender.track = next; }),
      getParameters: vi.fn(() => ({ encodings: [{}] })),
      setParameters: vi.fn(async () => undefined),
    };
    this.senders.push(sender);
    return sender;
  });
  removeTrack = vi.fn();
  getSenders = vi.fn(() => this.senders);
  getTransceivers = vi.fn(() => this.transceivers);
  getStats = vi.fn(async () => this.stats);
  // Production attempts ONE ICE restart before tearing a `failed` peer down
  // (MAX_ICE_RESTART_ATTEMPTS); the double must expose that surface.
  restartIce = vi.fn();
  close = vi.fn(() => { this.connectionState = 'closed'; });

  constructor(config: RTCConfiguration) {
    DeepPeerConnection.instances.push(this);
    DeepPeerConnection.configs.push(config);
  }
}

class DeepSessionDescription {
  type: RTCSdpType;
  sdp?: string;
  constructor(init: RTCSessionDescriptionInit) { this.type = init.type; this.sdp = init.sdp; }
}

class DeepIceCandidate {
  candidate: string;
  constructor(init: RTCIceCandidateInit) { this.candidate = init.candidate ?? ''; }
}

function deepTrack(kind: 'audio' | 'video', settings: MediaTrackSettings = {}) {
  return {
    kind,
    enabled: true,
    readyState: 'live' as string,
    onended: null as null | (() => void),
    stop: vi.fn(function (this: { readyState: string }) { this.readyState = 'ended'; }),
    getSettings: vi.fn(() => settings),
  };
}

function deepStream(...tracks: ReturnType<typeof deepTrack>[]): MediaStream {
  return new MediaStream(tracks as unknown as MediaStreamTrack[]);
}

describe('RTC deep signalling and media state machine', () => {
  beforeEach(() => {
    DeepPeerConnection.instances = [];
    DeepPeerConnection.configs = [];
    vi.stubGlobal('RTCPeerConnection', DeepPeerConnection);
    vi.stubGlobal('RTCSessionDescription', DeepSessionDescription);
    vi.stubGlobal('RTCIceCandidate', DeepIceCandidate);
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: vi.fn((kind: string) => ({
        codecs: kind === 'audio'
          ? [{ mimeType: 'audio/PCMU' }, { mimeType: 'audio/opus' }]
          : [{ mimeType: 'video/H264' }, { mimeType: 'video/VP8' }, { mimeType: 'video/VP9' }],
      })),
    });
  });

  it('routes peer/E2E/state/activity events and safely contains malformed or rejected signalling', async () => {
    const render = vi.fn(); const remove = vi.fn(); const update = vi.fn(); const speaking = vi.fn();
    const initVoiceE2E = vi.fn(async () => true); const renderVoiceE2EBadge = vi.fn();
    BridgeRegistry.register('voicePanel:renderVoicePeer', render as unknown as AnyFn);
    BridgeRegistry.register('voicePanel:removeVoicePeer', remove as unknown as AnyFn);
    BridgeRegistry.register('voicePanel:updatePeerState', update as unknown as AnyFn);
    BridgeRegistry.register('voicePanel:updatePeerSpeaking', speaking as unknown as AnyFn);
    BridgeRegistry.register('BridgeVoiceE2E', ({ initVoiceE2E, renderVoiceE2EBadge, registerSocketEvents: vi.fn() } as unknown) as AnyFn);
    const rtc = rtcFor(); rtc.currentChannelId = CHANNEL;

    await handlers['voice:existing-peers'][0]([{ socketId: 'peer-a' }]);
    await Promise.resolve();
    expect(initVoiceE2E).toHaveBeenCalledWith(CHANNEL, [{ socketId: 'peer-a' }]);
    expect(renderVoiceE2EBadge).toHaveBeenCalledOnce();
    expect(emitted).toContainEqual(expect.objectContaining({ event: 'webrtc:offer', payload: expect.objectContaining({ targetSocketId: 'peer-a' }) }));

    handlers['voice:peer-joined'][0]({ socketId: 'peer-b' });
    handlers['voice:peer-state'][0]({ socketId: 'peer-a', muted: true, video: false });
    handlers['voice:activity'][0]({ socketId: 7, speaking: true });
    handlers['voice:activity'][0]({ socketId: 'peer-a', speaking: 1 });
    handlers['voice:activity'][0]({ socketId: 'peer-a', speaking: true });
    expect(render).toHaveBeenCalledWith({ socketId: 'peer-b' }, false);
    expect(update).toHaveBeenCalledWith('peer-a', { muted: true, video: false });
    expect(speaking.mock.calls).toEqual([['peer-a', false], ['peer-a', true]]);

    const pc = rtc.peers.get('peer-a') as unknown as DeepPeerConnection;
    const answer = handlers['webrtc:answer'][0] as (value: unknown) => Promise<void>;
    await answer({ fromSocketId: 2, answer: {} });
    pc.signalingState = 'stable';
    await answer({ fromSocketId: 'peer-a', answer: { type: 'answer' } });
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    pc.signalingState = 'have-local-offer';
    await answer({ fromSocketId: 'peer-a', answer: { type: 'answer', sdp: 'ok' } });
    expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
    pc.signalingState = 'have-local-offer';
    pc.setRemoteDescription.mockRejectedValueOnce(new Error('bad answer'));
    await expect(answer({ fromSocketId: 'peer-a', answer: { type: 'answer' } })).resolves.toBeUndefined();

    const ice = handlers['webrtc:ice-candidate'][0] as (value: unknown) => Promise<void>;
    pc.remoteDescription = { type: 'answer' };
    await ice({ fromSocketId: 'peer-a', candidate: { candidate: 'one' } });
    pc.addIceCandidate.mockRejectedValueOnce(new Error('bad ice'));
    await expect(ice({ fromSocketId: 'peer-a', candidate: { candidate: 'two' } })).resolves.toBeUndefined();
    expect(pc.addIceCandidate).toHaveBeenCalledTimes(2);

    handlers['voice:peer-left'][0]({ socketId: 'peer-a' });
    expect(pc.close).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('peer-a');
  });

  it('applies channel/mobile/noise-processing owners, starts VAD, and cleans every owner on channel replacement', async () => {
    const raw = deepStream(deepTrack('audio'));
    const clean = deepStream(deepTrack('audio'));
    const process = vi.fn(async () => clean);
    const init = vi.fn(); const start = vi.fn(); const stop = vi.fn();
    const gum = vi.fn(async () => raw);
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: gum, enumerateDevices: vi.fn(async () => []) } });
    BridgeRegistry.register('currentServerChannels', (() => [{ _id: CHANNEL, bitrate: 112_000 }]) as AnyFn);
    BridgeRegistry.register('BridgeNS', ({ enabled: true, process } as unknown) as AnyFn);
    BridgeRegistry.register('VoiceActivityUI', ({ init } as unknown) as AnyFn);
    BridgeRegistry.register('_bridgeStartLocalVAD', start as unknown as AnyFn);
    BridgeRegistry.register('_bridgeStopLocalVAD', stop as unknown as AnyFn);
    const rtc = rtcFor(); rtc.selectedMicId = 'mic-deep';
    (rtc as unknown as { _mobileAudioOverride: MediaTrackConstraints })._mobileAudioOverride = { channelCount: 1 };

    await rtc.joinVoice(CHANNEL, SERVER);
    expect(gum).toHaveBeenCalledWith({ audio: expect.objectContaining({
      deviceId: { exact: 'mic-deep' }, channelCount: 1, echoCancellation: true, noiseSuppression: true,
    }), video: false });
    expect(process).toHaveBeenCalledWith(raw);
    expect(rtc.localStream).toBe(clean);
    expect(rtc.channelBitrate).toBe(112_000);
    expect(init).toHaveBeenCalledWith(rtc.socket);
    expect(start).toHaveBeenCalledWith(clean, CHANNEL);

    const screenTrack = deepTrack('video');
    rtc.screenStream = deepStream(screenTrack);
    const peer = new DeepPeerConnection({}); rtc.peers.set('old-peer', peer as unknown as RTCPeerConnection);
    await rtc.joinVoice('ch-next', SERVER);
    expect(emitted.some(entry => entry.event === 'voice:leave' && entry.payload.channelId === CHANNEL)).toBe(true);
    expect(peer.close).toHaveBeenCalledOnce();
    expect(screenTrack.stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalled();
  });

  it('replaces/adds camera and screen tracks, owns actual screen audio once, and renegotiates teardown', async () => {
    const camera = deepTrack('video');
    const screenVideo = deepTrack('video'); const screenAudio = deepTrack('audio');
    const cameraStream = deepStream(camera); const displayStream = deepStream(screenVideo, screenAudio);
    const gum = vi.fn(async () => cameraStream); const gdm = vi.fn(async () => displayStream);
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: gum, getDisplayMedia: gdm, enumerateDevices: vi.fn(async () => []) } });
    BridgeRegistry.register('BridgeVideoQuality', ({ getConstraints: () => ({ width: { ideal: 1920 } }) } as unknown) as AnyFn);
    const rtc = rtcFor(); rtc.currentChannelId = CHANNEL; rtc.localStream = deepStream(deepTrack('audio'));
    const create = (rtc as unknown as { _createPeerConnection(id: string, peer: PeerInfo): RTCPeerConnection })._createPeerConnection.bind(rtc);
    const first = create('first', { socketId: 'first' }) as unknown as DeepPeerConnection;
    const second = create('second', { socketId: 'second' }) as unknown as DeepPeerConnection;
    const existingVideo = {
      track: deepTrack('video'), replaceTrack: vi.fn(async () => undefined),
      getParameters: vi.fn(() => ({ encodings: [{}] })), setParameters: vi.fn(async () => undefined),
    };
    first.senders.push(existingVideo);

    await expect(rtc.enableVideo(true)).resolves.toBe(true);
    expect(existingVideo.replaceTrack).toHaveBeenCalledWith(camera);
    expect(second.addTrack).toHaveBeenCalledWith(camera, rtc.localStream);
    expect(emitted.filter(entry => entry.event === 'webrtc:offer')).toHaveLength(2);

    first.signalingState = 'stable'; second.signalingState = 'stable';
    await expect(rtc.startScreenShare('invalid' as never, true)).resolves.toBe(true);
    expect(gdm).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ width: { ideal: 1920 } }), audio: expect.any(Object) }));
    expect(existingVideo.replaceTrack).toHaveBeenLastCalledWith(screenVideo);
    expect(existingVideo.setParameters).toHaveBeenCalled();
    expect(rtc.screenAudioActive).toBe(true);
    const firstAudioAdds = first.addTrack.mock.calls.filter(([track]) => track === screenAudio).length;
    (rtc as unknown as { _attachScreenAudioTo(pc: RTCPeerConnection): void })._attachScreenAudioTo(first as unknown as RTCPeerConnection);
    expect(first.addTrack.mock.calls.filter(([track]) => track === screenAudio)).toHaveLength(firstAudioAdds);

    screenAudio.onended?.();
    await Promise.resolve();
    expect(first.removeTrack).toHaveBeenCalled();
    expect(second.removeTrack).toHaveBeenCalled();
    expect(rtc.screenAudioActive).toBe(false);
    rtc.videoOn = false;
    rtc.stopScreenShare();
    await Promise.resolve();
    expect(screenVideo.stop).toHaveBeenCalled();
    expect(rtc.screenSharing).toBe(false);
    expect(existingVideo.replaceTrack).toHaveBeenLastCalledWith(null);
  });

  it('handles glare, peer replacement, ICE/track callbacks, and terminal connection cleanup', async () => {
    const attach = vi.fn(); const remove = vi.fn();
    BridgeRegistry.register('voicePanel:attachRemoteStream', attach as unknown as AnyFn);
    BridgeRegistry.register('voicePanel:removeVoicePeer', remove as unknown as AnyFn);
    const rtc = rtcFor(); rtc.currentChannelId = CHANNEL; rtc.localStream = deepStream(deepTrack('audio'));
    const create = (rtc as unknown as { _createPeerConnection(id: string, peer: PeerInfo): RTCPeerConnection })._createPeerConnection.bind(rtc);
    const old = create('same', { socketId: 'same' }) as unknown as DeepPeerConnection;
    const pc = create('same', { socketId: 'same' }) as unknown as DeepPeerConnection;
    expect(old.close).toHaveBeenCalledOnce();

    pc.onicecandidate?.({ candidate: null });
    pc.onicecandidate?.({ candidate: { candidate: 'local' } });
    expect(emitted.filter(entry => entry.event === 'webrtc:ice-candidate')).toHaveLength(1);
    pc.ontrack?.({ streams: [] });
    const remote = deepStream(deepTrack('audio'));
    pc.ontrack?.({ streams: [remote] });
    expect(attach).toHaveBeenCalledWith('same', remote, undefined);

    pc.signalingState = 'have-local-offer';
    const offer = handlers['webrtc:offer'][0] as (value: unknown) => Promise<void>;
    await offer({ fromSocketId: 'same', offer: { type: 'offer', sdp: 'glare' } });
    expect(pc.setLocalDescription).toHaveBeenCalledWith({ type: 'rollback' });
    expect(emitted).toContainEqual(expect.objectContaining({ event: 'webrtc:answer', payload: expect.objectContaining({ targetSocketId: 'same' }) }));

    // `failed` bir kez ICE RESTART dener (MAX_ICE_RESTART_ATTEMPTS = 1);
    // gecici bir ag olayi tum katilimciyi dusurmez. Israrli basarisizlik
    // (ikinci `failed`) yikimi tetikler.
    pc.connectionState = 'failed';
    pc.onconnectionstatechange?.();
    expect(pc.restartIce).toHaveBeenCalled();
    expect(rtc.peers.has('same')).toBe(true);

    pc.onconnectionstatechange?.();
    expect(pc.close).toHaveBeenCalled();
    expect(rtc.peers.has('same')).toBe(false);
    expect(remove).toHaveBeenCalledWith('same');
  });

  it('adapts video bitrate from measured loss and applies Opus/codec preferences without leaking timers', async () => {
    vi.useFakeTimers();
    try {
      const rtc = rtcFor();
      const videoParams = { encodings: [] as Array<{ maxBitrate?: number }> };
      const videoSender = {
        track: { kind: 'video' }, getParameters: vi.fn(() => videoParams), setParameters: vi.fn(async () => undefined),
      };
      const pc = new DeepPeerConnection({}); pc.senders = [videoSender];
      const report = { type: 'outbound-rtp', kind: 'video', packetsLost: 20, packetsSent: 100 };
      pc.stats.set('video', report);
      rtc.startAdaptiveBitrate(pc as unknown as RTCPeerConnection);
      await vi.advanceTimersByTimeAsync(3000);
      expect(videoParams.encodings[0].maxBitrate).toBe(750_000);
      Object.assign(report, { packetsLost: 26, packetsSent: 200 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(videoParams.encodings[0].maxBitrate).toBe(562_500);
      Object.assign(report, { packetsLost: 26, packetsSent: 300 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(videoParams.encodings[0].maxBitrate).toBe(618_750);
      Object.assign(report, { packetsLost: 29, packetsSent: 400 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(videoSender.setParameters).toHaveBeenCalledTimes(3);
      rtc.stopAdaptiveBitrate(pc as unknown as RTCPeerConnection);

      const audioParams = {
        encodings: [] as Array<{ maxBitrate?: number }>,
        codecs: [{ mimeType: 'audio/opus', sdpFmtpLine: 'minptime=10' }, { mimeType: 'audio/PCMU' }],
      };
      const audioSender = {
        track: { kind: 'audio' }, getParameters: () => audioParams, setParameters: vi.fn(async () => undefined),
      };
      pc.senders = [audioSender];
      await (rtc as unknown as { _applyOpusParams(peer: RTCPeerConnection, bitrate?: number): Promise<void> })
        ._applyOpusParams(pc as unknown as RTCPeerConnection, 96_000);
      expect(audioParams.encodings[0].maxBitrate).toBe(96_000);
      expect(audioParams.codecs[0].sdpFmtpLine).toContain('maxaveragebitrate=96000');

      const audioCodec = vi.fn(); const videoCodec = vi.fn();
      pc.transceivers = [
        { receiver: { track: { kind: 'audio' } }, setCodecPreferences: audioCodec },
        { receiver: { track: { kind: 'video' } }, setCodecPreferences: videoCodec },
      ];
      (rtc as unknown as { _preferOpus(peer: RTCPeerConnection): void })._preferOpus(pc as unknown as RTCPeerConnection);
      rtc.preferVP9(pc as unknown as RTCPeerConnection);
      expect(audioCodec.mock.calls[0][0][0].mimeType).toBe('audio/opus');
      expect(videoCodec.mock.calls[0][0].map((codec: { mimeType: string }) => codec.mimeType))
        .toEqual(['video/VP9', 'video/VP8', 'video/H264']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes one device-settings bridge that applies processing without requiring an explicit microphone id', async () => {
    const socket = makeSocket();
    BridgeRegistry.register('socket', socket as unknown as AnyFn);
    const rtc = ensureRtc()!;
    const apply = BridgeRegistry.get<(payload: unknown) => void>('voice:applyDeviceSettings')!;
    expect(apply).toBeTypeOf('function');

    apply(undefined);
    apply({ echoCancellation: false, noiseSuppression: false });
    await Promise.resolve();
    expect(rtc.echoCancellation).toBe(false);
    expect(rtc.noiseSuppression).toBe(false);

    apply({ micDeviceId: 'mic-from-settings', echoCancellation: true });
    await Promise.resolve();
    expect(rtc.selectedMicId).toBe('mic-from-settings');
    expect(rtc.echoCancellation).toBe(true);
    expect(localStorage.getItem('bridge:device:mic')).toBe('mic-from-settings');
  });

  it('does not resurrect state when media acquisition rejects after the socket silently disconnects', async () => {
    const socket = makeSocket();
    let rejectMedia!: (reason: Error) => void;
    let promptOpened!: () => void;
    const prompt = new Promise<void>(resolve => { promptOpened = resolve; });
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      mediaDevices: {
        getUserMedia: vi.fn(() => new Promise<MediaStream>((_resolve, reject) => {
          rejectMedia = reject;
          promptOpened();
        })),
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const rtc = rtcFor(socket);
    const joining = rtc.joinVoice(CHANNEL, SERVER);
    // See above: the ICE-policy await runs before the connected guard.
    await prompt;
    socket.connected = false;
    rejectMedia(new DOMException('device vanished', 'NotReadableError'));

    await expect(joining).rejects.toMatchObject({ name: 'NotReadableError' });
    expect(rtc.currentChannelId).toBeNull();
    expect(rtc.localStream).toBeNull();
    expect(emitted.some(entry => entry.event === 'voice:join')).toBe(false);
  });

  it('owns camera/microphone replacement and disable branches without leaving old tracks live', async () => {
    const oldAudio = deepTrack('audio'); const oldVideo = deepTrack('video');
    const newAudio = deepTrack('audio'); const newVideo = deepTrack('video');
    const gum = vi.fn()
      .mockResolvedValueOnce(deepStream(newAudio))
      .mockResolvedValueOnce(deepStream(newVideo))
      .mockRejectedValueOnce(new Error('mic denied'))
      .mockRejectedValueOnce(new Error('camera denied'));
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: gum, enumerateDevices: vi.fn(async () => []) } });
    const rtc = rtcFor(); rtc.currentChannelId = CHANNEL; rtc.localStream = deepStream(oldAudio, oldVideo); rtc.videoOn = true;
    const pc = new DeepPeerConnection({});
    const audioSender = { track: oldAudio, replaceTrack: vi.fn(async () => undefined) };
    const videoSender = { track: oldVideo, replaceTrack: vi.fn(async () => undefined) };
    pc.senders = [audioSender, videoSender]; rtc.peers.set('peer', pc as unknown as RTCPeerConnection);

    await rtc.setMicDevice('mic-next');
    expect(oldAudio.stop).toHaveBeenCalledOnce();
    expect(audioSender.replaceTrack).toHaveBeenCalledWith(newAudio);
    expect(localStorage.getItem('bridge-mic')).toBe('mic-next');
    await rtc.setCameraDevice('cam-next');
    expect(oldVideo.stop).toHaveBeenCalledOnce();
    expect(videoSender.replaceTrack).toHaveBeenCalledWith(newVideo);
    expect(localStorage.getItem('bridge-camera')).toBe('cam-next');

    await rtc.setMicDevice('mic-denied');
    await rtc.setCameraDevice('cam-denied');
    expect(gum).toHaveBeenCalledTimes(4);
    await expect(rtc.enableVideo(false)).resolves.toBe(true);
    expect(newVideo.stop).toHaveBeenCalledOnce();
    expect(rtc.getLocalStream()).toBe(rtc.localStream);
  });

  it('contains audio-processing no-track/failure paths and applies bitrate only to audio senders', async () => {
    const empty = deepStream(deepTrack('video'));
    const gum = vi.fn().mockResolvedValueOnce(empty).mockRejectedValueOnce(new Error('processing down'));
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: gum, enumerateDevices: vi.fn(async () => []) } });
    const rtc = rtcFor(); rtc.currentChannelId = CHANNEL; rtc.localStream = deepStream(deepTrack('audio'));
    await rtc.setAudioProcessing({ echoCancellation: false, autoGainControl: false });
    expect(rtc.echoCancellation).toBe(false);
    expect(rtc.autoGainControl).toBe(false);
    await expect(rtc.setAudioProcessing({ noiseSuppression: false })).resolves.toBeUndefined();

    const audioParams = { encodings: [] as Array<{ maxBitrate?: number }> };
    const audioSender = {
      track: { kind: 'audio' }, getParameters: vi.fn(() => audioParams), setParameters: vi.fn(async () => undefined),
    };
    const videoOnly = new DeepPeerConnection({});
    const audio = new DeepPeerConnection({}); audio.senders = [audioSender];
    rtc.peers.set('video-only', videoOnly as unknown as RTCPeerConnection);
    rtc.peers.set('audio', audio as unknown as RTCPeerConnection);
    await rtc.setChannelBitrate(72_000);
    expect(audioParams.encodings[0].maxBitrate).toBe(72_000);
    audioSender.setParameters.mockRejectedValueOnce(new Error('unsupported'));
    await expect(rtc.setChannelBitrate(64_000)).resolves.toBeUndefined();
  });

  it('contains offer, renegotiation race, answer, and queued ICE failures', async () => {
    class FailingOfferPeerConnection extends DeepPeerConnection {
      constructor(config: RTCConfiguration) {
        super(config);
        this.createOffer.mockRejectedValue(new Error('offer down'));
      }
    }
    vi.stubGlobal('RTCPeerConnection', FailingOfferPeerConnection);
    const rtc = rtcFor(); rtc.currentChannelId = CHANNEL;
    const createOffer = (rtc as unknown as { _createOffer(id: string, peer: PeerInfo): Promise<void> })._createOffer.bind(rtc);
    await expect(createOffer('peer', { socketId: 'peer' })).resolves.toBeUndefined();
    expect(emitted.some(entry => entry.event === 'webrtc:offer')).toBe(false);

    vi.stubGlobal('RTCPeerConnection', DeepPeerConnection);
    const pc = new DeepPeerConnection({}); rtc.peers.set('peer', pc as unknown as RTCPeerConnection);

    const renegotiate = (rtc as unknown as { _renegotiate(peer: RTCPeerConnection, id: string): Promise<void> })._renegotiate.bind(rtc);
    const racing = new DeepPeerConnection({});
    racing.createOffer.mockImplementationOnce(async () => {
      racing.signalingState = 'have-remote-offer';
      return { type: 'offer', sdp: 'stale' };
    });
    await renegotiate(racing as unknown as RTCPeerConnection, 'racing');
    expect(racing.setLocalDescription).not.toHaveBeenCalled();
    racing.signalingState = 'stable';
    racing.createOffer.mockRejectedValueOnce(new Error('renegotiate down'));
    await expect(renegotiate(racing as unknown as RTCPeerConnection, 'racing')).resolves.toBeUndefined();

    const offerHandler = handlers['webrtc:offer'][0] as (payload: unknown) => Promise<void>;
    pc.setRemoteDescription.mockRejectedValueOnce(new Error('bad remote offer'));
    await expect(offerHandler({ fromSocketId: 'peer', offer: { type: 'offer' } })).resolves.toBeUndefined();

    const flushIce = (rtc as unknown as { _flushPendingIce(id: string, peer: RTCPeerConnection): Promise<void> })._flushPendingIce.bind(rtc);
    pc.remoteDescription = null;
    await flushIce('peer', pc as unknown as RTCPeerConnection);
    pc.remoteDescription = { type: 'answer' };
    await flushIce('absent', pc as unknown as RTCPeerConnection);
    (rtc as unknown as { _pendingIce: Map<string, RTCIceCandidateInit[]> })._pendingIce.set('peer', [{ candidate: 'bad queued' }]);
    pc.addIceCandidate.mockRejectedValueOnce(new Error('queued rejected'));
    await expect(flushIce('peer', pc as unknown as RTCPeerConnection)).resolves.toBeUndefined();
  });

  it('applies connected-state Opus defaults and handles terminal state without an app owner', async () => {
    vi.useFakeTimers();
    try {
      const rtc = rtcFor(); rtc.channelBitrate = 0;
      const create = (rtc as unknown as { _createPeerConnection(id: string, peer: PeerInfo): RTCPeerConnection })._createPeerConnection.bind(rtc);
      const pc = create('connected', { socketId: 'connected' }) as unknown as DeepPeerConnection;
      const params = { encodings: [] as Array<{ maxBitrate?: number }> };
      const sender = { track: { kind: 'audio' }, getParameters: () => params, setParameters: vi.fn(async () => undefined) };
      pc.senders = [sender]; pc.connectionState = 'connected';
      pc.onconnectionstatechange?.();
      await Promise.resolve(); await Promise.resolve();
      expect(params.encodings[0].maxBitrate).toBe(128_000);
      rtc.stopAdaptiveBitrate(pc as unknown as RTCPeerConnection);

      // `disconnected` COGU ZAMAN geciciydir (Wi-Fi roam, kisa mobil devir).
      // Uretim PEER_DISCONNECT_GRACE_MS (8 sn) bekler; hemen yikmaz.
      pc.connectionState = 'disconnected';
      pc.onconnectionstatechange?.();
      expect(rtc.peers.has('connected')).toBe(true);
      expect(pc.close).not.toHaveBeenCalled();

      vi.advanceTimersByTime(8_000);
      expect(rtc.peers.has('connected')).toBe(false);
      expect(pc.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains adaptive bitrate/codec capability edge cases and converges at the upper cap', async () => {
    vi.useFakeTimers();
    try {
      const rtc = rtcFor();
      const noVideo = new DeepPeerConnection({});
      await expect((rtc as unknown as { _setVideoBitrate(peer: RTCPeerConnection, kbps: number): Promise<void> })
        ._setVideoBitrate(noVideo as unknown as RTCPeerConnection, 500)).resolves.toBeUndefined();

      const sender = {
        track: { kind: 'video' }, getParameters: () => ({ encodings: [{}] }), setParameters: vi.fn(async () => undefined),
      };
      const pc = new DeepPeerConnection({}); pc.senders = [sender];
      const nonVideo = { type: 'inbound-rtp', kind: 'video', packetsLost: 0, packetsSent: 100 };
      const stagnant = { type: 'outbound-rtp', kind: 'video', packetsLost: 0, packetsSent: 0 };
      pc.stats.set('non-video', nonVideo); pc.stats.set('stagnant', stagnant);
      rtc.startAdaptiveBitrate(pc as unknown as RTCPeerConnection);
      await vi.advanceTimersByTimeAsync(3000);
      expect(sender.setParameters).not.toHaveBeenCalled();
      pc.stats.delete('non-video'); pc.stats.delete('stagnant');
      const healthy = { type: 'outbound-rtp', kind: 'video', packetsLost: 0, packetsSent: 100 };
      pc.stats.set('healthy', healthy);
      for (let i = 0; i < 14; i += 1) {
        healthy.packetsSent += 100;
        await vi.advanceTimersByTimeAsync(3000);
      }
      const callsAtCap = sender.setParameters.mock.calls.length;
      healthy.packetsSent += 100;
      await vi.advanceTimersByTimeAsync(3000);
      expect(sender.setParameters.mock.calls.length).toBe(callsAtCap);
      rtc.stopAdaptiveBitrate(pc as unknown as RTCPeerConnection);

      const closed = new DeepPeerConnection({}); closed.connectionState = 'closed';
      rtc.startAdaptiveBitrate(closed as unknown as RTCPeerConnection);
      await vi.advanceTimersByTimeAsync(3000);
      const failing = new DeepPeerConnection({}); failing.getStats.mockRejectedValue(new Error('stats down'));
      rtc.startAdaptiveBitrate(failing as unknown as RTCPeerConnection);
      await vi.advanceTimersByTimeAsync(3000);
      rtc.stopAdaptiveBitrate(failing as unknown as RTCPeerConnection);

      const audioPc = new DeepPeerConnection({});
      const audioParams = { encodings: [] as Array<{ maxBitrate?: number }> };
      audioPc.senders = [{
        track: { kind: 'audio' }, getParameters: () => audioParams,
        setParameters: vi.fn(async () => { throw new Error('opus unsupported'); }),
      }];
      await expect((rtc as unknown as { _applyOpusParams(peer: RTCPeerConnection): Promise<void> })
        ._applyOpusParams(audioPc as unknown as RTCPeerConnection)).resolves.toBeUndefined();
      audioPc.senders = [];
      await expect((rtc as unknown as { _applyOpusParams(peer: RTCPeerConnection): Promise<void> })
        ._applyOpusParams(audioPc as unknown as RTCPeerConnection)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers through the document socket-ready owner after constructor setup fails', () => {
    BridgeRegistry.register('socket', makeSocket() as unknown as AnyFn);
    expect(ensureRtc()).toBeInstanceOf(BridgeRTC);
    const apply = BridgeRegistry.get<(payload: unknown) => void>('voice:applyDeviceSettings');
    expect(apply).toBeTypeOf('function');
    const broken = {
      connected: true, emit: vi.fn(), off: vi.fn(),
      on: vi.fn(() => { throw new Error('listener setup failed'); }),
    };
    BridgeRegistry.register('socket', broken as unknown as AnyFn);
    expect(ensureRtc()).toBeNull();
    expect(BridgeRegistry.has('rtc')).toBe(false);
    expect(() => apply?.({ echoCancellation: false })).not.toThrow();

    const healthy = makeSocket();
    BridgeRegistry.register('socket', healthy as unknown as AnyFn);
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(BridgeRegistry.get('rtc')).toBeInstanceOf(BridgeRTC);
  });

  it('handles empty peer/disconnect events and a declined E2E bootstrap without side effects', async () => {
    const left = vi.fn(); document.addEventListener('bridge:voice-left', left, { once: true });
    const initVoiceE2E = vi.fn(async () => false); const renderVoiceE2EBadge = vi.fn();
    BridgeRegistry.register('BridgeVoiceE2E', ({ initVoiceE2E, renderVoiceE2EBadge, registerSocketEvents: vi.fn() } as unknown) as AnyFn);
    const rtc = rtcFor();
    handlers.disconnect[0]('idle disconnect');
    expect(left).not.toHaveBeenCalled();
    await handlers['voice:existing-peers'][0]([]);
    expect(initVoiceE2E).not.toHaveBeenCalled();
    await handlers['voice:existing-peers'][0]([{ socketId: 'peer-declined' }]);
    await Promise.resolve();
    expect(initVoiceE2E).toHaveBeenCalledOnce();
    expect(renderVoiceE2EBadge).not.toHaveBeenCalled();
    handlers['voice:peer-left'][0]({ socketId: 'unknown-peer' });
    expect(rtc.peers.has('unknown-peer')).toBe(false);
  });

  it('covers camera-first media, video-less screen peers, actual track end, and camera restoration', async () => {
    const camera = deepTrack('video'); const screen = deepTrack('video'); const restored = deepTrack('video');
    const gum = vi.fn().mockResolvedValueOnce(deepStream(camera)).mockResolvedValueOnce(deepStream(restored));
    const gdm = vi.fn(async () => deepStream(screen));
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: gum, getDisplayMedia: gdm, enumerateDevices: vi.fn(async () => []) } });
    const rtc = rtcFor(); rtc.currentChannelId = CHANNEL;
    await expect(rtc.enableVideo(true)).resolves.toBe(true);
    expect(rtc.localStream?.getVideoTracks()[0]).toBe(camera);

    const withVideo = new DeepPeerConnection({});
    const screenParams = { encodings: [{}] as Array<{ maxBitrate?: number; maxFramerate?: number }> };
    const videoSender = {
      track: camera, replaceTrack: vi.fn(async () => undefined), getParameters: () => screenParams,
      setParameters: vi.fn(async () => { throw new Error('screen tuning unsupported'); }),
    };
    withVideo.senders = [videoSender];
    const withoutVideo = new DeepPeerConnection({});
    rtc.peers.set('with-video', withVideo as unknown as RTCPeerConnection);
    rtc.peers.set('without-video', withoutVideo as unknown as RTCPeerConnection);
    await expect(rtc.startScreenShare('hd', false)).resolves.toBe(true);
    expect(rtc.screenAudioActive).toBe(false);
    expect(withoutVideo.addTrack).toHaveBeenCalledWith(screen, rtc.screenStream);
    expect(screenParams.encodings[0]).toMatchObject({ maxBitrate: 2_000_000, maxFramerate: 30 });

    screen.onended?.();
    await Promise.resolve(); await Promise.resolve();
    expect(screen.stop).toHaveBeenCalled();
    expect(gum).toHaveBeenCalledTimes(2);
  });

  it('processes replacement tracks through noise suppression even when peers lack matching senders', async () => {
    const cleanProcessing = deepStream(deepTrack('audio'));
    const cleanMic = deepStream(deepTrack('audio'));
    const rawProcessing = deepStream(deepTrack('audio'));
    const rawMic = deepStream(deepTrack('audio'));
    const camera = deepStream(deepTrack('video'));
    const process = vi.fn().mockResolvedValueOnce(cleanProcessing).mockResolvedValueOnce(cleanMic);
    const gum = vi.fn().mockResolvedValueOnce(rawProcessing).mockResolvedValueOnce(rawMic).mockResolvedValueOnce(camera);
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: gum, enumerateDevices: vi.fn(async () => []) } });
    BridgeRegistry.register('BridgeNS', ({ enabled: true, process } as unknown) as AnyFn);
    const rtc = rtcFor(); rtc.currentChannelId = CHANNEL; rtc.localStream = deepStream(deepTrack('audio'), deepTrack('video')); rtc.videoOn = true;
    rtc.peers.set('no-senders', new DeepPeerConnection({}) as unknown as RTCPeerConnection);
    await rtc.setAudioProcessing({ echoCancellation: false });
    await rtc.setMicDevice('processed-mic');
    await rtc.setCameraDevice('camera-without-sender');
    expect(process.mock.calls).toEqual([[rawProcessing], [rawMic]]);
    expect(rtc.localStream.getAudioTracks()[0]).toBe(cleanMic.getAudioTracks()[0]);
    expect(rtc.localStream.getVideoTracks()[0]).toBe(camera.getVideoTracks()[0]);
  });

  it('handles absent RTP capabilities, pre-existing encodings, and missing stats counters', async () => {
    vi.useFakeTimers();
    try {
      const rtc = rtcFor();
      vi.stubGlobal('RTCRtpSender', {});
      const audioCodec = vi.fn(); const videoCodec = vi.fn();
      const pc = new DeepPeerConnection({});
      pc.transceivers = [
        { receiver: { track: { kind: 'audio' } }, setCodecPreferences: audioCodec },
        { receiver: { track: { kind: 'video' } }, setCodecPreferences: videoCodec },
      ];
      (rtc as unknown as { _preferOpus(peer: RTCPeerConnection): void })._preferOpus(pc as unknown as RTCPeerConnection);
      rtc.preferVP9(pc as unknown as RTCPeerConnection);
      expect(audioCodec).not.toHaveBeenCalled(); expect(videoCodec).not.toHaveBeenCalled();

      const params = { encodings: [{}] as Array<{ maxBitrate?: number }>, codecs: [{ mimeType: 'audio/opus' }] };
      const setParameters = vi.fn(async () => undefined);
      pc.senders = [{ track: { kind: 'audio' }, getParameters: () => params, setParameters }];
      await (rtc as unknown as { _applyOpusParams(peer: RTCPeerConnection): Promise<void> })
        ._applyOpusParams(pc as unknown as RTCPeerConnection);
      expect(params.encodings).toHaveLength(1);
      expect(params.codecs[0]).toHaveProperty('sdpFmtpLine', expect.stringContaining('useinbandfec=1'));

      const videoSender = { track: { kind: 'video' }, getParameters: () => ({ encodings: [{}] }), setParameters: vi.fn(async () => undefined) };
      pc.senders = [videoSender];
      pc.stats.set('missing-counters', { type: 'outbound-rtp', kind: 'video' });
      rtc.startAdaptiveBitrate(pc as unknown as RTCPeerConnection);
      await vi.advanceTimersByTimeAsync(3000);
      expect(videoSender.setParameters).not.toHaveBeenCalled();
      rtc.stopAdaptiveBitrate(pc as unknown as RTCPeerConnection);
    } finally {
      vi.useRealTimers();
    }
  });
});
