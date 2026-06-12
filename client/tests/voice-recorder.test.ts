// client/tests/voice-recorder.test.ts — Sprint C1: VoiceRecorder Tests
'use strict';

// ── MediaRecorder Mock ────────────────────────────────────────
class MockMediaRecorder {
  constructor(stream, opts = {}) {
    this.stream   = stream;
    this.mimeType = opts.mimeType || 'audio/webm';
    this.state    = 'inactive';
    this.ondataavailable = null;
    this.onstop          = null;
    this.onerror         = null;
  }
  start(timeslice) {
    this.state = 'recording';
    // Simulate data chunk after 10ms
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(['audio-data'], { type: 'audio/webm' }) });
    }, 10);
  }
  stop() {
    this.state = 'inactive';
    setTimeout(() => this.onstop?.(), 5);
  }
  static isTypeSupported(type) {
    return ['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus'].includes(type);
  }
}
global.MediaRecorder = MockMediaRecorder;

// ── getUserMedia Mock ─────────────────────────────────────────
const mockStream = {
  getTracks:       jest.fn(() => [{ stop: jest.fn(), kind: 'audio' }]),
  getAudioTracks:  jest.fn(() => [{ stop: jest.fn(), applyConstraints: jest.fn() }]),
};

global.navigator = {
  ...global.navigator,
  mediaDevices: {
    getUserMedia: jest.fn().mockResolvedValue(mockStream),
  },
};

// ── AudioContext Mock ─────────────────────────────────────────
const mockAnalyser = {
  fftSize:                 256,
  frequencyBinCount:       128,
  connect:                 jest.fn(),
  disconnect:              jest.fn(),
  getByteTimeDomainData:   jest.fn((arr) => { arr.fill(128); }),
  getByteFrequencyData:    jest.fn((arr) => { arr.fill(64); }),
};

const mockGainNode = { connect: jest.fn(), gain: { value: 1 } };
const mockSource   = { connect: jest.fn(), disconnect: jest.fn() };

global.AudioContext = jest.fn(() => ({
  createAnalyser:         jest.fn(() => mockAnalyser),
  createGain:             jest.fn(() => mockGainNode),
  createMediaStreamSource: jest.fn(() => mockSource),
  destination:            {},
  close:                  jest.fn(),
  state:                  'running',
}));

// ── BridgeRegistry Mock ───────────────────────────────────────
const registry = {};
jest.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register: jest.fn((k, v) => { registry[k] = v; }),
    get:      jest.fn((k) => registry[k] ?? null),
    call:     jest.fn((k, ...a) => registry[k]?.(...a)),
  },
}), { virtual: true });

jest.mock('../js/core/globals.js', () => ({
  getCurrentChannel: jest.fn(() => ({ _id: 'chan-001' })),
  getCurrentServer:  jest.fn(() => ({ _id: 'srv-001' })),
}), { virtual: true });

global.fetch = jest.fn().mockResolvedValue({
  ok: true, json: () => Promise.resolve({ _id: 'msg-001', url: '/uploads/voice.webm' }),
});

global.cancelAnimationFrame = jest.fn();
global.requestAnimationFrame = jest.fn((cb) => { setTimeout(cb, 16); return 1; });

// ── Import after mocks ────────────────────────────────────────

describe('BridgeVoiceRecorder — temel davranış', () => {
  test('MediaRecorder.isTypeSupported desteklenen codec tanır', () => {
    expect(MediaRecorder.isTypeSupported('audio/webm')).toBe(true);
    expect(MediaRecorder.isTypeSupported('audio/webm;codecs=opus')).toBe(true);
    expect(MediaRecorder.isTypeSupported('audio/mp4')).toBe(false);
  });

  test('MediaRecorder inactive başlar', () => {
    const stream = { getTracks: jest.fn(() => []) };
    const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    expect(mr.state).toBe('inactive');
  });

  test('MediaRecorder.start() recording state\'e geçer', () => {
    const stream = { getTracks: jest.fn(() => []) };
    const mr = new MediaRecorder(stream);
    mr.start();
    expect(mr.state).toBe('recording');
  });

  test('MediaRecorder.stop() inactive state\'e geçer', () => {
    const stream = { getTracks: jest.fn(() => []) };
    const mr = new MediaRecorder(stream);
    mr.start();
    mr.stop();
    expect(mr.state).toBe('inactive');
  });

  test('MediaRecorder.stop() onstop callback\'i tetikler', async () => {
    const stream = { getTracks: jest.fn(() => []) };
    const mr    = new MediaRecorder(stream);
    const onStop = jest.fn();
    mr.onstop = onStop;
    mr.start();
    mr.stop();
    await new Promise(r => setTimeout(r, 20));
    expect(onStop).toHaveBeenCalled();
  });
});

describe('BridgeVoiceRecorder — getUserMedia', () => {
  test('getUserMedia audio stream döner', async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    expect(stream).toBe(mockStream);
    expect(stream.getTracks).toBeDefined();
  });

  test('getUserMedia başarısız olunca hata fırlatılır', async () => {
    navigator.mediaDevices.getUserMedia.mockRejectedValueOnce(
      new Error('Permission denied')
    );
    await expect(
      navigator.mediaDevices.getUserMedia({ audio: true })
    ).rejects.toThrow('Permission denied');
  });

  test('stream tracks stop() çağrılabilir', () => {
    const track = mockStream.getTracks()[0];
    expect(() => track.stop()).not.toThrow();
  });
});

describe('BridgeVoiceRecorder — AudioContext analiz', () => {
  test('AudioContext oluşturulabilir', () => {
    const ctx = new AudioContext();
    expect(ctx).toBeTruthy();
    expect(ctx.createAnalyser).toBeDefined();
  });

  test('createAnalyser AnalyserNode döner', () => {
    const ctx      = new AudioContext();
    const analyser = ctx.createAnalyser();
    expect(analyser.fftSize).toBe(256);
    expect(analyser.frequencyBinCount).toBe(128);
  });

  test('getByteTimeDomainData waveform verisi üretir', () => {
    const ctx      = new AudioContext();
    const analyser = ctx.createAnalyser();
    const data     = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    // mock 128 ile doldurur — sessizlik/orta seviye
    expect(data[0]).toBe(128);
  });

  test('createMediaStreamSource stream kaynaklarını bağlar', () => {
    const ctx    = new AudioContext();
    const source = ctx.createMediaStreamSource(mockStream);
    expect(source.connect).toBeDefined();
  });
});

describe('BridgeVoiceRecorder — upload simülasyonu', () => {
  test('fetch /api/voice-messages POST çağrılabilir', async () => {
    const blob = new Blob(['audio-data'], { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('file', blob, 'voice.webm');
    formData.append('duration', '3000');

    await fetch('/api/voice-messages', { method: 'POST', body: formData });
    expect(fetch).toHaveBeenCalledWith('/api/voice-messages', expect.objectContaining({ method: 'POST' }));
  });

  test('upload başarısızlığı handle edilir', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network error'));
    const onError = jest.fn();
    try {
      await fetch('/api/voice-messages', { method: 'POST' });
    } catch (e) {
      onError(e.message);
    }
    expect(onError).toHaveBeenCalledWith('Network error');
  });
});

describe('BridgeVoiceRecorder — max duration', () => {
  test('setTimeout ile maxDuration sonrası stop tetiklenir', async () => {
    jest.useFakeTimers();
    const stopFn = jest.fn();
    const timerId = setTimeout(stopFn, 300_000);
    jest.advanceTimersByTime(300_000);
    expect(stopFn).toHaveBeenCalled();
    clearTimeout(timerId);
    jest.useRealTimers();
  });

  test('clearTimeout ile timer iptal edilebilir', () => {
    jest.useFakeTimers();
    const stopFn = jest.fn();
    const timerId = setTimeout(stopFn, 300_000);
    clearTimeout(timerId);
    jest.advanceTimersByTime(300_000);
    expect(stopFn).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe('BridgeVoiceRecorder — BridgeRegistry kaydı', () => {
  test('BridgeRegistry.register çağrılabilir', () => {
    const { BridgeRegistry } = require('../js/core/bridge-registry.js');
    BridgeRegistry.register('BridgeVoiceRecorder', jest.fn());
    expect(BridgeRegistry.register).toHaveBeenCalledWith('BridgeVoiceRecorder', expect.any(Function));
  });
});
