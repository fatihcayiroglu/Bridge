// client/tests/voice-messages.test.ts — Sprint 52
// voice-messages.ts için unit testler
// Kapsam: startVoiceRecord, stopVoiceRecord, sendVoiceMessage

'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../js/core/api-fetch', () => ({
  apiFetch: jest.fn(),
}), { virtual: true });

jest.mock('../js/core/globals', () => ({
  getAPI: jest.fn(() => 'http://localhost:3000'),
}), { virtual: true });

// ── MediaRecorder stub ────────────────────────────────────────────────────────

let mockRecorderInstance = null;

class MockMediaRecorder {
  constructor(stream, opts) {
    this.stream  = stream;
    this.opts    = opts;
    this.state   = 'inactive';
    this.ondataavailable = null;
    this.onstop  = null;
    mockRecorderInstance = this;
  }
  start()  { this.state = 'recording'; }
  stop()   {
    this.state = 'inactive';
    this.onstop?.();
  }
  // helper: trigger data
  _emitData(size = 500) {
    this.ondataavailable?.({ data: { size, type: 'audio/webm' } });
  }
}
global.MediaRecorder = MockMediaRecorder;

// ── getUserMedia stub ──────────────────────────────────────────────────────────

const mockStream = {
  getTracks: jest.fn(() => [{ stop: jest.fn() }]),
};

global.navigator.mediaDevices = {
  getUserMedia: jest.fn().mockResolvedValue(mockStream),
};

// ── Blob stub ─────────────────────────────────────────────────────────────────

const OrigBlob = global.Blob;

// ── Helpers ────────────────────────────────────────────────────────────────────

function setupCurrentChannel(id = 'ch1', serverId = 'srv1') {
  global.currentChannel = { _id: id, serverId };
  global.currentServer  = { _id: serverId };
}

function loadModule() {
  jest.resetModules();
  mockRecorderInstance = null;
  return require('../js/core/voice-messages');
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('startVoiceRecord()', () => {
  beforeEach(() => {
    navigator.mediaDevices.getUserMedia.mockResolvedValue(mockStream);
    global.toast.mockClear();
  });

  test('getUserMedia çağırır', async () => {
    const { startVoiceRecord } = loadModule();
    await startVoiceRecord();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  test('MediaRecorder başlatır', async () => {
    const { startVoiceRecord } = loadModule();
    await startVoiceRecord();
    expect(mockRecorderInstance).not.toBeNull();
    expect(mockRecorderInstance.state).toBe('recording');
  });

  test('kayıt başladığında toast gösterir', async () => {
    const { startVoiceRecord } = loadModule();
    await startVoiceRecord();
    expect(global.toast).toHaveBeenCalledWith(expect.stringContaining('Kayıt'), expect.anything());
  });

  test('ikinci çağrı yeni kayıt başlatmaz', async () => {
    const { startVoiceRecord } = loadModule();
    await startVoiceRecord();
    const first = mockRecorderInstance;
    await startVoiceRecord();
    expect(mockRecorderInstance).toBe(first);
  });

  test('getUserMedia reddedilince toast gösterir', async () => {
    navigator.mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('denied'));
    const { startVoiceRecord } = loadModule();
    await startVoiceRecord();
    expect(global.toast).toHaveBeenCalledWith(expect.stringContaining('reddedildi'), 'error');
  });

  test('btn-voice-msg elementi varsa renklendirir', async () => {
    document.body.innerHTML = '<button id="btn-voice-msg"></button>';
    const { startVoiceRecord } = loadModule();
    await startVoiceRecord();
    const btn = document.getElementById('btn-voice-msg');
    expect(btn.style.color).toBe('var(--red)');
  });
});

describe('stopVoiceRecord()', () => {
  test('aktif kayıt varsa durdurur', async () => {
    const { startVoiceRecord, stopVoiceRecord } = loadModule();
    await startVoiceRecord();
    stopVoiceRecord();
    expect(mockRecorderInstance.state).toBe('inactive');
  });

  test('kayıt yokken hata vermez', () => {
    const { stopVoiceRecord } = loadModule();
    expect(() => stopVoiceRecord()).not.toThrow();
  });

  test('btn-voice-msg stili temizlenir', async () => {
    document.body.innerHTML = '<button id="btn-voice-msg" style="color:var(--red)"></button>';
    const { startVoiceRecord, stopVoiceRecord } = loadModule();
    await startVoiceRecord();
    stopVoiceRecord();
    const btn = document.getElementById('btn-voice-msg');
    expect(btn.style.color).toBe('');
  });
});

describe('sendVoiceMessage()', () => {
  const { apiFetch } = require('../js/core/api-fetch');

  beforeEach(() => {
    setupCurrentChannel();
    apiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    global.toast.mockClear();
  });

  test('chunk yoksa gönderme yapmaz', async () => {
    const { sendVoiceMessage } = loadModule();
    await sendVoiceMessage();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  test('çok küçük blob ise hata toast gösterir', async () => {
    // Blob.size'ı küçük yap
    const origBlob = global.Blob;
    global.Blob = class { constructor() { this.size = 10; this.type = 'audio/webm'; } };
    const { startVoiceRecord, stopVoiceRecord } = loadModule();
    await startVoiceRecord();
    mockRecorderInstance._emitData(10);
    stopVoiceRecord();
    expect(global.toast).toHaveBeenCalledWith(expect.stringContaining('kısa'), 'error');
    global.Blob = origBlob;
  });

  test('başarılı gönderimde success toast gösterir', async () => {
    const origBlob = global.Blob;
    global.Blob = class { constructor() { this.size = 5000; this.type = 'audio/webm'; } };
    const { startVoiceRecord, stopVoiceRecord } = loadModule();
    await startVoiceRecord();
    mockRecorderInstance._emitData(5000);
    stopVoiceRecord(); // onstop → sendVoiceMessage
    // wait for async
    await new Promise(r => setTimeout(r, 0));
    expect(global.toast).toHaveBeenCalledWith(expect.stringContaining('gönderildi'), 'success');
    global.Blob = origBlob;
  });

  test('API hatası durumunda error toast gösterir', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Sunucu hatası' }),
    });
    const origBlob = global.Blob;
    global.Blob = class { constructor() { this.size = 5000; this.type = 'audio/webm'; } };
    const { startVoiceRecord, stopVoiceRecord } = loadModule();
    await startVoiceRecord();
    mockRecorderInstance._emitData(5000);
    stopVoiceRecord();
    await new Promise(r => setTimeout(r, 0));
    expect(global.toast).toHaveBeenCalledWith(expect.stringContaining('gönderilemedi'), 'error');
    global.Blob = origBlob;
  });

  test('kanal yoksa gönderme yapmaz', async () => {
    global.currentChannel = null;
    const origBlob = global.Blob;
    global.Blob = class { constructor() { this.size = 5000; this.type = 'audio/webm'; } };
    const { startVoiceRecord, stopVoiceRecord } = loadModule();
    await startVoiceRecord();
    mockRecorderInstance._emitData(5000);
    stopVoiceRecord();
    await new Promise(r => setTimeout(r, 0));
    expect(apiFetch).not.toHaveBeenCalled();
    global.Blob = origBlob;
  });
});
