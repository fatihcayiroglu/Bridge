// client/tests/webrtc-sfu.test.ts
// BridgeRTC (js/webrtc-sfu.ts) — CANLI sözleşme testleri (native Vitest/ESM).
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — GERÇEK ÜRETİM MODÜLÜNE KARŞI MIGRATION
// ════════════════════════════════════════════════════════════════════════════
//
// ÇÖKME NEDENİ (ölçüldü): `jest.mock is not a function` @ eski satır 15.
// Süit 0 test kaydediyordu.
//
// BU DOSYA DİĞER EMEKLİ EDİLENLERDEN FARKLIDIR: gerçek üretim modülünü
// yükler ve gerçek `BridgeRTC` sınıfını örnekler. Bu yüzden emekli
// EDİLMEDİ, taşındı.
//
// ── ÜRÜN DURUMU ─────────────────────────────────────────────────────────────
// SFU client yerel ESM dependency'dir; ürün dalı browser global'i ile değil
// sunucunun authoritative `voice:capabilities` cevabıyla seçilir. Bu unit
// süitte gerçek ağ negotiation'ı ayrı test edilir; doğrudan leave/cleanup
// dallarında `_sfuAvailable` yalnız o authoritative sonucun test double'ıdır.
//
// ── KALDIRILMIŞ SÖZLEŞME ────────────────────────────────────────────────────
// PER_PEER_VOICE_VOLUME = ABSENT. Üretimde `BridgeVoiceVolume`,
// `applyVolume`, `bridge-vol-*` kodu 0'dır. Eski süitte de bunlara dair
// iddia YOKTU (doğrulandı), dolayısıyla düşürülen bir hacim iddiası yok.
//
// ── ESKİ 18 TESTİN DURUMU ───────────────────────────────────────────────────
// 17'si gerçek fonksiyonlara karşılık geliyordu ve KORUNDU.
// 1'i (`setChannelBitrate` — "channelBitrate güncellenir") yalnızca düz bir
// property ataması yapıp onu geri okuyordu; üretim metodunu HİÇ çağırmıyordu.
// O iddia, gerçek `setChannelBitrate()` çağrısı + üretimdeki varsayılan
// (64_000, :144) ile YENİDEN YAZILDI.
//
// Kapsama eklenen, eski süitte OLMAYAN canlı sözleşmeler: screenStream
// temizliği, videoOn/screenSharing sıfırlama, peerStreams temizliği,
// `_broadcastState` yayını ve `_sfuAvailable` türetimi.
//
// Bu sertleştirme turu ayrıca gerçek yaşam döngüsü yarışlarını, kaynak
// temizliğini, kalıcı cihaz seçimlerini ve SFU/P2P yönlendirmesini doğrular.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `mediasoup-client` is an OPTIONAL runtime. Production never activates SFU
// merely because the library exists (webrtc-sfu.ts:171), but when it IS used a
// missing/broken library surfaces at `new Device()`. This switch models exactly
// that boundary; the suite toggles it with setMediasoupPresent() and then calls
// vi.resetModules() so the module graph is rebuilt against the new state.
const mediasoupRuntime = vi.hoisted(() => ({ present: true }));

vi.mock('mediasoup-client', () => ({
  Device: class TestMediasoupDevice {
    rtpCapabilities = { codecs: [] };
    load = vi.fn(async () => undefined);
    createSendTransport = vi.fn();
    createRecvTransport = vi.fn();
    constructor() {
      if (!mediasoupRuntime.present) throw new Error('mediasoup-client is not installed');
    }
  },
}));

function setMediasoupPresent(present: boolean): void {
  mediasoupRuntime.present = present;
}

// The library is present by default; only tests that explicitly model its
// absence flip the switch, and it must not leak into the next test.
beforeEach(() => { mediasoupRuntime.present = true; });

// Yalnız gerçek dış sınırlar mock'lanır — test edilen modül DEĞİL.
vi.mock('../js/core/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: { register: vi.fn(), get: vi.fn(() => null), call: vi.fn(), has: vi.fn(() => false) },
}));
// Remote-media UI effects are owned by VoicePanel under `voicePanel:*`
// registry keys, toasts by core/utils (core/voice-panel-adapter.ts). The
// legacy `bridgeApp` object these tests used to register is never registered
// in production, which is why SFU mode played no remote audio.
const uiToast = vi.hoisted(() => vi.fn());
vi.mock('../js/core/utils', async (importOriginal) => ({ ...(await importOriginal<object>()), toast: uiToast }));
function voicePanelOwners(owners: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return ((name: string) => {
    if (name in extra) return extra[name];
    return name.startsWith('voicePanel:') ? (owners[name.slice('voicePanel:'.length)] ?? null) : null;
  }) as any;
}
vi.mock('../js/core/globals', () => ({
  getAPI: () => 'http://localhost:3000',
  currentServerChannels: () => [],
  setCurrentServerChannels: vi.fn(),
}));
vi.mock('../js/core/auth-compat', () => ({
  readToken: () => 'test-access-token',
}));

import { BridgeRegistry } from '../js/core/bridge-registry';

// ─── Sınır taklitleri ───────────────────────────────────────────────────────

type Emitted = { event: string; payload: unknown };

function makeSocket() {
  const emitted: Emitted[] = [];
  return {
    id: 'basic-socket',
    connected: true,
    emitted,
    emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn(),
  };
}

function makeTrack(kind: 'audio' | 'video' = 'audio', enabled = true) {
  return { kind, enabled, onended: null as null | (() => void), stop: vi.fn(), clone: vi.fn() };
}

function makeStream(tracks: ReturnType<typeof makeTrack>[]) {
  const owned = [...tracks];
  return {
    getTracks: () => owned,
    getAudioTracks: () => owned.filter(t => t.kind === 'audio'),
    getVideoTracks: () => owned.filter(t => t.kind === 'video'),
    addTrack: vi.fn((track: ReturnType<typeof makeTrack>) => { owned.push(track); }),
    removeTrack: vi.fn((track: ReturnType<typeof makeTrack>) => {
      const index = owned.indexOf(track);
      if (index >= 0) owned.splice(index, 1);
    }),
  };
}

function makeProducer(id: string) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    id, close: vi.fn(), pause: vi.fn(), resume: vi.fn(), replaceTrack: vi.fn(async () => undefined),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => { handlers.set(event, fn); }), handlers,
  };
}
function makeConsumer(id: string) {
  return { id, track: makeTrack('audio'), close: vi.fn(), resume: vi.fn() };
}
function makeTransport(id: string) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    id, close: vi.fn(),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => { handlers.set(event, fn); }),
    produce: vi.fn(), consume: vi.fn(), handlers,
  };
}

function makeInteractiveSocket() {
  const emitted: Emitted[] = [];
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const socket = {
    id: 'interactive', connected: true, emitted, handlers,
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
      return socket;
    }),
    once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      const wrapped = (...args: unknown[]) => { socket.off(event, wrapped); fn(...args); };
      socket.on(event, wrapped);
      return socket;
    }),
    off: vi.fn((event: string, fn?: (...args: unknown[]) => void) => {
      if (fn) handlers.get(event)?.delete(fn); else handlers.delete(event);
      if (handlers.get(event)?.size === 0) handlers.delete(event);
      return socket;
    }),
    emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); return socket; }),
    async dispatch(event: string, payload?: unknown) {
      await Promise.all([...(handlers.get(event) ?? [])].map(fn => fn(payload)));
    },
    connect: vi.fn(() => socket),
    disconnect: vi.fn(() => { socket.connected = false; return socket; }),
  };
  return socket;
}

const G = globalThis as Record<string, unknown>;

/** Gerçek üretim modülünü taze yükler ve gerçek BridgeRTC örnekler. */
async function makeRTC(opts: { sfu: boolean } = { sfu: false }) {
  vi.resetModules();
  const mod = await import('../js/webrtc-sfu');
  const socket = makeSocket();
  const rtc = new (mod as any).BridgeRTC(socket);
  // Unit cleanup/leave tests use the negotiated server result as their seam.
  // Capability negotiation itself is exercised by dedicated tests below.
  //
  // `joinVoice()` RE-NEGOTIATES on every call and overwrites `_sfuAvailable`
  // (webrtc-sfu.ts:471), so setting the field alone is only a seam for the
  // non-join paths. Stub the negotiation itself so join-driven tests get the
  // branch they declare instead of silently falling back to P2P.
  (rtc as any)._sfuAvailable = opts.sfu;
  (rtc as any)._negotiateSfuCapability = vi.fn(async () => opts.sfu);
  return { rtc, socket };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  vi.mocked(BridgeRegistry.get).mockReturnValue(null);
});

afterEach(() => {
  delete G.io;
  localStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SFU owner redirect signaling', () => {
  it('registers authentication listeners before connecting the targeted socket', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const targeted = {
      id: 'targeted-1', connected: false,
      emit: vi.fn(),
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => { handlers.set(event, fn); return targeted; }),
      once: vi.fn(),
      off: vi.fn((event: string) => { handlers.delete(event); return targeted; }),
      disconnect: vi.fn(() => targeted),
      connect: vi.fn(() => {
        // Deliberately authenticate synchronously to lock the listener ordering.
        handlers.get('userAuthenticated')?.();
        return targeted;
      }),
    };
    const io = vi.fn(() => targeted);
    G.io = io;

    await (rtc as any)._connectSfuOwner('bridge-2');

    expect(io).toHaveBeenCalledWith('http://localhost:3000', expect.objectContaining({
      autoConnect: false,
      forceNew: true,
      query: { bridgeNode: 'bridge-2' },
      auth: { token: 'test-access-token' },
    }));
    expect(targeted.on.mock.invocationCallOrder[0]).toBeLessThan(targeted.connect.mock.invocationCallOrder[0]);
    expect(targeted.connect).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid owner ids before creating a socket', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const io = vi.fn();
    G.io = io;

    await expect((rtc as any)._connectSfuOwner('../untrusted')).rejects.toThrow(/invalid/i);
    expect(io).not.toHaveBeenCalled();
  });

  it('propagates signaling failure and removes false joined state/resources', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const audioTrack = makeTrack('audio');
    const stream = makeStream([audioTrack]);
    const previousMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    (rtc as any)._sfuJoin = vi.fn().mockRejectedValue(new Error('owner unavailable'));

    try {
      await expect(rtc.joinVoice('voice-1', 'server-1')).rejects.toThrow('owner unavailable');
      expect(audioTrack.stop).toHaveBeenCalledTimes(1);
      expect(rtc.currentChannelId).toBeNull();
      expect(rtc.currentServerId).toBeNull();
      expect(rtc.localStream).toBeNull();
      expect(rtc.isInVoice()).toBe(false);
    } finally {
      if (previousMediaDevices) Object.defineProperty(navigator, 'mediaDevices', previousMediaDevices);
      else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
  });

  it('cleans join, redirect and error listeners when one terminal signal wins', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const signaling = {
      id: 'signaling-1', connected: true, emit: vi.fn(), disconnect: vi.fn(), once: vi.fn(),
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => { handlers.set(event, fn); return signaling; }),
      off: vi.fn((event: string) => { handlers.delete(event); return signaling; }),
    };

    const waiting = (rtc as any)._waitForSfuJoin(signaling, 'voice-1');
    handlers.get('sfu:joined')?.({ existingPeers: [] });
    await expect(waiting).resolves.toEqual({ existingPeers: [] });

    expect(signaling.off).toHaveBeenCalledWith('sfu:joined', expect.any(Function));
    expect(signaling.off).toHaveBeenCalledWith('sfu:redirect', expect.any(Function));
    expect(signaling.off).toHaveBeenCalledWith('sfu:error', expect.any(Function));
    expect(handlers.size).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// isInVoice — webrtc-sfu.ts:165
// ════════════════════════════════════════════════════════════════════════════
describe('isInVoice()', () => {
  it('başlangıçta false döner', async () => {
    const { rtc } = await makeRTC();

    expect(rtc.isInVoice()).toBe(false);
  });

  it('currentChannelId set edilince true döner', async () => {
    const { rtc } = await makeRTC();
    rtc.currentChannelId = 'ch-1';

    expect(rtc.isInVoice()).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SFU uygunluğu — constructor türetimi (:160)
// ════════════════════════════════════════════════════════════════════════════
describe('SFU/P2P branch after authoritative capability negotiation', () => {
  it('server SFU capability false iken P2P dalı seçilir', async () => {
    const { rtc, socket } = await makeRTC({ sfu: false });
    rtc.currentChannelId = 'ch-1';
    rtc.currentServerId = 'srv-1';

    rtc.leaveVoice();

    expect(socket.emitted.map(e => e.event)).toContain('voice:leave');
    expect(socket.emitted.map(e => e.event)).not.toContain('sfu:leave');
  });

  it('server SFU capability true iken SFU dalı seçilir', async () => {
    const { rtc, socket } = await makeRTC({ sfu: true });
    rtc.currentChannelId = 'ch-1';
    rtc.currentServerId = 'srv-1';

    rtc.leaveVoice();

    expect(socket.emitted.map(e => e.event)).toContain('sfu:leave');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// loadSavedDevices — :180-183
// ════════════════════════════════════════════════════════════════════════════
describe('loadSavedDevices()', () => {
  it('kaydedilmiş cihaz kimlikleri yüklenir', async () => {
    localStorage.setItem('bridge-mic', 'mic-1');
    localStorage.setItem('bridge-camera', 'cam-1');
    localStorage.setItem('bridge-speaker', 'spk-1');
    const { rtc } = await makeRTC();

    rtc.loadSavedDevices();

    expect(rtc.selectedMicId).toBe('mic-1');
    expect(rtc.selectedCameraId).toBe('cam-1');
    expect(rtc.selectedSpeakerId).toBe('spk-1');
  });

  it('kayıt yokken null olur (undefined DEĞİL)', async () => {
    const { rtc } = await makeRTC();

    rtc.loadSavedDevices();

    expect(rtc.selectedMicId).toBeNull();
    expect(rtc.selectedCameraId).toBeNull();
    expect(rtc.selectedSpeakerId).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// setMuted — :412-418
// ════════════════════════════════════════════════════════════════════════════
describe('setMuted()', () => {
  it('muted bayrağı güncellenir', async () => {
    const { rtc } = await makeRTC();

    rtc.setMuted(true);
    expect(rtc.muted).toBe(true);

    rtc.setMuted(false);
    expect(rtc.muted).toBe(false);
  });

  it('yerel ses izleri enabled=!muted olur', async () => {
    const { rtc } = await makeRTC();
    const track = makeTrack('audio', true);
    rtc.localStream = makeStream([track]);

    rtc.setMuted(true);
    expect(track.enabled).toBe(false);

    rtc.setMuted(false);
    expect(track.enabled).toBe(true);
  });

  it('audio producer pause/resume edilir', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const producer = makeProducer('audio-p');
    rtc.producers.set('audio', producer);

    rtc.setMuted(true);
    expect(producer.pause).toHaveBeenCalled();

    rtc.setMuted(false);
    expect(producer.resume).toHaveBeenCalled();
  });

  it('kanaldayken durum yayınlanır, kanal yokken YAYINLANMAZ', async () => {
    // _broadcastState currentChannelId yoksa erken döner (:kaynak).
    const { rtc, socket } = await makeRTC();

    rtc.setMuted(true);
    expect(socket.emitted.filter(e => e.event === 'voice:state-update')).toHaveLength(0);

    rtc.currentChannelId = 'ch-1';
    rtc.setMuted(false);
    const state = socket.emitted.filter(e => e.event === 'voice:state-update');
    expect(state).toHaveLength(1);
    expect((state[0].payload as { muted: boolean }).muted).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// setDeafened — :420-425
// ════════════════════════════════════════════════════════════════════════════
describe('setDeafened()', () => {
  it('deafened bayrağı güncellenir', async () => {
    const { rtc } = await makeRTC();

    rtc.setDeafened(true);

    expect(rtc.deafened).toBe(true);
  });

  it('sağırlaştırma sessize almayı da tetikler', async () => {
    const { rtc } = await makeRTC();

    rtc.setDeafened(true);

    expect(rtc.muted).toBe(true);
  });

  it('sağırlaştırmayı kaldırmak muted durumunu DEĞİŞTİRMEZ', async () => {
    const { rtc } = await makeRTC();
    rtc.muted = false;

    rtc.setDeafened(false);

    expect(rtc.muted).toBe(false);
  });

  it('uzak ses elemanları deafened durumunu yansıtır', async () => {
    document.body.innerHTML = '<audio class="remote-audio"></audio><audio class="remote-audio"></audio>';
    const { rtc } = await makeRTC();

    rtc.setDeafened(true);
    document.querySelectorAll<HTMLMediaElement>('.remote-audio').forEach(el => {
      expect(el.muted).toBe(true);
    });

    rtc.setDeafened(false);
    document.querySelectorAll<HTMLMediaElement>('.remote-audio').forEach(el => {
      expect(el.muted).toBe(false);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// leaveVoice — :369-388
// ════════════════════════════════════════════════════════════════════════════
describe('leaveVoice()', () => {
  it('kanalda değilken hata fırlatmaz ve hiçbir şey yayınlamaz', async () => {
    const { rtc, socket } = await makeRTC();

    expect(() => rtc.leaveVoice()).not.toThrow();
    expect(socket.emitted).toHaveLength(0);
  });

  it('P2P yolunda voice:leave doğru yükle yayınlanır', async () => {
    const { rtc, socket } = await makeRTC({ sfu: false });
    rtc.currentChannelId = 'ch-1';
    rtc.currentServerId = 'srv-1';

    rtc.leaveVoice();

    const leave = socket.emitted.find(e => e.event === 'voice:leave');
    expect(leave?.payload).toEqual({ channelId: 'ch-1', serverId: 'srv-1' });
  });

  it('SFU yolunda sfu:leave doğru yükle yayınlanır', async () => {
    const { rtc, socket } = await makeRTC({ sfu: true });
    rtc.currentChannelId = 'ch-1';
    rtc.currentServerId = 'srv-1';

    rtc.leaveVoice();

    const leave = socket.emitted.find(e => e.event === 'sfu:leave');
    expect(leave?.payload).toEqual({ channelId: 'ch-1', serverId: 'srv-1' });
  });

  it('kanal/sunucu durumu sıfırlanır', async () => {
    const { rtc } = await makeRTC();
    rtc.currentChannelId = 'ch-1';
    rtc.currentServerId = 'srv-1';

    rtc.leaveVoice();

    expect(rtc.currentChannelId).toBeNull();
    expect(rtc.currentServerId).toBeNull();
    expect(rtc.isInVoice()).toBe(false);
  });

  it('yerel akış izleri durdurulur ve referans bırakılır', async () => {
    const { rtc } = await makeRTC();
    const track = makeTrack('audio');
    rtc.localStream = makeStream([track]);
    rtc.currentChannelId = 'ch-1';

    rtc.leaveVoice();

    expect(track.stop).toHaveBeenCalled();
    expect(rtc.localStream).toBeNull();
  });

  it('ekran paylaşımı akışı da durdurulur ve bayraklar sıfırlanır', async () => {
    // Eski süitte kapsanmıyordu; üretimde canlı (:379-386).
    const { rtc } = await makeRTC();
    const screenTrack = makeTrack('video');
    rtc.screenStream = makeStream([screenTrack]);
    rtc.currentChannelId = 'ch-1';
    rtc.videoOn = true;
    rtc.screenSharing = true;

    rtc.leaveVoice();

    expect(screenTrack.stop).toHaveBeenCalled();
    expect(rtc.screenStream).toBeNull();
    expect(rtc.videoOn).toBe(false);
    expect(rtc.screenSharing).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// _sfuCleanup — :390-402 (leaveVoice üzerinden, SFU dalında)
// ════════════════════════════════════════════════════════════════════════════
describe('SFU kaynak serbest bırakma', () => {
  it('tüm producer/consumer/transport kapatılır ve durum sıfırlanır', async () => {
    const { rtc } = await makeRTC({ sfu: true });

    const pAudio = makeProducer('p-audio');
    const pVideo = makeProducer('p-video');
    const c1 = makeConsumer('c1');
    const c2 = makeConsumer('c2');
    const send = makeTransport('send');
    const recv = makeTransport('recv');

    rtc.producers.set('audio', pAudio);
    rtc.producers.set('video', pVideo);
    rtc.consumers.set('prod-1', c1);
    rtc.consumers.set('prod-2', c2);
    const peerAudio = makeTrack('audio');
    const peerVideo = makeTrack('video');
    rtc.peerStreams.set('sock-1', { audio: makeStream([peerAudio]), video: makeStream([peerVideo]) });
    rtc.sendTransport = send;
    rtc.recvTransport = recv;
    rtc.currentChannelId = 'ch-1';

    rtc.leaveVoice();

    expect(pAudio.close).toHaveBeenCalled();
    expect(pVideo.close).toHaveBeenCalled();
    expect(c1.close).toHaveBeenCalled();
    expect(c2.close).toHaveBeenCalled();
    expect(send.close).toHaveBeenCalled();
    expect(recv.close).toHaveBeenCalled();

    expect(rtc.producers.size).toBe(0);
    expect(rtc.consumers.size).toBe(0);
    expect(rtc.peerStreams.size).toBe(0);   // eski süitte kapsanmıyordu
    expect(peerAudio.stop).toHaveBeenCalledOnce();
    expect(peerVideo.stop).toHaveBeenCalledOnce();
    expect(rtc.sendTransport).toBeNull();
    expect(rtc.recvTransport).toBeNull();
    expect(rtc.device).toBeNull();
  });

  it('P2P çıkışı da yanlışlıkla kalmış SFU kaynağını güvenle temizler', async () => {
    const { rtc } = await makeRTC({ sfu: false });
    const producer = makeProducer('p-audio');
    rtc.producers.set('audio', producer);
    rtc.currentChannelId = 'ch-1';

    rtc.leaveVoice();

    expect(producer.close).toHaveBeenCalledOnce();
    expect(rtc.producers.size).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// setChannelBitrate — :554-558
// ════════════════════════════════════════════════════════════════════════════
describe('setChannelBitrate()', () => {
  it('varsayılan bitrate üretim değeridir', async () => {
    const { rtc } = await makeRTC();

    expect(rtc.channelBitrate).toBe(64_000);
  });

  it('gerçek metot çağrısı bitrate değerini günceller', async () => {
    // Eski test yalnız `rtc.channelBitrate = X` atayıp geri okuyordu;
    // üretim metodunu hiç çağırmıyordu. Artık gerçek çağrı ölçülür.
    const { rtc } = await makeRTC();

    rtc.setChannelBitrate(128_000);

    expect(rtc.channelBitrate).toBe(128_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Deep SFU signalling, transport and media behavior
// ════════════════════════════════════════════════════════════════════════════

describe('SFU signal wait ownership', () => {
  it('filters unrelated replies, resolves one matching reply, and removes both listeners', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const socket = makeInteractiveSocket();
    const waiting = (rtc as any)._waitForEvent(socket, 'sfu:done', (value: any) => value.id === 'wanted', 1000);
    let settled = false; void waiting.finally(() => { settled = true; });

    socket.dispatch('sfu:done', { id: 'other' });
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.dispatch('sfu:done', { id: 'wanted', ok: true });

    await expect(waiting).resolves.toEqual({ id: 'wanted', ok: true });
    expect(socket.handlers.has('sfu:done')).toBe(false);
    expect(socket.handlers.has('sfu:error')).toBe(false);
  });

  it('propagates explicit/default signaling errors and times out with listener cleanup', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const explicit = makeInteractiveSocket();
    const first = (rtc as any)._waitForEvent(explicit, 'sfu:first', undefined, 1000);
    explicit.dispatch('sfu:error', { message: 'permission revoked' });
    await expect(first).rejects.toThrow('permission revoked');

    const fallback = makeInteractiveSocket();
    const second = (rtc as any)._waitForEvent(fallback, 'sfu:second', undefined, 1000);
    fallback.dispatch('sfu:error', { message: 42 });
    await expect(second).rejects.toThrow('Ses bağlantısı tamamlanamadı.');

    vi.useFakeTimers();
    try {
      const timed = makeInteractiveSocket();
      const third = (rtc as any)._waitForEvent(timed, 'sfu:third', undefined, 25);
      const assertion = expect(third).rejects.toThrow(/timeout.*sfu:third/i);
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(timed.handlers.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('binds capability and join redirects to the requested channel', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const socket = makeInteractiveSocket();
    const caps = (rtc as any)._waitForRtpCapabilities(socket, 'voice-a');
    // Uretim her sinyale bir `requestId` ekler; `_waitForEvent` hatalari o
    // istege gore kapsar (webrtc-sfu.ts scope.requestId). Sozlesme kanal
    // baglamasidir, tam yuk esitligi degil.
    expect(socket.emitted).toContainEqual({
      event: 'sfu:get-rtp-capabilities',
      payload: expect.objectContaining({ channelId: 'voice-a', requestId: expect.any(String) }),
    });
    socket.dispatch('sfu:redirect', { channelId: 'other', ownerNodeId: 'node-x' });
    socket.dispatch('sfu:rtp-capabilities', { rtpCapabilities: { codecs: ['opus'] } });
    await expect(caps).resolves.toEqual({ rtpCapabilities: { codecs: ['opus'] } });

    const redirected = makeInteractiveSocket();
    const rejected = (rtc as any)._waitForRtpCapabilities(redirected, 'voice-a');
    redirected.dispatch('sfu:redirect', { channelId: 'voice-a', ownerNodeId: 'node-b' });
    await expect(rejected).rejects.toMatchObject({ name: 'SfuRedirectSignal', ownerNodeId: 'node-b', channelId: 'voice-a' });

    const joinedSocket = makeInteractiveSocket();
    const joined = (rtc as any)._waitForSfuJoin(joinedSocket, 'voice-a');
    joinedSocket.dispatch('sfu:redirect', { channelId: 'other', ownerNodeId: 'node-z' });
    joinedSocket.dispatch('sfu:joined', { existingPeers: [{ socketId: 'p1' }] });
    await expect(joined).resolves.toEqual({ existingPeers: [{ socketId: 'p1' }] });

    const joinRedirected = makeInteractiveSocket();
    const joinRejected = (rtc as any)._waitForSfuJoin(joinRedirected, 'voice-a');
    joinRedirected.dispatch('sfu:redirect', { channelId: 'voice-a' });
    await expect(joinRejected).rejects.toMatchObject({
      name: 'SfuRedirectSignal', ownerNodeId: null, channelId: 'voice-a',
    });
    expect(joinRedirected.handlers.size).toBe(0);
  });
});

describe('SFU dedicated owner recovery', () => {
  it('rejects missing Socket.IO ownership and resets a failed targeted connection', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    delete G.io;
    await expect((rtc as any)._connectSfuOwner('node-a')).rejects.toThrow(/cannot be authenticated/i);

    const targeted = makeInteractiveSocket();
    targeted.connect.mockImplementation(() => {
      targeted.dispatch('connect_error', new Error('owner offline'));
      return targeted;
    });
    G.io = vi.fn(() => targeted);
    await expect((rtc as any)._connectSfuOwner('node-a')).rejects.toThrow('owner offline');
    expect(targeted.disconnect).toHaveBeenCalledOnce();
    expect((rtc as any)._sfuSocket).toBe(rtc.socket);
  });

  it('caps repeated redirects instead of looping between SFU owners forever', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const main = makeInteractiveSocket();
    main.emit.mockImplementation((event: string, payload: unknown) => {
      main.emitted.push({ event, payload });
      if (event === 'sfu:get-rtp-capabilities') {
        queueMicrotask(() => main.dispatch('sfu:redirect', { channelId: 'voice-loop', ownerNodeId: 'node-loop' }));
      }
      return main;
    });
    (rtc as any)._sfuSocket = main;
    const created: ReturnType<typeof makeInteractiveSocket>[] = [];
    G.io = vi.fn(() => {
      const targeted = makeInteractiveSocket(); created.push(targeted);
      targeted.connect.mockImplementation(() => { targeted.dispatch('userAuthenticated'); return targeted; });
      targeted.emit.mockImplementation((event: string, payload: unknown) => {
        targeted.emitted.push({ event, payload });
        if (event === 'sfu:get-rtp-capabilities') {
          queueMicrotask(() => targeted.dispatch('sfu:redirect', { channelId: 'voice-loop', ownerNodeId: 'node-loop' }));
        }
        return targeted;
      });
      return targeted;
    });

    await expect((rtc as any)._sfuJoin('voice-loop', 'server-a')).rejects.toThrow(/yönlendirmesi tamamlanamadı/i);
    expect(G.io).toHaveBeenCalledTimes(4);
    expect((rtc as any)._redirectCount).toBe(0);
    expect(created.slice(0, -1).every(socket => socket.disconnect.mock.calls.length === 1)).toBe(true);
  });
});

describe('SFU transport and consume protocol', () => {
  it('creates both transports, acknowledges DTLS/produce, produces audio, and resumes a routed consumer', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const socket = makeInteractiveSocket();
    const audioTrack = makeTrack('audio');
    rtc.localStream = makeStream([audioTrack]);
    rtc.currentChannelId = 'voice-transport';
    const audioProducer = makeProducer('producer-audio');
    const send = makeTransport('send-t'); send.produce.mockResolvedValue(audioProducer);
    const consumer = makeConsumer('consumer-video'); consumer.track = makeTrack('video');
    const recv = makeTransport('recv-t'); recv.consume.mockResolvedValue(consumer);
    rtc.device = {
      rtpCapabilities: { codecs: ['opus', 'vp9'] }, load: vi.fn(),
      createSendTransport: vi.fn(() => send), createRecvTransport: vi.fn(() => recv),
    };
    (rtc as any)._sfuSocket = socket;
    const attachRemoteStream = vi.fn(); const handleNewProducer = vi.fn();
    const registry = (await import('../js/core/bridge-registry')).BridgeRegistry;
    vi.mocked(registry.get).mockImplementation((name: string) => {
      if (name === 'voicePanel:attachRemoteStream') return attachRemoteStream as any;
      if (name === 'voicePanel:sfuHandleNewProducer') return handleNewProducer as any;
      return null;
    });
    socket.emit.mockImplementation((event: string, payload: any) => {
      socket.emitted.push({ event, payload });
      if (event === 'sfu:create-transport') queueMicrotask(() => socket.dispatch('sfu:transport-created', {
        direction: payload.direction, id: `${payload.direction}-id`, iceParameters: {}, iceCandidates: [], dtlsParameters: {},
      }));
      if (event === 'sfu:connect-transport') queueMicrotask(() => socket.dispatch('sfu:transport-connected', { direction: payload.direction }));
      if (event === 'sfu:produce') queueMicrotask(() => socket.dispatch('sfu:produced', { producerId: 'server-producer', kind: payload.appData?.screen ? 'screen' : payload.kind }));
      if (event === 'sfu:consume') queueMicrotask(() => socket.dispatch('sfu:consumed', {
        producerId: payload.producerId, consumerId: 'consumer-video', kind: 'video', rtpParameters: {},
      }));
      return socket;
    });

    await (rtc as any)._createSendTransport('voice-transport');
    expect(rtc.sendTransport).toBe(send);
    expect(send.produce).toHaveBeenCalledWith(expect.objectContaining({ track: audioTrack, codecOptions: expect.objectContaining({ opusDtx: true }) }));
    expect(rtc.producers.get('audio')).toBe(audioProducer);

    const connectCb = vi.fn(); const connectErr = vi.fn();
    await send.handlers.get('connect')?.({ dtlsParameters: { role: 'auto' } }, connectCb, connectErr);
    expect(connectCb).toHaveBeenCalledOnce(); expect(connectErr).not.toHaveBeenCalled();
    const producedCb = vi.fn();
    await send.handlers.get('produce')?.({ kind: 'video', rtpParameters: {}, appData: { screen: true } }, producedCb, vi.fn());
    expect(producedCb).toHaveBeenCalledWith({ id: 'server-producer' });

    await (rtc as any)._createRecvTransport('voice-transport');
    const recvCb = vi.fn();
    await recv.handlers.get('connect')?.({ dtlsParameters: {} }, recvCb, vi.fn());
    expect(recvCb).toHaveBeenCalledOnce();
    (rtc as any)._socketToUserId.set('socket-video', 'user-video');
    const result = await (rtc as any)._consume('producer-video', 'socket-video', 'video');
    expect(result).toBe(consumer);
    expect(consumer.resume).toHaveBeenCalledOnce();
    expect(socket.emitted).toContainEqual({
      event: 'sfu:resume-consumer',
      payload: expect.objectContaining({ producerId: 'producer-video', requestId: expect.any(String) }),
    });
    expect(attachRemoteStream).toHaveBeenCalledWith('socket-video', expect.anything(), 'video');
    expect(handleNewProducer).toHaveBeenCalledWith('socket-video', 'user-video', expect.anything(), 'video');
  });

  it('returns null before receive ownership and contains rejected consume/producer operations', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    await expect((rtc as any)._consume('missing', 'socket', 'audio')).resolves.toBeNull();
    await expect((rtc as any)._produceAudio()).resolves.toBeUndefined();

    rtc.localStream = makeStream([makeTrack('audio')]);
    const send = makeTransport('send-fail'); send.produce.mockRejectedValue(new Error('produce failed'));
    rtc.sendTransport = send;
    await expect((rtc as any)._produceAudio()).resolves.toBeUndefined();

    const socket = makeInteractiveSocket();
    (rtc as any)._sfuSocket = socket;
    rtc.device = { rtpCapabilities: {}, load: vi.fn() };
    rtc.recvTransport = makeTransport('recv-fail');
    socket.emit.mockImplementation((event: string, payload: any) => {
      socket.emitted.push({ event, payload });
      if (event === 'sfu:consume') queueMicrotask(() => socket.dispatch('sfu:error', { message: 'consume denied' }));
      return socket;
    });
    await expect((rtc as any)._consume('denied', 'socket', 'audio')).resolves.toBeNull();
  });
});

describe('SFU media/device owner behavior', () => {
  it('stops the permission warm-up, still enumerates after denial, and fails closed on enumeration errors', async () => {
    const { rtc } = await makeRTC();
    const warmupTrack = makeTrack('audio');
    const enumerateDevices = vi.fn(async () => [
      { kind: 'audioinput', deviceId: 'mic' }, { kind: 'audiooutput', deviceId: 'speaker' },
      { kind: 'videoinput', deviceId: 'camera' }, { kind: 'other', deviceId: 'ignored' },
    ] as MediaDeviceInfo[]);
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(makeStream([warmupTrack]))
      .mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia, enumerateDevices,
    } });
    await expect(rtc.getDevices()).resolves.toEqual({
      microphones: [expect.objectContaining({ deviceId: 'mic' })],
      speakers: [expect.objectContaining({ deviceId: 'speaker' })],
      cameras: [expect.objectContaining({ deviceId: 'camera' })],
    });
    expect(warmupTrack.stop).toHaveBeenCalledOnce();
    await expect(rtc.getDevices()).resolves.toEqual({
      microphones: [expect.objectContaining({ deviceId: 'mic' })],
      speakers: [expect.objectContaining({ deviceId: 'speaker' })],
      cameras: [expect.objectContaining({ deviceId: 'camera' })],
    });
    enumerateDevices.mockRejectedValueOnce(new Error('hardware unavailable'));
    await expect(rtc.getDevices()).resolves.toEqual({ microphones: [], speakers: [], cameras: [] });
  });

  it('switches a live microphone through the real noise-processing owner and producer', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const oldTrack = makeTrack('audio'); const newTrack = makeTrack('audio');
    const oldStream = makeStream([oldTrack]); const raw = makeStream([makeTrack('audio')]); const clean = makeStream([newTrack]);
    const getUserMedia = vi.fn(async () => raw); const process = vi.fn(async () => clean);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const toast = uiToast; toast.mockClear(); const registry = (await import('../js/core/bridge-registry')).BridgeRegistry;
    vi.mocked(registry.get).mockImplementation((name: string) => {
      if (name === 'BridgeNS') return { enabled: true, process } as any;
      return null;
    });
    const producer = makeProducer('audio-live');
    rtc.currentChannelId = 'voice-live'; rtc.localStream = oldStream; rtc.producers.set('audio', producer);

    await rtc.setMicDevice('mic-next');

    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'mic-next' }, echoCancellation: true }), video: false });
    expect(process).toHaveBeenCalledWith(raw);
    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(rtc.localStream.getAudioTracks()).toEqual([newTrack]);
    expect(producer.replaceTrack).toHaveBeenCalledWith({ track: newTrack });
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'success');
  });

  it('owns SFU camera/screen producers, track-ended cleanup, denial, and active camera restoration', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const local = makeStream([makeTrack('audio')]); const camera = makeTrack('video'); const screen = makeTrack('video');
    const cameraStream = makeStream([camera]); const screenStream = makeStream([screen]);
    const getUserMedia = vi.fn(async () => cameraStream); const getDisplayMedia = vi.fn(async () => screenStream);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia, getDisplayMedia } });
    const videoProducer = makeProducer('video-p'); const screenProducer = makeProducer('screen-p');
    const send = makeTransport('send-media');
    send.produce.mockImplementation(async (opts: any) => opts.appData?.screen ? screenProducer : videoProducer);
    rtc.localStream = local; rtc.currentChannelId = 'voice-media'; rtc.sendTransport = send;

    await expect(rtc.enableVideo(true)).resolves.toBe(true);
    expect(rtc.producers.get('video')).toBe(videoProducer);
    expect(local.getVideoTracks()).toEqual([camera]);
    videoProducer.handlers.get('trackended')?.();
    await Promise.resolve();
    expect(rtc.videoOn).toBe(false);

    await expect(rtc.startScreenShare('4k60', true)).resolves.toBe(true);
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.any(Object), video: expect.objectContaining({ cursor: 'always' }) }));
    expect(send.produce).toHaveBeenLastCalledWith(expect.objectContaining({ appData: { screen: true }, encodings: [{ maxBitrate: 20_000_000 }] }));
    expect(rtc.producers.get('screen')).toBe(screenProducer);
    screenProducer.handlers.get('trackended')?.();
    expect(screen.stop).toHaveBeenCalled();
    expect(rtc.screenSharing).toBe(false);

    getUserMedia.mockRejectedValueOnce(new Error('camera denied'));
    await expect(rtc.enableVideo(true)).resolves.toBe(false);
    getDisplayMedia.mockRejectedValueOnce(new Error('share cancelled'));
    await expect(rtc.startScreenShare()).resolves.toBe(false);
  });

  it('switches active camera/speaker devices, contains sink failures, and preserves choices while idle', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const oldVideo = makeTrack('video'); const nextVideo = makeTrack('video');
    rtc.localStream = makeStream([oldVideo]); rtc.currentChannelId = 'voice-device'; rtc.videoOn = true;
    const producer = makeProducer('video-device'); rtc.producers.set('video', producer);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => makeStream([nextVideo])),
    } });
    await rtc.setCameraDevice('cam-next');
    expect(oldVideo.stop).toHaveBeenCalledOnce();
    expect(producer.replaceTrack).toHaveBeenCalledWith({ track: nextVideo });

    const ok = vi.fn(async () => undefined); const fail = vi.fn(async () => { throw new Error('unsupported'); });
    const a = document.createElement('audio') as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    const b = document.createElement('audio') as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    a.className = 'remote-audio'; a.setSinkId = ok; b.setSinkId = fail; document.body.append(a, b);
    await expect(rtc.setSpeakerDevice('speaker-next')).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledWith('speaker-next'); expect(fail).toHaveBeenCalledWith('speaker-next');

    rtc.currentChannelId = null; rtc.localStream = null; rtc.videoOn = false;
    await rtc.setMicDevice('idle-mic'); await rtc.setCameraDevice('idle-camera');
    expect(localStorage.getItem('bridge-mic')).toBe('idle-mic');
    expect(localStorage.getItem('bridge-camera')).toBe('idle-camera');
  });
});

describe('SFU and P2P socket event routing', () => {
  class P2PPeer {
    static instances: P2PPeer[] = [];
    signalingState: RTCSignalingState = 'stable'; connectionState: RTCPeerConnectionState = 'new';
    localDescription: RTCSessionDescriptionInit | null = null; remoteDescription: RTCSessionDescriptionInit | null = null;
    onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
    ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer' }) as RTCSessionDescriptionInit);
    createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer' }) as RTCSessionDescriptionInit);
    setLocalDescription = vi.fn(async (d: RTCSessionDescriptionInit) => { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; });
    setRemoteDescription = vi.fn(async (d: RTCSessionDescriptionInit) => { this.remoteDescription = d; this.signalingState = 'stable'; });
    addIceCandidate = vi.fn(async () => undefined); addTrack = vi.fn(); close = vi.fn();
    constructor(public config: RTCConfiguration) { P2PPeer.instances.push(this); }
  }

  beforeEach(() => {
    P2PPeer.instances = [];
    G.RTCPeerConnection = P2PPeer;
    G.RTCSessionDescription = class { constructor(init: object) { Object.assign(this, init); } };
    G.RTCIceCandidate = class { constructor(init: object) { Object.assign(this, init); } };
  });

  it('routes SFU peer/producer lifecycle, E2E, ICE config and stream cleanup through canonical UI owners', async () => {
    setMediasoupPresent(true); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket(); const rtc = new BridgeRTC(socket as any) as any;
    const render = vi.fn(); const remove = vi.fn(); const update = vi.fn(); const attach = vi.fn();
    const initVoiceE2E = vi.fn(async () => true); const renderVoiceE2EBadge = vi.fn();
    const registry = (await import('../js/core/bridge-registry')).BridgeRegistry;
    vi.mocked(registry.get).mockImplementation((name: string) => {
      if (name === 'BridgeVoiceE2E') return { initVoiceE2E, renderVoiceE2EBadge, registerSocketEvents: vi.fn() } as any;
      return voicePanelOwners({ renderVoicePeer: render, removeVoicePeer: remove, updatePeerState: update, attachRemoteStream: attach })(name);
    });
    rtc._consume = vi.fn(async () => makeConsumer('routed'));
    rtc.currentChannelId = 'voice-events';
    await socket.dispatch('sfu:joined', {
      iceServers: [{ urls: 'turn:relay.example' }], iceTransportPolicy: 'relay',
      existingPeers: [{ socketId: 'peer-a', userId: 'user-a', producers: [{ producerId: 'prod-a', kind: 'audio' }] }],
    });
    await Promise.resolve(); await Promise.resolve();
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ socketId: 'peer-a' }), false);
    expect(rtc._consume).toHaveBeenCalledWith('prod-a', 'peer-a', 'audio');
    expect(initVoiceE2E).toHaveBeenCalled(); expect(renderVoiceE2EBadge).toHaveBeenCalled();

    socket.dispatch('sfu:peer-joined', { socketId: 'peer-b', userId: 'user-b' });
    socket.dispatch('sfu:new-producer', { socketId: 'peer-b', producerId: 'prod-b', kind: 'video' });
    const consumer = makeConsumer('closed'); rtc.consumers.set('prod-closed', consumer);
    socket.dispatch('sfu:producer-closed', { producerId: 'prod-closed' });
    expect(consumer.close).toHaveBeenCalled();
    const audio = makeTrack('audio'); const video = makeTrack('video');
    rtc.peerStreams.set('peer-b', { audio: makeStream([audio]), video: makeStream([video]) });
    const owned = makeConsumer('owned'); owned._socketId = 'peer-b'; rtc.consumers.set('owned', owned);
    socket.dispatch('sfu:peer-left', { socketId: 'peer-b' });
    expect(audio.stop).toHaveBeenCalled(); expect(video.stop).toHaveBeenCalled(); expect(owned.close).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('peer-b');
    socket.dispatch('voice:peer-state', { socketId: 'peer-a', muted: true });
    expect(update).toHaveBeenCalledWith('peer-a', { muted: true });
  });

  it('executes the fallback offer/answer/ICE/track/terminal-peer state machine only outside SFU mode', async () => {
    setMediasoupPresent(false); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket(); const rtc = new BridgeRTC(socket as any) as any;
    const render = vi.fn(); const remove = vi.fn(); const attach = vi.fn();
    const registry = (await import('../js/core/bridge-registry')).BridgeRegistry;
    vi.mocked(registry.get).mockImplementation(voicePanelOwners({ renderVoicePeer: render, removeVoicePeer: remove, attachRemoteStream: attach }));
    rtc.localStream = makeStream([makeTrack('audio')]); rtc.currentChannelId = 'voice-p2p';

    await socket.dispatch('voice:existing-peers', [{ socketId: 'peer-p2p' }]);
    await Promise.resolve(); await Promise.resolve();
    const pc = P2PPeer.instances[0];
    expect(rtc.peers.get('peer-p2p')).toBe(pc);
    expect(pc.addTrack).toHaveBeenCalled();
    expect(socket.emitted.some(entry => entry.event === 'webrtc:offer')).toBe(true);
    socket.dispatch('voice:peer-joined', { socketId: 'peer-new' });
    expect(render).toHaveBeenCalledWith({ socketId: 'peer-new' }, false);

    pc.signalingState = 'have-local-offer';
    socket.dispatch('webrtc:answer', { fromSocketId: 'peer-p2p', answer: { type: 'answer', sdp: 'remote' } });
    await Promise.resolve(); expect(pc.setRemoteDescription).toHaveBeenCalled();
    socket.dispatch('webrtc:ice-candidate', { fromSocketId: 'peer-p2p', candidate: { candidate: 'ice' } });
    await Promise.resolve(); expect(pc.addIceCandidate).toHaveBeenCalled();
    const stream = makeStream([makeTrack('audio')]); pc.ontrack?.({ streams: [stream as any] });
    expect(attach).toHaveBeenCalledWith('peer-p2p', stream, undefined);
    pc.onicecandidate?.({ candidate: { candidate: 'local' } });
    expect(socket.emitted.some(entry => entry.event === 'webrtc:ice-candidate')).toBe(true);
    pc.connectionState = 'failed'; pc.onconnectionstatechange?.();
    expect(pc.close).toHaveBeenCalled(); expect(remove).toHaveBeenCalledWith('peer-p2p');

    await socket.dispatch('webrtc:offer', { fromSocketId: 'answer-peer', offer: { type: 'offer', sdp: 'incoming' } });
    expect(socket.emitted.some(entry => entry.event === 'webrtc:answer')).toBe(true);
  });
});

describe('BridgeRTC hardened session lifecycle', () => {
  it('joins P2P with canonical channel/device owners, processed audio, UI and VAD', async () => {
    const { rtc, socket } = await makeRTC({ sfu: false });
    const raw = makeStream([makeTrack('audio')]);
    const clean = makeStream([makeTrack('audio')]);
    const getUserMedia = vi.fn(async () => raw);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const process = vi.fn(async () => clean);
    const init = vi.fn();
    const startVAD = vi.fn();
    vi.mocked(BridgeRegistry.get).mockImplementation((name: string) => {
      if (name === 'currentServerChannels') return (() => [{ _id: 'voice-p2p', bitrate: 96_000 }]) as any;
      if (name === 'BridgeNS') return { enabled: false, process } as any;
      if (name === 'VoiceActivityUI') return { init } as any;
      if (name === '_bridgeStartLocalVAD') return startVAD as any;
      return null;
    });
    rtc.selectedMicId = 'mic-canonical';

    await rtc.joinVoice('voice-p2p', 'server-p2p');

    expect(rtc.getLocalStream()).toBe(clean);
    expect(rtc.channelBitrate).toBe(96_000);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: 'mic-canonical' }, echoCancellation: false }),
      video: false,
    });
    expect(process).toHaveBeenCalledWith(raw);
    expect(socket.emitted).toContainEqual({ event: 'voice:join', payload: { channelId: 'voice-p2p', serverId: 'server-p2p' } });
    expect(init).toHaveBeenCalledWith(socket);
    expect(startVAD).toHaveBeenCalledWith(clean, 'voice-p2p');
  });

  it('falls back to a silent stream on microphone denial and makes same-channel join idempotent', async () => {
    const { rtc, socket } = await makeRTC({ sfu: false });
    const getUserMedia = vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const toast = uiToast; toast.mockClear();
    vi.mocked(BridgeRegistry.get).mockImplementation(() => null);

    await rtc.joinVoice('voice-silent', 'server-a');
    await rtc.joinVoice('voice-silent', 'server-a');

    expect(toast).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(rtc.localStream).not.toBeNull();
    expect(socket.emitted.filter(e => e.event === 'voice:join')).toHaveLength(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('rejects a disconnected join before acquiring media', async () => {
    const { rtc, socket } = await makeRTC({ sfu: false });
    socket.connected = false;
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });

    await expect(rtc.joinVoice('voice-offline', 'server-a')).rejects.toMatchObject({ name: 'AbortError' });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('a leave during the permission prompt stops the late stream and never emits a stale join', async () => {
    const { rtc, socket } = await makeRTC({ sfu: false });
    let resolveMedia!: (stream: any) => void;
    const media = new Promise<any>(resolve => { resolveMedia = resolve; });
    // `joinVoice` now negotiates the server SFU capability BEFORE touching the
    // microphone, so leaving synchronously after the call aborts even earlier
    // and never opens the prompt. Wait until the prompt is actually open — that
    // is the race this test exists to pin.
    let promptOpened!: () => void;
    const prompt = new Promise<void>(resolve => { promptOpened = resolve; });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(() => { promptOpened(); return media; }),
    } });
    const lateTrack = makeTrack('audio');

    const joining = rtc.joinVoice('voice-late', 'server-a');
    await prompt;
    rtc.leaveVoice();
    resolveMedia(makeStream([lateTrack]));
    await joining;

    expect(lateTrack.stop).toHaveBeenCalledOnce();
    expect(rtc.currentChannelId).toBeNull();
    expect(socket.emitted.some(e => e.event === 'voice:join')).toBe(false);
  });

  it('loads canonical Settings device keys first and preserves legacy fallback', async () => {
    localStorage.setItem('bridge:device:mic', 'canonical-mic');
    localStorage.setItem('bridge-mic', 'legacy-mic');
    localStorage.setItem('bridge-camera', 'legacy-camera');
    localStorage.setItem('bridge:device:speaker', 'canonical-speaker');
    const { rtc } = await makeRTC();

    rtc.loadSavedDevices();

    expect(rtc.selectedMicId).toBe('canonical-mic');
    expect(rtc.selectedCameraId).toBe('legacy-camera');
    expect(rtc.selectedSpeakerId).toBe('canonical-speaker');
  });

  it('main socket disconnect closes local media, P2P peers, SFU resources and broadcasts voice-left', async () => {
    setMediasoupPresent(false);
    vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    const local = makeTrack('audio');
    const producer = makeProducer('stale-producer');
    const pc = { close: vi.fn() };
    rtc.currentChannelId = 'voice-disconnect';
    rtc.localStream = makeStream([local]);
    rtc.producers.set('audio', producer);
    rtc.peers.set('peer', pc);
    const left = vi.fn();
    document.addEventListener('bridge:voice-left', left, { once: true });

    await socket.dispatch('disconnect');

    expect(local.stop).toHaveBeenCalledOnce();
    expect(producer.close).toHaveBeenCalledOnce();
    expect(pc.close).toHaveBeenCalledOnce();
    expect(rtc.currentChannelId).toBeNull();
    expect(left).toHaveBeenCalledOnce();
    await socket.dispatch('disconnect');
    expect(left).toHaveBeenCalledOnce();
  });
});

describe('SFU wait and owner failure matrix', () => {
  it('uses the default matcher and accepts redirects without an owner id', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const eventSocket = makeInteractiveSocket();
    const event = (rtc as any)._waitForEvent(eventSocket, 'sfu:any');
    await eventSocket.dispatch('sfu:any', { ok: true });
    await expect(event).resolves.toEqual({ ok: true });

    const capsSocket = makeInteractiveSocket();
    const redirected = (rtc as any)._waitForRtpCapabilities(capsSocket, 'voice-ownerless');
    await capsSocket.dispatch('sfu:redirect', { channelId: 'voice-ownerless' });
    await expect(redirected).rejects.toMatchObject({ ownerNodeId: null, channelId: 'voice-ownerless' });
  });

  it('contains capability/join signaling errors and both protocol timeouts', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const capsError = makeInteractiveSocket();
    const caps = (rtc as any)._waitForRtpCapabilities(capsError, 'voice-caps');
    await capsError.dispatch('sfu:error', { message: 'caps denied' });
    await expect(caps).rejects.toThrow('caps denied');

    const joinError = makeInteractiveSocket();
    const join = (rtc as any)._waitForSfuJoin(joinError, 'voice-join');
    await joinError.dispatch('sfu:error', {});
    await expect(join).rejects.toThrow('Ses kanalına katılım tamamlanamadı.');

    vi.useFakeTimers();
    try {
      const capsTimed = makeInteractiveSocket();
      const capsTimeout = (rtc as any)._waitForRtpCapabilities(capsTimed, 'voice-timeout');
      const capsAssertion = expect(capsTimeout).rejects.toThrow(/capability request timed out/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await capsAssertion;

      const joinTimed = makeInteractiveSocket();
      const joinTimeout = (rtc as any)._waitForSfuJoin(joinTimed, 'voice-timeout');
      const joinAssertion = expect(joinTimeout).rejects.toThrow(/join timed out/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await joinAssertion;
    } finally { vi.useRealTimers(); }
  });

  it('normalizes non-Error owner failures and times out authentication with cleanup', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const rejected = makeInteractiveSocket();
    rejected.connect.mockImplementation(() => { void rejected.dispatch('connect_error', 'offline'); return rejected; });
    G.io = vi.fn(() => rejected);
    await expect((rtc as any)._connectSfuOwner('node-safe')).rejects.toThrow(/connection failed/i);
    expect(rejected.disconnect).toHaveBeenCalledOnce();

    vi.useFakeTimers();
    try {
      const timed = makeInteractiveSocket();
      G.io = vi.fn(() => timed);
      const pending = (rtc as any)._connectSfuOwner('node-timeout');
      const assertion = expect(pending).rejects.toThrow(/authentication timed out/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(timed.disconnect).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

describe('SFU join and transport exceptional paths', () => {
  it('completes a full join and ignores two attempts whose signaling socket changed', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const first = makeInteractiveSocket();
    const second = makeInteractiveSocket();
    const third = makeInteractiveSocket();
    (rtc as any)._sfuSocket = first;
    let attempt = 0;
    (rtc as any)._waitForRtpCapabilities = vi.fn(async (socket: any) => {
      attempt += 1;
      if (attempt === 1) (rtc as any)._sfuSocket = second;
      return { rtpCapabilities: { attempt, socket: socket.id } };
    });
    (rtc as any)._waitForSfuJoin = vi.fn(async () => {
      if (attempt === 2) (rtc as any)._sfuSocket = third;
      return { existingPeers: [] };
    });
    (rtc as any)._createSendTransport = vi.fn(async () => undefined);
    (rtc as any)._createRecvTransport = vi.fn(async () => undefined);

    await (rtc as any)._sfuJoin('voice-success', 'server-a');

    expect(attempt).toBe(3);
    expect((rtc as any)._createSendTransport).toHaveBeenCalledOnce();
    expect((rtc as any)._createRecvTransport).toHaveBeenCalledOnce();
    expect((rtc as any)._redirectCount).toBe(0);
  });

  it('propagates a non-redirect join failure', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    (rtc as any)._waitForRtpCapabilities = vi.fn(async () => { throw new Error('router unavailable'); });
    await expect((rtc as any)._sfuJoin('voice-fail', 'server-a')).rejects.toThrow('router unavailable');
  });

  it('rejects transport creation if ownership changes before commit', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const sendSocket = makeInteractiveSocket();
    (rtc as any)._sfuSocket = sendSocket;
    rtc.device = { createSendTransport: vi.fn(), createRecvTransport: vi.fn(), load: vi.fn(), rtpCapabilities: {} };
    sendSocket.emit.mockImplementation((event: string, payload: any) => {
      sendSocket.emitted.push({ event, payload });
      if (event === 'sfu:create-transport') queueMicrotask(() => {
        (rtc as any)._sfuSocket = makeInteractiveSocket();
        void sendSocket.dispatch('sfu:transport-created', { direction: 'send', id: 'stale', iceParameters: {}, iceCandidates: [], dtlsParameters: {} });
      });
      return sendSocket;
    });
    await expect((rtc as any)._createSendTransport('voice-stale')).rejects.toThrow(/socket changed/i);

    const recvSocket = makeInteractiveSocket();
    (rtc as any)._sfuSocket = recvSocket;
    recvSocket.emit.mockImplementation((event: string, payload: any) => {
      recvSocket.emitted.push({ event, payload });
      if (event === 'sfu:create-transport') queueMicrotask(() => {
        (rtc as any)._sfuSocket = makeInteractiveSocket();
        void recvSocket.dispatch('sfu:transport-created', { direction: 'recv', id: 'stale', iceParameters: {}, iceCandidates: [], dtlsParameters: {} });
      });
      return recvSocket;
    });
    await expect((rtc as any)._createRecvTransport('voice-stale')).rejects.toThrow(/socket changed/i);
  });

  it('closes a send transport and late producer when leave wins during audio production', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const socket = makeInteractiveSocket();
    (rtc as any)._sfuSocket = socket;
    rtc.currentChannelId = 'voice-late-audio';
    rtc.localStream = makeStream([makeTrack('audio')]);
    const send = makeTransport('send-late-audio');
    let resolveProducer!: (producer: any) => void;
    send.produce.mockImplementation(() => new Promise(resolve => { resolveProducer = resolve; }));
    rtc.device = {
      rtpCapabilities: {}, load: vi.fn(),
      createSendTransport: vi.fn(() => send), createRecvTransport: vi.fn(),
    };
    socket.emit.mockImplementation((event: string, payload: any) => {
      socket.emitted.push({ event, payload });
      if (event === 'sfu:create-transport') queueMicrotask(() => socket.dispatch('sfu:transport-created', {
        direction: 'send', id: 'send-late-audio', iceParameters: {}, iceCandidates: [], dtlsParameters: {},
      }));
      return socket;
    });
    const generation = (rtc as any)._sessionGeneration;
    const creating = (rtc as any)._createSendTransport('voice-late-audio', generation);
    await vi.waitFor(() => expect(send.produce).toHaveBeenCalledOnce());

    rtc.leaveVoice();
    const producer = makeProducer('late-audio');
    resolveProducer(producer);

    await expect(creating).rejects.toMatchObject({ name: 'AbortError' });
    expect(producer.close).toHaveBeenCalledOnce();
    expect(send.close).toHaveBeenCalled();
    expect(rtc.sendTransport).toBeNull();
    expect(rtc.producers.has('audio')).toBe(false);
  });

  it('routes send/receive callback failures to errbacks without leaking rejections', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const socket = makeInteractiveSocket();
    const send = makeTransport('send-errors');
    const recv = makeTransport('recv-errors');
    rtc.device = {
      rtpCapabilities: {}, load: vi.fn(),
      createSendTransport: vi.fn(() => send), createRecvTransport: vi.fn(() => recv),
    };
    (rtc as any)._sfuSocket = socket;
    socket.emit.mockImplementation((event: string, payload: any) => {
      socket.emitted.push({ event, payload });
      if (event === 'sfu:create-transport') queueMicrotask(() => socket.dispatch('sfu:transport-created', {
        direction: payload.direction, id: payload.direction, iceParameters: {}, iceCandidates: [], dtlsParameters: {},
      }));
      return socket;
    });

    await (rtc as any)._createSendTransport('voice-errors');
    await (rtc as any)._createRecvTransport('voice-errors');
    (rtc as any)._waitForEvent = vi.fn()
      .mockRejectedValueOnce(new Error('connect denied'))
      .mockRejectedValueOnce('produce exploded')
      .mockRejectedValueOnce('produce without errback')
      .mockRejectedValueOnce(new Error('receive denied'));
    const sendConnectError = vi.fn();
    await send.handlers.get('connect')?.({ dtlsParameters: {} }, vi.fn(), sendConnectError);
    expect(sendConnectError).toHaveBeenCalledWith(expect.any(Error));
    const produceError = vi.fn();
    await send.handlers.get('produce')?.({ kind: 'video', rtpParameters: {} }, vi.fn(), produceError);
    expect(produceError).toHaveBeenCalledWith(expect.objectContaining({ message: 'produce exploded' }));
    await send.handlers.get('produce')?.({ kind: 'video', rtpParameters: {} }, vi.fn(), null);

    const recvConnectError = vi.fn();
    await recv.handlers.get('connect')?.({ dtlsParameters: {} }, vi.fn(), recvConnectError);
    expect(recvConnectError).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('SFU media ownership edge cases', () => {
  it('handles audio-less streams and closes a produced audio track on trackended', async () => {
    const { rtc, socket } = await makeRTC({ sfu: true });
    const send = makeTransport('audio-owner');
    rtc.sendTransport = send;
    rtc.localStream = makeStream([makeTrack('video')]);
    await expect((rtc as any)._produceAudio()).resolves.toBeUndefined();
    expect(send.produce).not.toHaveBeenCalled();

    const producer = makeProducer('audio-produced');
    const audio = makeTrack('audio');
    rtc.localStream = makeStream([audio]);
    send.produce.mockResolvedValue(producer);
    await (rtc as any)._produceAudio();
    producer.handlers.get('trackended')?.();

    expect(producer.close).toHaveBeenCalledOnce();
    expect(rtc.producers.has('audio')).toBe(false);
    expect(socket.emitted).toContainEqual({ event: 'sfu:close-producer', payload: { kind: 'audio' } });
  });

  it('reuses peer streams for audio consumers and rejects a result from a replaced socket', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const socket = makeInteractiveSocket();
    (rtc as any)._sfuSocket = socket;
    rtc.device = { rtpCapabilities: { codecs: ['opus'] }, load: vi.fn() };
    const consumer = makeConsumer('consumer-audio');
    (consumer as any).resume = undefined;
    const recv = makeTransport('recv-audio');
    recv.consume.mockResolvedValue(consumer);
    rtc.recvTransport = recv;
    const audioStream = makeStream([]);
    rtc.peerStreams.set('peer-audio', { audio: audioStream, video: makeStream([]) });
    socket.emit.mockImplementation((event: string, payload: any) => {
      socket.emitted.push({ event, payload });
      if (event === 'sfu:consume') queueMicrotask(() => socket.dispatch('sfu:consumed', {
        producerId: payload.producerId, consumerId: 'consumer-audio', kind: 'audio', rtpParameters: {},
      }));
      return socket;
    });

    await expect((rtc as any)._consume('producer-audio', 'peer-audio', 'audio')).resolves.toBe(consumer);
    expect(audioStream.addTrack).toHaveBeenCalledWith(consumer.track);

    const staleSocket = makeInteractiveSocket();
    (rtc as any)._sfuSocket = staleSocket;
    staleSocket.emit.mockImplementation((event: string, payload: any) => {
      staleSocket.emitted.push({ event, payload });
      if (event === 'sfu:consume') queueMicrotask(() => {
        (rtc as any)._sfuSocket = makeInteractiveSocket();
        void staleSocket.dispatch('sfu:consumed', {
          producerId: payload.producerId, consumerId: 'stale', kind: 'audio', rtpParameters: {},
        });
      });
      return staleSocket;
    });
    await expect((rtc as any)._consume('producer-stale', 'peer-audio', 'audio')).resolves.toBeNull();
  });

  it('guards idle/idempotent camera calls and cleans a failed SFU producer acquisition', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    await expect(rtc.enableVideo(true)).resolves.toBe(false);

    const local = makeStream([makeTrack('audio')]);
    const camera = makeTrack('video');
    const cameraStream = makeStream([camera]);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => cameraStream),
    } });
    const send = makeTransport('camera-fail');
    send.produce.mockRejectedValue(new Error('producer denied'));
    rtc.currentChannelId = 'voice-camera';
    rtc.localStream = local;
    rtc.sendTransport = send;
    rtc.selectedCameraId = 'camera-selected';

    await expect(rtc.enableVideo(true)).resolves.toBe(false);
    expect(camera.stop).toHaveBeenCalledOnce();
    expect(local.getVideoTracks()).toHaveLength(0);

    (rtc as any)._sfuAvailable = false;
    const nextCamera = makeTrack('video');
    const getUserMedia = vi.fn(async () => makeStream([nextCamera]));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    await expect(rtc.enableVideo(true)).resolves.toBe(true);
    await expect(rtc.enableVideo(true)).resolves.toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await expect(rtc.enableVideo(false)).resolves.toBe(true);
    expect(nextCamera.stop).toHaveBeenCalledOnce();
    expect(local.getVideoTracks()).toHaveLength(0);
  });

  it('cancels a pending camera request when video is disabled', async () => {
    const { rtc } = await makeRTC({ sfu: false });
    let resolveCamera!: (stream: any) => void;
    const pendingCamera = new Promise<any>(resolve => { resolveCamera = resolve; });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(() => pendingCamera),
    } });
    const track = makeTrack('video');
    rtc.currentChannelId = 'voice-camera-race';
    rtc.localStream = makeStream([makeTrack('audio')]);

    const enabling = rtc.enableVideo(true);
    await rtc.enableVideo(false);
    resolveCamera(makeStream([track]));

    await expect(enabling).resolves.toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(rtc.videoOn).toBe(false);
  });

  it('uses safe screen defaults, stays idempotent, and track onended fully stops capture', async () => {
    const { rtc } = await makeRTC({ sfu: false });
    await expect(rtc.startScreenShare()).resolves.toBe(false);
    const screen = makeTrack('video');
    const stream = makeStream([screen]);
    const getDisplayMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
    rtc.currentChannelId = 'voice-screen';

    await expect(rtc.startScreenShare('invalid-quality' as any)).resolves.toBe(true);
    await expect(rtc.startScreenShare()).resolves.toBe(true);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: false,
      video: expect.objectContaining({ width: { ideal: 1280 }, height: { ideal: 720 } }),
    }));

    screen.onended?.();
    expect(screen.stop).toHaveBeenCalledOnce();
    expect(rtc.screenSharing).toBe(false);
    expect(rtc.screenStream).toBeNull();
  });

  it('stops empty/failed/stale display captures without publishing sharing state', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    rtc.currentChannelId = 'voice-screen-errors';
    const toast = uiToast; toast.mockClear();
    vi.mocked(BridgeRegistry.get).mockImplementation(() => null);
    const emptyAudio = makeTrack('audio');
    const empty = makeStream([emptyAudio]);
    const getDisplayMedia = vi.fn(async () => empty);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
    await expect(rtc.startScreenShare()).resolves.toBe(false);
    expect(emptyAudio.stop).toHaveBeenCalledOnce();

    const failedTrack = makeTrack('video');
    const failedStream = makeStream([failedTrack]);
    const send = makeTransport('screen-fail');
    send.produce.mockRejectedValue(new Error('screen producer denied'));
    rtc.sendTransport = send;
    getDisplayMedia.mockResolvedValueOnce(failedStream);
    await expect(rtc.startScreenShare()).resolves.toBe(false);
    expect(failedTrack.stop).toHaveBeenCalledOnce();

    let resolveDisplay!: (stream: any) => void;
    getDisplayMedia.mockImplementationOnce(() => new Promise(resolve => { resolveDisplay = resolve; }));
    const staleTrack = makeTrack('video');
    const pending = rtc.startScreenShare();
    rtc.stopScreenShare();
    resolveDisplay(makeStream([staleTrack]));
    await expect(pending).resolves.toBe(false);
    expect(staleTrack.stop).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledTimes(2);
  });
});

describe('SFU device replacement containment', () => {
  it('writes canonical keys and handles no-processor/no-producer device replacements', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const oldAudio = makeTrack('audio');
    const oldVideo = makeTrack('video');
    rtc.localStream = makeStream([oldAudio, oldVideo]);
    rtc.currentChannelId = 'voice-devices';
    rtc.videoOn = true;
    const nextAudio = makeTrack('audio');
    const nextVideo = makeTrack('video');
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(makeStream([nextAudio]))
      .mockResolvedValueOnce(makeStream([nextVideo]));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.mocked(BridgeRegistry.get).mockImplementation(() => null);

    await rtc.setMicDevice('mic-canonical');
    await rtc.setCameraDevice('camera-canonical');
    await rtc.setSpeakerDevice('speaker-canonical');

    expect(localStorage.getItem('bridge:device:mic')).toBe('mic-canonical');
    expect(localStorage.getItem('bridge:device:camera')).toBe('camera-canonical');
    expect(localStorage.getItem('bridge:device:speaker')).toBe('speaker-canonical');
    expect(rtc.localStream.getAudioTracks()).toEqual([nextAudio]);
    expect(rtc.localStream.getVideoTracks()).toEqual([nextVideo]);
  });

  it('stops acquired tracks and contains microphone/camera replacement failures', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const oldAudio = makeTrack('audio');
    const oldVideo = makeTrack('video');
    rtc.localStream = makeStream([oldAudio, oldVideo]);
    rtc.currentChannelId = 'voice-device-errors';
    rtc.videoOn = true;
    const rawAudio = makeTrack('audio');
    const emptyAudioTrack = makeTrack('video');
    const emptyVideoTrack = makeTrack('audio');
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(makeStream([rawAudio]))
      .mockResolvedValueOnce(makeStream([emptyAudioTrack]))
      .mockResolvedValueOnce(makeStream([emptyVideoTrack]));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const toast = uiToast; toast.mockClear();
    vi.mocked(BridgeRegistry.get).mockImplementation((name: string) => {
      if (name === 'BridgeNS') return { enabled: true, process: vi.fn(async () => { throw new Error('processor failed'); }) } as any;
      return null;
    });

    await rtc.setMicDevice('mic-fail');
    vi.mocked(BridgeRegistry.get).mockImplementation(() => null);
    await rtc.setMicDevice('mic-empty');
    await rtc.setCameraDevice('camera-empty');

    expect(rawAudio.stop).toHaveBeenCalledOnce();
    expect(emptyAudioTrack.stop).toHaveBeenCalledOnce();
    expect(emptyVideoTrack.stop).toHaveBeenCalledOnce();
    expect(toast.mock.calls.filter(call => call[1] === 'error')).toHaveLength(3);
  });

  it('preserves working local tracks when an SFU producer rejects a device replacement', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const oldAudio = makeTrack('audio');
    const oldVideo = makeTrack('video');
    rtc.localStream = makeStream([oldAudio, oldVideo]);
    rtc.currentChannelId = 'voice-device-rollback';
    rtc.videoOn = true;
    const nextAudio = makeTrack('audio');
    const nextVideo = makeTrack('video');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn()
        .mockResolvedValueOnce(makeStream([nextAudio]))
        .mockResolvedValueOnce(makeStream([nextVideo])),
    } });
    const audioProducer = makeProducer('audio-rollback');
    const videoProducer = makeProducer('video-rollback');
    audioProducer.replaceTrack.mockRejectedValueOnce(new Error('audio sender rejected replacement'));
    videoProducer.replaceTrack.mockRejectedValueOnce(new Error('video sender rejected replacement'));
    rtc.producers.set('audio', audioProducer);
    rtc.producers.set('video', videoProducer);
    const toast = uiToast; toast.mockClear();
    vi.mocked(BridgeRegistry.get).mockImplementation(() => null);

    await rtc.setMicDevice('mic-rejected');
    await rtc.setCameraDevice('camera-rejected');

    expect(oldAudio.stop).not.toHaveBeenCalled();
    expect(oldVideo.stop).not.toHaveBeenCalled();
    expect(nextAudio.stop).toHaveBeenCalledOnce();
    expect(nextVideo.stop).toHaveBeenCalledOnce();
    expect(rtc.localStream.getAudioTracks()).toEqual([oldAudio]);
    expect(rtc.localStream.getVideoTracks()).toEqual([oldVideo]);
    expect(toast.mock.calls.filter(call => call[1] === 'error')).toHaveLength(2);
  });
});

describe('SFU/P2P alternate routing outcomes', () => {
  class DeepPeer {
    static instances: DeepPeer[] = [];
    signalingState: RTCSignalingState = 'stable';
    connectionState: RTCPeerConnectionState = 'new';
    localDescription: RTCSessionDescriptionInit | null = null;
    onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
    ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'deep-offer' }) as RTCSessionDescriptionInit);
    createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'deep-answer' }) as RTCSessionDescriptionInit);
    setLocalDescription = vi.fn(async (value: RTCSessionDescriptionInit) => { this.localDescription = value; });
    setRemoteDescription = vi.fn(async () => undefined);
    addIceCandidate = vi.fn(async () => undefined);
    addTrack = vi.fn();
    close = vi.fn();
    constructor(public config: RTCConfiguration) { DeepPeer.instances.push(this); }
  }

  beforeEach(() => {
    DeepPeer.instances = [];
    G.RTCPeerConnection = DeepPeer;
    G.RTCSessionDescription = class { constructor(init: object) { Object.assign(this, init); } };
    G.RTCIceCandidate = class { constructor(init: object) { Object.assign(this, init); } };
  });

  it('SFU mode ignores every P2P-only signaling event', async () => {
    setMediasoupPresent(true);
    vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    // "SFU modu" YETKILI pazarlik sonucudur; kurucu artik yalnizca istemci
    // kutuphanesi var diye SFU'yu acmaz (webrtc-sfu.ts:171).
    rtc._sfuAvailable = true;
    const render = vi.fn();
    vi.mocked(BridgeRegistry.get).mockImplementation(voicePanelOwners({ renderVoicePeer: render, removeVoicePeer: vi.fn() }));

    await socket.dispatch('voice:existing-peers', [{ socketId: 'ignored' }]);
    await socket.dispatch('voice:peer-joined', { socketId: 'ignored' });
    await socket.dispatch('voice:peer-left', { socketId: 'ignored' });
    await socket.dispatch('webrtc:offer', { fromSocketId: 'ignored', offer: {} });
    await socket.dispatch('webrtc:answer', { fromSocketId: 'ignored', answer: {} });
    await socket.dispatch('webrtc:ice-candidate', { fromSocketId: 'ignored', candidate: {} });

    expect(DeepPeer.instances).toHaveLength(0);
    expect(render).not.toHaveBeenCalled();
    expect(rtc.peers.size).toBe(0);
  });

  it('P2P E2E handles false initialization and empty rooms without claiming a badge', async () => {
    setMediasoupPresent(false);
    vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    const initVoiceE2E = vi.fn(async () => false);
    const renderVoiceE2EBadge = vi.fn();
    vi.mocked(BridgeRegistry.get).mockImplementation((name: string) => name === 'BridgeVoiceE2E'
      ? { initVoiceE2E, renderVoiceE2EBadge, registerSocketEvents: vi.fn() } as any : null);

    await socket.dispatch('voice:existing-peers', [{ socketId: 'peer-e2e' }]);
    await Promise.resolve();
    expect(initVoiceE2E).toHaveBeenCalledOnce();
    expect(renderVoiceE2EBadge).not.toHaveBeenCalled();
    await socket.dispatch('voice:existing-peers', []);
    expect(initVoiceE2E).toHaveBeenCalledOnce();
  });

  it('routes absent/stable P2P peers and contains rejected ICE/offer/answer work', async () => {
    setMediasoupPresent(false);
    vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    const remove = vi.fn();
    vi.mocked(BridgeRegistry.get).mockImplementation(voicePanelOwners({ removeVoicePeer: remove }));

    await socket.dispatch('voice:peer-left', { socketId: 'missing-peer' });
    expect(remove).toHaveBeenCalledWith('missing-peer');
    await socket.dispatch('webrtc:answer', { fromSocketId: 'missing-peer', answer: {} });

    const stable = new DeepPeer({});
    rtc.peers.set('stable-peer', stable);
    await socket.dispatch('webrtc:answer', { fromSocketId: 'stable-peer', answer: {} });
    expect(stable.setRemoteDescription).not.toHaveBeenCalled();
    await socket.dispatch('webrtc:ice-candidate', { fromSocketId: 'stable-peer', candidate: null });
    expect(stable.addIceCandidate).not.toHaveBeenCalled();
    stable.addIceCandidate.mockRejectedValueOnce(new Error('bad candidate'));
    await socket.dispatch('webrtc:ice-candidate', { fromSocketId: 'stable-peer', candidate: { candidate: 'bad' } });
    expect(stable.addIceCandidate).toHaveBeenCalledOnce();

    const offerFailure = new DeepPeer({});
    offerFailure.createOffer.mockRejectedValueOnce(new Error('offer failed'));
    vi.spyOn(rtc, '_p2pCreatePeer').mockReturnValueOnce(offerFailure);
    await expect(rtc._p2pCreateOffer('offer-fail', { socketId: 'offer-fail' })).resolves.toBeUndefined();

    const answerFailure = new DeepPeer({});
    answerFailure.setRemoteDescription.mockRejectedValueOnce(new Error('answer failed'));
    rtc.peers.set('answer-fail', answerFailure);
    await expect(rtc._p2pHandleOffer('answer-fail', {})).resolves.toBeUndefined();
  });

  it('covers custom ICE, empty callbacks, nonterminal state and unknown peer removal', async () => {
    setMediasoupPresent(false);
    vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    rtc._iceServers = [{ urls: 'turn:custom.example' }];
    rtc._iceTransportPolicy = 'relay';
    const pc = rtc._p2pCreatePeer('callback-peer', { socketId: 'callback-peer' }) as DeepPeer;

    expect(pc.config).toEqual({ iceServers: [{ urls: 'turn:custom.example' }], iceTransportPolicy: 'relay' });
    pc.onicecandidate?.({ candidate: null });
    pc.ontrack?.({ streams: [] });
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    expect(socket.emitted.some(entry => entry.event === 'webrtc:ice-candidate')).toBe(false);

    rtc._p2pRemovePeer('unknown-peer');
    expect(pc.close).not.toHaveBeenCalled();
  });

  it('SFU empty metadata paths do not fabricate users, producers, consumers or E2E badges', async () => {
    setMediasoupPresent(true);
    vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    rtc.currentChannelId = 'voice-empty-meta';
    const initVoiceE2E = vi.fn(async () => false);
    const badge = vi.fn();
    const remove = vi.fn();
    vi.mocked(BridgeRegistry.get).mockImplementation((name: string) => {
      if (name === 'BridgeVoiceE2E') return { initVoiceE2E, renderVoiceE2EBadge: badge, registerSocketEvents: vi.fn() } as any;
      return voicePanelOwners({ renderVoicePeer: vi.fn(), removeVoicePeer: remove })(name);
    });
    rtc._consume = vi.fn();

    await socket.dispatch('sfu:joined', { existingPeers: [{ socketId: 'peer-no-meta' }] });
    await Promise.resolve();
    expect(rtc._socketToUserId.get('peer-no-meta')).toBe('');
    expect(rtc._consume).not.toHaveBeenCalled();
    expect(initVoiceE2E).toHaveBeenCalledOnce();
    expect(badge).not.toHaveBeenCalled();
    await socket.dispatch('sfu:joined', { existingPeers: [] });

    await socket.dispatch('sfu:producer-closed', { producerId: 'unknown-producer' });
    const unrelated = makeConsumer('unrelated');
    unrelated._socketId = 'another-peer';
    rtc.consumers.set('unrelated', unrelated);
    await socket.dispatch('sfu:peer-left', { socketId: 'missing-streams' });
    expect(unrelated.close).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('missing-streams');
  });

  it('dedicated disconnect is ignored and E2E registration follows the active signaling mode', async () => {
    const { rtc, socket } = await makeRTC({ sfu: true });
    const dedicated = makeInteractiveSocket();
    (rtc as any)._bindSocketEvents(dedicated);
    rtc.currentChannelId = 'voice-dedicated';
    await dedicated.dispatch('disconnect');
    expect(rtc.currentChannelId).toBe('voice-dedicated');

    const registerSocketEvents = vi.fn();
    vi.mocked(BridgeRegistry.get).mockImplementation((name: string) => name === 'BridgeVoiceE2E'
      ? { registerSocketEvents, initVoiceE2E: vi.fn(), renderVoiceE2EBadge: vi.fn() } as any : null);
    (rtc as any)._sfuSocket = dedicated;
    rtc.registerVoiceE2EEvents('user-sfu');
    expect(registerSocketEvents).toHaveBeenCalledWith(dedicated, 'user-sfu');

    (rtc as any)._sfuAvailable = false;
    rtc.registerVoiceE2EEvents('user-p2p');
    expect(registerSocketEvents).toHaveBeenCalledWith(socket, 'user-p2p');
  });
});

describe('BridgeRTC late-operation ownership', () => {
  it('prevents an older real SFU capability reply from signaling after channel replacement', async () => {
    setMediasoupPresent(true);
    vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    // Sunucu SFU yetenegi HER `joinVoice` cagrisinda yeniden pazarlik edilir;
    // yetkili sonucun test double'i pazarligin KENDISIDIR (makeRTC ile ayni seam).
    (rtc as any)._sfuAvailable = true;
    (rtc as any)._negotiateSfuCapability = vi.fn(async () => true);
    const firstTrack = makeTrack('audio');
    const replacementTrack = makeTrack('audio');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn()
        .mockResolvedValueOnce(makeStream([firstTrack]))
        .mockResolvedValueOnce(makeStream([replacementTrack])),
    } });
    rtc._createSendTransport = vi.fn(async () => undefined);
    rtc._createRecvTransport = vi.fn(async () => undefined);

    const firstJoin = rtc.joinVoice('voice-stale-signaling', 'server-a');
    await vi.waitFor(() => expect(socket.emitted.filter(e => e.event === 'sfu:get-rtp-capabilities')).toHaveLength(1));
    const replacementJoin = rtc.joinVoice('voice-current-signaling', 'server-a');
    await vi.waitFor(() => expect(socket.emitted.filter(e => e.event === 'sfu:get-rtp-capabilities')).toHaveLength(2));

    await socket.dispatch('sfu:rtp-capabilities', { rtpCapabilities: { codecs: ['opus'] } });
    await vi.waitFor(() => expect(socket.emitted.filter(e => e.event === 'sfu:join')).toHaveLength(1));
    expect(socket.emitted.filter(e => e.event === 'sfu:join').map(e => (e.payload as any).channelId))
      .toEqual(['voice-current-signaling']);
    await socket.dispatch('sfu:joined', { existingPeers: [] });
    await Promise.all([firstJoin, replacementJoin]);

    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(replacementTrack.stop).not.toHaveBeenCalled();
    expect(rtc.currentChannelId).toBe('voice-current-signaling');
    expect(rtc._createSendTransport).toHaveBeenCalledOnce();
    expect(rtc._createRecvTransport).toHaveBeenCalledOnce();
  });

  it('replaces an active channel by closing its media before the next join', async () => {
    const { rtc, socket } = await makeRTC({ sfu: false });
    const firstTrack = makeTrack('audio');
    const secondTrack = makeTrack('audio');
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(makeStream([firstTrack]))
      .mockResolvedValueOnce(makeStream([secondTrack]));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });

    await rtc.joinVoice('voice-first', 'server-a');
    await rtc.joinVoice('voice-second', 'server-a');

    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(rtc.currentChannelId).toBe('voice-second');
    expect(socket.emitted.map(e => e.event)).toEqual(expect.arrayContaining(['voice:leave', 'voice:join']));
  });

  it('stops both raw and processed streams when leave wins during noise processing', async () => {
    const { rtc, socket } = await makeRTC({ sfu: false });
    const rawTrack = makeTrack('audio');
    const cleanTrack = makeTrack('audio');
    const raw = makeStream([rawTrack]);
    const clean = makeStream([cleanTrack]);
    let resolveProcess!: (stream: any) => void;
    const process = vi.fn(() => new Promise<any>(resolve => { resolveProcess = resolve; }));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => raw),
    } });
    vi.mocked(BridgeRegistry.get).mockImplementation((name: string) => name === 'BridgeNS'
      ? { enabled: true, process } as any : null);

    const joining = rtc.joinVoice('voice-processed-late', 'server-a');
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
    rtc.leaveVoice();
    resolveProcess(clean);
    await joining;

    expect(rawTrack.stop).toHaveBeenCalledOnce();
    expect(cleanTrack.stop).toHaveBeenCalledOnce();
    expect(socket.emitted.some(e => e.event === 'voice:join')).toBe(false);
  });

  it('contains a processor rejection after leave and does not publish a stale microphone error', async () => {
    const { rtc } = await makeRTC({ sfu: false });
    const rawTrack = makeTrack('audio');
    let rejectProcess!: (reason: unknown) => void;
    const process = vi.fn(() => new Promise<any>((_resolve, reject) => { rejectProcess = reject; }));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => makeStream([rawTrack])),
    } });
    const toast = uiToast; toast.mockClear();
    vi.mocked(BridgeRegistry.get).mockImplementation((name: string) => {
      if (name === 'BridgeNS') return { enabled: true, process } as any;
      return null;
    });

    const joining = rtc.joinVoice('voice-process-reject', 'server-a');
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
    rtc.leaveVoice();
    rejectProcess(new Error('processor late failure'));
    await joining;

    expect(rawTrack.stop).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
  });

  it('late SFU success and failure cannot resurrect or report a departed session', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const { rtc } = await makeRTC({ sfu: true });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        getUserMedia: vi.fn(async () => makeStream([makeTrack('audio')])),
      } });
      let finish!: () => void;
      (rtc as any)._sfuJoin = vi.fn(() => new Promise<void>((resolve, reject) => {
        finish = () => outcome === 'resolve' ? resolve() : reject(new Error('late SFU failure'));
      }));

      const joining = rtc.joinVoice(`voice-sfu-${outcome}`, 'server-a');
      await vi.waitFor(() => expect((rtc as any)._sfuJoin).toHaveBeenCalledOnce());
      rtc.leaveVoice();
      finish();
      await expect(joining).resolves.toBeUndefined();
      expect(rtc.currentChannelId).toBeNull();
    }
  });

  it('an older SFU join resolving late cannot tear down its replacement session', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const firstTrack = makeTrack('audio');
    const replacementTrack = makeTrack('audio');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn()
        .mockResolvedValueOnce(makeStream([firstTrack]))
        .mockResolvedValueOnce(makeStream([replacementTrack])),
    } });
    let resolveFirst!: () => void;
    let attempts = 0;
    (rtc as any)._sfuJoin = vi.fn(() => {
      attempts += 1;
      return attempts === 1
        ? new Promise<void>(resolve => { resolveFirst = resolve; })
        : Promise.resolve();
    });

    const firstJoin = rtc.joinVoice('voice-old', 'server-a');
    await vi.waitFor(() => expect((rtc as any)._sfuJoin).toHaveBeenCalledOnce());
    await rtc.joinVoice('voice-replacement', 'server-a');
    resolveFirst();
    await firstJoin;

    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(replacementTrack.stop).not.toHaveBeenCalled();
    expect(rtc.currentChannelId).toBe('voice-replacement');
    expect(rtc.localStream?.getAudioTracks()).toEqual([replacementTrack]);
  });

  it('successful SFU join initializes the active SFU UI and VAD owners', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const local = makeStream([makeTrack('audio')]);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => local),
    } });
    (rtc as any)._sfuJoin = vi.fn(async () => undefined);
    const init = vi.fn();
    const start = vi.fn();
    vi.mocked(BridgeRegistry.get).mockImplementation((name: string) => {
      if (name === 'VoiceActivityUI') return { init } as any;
      if (name === '_bridgeStartLocalVAD') return start as any;
      return null;
    });

    await rtc.joinVoice('voice-sfu-ui', 'server-a');
    expect(init).toHaveBeenCalledWith((rtc as any)._sfuSocket);
    expect(start).toHaveBeenCalledWith(local, 'voice-sfu-ui');
  });
});

describe('Late camera, screen and device operations', () => {
  it('rejects camera streams without video and closes a producer resolved after disable', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    rtc.currentChannelId = 'voice-camera-empty';
    rtc.localStream = makeStream([makeTrack('audio')]);
    const noVideo = makeTrack('audio');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => makeStream([noVideo])),
    } });
    await expect(rtc.enableVideo(true)).resolves.toBe(false);
    expect(noVideo.stop).toHaveBeenCalledOnce();

    const camera = makeTrack('video');
    let resolveProducer!: (producer: any) => void;
    const send = makeTransport('late-video-producer');
    send.produce.mockImplementation(() => new Promise(resolve => { resolveProducer = resolve; }));
    rtc.sendTransport = send;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => makeStream([camera])),
    } });
    const enabling = rtc.enableVideo(true);
    await vi.waitFor(() => expect(send.produce).toHaveBeenCalledOnce());
    await rtc.enableVideo(false);
    const producer = makeProducer('late-video');
    resolveProducer(producer);
    await expect(enabling).resolves.toBe(false);
    expect(producer.close).toHaveBeenCalledOnce();
    expect(camera.stop).toHaveBeenCalled();
  });

  it('closes a screen producer resolved after stop', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    rtc.currentChannelId = 'voice-screen-late';
    const screen = makeTrack('video');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getDisplayMedia: vi.fn(async () => makeStream([screen])),
    } });
    let resolveProducer!: (producer: any) => void;
    const send = makeTransport('late-screen-producer');
    send.produce.mockImplementation(() => new Promise(resolve => { resolveProducer = resolve; }));
    rtc.sendTransport = send;

    const sharing = rtc.startScreenShare();
    await vi.waitFor(() => expect(send.produce).toHaveBeenCalledOnce());
    rtc.stopScreenShare();
    const producer = makeProducer('late-screen');
    resolveProducer(producer);
    await expect(sharing).resolves.toBe(false);
    expect(producer.close).toHaveBeenCalledOnce();
    expect(screen.stop).toHaveBeenCalledOnce();
  });

  it('stale processed microphone and camera replacements stop their new tracks', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    rtc.currentChannelId = 'voice-device-stale';
    rtc.localStream = makeStream([makeTrack('audio'), makeTrack('video')]);
    rtc.videoOn = true;
    const rawTrack = makeTrack('audio');
    const cleanTrack = makeTrack('audio');
    let resolveProcess!: (stream: any) => void;
    const process = vi.fn(() => new Promise<any>(resolve => { resolveProcess = resolve; }));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => makeStream([rawTrack])),
    } });
    vi.mocked(BridgeRegistry.get).mockImplementation((name: string) => name === 'BridgeNS'
      ? { enabled: true, process } as any : null);
    const mic = rtc.setMicDevice('mic-stale');
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
    rtc.leaveVoice();
    resolveProcess(makeStream([cleanTrack]));
    await mic;
    expect(rawTrack.stop).toHaveBeenCalledOnce();
    expect(cleanTrack.stop).toHaveBeenCalledOnce();

    rtc.currentChannelId = 'voice-camera-stale';
    rtc.localStream = makeStream([makeTrack('audio')]);
    rtc.videoOn = true;
    const nextCamera = makeTrack('video');
    let resolveCamera!: (stream: any) => void;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(() => new Promise(resolve => { resolveCamera = resolve; })),
    } });
    const camera = rtc.setCameraDevice('camera-stale');
    rtc.leaveVoice();
    resolveCamera(makeStream([nextCamera]));
    await camera;
    expect(nextCamera.stop).toHaveBeenCalledOnce();
  });

  it('stops processed mic and camera candidates when leave wins during producer replacement', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    rtc.currentChannelId = 'voice-mic-replace-stale';
    rtc.localStream = makeStream([makeTrack('audio')]);
    const rawMic = makeTrack('audio');
    const cleanMic = makeTrack('audio');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => makeStream([rawMic])),
    } });
    vi.mocked(BridgeRegistry.get).mockImplementation((name: string) => name === 'BridgeNS'
      ? { enabled: true, process: vi.fn(async () => makeStream([cleanMic])) } as any : null);
    const audioProducer = makeProducer('audio-replace-stale');
    let finishMicReplace!: () => void;
    audioProducer.replaceTrack.mockImplementation(() => new Promise<void>(resolve => { finishMicReplace = resolve; }));
    rtc.producers.set('audio', audioProducer);
    const mic = rtc.setMicDevice('mic-replace-stale');
    await vi.waitFor(() => expect(audioProducer.replaceTrack).toHaveBeenCalledOnce());
    rtc.leaveVoice();
    finishMicReplace();
    await mic;
    expect(rawMic.stop).toHaveBeenCalledOnce();
    expect(cleanMic.stop).toHaveBeenCalledOnce();

    rtc.currentChannelId = 'voice-camera-replace-stale';
    rtc.localStream = makeStream([makeTrack('audio'), makeTrack('video')]);
    rtc.videoOn = true;
    const nextCamera = makeTrack('video');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => makeStream([nextCamera])),
    } });
    const videoProducer = makeProducer('video-replace-stale');
    let finishCameraReplace!: () => void;
    videoProducer.replaceTrack.mockImplementation(() => new Promise<void>(resolve => { finishCameraReplace = resolve; }));
    rtc.producers.set('video', videoProducer);
    const camera = rtc.setCameraDevice('camera-replace-stale');
    await vi.waitFor(() => expect(videoProducer.replaceTrack).toHaveBeenCalledOnce());
    rtc.leaveVoice();
    finishCameraReplace();
    await camera;
    expect(nextCamera.stop).toHaveBeenCalledOnce();
  });
});

describe('Remaining protocol alternatives', () => {
  it('keeps the safe default bitrate when channel metadata omits an override', async () => {
    const { rtc } = await makeRTC({ sfu: false });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn(async () => makeStream([makeTrack('audio')])),
    } });
    vi.mocked(BridgeRegistry.get).mockImplementation((name: string) => name === 'currentServerChannels'
      ? (() => [{ _id: 'voice-default-bitrate' }]) as any : null);
    await rtc.joinVoice('voice-default-bitrate', 'server-a');
    expect(rtc.channelBitrate).toBe(64_000);
  });

  it('uses default ICE policy and peer-joined user fallback', async () => {
    setMediasoupPresent(true);
    vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    // Sunucu SFU yetenegi HER `joinVoice` cagrisinda yeniden pazarlik edilir;
    // yetkili sonucun test double'i pazarligin KENDISIDIR (makeRTC ile ayni seam).
    (rtc as any)._sfuAvailable = true;
    (rtc as any)._negotiateSfuCapability = vi.fn(async () => true);
    rtc.currentChannelId = 'voice-default-policy';
    rtc._consume = vi.fn();
    await socket.dispatch('sfu:joined', { iceServers: [{ urls: 'turn:default-policy' }], existingPeers: [] });
    expect(rtc._iceTransportPolicy).toBe('all');
    await socket.dispatch('sfu:peer-joined', { socketId: 'peer-no-user' });
    expect(rtc._socketToUserId.get('peer-no-user')).toBe('');
  });

  it('renders the P2P E2E badge only after a true initialization', async () => {
    setMediasoupPresent(false);
    vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    new BridgeRTC(socket as any);
    const badge = vi.fn();
    vi.mocked(BridgeRegistry.get).mockImplementation((name: string) => name === 'BridgeVoiceE2E'
      ? { initVoiceE2E: vi.fn(async () => true), renderVoiceE2EBadge: badge } as any : null);
    await socket.dispatch('voice:existing-peers', [{ socketId: 'peer-badge' }]);
    await vi.waitFor(() => expect(badge).toHaveBeenCalledOnce());
  });

  it('normalizes the remaining transport callback error variants', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    const send = makeTransport('send-remaining');
    const recv = makeTransport('recv-remaining');
    rtc.sendTransport = send;
    rtc.recvTransport = recv;
    const socket = makeInteractiveSocket();
    (rtc as any)._sfuSocket = socket;
    send.on('produce', async () => undefined);
    // Reuse the production callbacks by creating transports once.
    rtc.device = { rtpCapabilities: {}, load: vi.fn(), createSendTransport: () => send, createRecvTransport: () => recv };
    socket.emit.mockImplementation((event: string, payload: any) => {
      socket.emitted.push({ event, payload });
      if (event === 'sfu:create-transport') queueMicrotask(() => socket.dispatch('sfu:transport-created', {
        direction: payload.direction, id: payload.direction, iceParameters: {}, iceCandidates: [], dtlsParameters: {},
      }));
      return socket;
    });
    rtc.localStream = null;
    await (rtc as any)._createSendTransport('voice-callbacks');
    await (rtc as any)._createRecvTransport('voice-callbacks');
    (rtc as any)._waitForEvent = vi.fn()
      .mockRejectedValueOnce('send connect string')
      .mockRejectedValueOnce(new Error('send connect without errback'))
      .mockRejectedValueOnce(new Error('produce Error'))
      .mockRejectedValueOnce('receive string');
    const sendConnectError = vi.fn();
    await send.handlers.get('connect')?.({ dtlsParameters: {} }, vi.fn(), sendConnectError);
    expect(sendConnectError).toHaveBeenCalledWith(expect.objectContaining({ message: 'send connect string' }));
    await send.handlers.get('connect')?.({ dtlsParameters: {} }, vi.fn(), null);
    const produceError = vi.fn();
    await send.handlers.get('produce')?.({ kind: 'audio', rtpParameters: {}, appData: {} }, vi.fn(), produceError);
    expect(produceError).toHaveBeenCalledWith(expect.any(Error));
    const receiveError = vi.fn();
    await recv.handlers.get('connect')?.({ dtlsParameters: {} }, vi.fn(), receiveError);
    expect(receiveError).toHaveBeenCalledWith(expect.objectContaining({ message: 'receive string' }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P2 media lab regressions (real browsers, real mediasoup): a late joiner was
// deaf to everyone already in the room, and SFU remote audio was never
// attached to a playing element.
// ════════════════════════════════════════════════════════════════════════════
describe('SFU late join consumes producers announced before the receive transport', () => {
  it('existing peers from sfu:joined are consumed once the receive transport exists and reach the voice UI owner', async () => {
    setMediasoupPresent(true); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    const attach = vi.fn();
    const registry = (await import('../js/core/bridge-registry')).BridgeRegistry;
    vi.mocked(registry.get).mockImplementation(voicePanelOwners({ attachRemoteStream: attach, renderVoicePeer: vi.fn() }));

    const consumer = makeConsumer('consumer-early');
    const recv = makeTransport('recv-late'); recv.consume.mockResolvedValue(consumer);
    socket.emit.mockImplementation((event: string, payload: any) => {
      socket.emitted.push({ event, payload });
      if (event === 'sfu:consume') queueMicrotask(() => socket.dispatch('sfu:consumed', {
        producerId: payload.producerId, consumerId: 'consumer-early', kind: 'audio', rtpParameters: {},
      }));
      return socket;
    });
    rtc.currentChannelId = 'voice-late-join';
    rtc._waitForRtpCapabilities = vi.fn(async () => ({ rtpCapabilities: { codecs: [] } }));
    // The owner answers the join with the peers already in the room — BEFORE
    // this client has created any transport.
    rtc._waitForSfuJoin = vi.fn(async () => {
      await socket.dispatch('sfu:joined', {
        existingPeers: [{ socketId: 'peer-early', userId: 'user-early', producers: [{ producerId: 'producer-early', kind: 'audio' }] }],
      });
      expect(socket.emitted.some(e => e.event === 'sfu:consume')).toBe(false);
      return {};
    });
    rtc._createSendTransport = vi.fn(async () => undefined);
    rtc._createRecvTransport = vi.fn(async () => { rtc.recvTransport = recv; });

    await rtc._sfuJoin('voice-late-join', 'server-a', rtc._sessionGeneration);

    expect(socket.emitted).toContainEqual({ event: 'sfu:consume', payload: expect.objectContaining({ producerId: 'producer-early' }) });
    expect(rtc.consumers.get('producer-early')).toBe(consumer);
    expect(attach).toHaveBeenCalledWith('peer-early', expect.anything(), 'audio');
  });

  it('forgets a queued producer that closes, or whose peer leaves, before the transport exists', async () => {
    setMediasoupPresent(true); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    rtc.currentChannelId = 'voice-queue';
    await socket.dispatch('sfu:new-producer', { socketId: 'peer-1', producerId: 'p-closed', kind: 'audio' });
    await socket.dispatch('sfu:new-producer', { socketId: 'peer-2', producerId: 'p-left', kind: 'video' });
    await socket.dispatch('sfu:new-producer', { socketId: 'peer-3', producerId: 'p-kept', kind: 'audio' });
    await socket.dispatch('sfu:new-producer', { socketId: 'peer-3', producerId: 'p-kept', kind: 'audio' });
    await socket.dispatch('sfu:producer-closed', { producerId: 'p-closed' });
    await socket.dispatch('sfu:peer-left', { socketId: 'peer-2' });
    expect(rtc._pendingConsumes).toEqual([{ producerId: 'p-kept', socketId: 'peer-3', kind: 'audio' }]);
    rtc.leaveVoice();
    expect(rtc._pendingConsumes).toEqual([]);
  });
});

describe('SFU remote media keeps one stream per producer kind', () => {
  async function consumingRTC() {
    setMediasoupPresent(true); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    const attach = vi.fn(); const tiles = vi.fn();
    const registry = (await import('../js/core/bridge-registry')).BridgeRegistry;
    vi.mocked(registry.get).mockImplementation(voicePanelOwners({ attachRemoteStream: attach, sfuHandleNewProducer: tiles }));
    const pending = new Map<string, ReturnType<typeof makeConsumer>>();
    const recv = makeTransport('recv-kinds');
    recv.consume.mockImplementation(async ({ producerId }: { producerId: string }) => pending.get(producerId));
    socket.emit.mockImplementation((event: string, payload: any) => {
      socket.emitted.push({ event, payload });
      if (event === 'sfu:consume') queueMicrotask(() => socket.dispatch('sfu:consumed', {
        producerId: payload.producerId, consumerId: `consumer-${payload.producerId}`,
        kind: pending.get(payload.producerId)!.track.kind, rtpParameters: {},
      }));
      return socket;
    });
    rtc.recvTransport = recv;
    rtc.device = { rtpCapabilities: { codecs: [] }, load: vi.fn() };
    rtc.currentChannelId = 'voice-kinds';
    const consume = async (producerId: string, kind: string, trackKind: 'audio' | 'video') => {
      const consumer = makeConsumer(producerId); consumer.track = makeTrack(trackKind);
      pending.set(producerId, consumer);
      expect(await rtc._consume(producerId, 'peer-k', kind)).toBe(consumer);
      return consumer;
    };
    const streamOf = (kind: string) => attach.mock.calls.filter(call => call[2] === kind).at(-1)![1] as MediaStream;
    return { rtc, socket, attach, tiles, consume, streamOf };
  }

  it('routes microphone, system audio, camera and screen to separate streams and names each for the UI', async () => {
    const { rtc, attach, tiles, consume, streamOf } = await consumingRTC();
    const mic = await consume('p-mic', 'audio', 'audio');
    const system = await consume('p-system', 'screen-audio', 'audio');
    const camera = await consume('p-camera', 'video', 'video');
    const screen = await consume('p-screen', 'screen', 'video');

    expect(streamOf('audio').getTracks()).toEqual([mic.track]);
    expect(streamOf('screen-audio').getTracks()).toEqual([system.track]);
    expect(streamOf('video').getTracks()).toEqual([camera.track]);
    expect(streamOf('screen').getTracks()).toEqual([screen.track]);
    expect(new Set(attach.mock.calls.map(call => call[1])).size).toBe(4);
    expect(tiles).toHaveBeenCalledWith('peer-k', undefined, streamOf('video'), 'video');
    expect(tiles).toHaveBeenCalledWith('peer-k', undefined, streamOf('screen'), 'screen');

    rtc.leaveVoice();
    for (const consumer of [mic, system, camera, screen]) expect(consumer.track.stop).toHaveBeenCalled();
    expect(rtc.peerStreams.size).toBe(0);
  });

  it('drops a closed producer\'s track from its stream, so a restarted share is the only track', async () => {
    const { socket, consume, streamOf } = await consumingRTC();
    const mic = await consume('p-mic', 'audio', 'audio');
    const first = await consume('p-screen-1', 'screen', 'video');
    const stream = streamOf('screen');

    await socket.dispatch('sfu:producer-closed', { producerId: 'p-screen-1' });
    expect(first.close).toHaveBeenCalledOnce();
    expect(stream.getTracks()).toEqual([]);
    expect(streamOf('audio').getTracks()).toEqual([mic.track]);

    const second = await consume('p-screen-2', 'screen', 'video');
    expect(streamOf('screen')).toBe(stream);
    expect(stream.getTracks()).toEqual([second.track]);
  });
});

describe('SFU transports use the ICE servers and relay policy issued at join', () => {
  it('passes TURN servers and iceTransportPolicy from sfu:joined to both mediasoup transports', async () => {
    setMediasoupPresent(true); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    const iceServers = [{ urls: ['stun:turn.example:3478'] }, { urls: ['turn:turn.example:3478'], username: '1:u', credential: 'c' }];
    await socket.dispatch('sfu:joined', { existingPeers: [], iceServers, iceTransportPolicy: 'relay' });

    const send = makeTransport('send-relay'); const recv = makeTransport('recv-relay');
    const createSendTransport = vi.fn(() => send); const createRecvTransport = vi.fn(() => recv);
    rtc.device = { rtpCapabilities: {}, load: vi.fn(), createSendTransport, createRecvTransport };
    rtc._sfuSocket = socket;
    socket.emit.mockImplementation((event: string, payload: any) => {
      socket.emitted.push({ event, payload });
      if (event === 'sfu:create-transport') queueMicrotask(() => socket.dispatch('sfu:transport-created', {
        direction: payload.direction, id: `${payload.direction}-id`, iceParameters: {}, iceCandidates: [], dtlsParameters: {},
      }));
      return socket;
    });

    await rtc._createSendTransport('voice-relay');
    await rtc._createRecvTransport('voice-relay');

    expect(createSendTransport).toHaveBeenCalledWith(expect.objectContaining({ iceServers, iceTransportPolicy: 'relay' }));
    expect(createRecvTransport).toHaveBeenCalledWith(expect.objectContaining({ iceServers, iceTransportPolicy: 'relay' }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Media session recovery (P2 media lab): ICE failure, owner/worker death and
// signaling loss used to leave a call on screen with no media, or drop the
// user from voice although the media path was intact.
// ════════════════════════════════════════════════════════════════════════════
describe('SFU media session recovery', () => {
  async function inCall(opts: { connected?: boolean } = {}) {
    setMediasoupPresent(true); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    socket.connected = opts.connected ?? true;
    const rtc = new BridgeRTC(socket as any) as any;
    rtc._sfuAvailable = true;
    rtc.currentChannelId = 'voice-recover';
    rtc.currentServerId = 'server-recover';
    rtc.localStream = makeStream([makeTrack('audio')]);
    const events: Array<{ type: string; detail: unknown }> = [];
    const listen = (type: string) => document.addEventListener(type, (e) => events.push({ type, detail: (e as CustomEvent).detail }));
    ['bridge:voice-reconnecting', 'bridge:voice-reconnected', 'bridge:voice-left'].forEach(listen);
    return { rtc, socket, events };
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  it('a failed transport re-establishes the session through a fresh join and keeps the user muted', async () => {
    const { rtc, events } = await inCall();
    const failed = makeTransport('send-failed');
    rtc.sendTransport = failed;
    rtc._watchTransport(failed, rtc._sessionGeneration);
    rtc.muted = true;
    const producer = makeProducer('audio-again');
    rtc._sfuJoin = vi.fn(async () => {
      rtc.sendTransport = makeTransport('send-new');
      rtc.producers.set('audio', producer);
    });

    failed.handlers.get('connectionstatechange')?.('failed');
    await rtc._recovery;

    expect(rtc._sfuJoin).toHaveBeenCalledWith('voice-recover', 'server-recover', expect.any(Number));
    expect(failed.close).toHaveBeenCalled();
    expect(producer.pause).toHaveBeenCalledOnce();
    expect(rtc.currentChannelId).toBe('voice-recover');
    expect(events.map(e => e.type)).toEqual(['bridge:voice-reconnecting', 'bridge:voice-reconnected']);
  });

  it('never retries a join the server refused: the call ends (no authorization bypass)', async () => {
    const { rtc, events } = await inCall();
    const refused = new Error('forbidden'); refused.name = 'SfuError:FORBIDDEN';
    rtc._sfuJoin = vi.fn(async () => { throw refused; });

    rtc._recoverSession('transport-failed');
    await rtc._recovery;

    expect(rtc._sfuJoin).toHaveBeenCalledOnce();
    expect(rtc.currentChannelId).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'bridge:voice-left', detail: { reason: 'media-session-lost' } });
  });

  it('keeps the call when only the app socket drops while the dedicated owner socket is alive', async () => {
    const { rtc, socket } = await inCall();
    const owner = makeInteractiveSocket(); owner.connected = true;
    rtc._dedicatedSfuSocket = owner;
    rtc._sfuJoin = vi.fn();

    await socket.dispatch('disconnect', 'transport close');

    expect(rtc.currentChannelId).toBe('voice-recover');
    expect(rtc._recovery).toBeNull();
    expect(rtc._sfuJoin).not.toHaveBeenCalled();
  });

  it('waits for the app socket to reconnect, then rejoins', async () => {
    const { rtc, socket } = await inCall();
    rtc._sfuJoin = vi.fn(async () => { rtc.sendTransport = makeTransport('send-back'); });

    socket.connected = false;
    await socket.dispatch('disconnect', 'ping timeout');
    await settle();
    expect(rtc._recovery).not.toBeNull();
    expect(rtc._sfuJoin).not.toHaveBeenCalled();
    expect(rtc.currentChannelId).toBe('voice-recover');

    socket.connected = true;
    await socket.dispatch('userAuthenticated');
    await rtc._recovery;
    expect(rtc._sfuJoin).toHaveBeenCalledOnce();
  });

  it('a server-initiated disconnect still ends the call without any rejoin', async () => {
    const { rtc, socket, events } = await inCall();
    rtc._sfuJoin = vi.fn();

    await socket.dispatch('disconnect', 'io server disconnect');

    expect(rtc._sfuJoin).not.toHaveBeenCalled();
    expect(rtc.currentChannelId).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'bridge:voice-left', detail: { reason: 'socket-disconnect' } });
  });

  it('an explicit leave during recovery stops it', async () => {
    const { rtc, socket } = await inCall();
    rtc._sfuJoin = vi.fn();
    socket.connected = false;
    await socket.dispatch('disconnect', 'transport close');
    rtc.leaveVoice();
    socket.connected = true;
    await socket.dispatch('userAuthenticated');
    await rtc._recovery;
    expect(rtc._sfuJoin).not.toHaveBeenCalled();
    expect(rtc.currentChannelId).toBeNull();
  });

  it('the dedicated owner socket dropping triggers recovery', async () => {
    const { rtc } = await inCall();
    const owner = makeInteractiveSocket(); owner.connected = true;
    rtc._dedicatedSfuSocket = owner;
    rtc._sfuSocket = owner;
    rtc._bindSocketEvents(owner);
    rtc._sfuJoin = vi.fn(async () => { rtc.sendTransport = makeTransport('send-owner'); });

    owner.connected = false;
    await owner.dispatch('disconnect', 'transport close');
    await rtc._recovery;

    expect(rtc._sfuJoin).toHaveBeenCalledOnce();
    expect(rtc.currentChannelId).toBe('voice-recover');
  });
});

describe('camera simulcast layers match what libwebrtc sends for the capture size', () => {
  it('uses the full-resolution top layer for a default 640x480 camera (2 layers)', async () => {
    const { cameraSimulcastEncodings } = await import('../js/webrtc-sfu');
    const vga = cameraSimulcastEncodings({ getSettings: () => ({ width: 640, height: 480 }) } as any);
    expect(vga).toEqual([{ maxBitrate: 200_000, scaleResolutionDownBy: 2 }, { maxBitrate: 900_000 }]);
  });
  it('keeps three layers from 960x540 up and a single layer for tiny captures', async () => {
    const { cameraSimulcastEncodings } = await import('../js/webrtc-sfu');
    expect(cameraSimulcastEncodings({ getSettings: () => ({ width: 1280, height: 720 }) } as any)).toHaveLength(3);
    expect(cameraSimulcastEncodings({ getSettings: () => ({ width: 320, height: 240 }) } as any)).toEqual([{ maxBitrate: 900_000 }]);
    expect(cameraSimulcastEncodings({ getSettings: () => ({}) } as any)).toHaveLength(2);
  });
});

describe('capture tracks survive producer/transport teardown', () => {
  it('every SFU producer is created with stopTracks: false (the app owns capture tracks)', async () => {
    setMediasoupPresent(true); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const rtc = new BridgeRTC(makeInteractiveSocket() as any) as any;
    const transport = makeTransport('send-own'); transport.produce.mockResolvedValue(makeProducer('p'));
    const video = { ...makeTrack('video'), getSettings: () => ({ width: 640, height: 480 }) };
    await rtc._produceCamera(transport, video);
    await rtc._produceScreen(transport, makeTrack('video'));
    await rtc._produceScreenAudio(transport, makeTrack('audio'));
    rtc.localStream = makeStream([makeTrack('audio')]);
    rtc.sendTransport = transport;
    await rtc._produceAudio(undefined, transport);
    expect(transport.produce).toHaveBeenCalledTimes(4);
    for (const [opts] of transport.produce.mock.calls) expect(opts).toEqual(expect.objectContaining({ stopTracks: false }));
  });
});

describe('SFU recovery over a dead signaling transport', () => {
  it('a recovery request that times out on a "connected" socket closes that transport so it reconnects now', async () => {
    setMediasoupPresent(true); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket() as any;
    // Socket.IO reports a deliberately closed engine as 'forced close'.
    const close = vi.fn(() => { socket.connected = false; void socket.dispatch('disconnect', 'forced close'); });
    socket.io = { engine: { close } };
    const rtc = new BridgeRTC(socket) as any;
    rtc._sfuAvailable = true;
    rtc.currentChannelId = 'voice-handoff';
    rtc.currentServerId = 'server-handoff';
    rtc.localStream = makeStream([makeTrack('audio')]);
    let calls = 0;
    rtc._sfuJoin = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('SFU RTP capability request timed out');
      rtc.sendTransport = makeTransport('send-handoff');
    });

    rtc._recoverSession('transport-failed');
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    socket.connected = true;
    await socket.dispatch('userAuthenticated');
    await rtc._recovery;

    expect(rtc._sfuJoin).toHaveBeenCalledTimes(2);
    expect(rtc.currentChannelId).toBe('voice-handoff');
  });

  it('an authorization refusal is not treated as a dead transport', async () => {
    setMediasoupPresent(true); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket() as any;
    const close = vi.fn();
    socket.io = { engine: { close } };
    const rtc = new BridgeRTC(socket) as any;
    rtc._sfuAvailable = true;
    rtc.currentChannelId = 'voice-refused';
    const refused = new Error('join timed out? no: forbidden'); refused.name = 'SfuError:FORBIDDEN';
    rtc._sfuJoin = vi.fn(async () => { throw refused; });
    rtc._recoverSession('transport-failed');
    await rtc._recovery;
    expect(close).not.toHaveBeenCalled();
    expect(rtc.currentChannelId).toBeNull();
  });
});

describe('server-side voice eviction reaches the SFU client', () => {
  it('voice:evicted for the current channel ends the call at once (no ghost call, no recovery)', async () => {
    setMediasoupPresent(true); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    rtc._sfuAvailable = true;
    rtc.currentChannelId = 'voice-evicted';
    rtc.localStream = makeStream([makeTrack('audio')]);
    const left: unknown[] = [];
    document.addEventListener('bridge:voice-left', (e) => left.push((e as CustomEvent).detail));
    rtc._sfuJoin = vi.fn();

    await socket.dispatch('voice:evicted', { channelId: 'other-channel' });
    expect(rtc.currentChannelId).toBe('voice-evicted');

    await socket.dispatch('voice:evicted', { channelId: 'voice-evicted' });
    expect(rtc.currentChannelId).toBeNull();
    expect(left).toContainEqual({ reason: 'evicted' });
    expect(rtc._recovery).toBeNull();
    expect(rtc._sfuJoin).not.toHaveBeenCalled();
  });
});

it('a forced close we did not request still ends the call (no silent auto-rejoin)', async () => {
  setMediasoupPresent(true); vi.resetModules();
  const { BridgeRTC } = await import('../js/webrtc-sfu');
  const socket = makeInteractiveSocket();
  const rtc = new BridgeRTC(socket as any) as any;
  rtc._sfuAvailable = true;
  rtc.currentChannelId = 'voice-forced';
  rtc.localStream = makeStream([makeTrack('audio')]);
  rtc._sfuJoin = vi.fn();
  await socket.dispatch('disconnect', 'forced close');
  expect(rtc.currentChannelId).toBeNull();
  expect(rtc._sfuJoin).not.toHaveBeenCalled();
});

describe('engine-originated state reaches the voice UI', () => {
  it('broadcasts the local state on every change so the panel mirrors it', async () => {
    const { rtc } = await makeRTC({ sfu: true });
    rtc.currentChannelId = 'voice-local';
    const seen: unknown[] = [];
    document.addEventListener('bridge:voice-local-state', (e) => seen.push((e as CustomEvent).detail));
    rtc.videoOn = false;
    (rtc as any)._broadcastState();
    expect(seen.at(-1)).toEqual({ muted: false, deafened: false, video: false, screensharing: false });
  });

  it('a microphone that ends underneath the call stops publishing, marks the user muted and says so', async () => {
    const { rtc, socket } = await makeRTC({ sfu: true });
    rtc.currentChannelId = 'voice-mic-lost';
    (rtc as any)._sfuSocket = socket;
    const producer = makeProducer('audio-lost');
    rtc.producers.set('audio', producer);
    uiToast.mockClear();
    const seen: Array<{ muted: boolean }> = [];
    document.addEventListener('bridge:voice-local-state', (e) => seen.push((e as CustomEvent).detail));

    (rtc as any)._onMicrophoneLost();

    expect(producer.close).toHaveBeenCalledOnce();
    expect(rtc.producers.has('audio')).toBe(false);
    expect(rtc.muted).toBe(true);
    expect(uiToast).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(seen.at(-1)?.muted).toBe(true);
    expect(socket.emitted.map(e => e.event)).toEqual(expect.arrayContaining(['sfu:close-producer', 'voice:state-update']));
  });
});

describe('recovery join names the session it replaces', () => {
  it('sends `replaces` with the socket that carried the lost session and records the new one', async () => {
    setMediasoupPresent(true); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    rtc.currentChannelId = 'voice-replace';
    rtc._sfuSessionSocketId = 'sock-before-handoff';
    rtc._waitForRtpCapabilities = vi.fn(async () => ({ rtpCapabilities: { codecs: [] } }));
    rtc._waitForSfuJoin = vi.fn(async () => ({ existingPeers: [] }));
    rtc._createSendTransport = vi.fn(async () => undefined);
    rtc._createRecvTransport = vi.fn(async () => undefined);

    await rtc._sfuJoin('voice-replace', 'server-a', rtc._sessionGeneration);

    const join = socket.emitted.find(e => e.event === 'sfu:join');
    expect(join?.payload).toEqual(expect.objectContaining({ replaces: 'sock-before-handoff' }));
    expect(rtc._sfuSessionSocketId).toBe('interactive');

    rtc.leaveVoice();
    expect(rtc._sfuSessionSocketId).toBeNull();
  });

  it('a first join sends no `replaces`', async () => {
    setMediasoupPresent(true); vi.resetModules();
    const { BridgeRTC } = await import('../js/webrtc-sfu');
    const socket = makeInteractiveSocket();
    const rtc = new BridgeRTC(socket as any) as any;
    rtc.currentChannelId = 'voice-first';
    rtc._waitForRtpCapabilities = vi.fn(async () => ({ rtpCapabilities: { codecs: [] } }));
    rtc._waitForSfuJoin = vi.fn(async () => ({ existingPeers: [] }));
    rtc._createSendTransport = vi.fn(async () => undefined);
    rtc._createRecvTransport = vi.fn(async () => undefined);
    await rtc._sfuJoin('voice-first', 'server-a', rtc._sessionGeneration);
    expect(socket.emitted.find(e => e.event === 'sfu:join')?.payload).not.toHaveProperty('replaces');
  });
});
