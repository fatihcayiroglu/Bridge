// client/tests/webrtc-sfu.test.ts — Sprint 77
// webrtc-sfu.ts / BridgeRTC sınıfı için unit testler.
// Kapsam: state management (mute/deafen/video flags), leaveVoice cleanup,
//         loadSavedDevices, isInVoice, setMuted track enabled toggle,
//         _sfuCleanup resource release, setChannelBitrate.
//
// NOT: _sfuJoin / _createSendTransport akışları gerçek RTCPeerConnection +
//      mediasoup-client gerektirdiğinden burada mock socket event round-trip
//      ile test edilir; tam entegrasyon testi mediasoup-handlers.test.ts (server) kapsar.

'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../js/core/logger', () => ({
  createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }),
}), { virtual: true });

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: {
    register: jest.fn(),
    get:      jest.fn(() => null),
    call:     jest.fn(),
    has:      jest.fn(() => false),
  },
}), { virtual: true });

jest.mock('../js/core/globals', () => ({
  getAPI:                   jest.fn(() => 'http://localhost:3000'),
  currentServerChannels:    jest.fn(() => []),
  setCurrentServerChannels: jest.fn(),
}), { virtual: true });

// mediasoup-client mock — BridgeRTC constructor'da `typeof mediasoupClient !== 'undefined'` kontrol eder
const mockProducer = {
  id:     'mock-producer-id',
  close:  jest.fn(),
  pause:  jest.fn(),
  resume: jest.fn(),
  on:     jest.fn(),
};
const mockConsumer = {
  id:     'mock-consumer-id',
  track:  { kind: 'audio' },
  close:  jest.fn(),
  resume: jest.fn(),
};
const mockSendTransport = {
  id:      'send-transport-id',
  produce: jest.fn(async () => mockProducer),
  close:   jest.fn(),
  on:      jest.fn(),
};
const mockRecvTransport = {
  id:      'recv-transport-id',
  consume: jest.fn(async () => mockConsumer),
  close:   jest.fn(),
  on:      jest.fn(),
};
const mockDevice = {
  rtpCapabilities:    { codecs: [] },
  load:               jest.fn(),
  createSendTransport: jest.fn(() => mockSendTransport),
  createRecvTransport: jest.fn(() => mockRecvTransport),
};

// mediasoupClient global stub
(global as Record<string, unknown>).mediasoupClient = {
  Device: jest.fn(() => mockDevice),
};

// ── Socket stub ────────────────────────────────────────────────────────────────

function makeSocket() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const onceHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    emit: jest.fn(),
    on:   jest.fn((event: string, fn: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(fn);
    }),
    once: jest.fn((event: string, fn: (...args: unknown[]) => void) => {
      if (!onceHandlers[event]) onceHandlers[event] = [];
      onceHandlers[event].push(fn);
    }),
    off:  jest.fn(),
    _trigger(event: string, ...args: unknown[]) {
      handlers[event]?.forEach(fn => fn(...args));
      const once = onceHandlers[event];
      if (once?.length) {
        const fn = once.shift()!;
        fn(...args);
      }
    },
  };
}

// ── MediaStream / MediaTrack stubs ────────────────────────────────────────────

function makeAudioTrack(enabled = true) {
  return {
    kind:    'audio',
    enabled,
    stop:    jest.fn(),
    clone:   jest.fn(),
  };
}

function makeMediaStream(tracks: ReturnType<typeof makeAudioTrack>[] = []) {
  return {
    getAudioTracks: jest.fn(() => tracks),
    getVideoTracks: jest.fn(() => []),
    addTrack:       jest.fn(),
    getTracks:      jest.fn(() => tracks),
  };
}

// ── Module loader ──────────────────────────────────────────────────────────────

function loadModule() {
  jest.resetModules();
  return require('../js/webrtc-sfu');
}

// ── BridgeRTC instance helper ─────────────────────────────────────────────────

function makeBridgeRTC(socket = makeSocket()) {
  const { BridgeRTC } = loadModule();
  return { rtc: new BridgeRTC(socket), socket };
}

// ── isInVoice() ───────────────────────────────────────────────────────────────

describe('isInVoice()', () => {
  test('başlangıçta false döner', () => {
    const { rtc } = makeBridgeRTC();
    expect(rtc.isInVoice()).toBe(false);
  });

  test('currentChannelId set edilince true döner', () => {
    const { rtc } = makeBridgeRTC();
    rtc.currentChannelId = 'ch-1';
    expect(rtc.isInVoice()).toBe(true);
  });
});

// ── loadSavedDevices() ────────────────────────────────────────────────────────

describe('loadSavedDevices()', () => {
  test('localStorage değerleri property olarak yüklenir', () => {
    localStorage.setItem('bridge-mic', 'mic-device-id');
    localStorage.setItem('bridge-camera', 'cam-device-id');
    localStorage.setItem('bridge-speaker', 'spk-device-id');
    const { rtc } = makeBridgeRTC();
    rtc.loadSavedDevices();
    expect(rtc.selectedMicId).toBe('mic-device-id');
    expect(rtc.selectedCameraId).toBe('cam-device-id');
    expect(rtc.selectedSpeakerId).toBe('spk-device-id');
    localStorage.clear();
  });

  test('localStorage boşken null döner', () => {
    localStorage.clear();
    const { rtc } = makeBridgeRTC();
    rtc.loadSavedDevices();
    expect(rtc.selectedMicId).toBeNull();
  });
});

// ── setMuted() ────────────────────────────────────────────────────────────────

describe('setMuted()', () => {
  test('muted flag güncellenir', () => {
    const { rtc } = makeBridgeRTC();
    rtc.setMuted(true);
    expect(rtc.muted).toBe(true);
    rtc.setMuted(false);
    expect(rtc.muted).toBe(false);
  });

  test('localStream audio track enabled toggle edilir', () => {
    const { rtc, socket } = makeBridgeRTC();
    const track = makeAudioTrack(true);
    rtc.localStream = makeMediaStream([track]) as never;
    rtc.currentChannelId = 'ch-1'; // broadcastState için

    rtc.setMuted(true);
    expect(track.enabled).toBe(false);

    rtc.setMuted(false);
    expect(track.enabled).toBe(true);
  });

  test('audio producer mute/unmute edilir', () => {
    const { rtc } = makeBridgeRTC();
    rtc.producers.set('audio', mockProducer as never);

    rtc.setMuted(true);
    expect(mockProducer.pause).toHaveBeenCalled();

    rtc.setMuted(false);
    expect(mockProducer.resume).toHaveBeenCalled();
  });
});

// ── setDeafened() ─────────────────────────────────────────────────────────────

describe('setDeafened()', () => {
  test('deafened flag güncellenir', () => {
    const { rtc } = makeBridgeRTC();
    rtc.setDeafened(true);
    expect(rtc.deafened).toBe(true);
  });

  test('deafened true olunca muted da true olur', () => {
    const { rtc } = makeBridgeRTC();
    rtc.setDeafened(true);
    expect(rtc.muted).toBe(true);
  });

  test('deafened false olunca muted etkilenmez (önceki değer korunur)', () => {
    const { rtc } = makeBridgeRTC();
    rtc.muted = false;
    rtc.setDeafened(false);
    expect(rtc.muted).toBe(false);
  });

  test('remote-audio elementleri muted property ile güncellenir', () => {
    document.body.innerHTML = `
      <audio class="remote-audio"></audio>
      <audio class="remote-audio"></audio>
    `;
    const { rtc } = makeBridgeRTC();
    rtc.setDeafened(true);
    document.querySelectorAll<HTMLMediaElement>('.remote-audio').forEach(el => {
      expect(el.muted).toBe(true);
    });
    document.body.innerHTML = '';
  });
});

// ── leaveVoice() ──────────────────────────────────────────────────────────────

describe('leaveVoice()', () => {
  test('currentChannelId olmadan çağrılınca hata fırlatmaz', () => {
    const { rtc } = makeBridgeRTC();
    expect(() => rtc.leaveVoice()).not.toThrow();
  });

  test('sfu:leave emit edilir', () => {
    const { rtc, socket } = makeBridgeRTC();
    rtc.currentChannelId = 'ch-1';
    rtc.currentServerId  = 'srv-1';
    rtc['_sfuAvailable'] = true;

    rtc.leaveVoice();
    expect(socket.emit).toHaveBeenCalledWith('sfu:leave', {
      channelId: 'ch-1', serverId: 'srv-1',
    });
  });

  test('leaveVoice sonrası currentChannelId null olur', () => {
    const { rtc } = makeBridgeRTC();
    rtc.currentChannelId = 'ch-1';
    rtc['_sfuAvailable'] = false; // P2P path: daha basit
    rtc.leaveVoice();
    expect(rtc.currentChannelId).toBeNull();
  });

  test('localStream track\'leri durdurulur', () => {
    const { rtc } = makeBridgeRTC();
    const track = makeAudioTrack();
    rtc.localStream      = makeMediaStream([track]) as never;
    rtc.currentChannelId = 'ch-1';
    rtc['_sfuAvailable'] = false;

    rtc.leaveVoice();
    expect(track.stop).toHaveBeenCalled();
    expect(rtc.localStream).toBeNull();
  });
});

// ── _sfuCleanup() — resource release ─────────────────────────────────────────

describe('_sfuCleanup() resource release', () => {
  test('tüm consumer ve producer\'lar kapatılır', () => {
    const { rtc } = makeBridgeRTC();

    const producer2 = { ...mockProducer, id: 'p2', close: jest.fn(), pause: jest.fn(), resume: jest.fn(), on: jest.fn() };
    const consumer2 = { ...mockConsumer, id: 'c2', close: jest.fn(), resume: jest.fn() };

    rtc.producers.set('audio', mockProducer as never);
    rtc.producers.set('video', producer2 as never);
    rtc.consumers.set('prod-1', mockConsumer as never);
    rtc.consumers.set('prod-2', consumer2 as never);

    rtc.sendTransport = mockSendTransport as never;
    rtc.recvTransport = mockRecvTransport as never;

    // _sfuCleanup private — leaveVoice içinden tetikle
    rtc.currentChannelId = 'ch-1';
    rtc['_sfuAvailable'] = true;
    rtc.leaveVoice();

    expect(mockProducer.close).toHaveBeenCalled();
    expect(producer2.close).toHaveBeenCalled();
    expect(mockConsumer.close).toHaveBeenCalled();
    expect(consumer2.close).toHaveBeenCalled();
    expect(mockSendTransport.close).toHaveBeenCalled();
    expect(mockRecvTransport.close).toHaveBeenCalled();

    expect(rtc.producers.size).toBe(0);
    expect(rtc.consumers.size).toBe(0);
    expect(rtc.sendTransport).toBeNull();
    expect(rtc.recvTransport).toBeNull();
    expect(rtc.device).toBeNull();
  });
});

// ── setChannelBitrate ─────────────────────────────────────────────────────────

describe('setChannelBitrate()', () => {
  test('channelBitrate güncellenir', () => {
    const { rtc } = makeBridgeRTC();
    rtc.channelBitrate = 128_000;
    expect(rtc.channelBitrate).toBe(128_000);
  });
});

// ── P2P fallback ──────────────────────────────────────────────────────────────

describe('P2P fallback — sfuAvailable false', () => {
  test('leaveVoice P2P path: voice:leave emit edilir', () => {
    const { rtc, socket } = makeBridgeRTC();
    rtc.currentChannelId  = 'ch-1';
    rtc.currentServerId   = 'srv-1';
    rtc['_sfuAvailable']  = false;

    rtc.leaveVoice();
    expect(socket.emit).toHaveBeenCalledWith('voice:leave', {
      channelId: 'ch-1', serverId: 'srv-1',
    });
  });
});
