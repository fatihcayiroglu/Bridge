// client/tests/music-player.test.ts — Sprint 52
// music-player.ts için unit testler
// Kapsam: showMusicPlayer, hideMusicPlayer, toggleMusicPause, setMusicVolume,
//         initMusicPlayer (socket event wiring), musicSkip, musicStop

'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockSocket = {
  on: jest.fn(),
  emit: jest.fn(),
};

jest.mock('../js/core/globals', () => ({
  getCurrentChannel: jest.fn(() => null),
  getCurrentServer:  jest.fn(() => null),
  getSocket:         jest.fn(() => mockSocket),
  getAPI:            jest.fn(() => 'http://localhost:3000'),
}), { virtual: true });

jest.mock('../js/core/utils', () => ({
  escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}), { virtual: true });

// ── Audio stub ─────────────────────────────────────────────────────────────────

function makeMockAudio() {
  const audio = {
    paused: false,
    volume: 0.5,
    crossOrigin: null,
    _events: {},
    play:  jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(function () { this.paused = true; }),
    addEventListener: jest.fn(function (ev, fn) { this._events[ev] = fn; }),
    _trigger: function (ev) { this._events[ev]?.(); },
  };
  return audio;
}

let mockAudioInstance = null;
global.Audio = jest.fn(function (src) {
  mockAudioInstance = makeMockAudio();
  mockAudioInstance.src = src;
  return mockAudioInstance;
});

// ── Helpers ────────────────────────────────────────────────────────────────────

import globals from '../js/core/globals';

function buildDOM() {
  document.body.innerHTML = `
    <div id="text-view"></div>
    <button id="music-playpause">⏸️</button>
  `;
}

function loadModule() {
  jest.resetModules();
  mockAudioInstance = null;
  return require('../js/core/music-player');
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('showMusicPlayer()', () => {
  beforeEach(() => {
    buildDOM();
    mockSocket.emit.mockClear();
  });

  test('müzik bar oluşturur ve text-view\'e ekler', () => {
    const { showMusicPlayer } = loadModule();
    showMusicPlayer({ streamUrl: 'http://test/audio.mp3', title: 'Test Şarkı' }, 'ch1');
    expect(document.getElementById('music-bar')).not.toBeNull();
    expect(document.getElementById('text-view').contains(document.getElementById('music-bar'))).toBe(true);
  });

  test('başlığı escHtml ile güvenli render eder', () => {
    const { showMusicPlayer } = loadModule();
    showMusicPlayer({ streamUrl: 'url', title: '<script>alert(1)</script>' }, 'ch1');
    const bar = document.getElementById('music-bar');
    expect(bar.innerHTML).not.toContain('<script>');
    expect(bar.innerHTML).toContain('&lt;script&gt;');
  });

  test('requestedBy bilgisini gösterir', () => {
    const { showMusicPlayer } = loadModule();
    showMusicPlayer({ streamUrl: 'url', title: 'Track', requestedBy: 'ahmet' }, 'ch1');
    expect(document.getElementById('music-bar').innerHTML).toContain('ahmet');
  });

  test('thumbnail yoksa emoji gösterir', () => {
    const { showMusicPlayer } = loadModule();
    showMusicPlayer({ streamUrl: 'url', title: 'Track' }, 'ch1');
    expect(document.getElementById('music-bar').innerHTML).toContain('🎵');
  });

  test('thumbnail varsa img etiketi ekler', () => {
    const { showMusicPlayer } = loadModule();
    showMusicPlayer({ streamUrl: 'url', title: 'Track', thumbnail: 'http://img/t.jpg' }, 'ch1');
    expect(document.getElementById('music-bar').innerHTML).toContain('<img');
  });

  test('Audio nesnesi oluşturur ve play() çağırır', () => {
    const { showMusicPlayer } = loadModule();
    showMusicPlayer({ streamUrl: 'http://audio.mp3', title: 'T' }, 'ch1');
    expect(global.Audio).toHaveBeenCalledWith('http://audio.mp3');
    expect(mockAudioInstance.play).toHaveBeenCalled();
  });

  test('ikinci çağrıda önceki audio\'yu durdurur', () => {
    const { showMusicPlayer } = loadModule();
    showMusicPlayer({ streamUrl: 'http://a1.mp3', title: 'T1' }, 'ch1');
    const firstAudio = mockAudioInstance;
    showMusicPlayer({ streamUrl: 'http://a2.mp3', title: 'T2' }, 'ch1');
    expect(firstAudio.pause).toHaveBeenCalled();
  });

  test('music-skip-btn tıklandığında socket.emit çağırır', () => {
    const { showMusicPlayer } = loadModule();
    showMusicPlayer({ streamUrl: 'url', title: 'T' }, 'ch1');
    document.getElementById('music-skip-btn')?.click();
    expect(mockSocket.emit).toHaveBeenCalledWith('music:ended', { channelId: 'ch1' });
  });
});

describe('hideMusicPlayer()', () => {
  beforeEach(() => buildDOM());

  test('mevcut audio\'yu durdurur ve bar\'ı kaldırır', () => {
    const { showMusicPlayer, hideMusicPlayer } = loadModule();
    showMusicPlayer({ streamUrl: 'url', title: 'T' }, 'ch1');
    const audio = mockAudioInstance;
    hideMusicPlayer();
    expect(audio.pause).toHaveBeenCalled();
    expect(document.getElementById('music-bar')).toBeNull();
  });

  test('bar yoksa hata fırlatmaz', () => {
    const { hideMusicPlayer } = loadModule();
    expect(() => hideMusicPlayer()).not.toThrow();
  });
});

describe('toggleMusicPause()', () => {
  beforeEach(() => buildDOM());

  test('çalıyorsa duraklatır ve düğmeyi günceller', () => {
    const { showMusicPlayer, toggleMusicPause } = loadModule();
    showMusicPlayer({ streamUrl: 'url', title: 'T' }, 'ch1');
    mockAudioInstance.paused = false;
    toggleMusicPause();
    expect(mockAudioInstance.pause).toHaveBeenCalled();
  });

  test('duraklatılmışsa çalar', () => {
    const { showMusicPlayer, toggleMusicPause } = loadModule();
    showMusicPlayer({ streamUrl: 'url', title: 'T' }, 'ch1');
    mockAudioInstance.paused = true;
    toggleMusicPause();
    expect(mockAudioInstance.play).toHaveBeenCalledTimes(2); // initial + toggle
  });

  test('audio yokken hata vermez', () => {
    const { toggleMusicPause } = loadModule();
    expect(() => toggleMusicPause()).not.toThrow();
  });
});

describe('setMusicVolume()', () => {
  beforeEach(() => buildDOM());

  test('sayısal string ile sesi ayarlar', () => {
    const { showMusicPlayer, setMusicVolume } = loadModule();
    showMusicPlayer({ streamUrl: 'url', title: 'T' }, 'ch1');
    setMusicVolume('0.8');
    expect(mockAudioInstance.volume).toBeCloseTo(0.8);
  });

  test('sayı ile de çalışır', () => {
    const { showMusicPlayer, setMusicVolume } = loadModule();
    showMusicPlayer({ streamUrl: 'url', title: 'T' }, 'ch1');
    setMusicVolume(0.3);
    expect(mockAudioInstance.volume).toBeCloseTo(0.3);
  });

  test('audio yokken hata vermez', () => {
    const { setMusicVolume } = loadModule();
    expect(() => setMusicVolume(0.5)).not.toThrow();
  });
});

describe('initMusicPlayer()', () => {
  beforeEach(() => {
    buildDOM();
    mockSocket.on.mockClear();
  });

  test('socket yokken hata vermez', () => {
    globals.getSocket.mockReturnValueOnce(null);
    const { initMusicPlayer } = loadModule();
    expect(() => initMusicPlayer()).not.toThrow();
  });

  test('music:play ve music:stop event\'lerini dinler', () => {
    const { initMusicPlayer } = loadModule();
    initMusicPlayer();
    const events = mockSocket.on.mock.calls.map(c => c[0]);
    expect(events).toContain('music:play');
    expect(events).toContain('music:stop');
  });

  test('music:play — yanlış kanal ise oynatmaz', () => {
    globals.getCurrentChannel.mockReturnValue({ _id: 'ch-other' });
    const { initMusicPlayer } = loadModule();
    initMusicPlayer();
    const playHandler = mockSocket.on.mock.calls.find(c => c[0] === 'music:play')?.[1];
    playHandler?.({ channelId: 'ch-diff', track: { streamUrl: 'u', title: 'T' } });
    expect(document.getElementById('music-bar')).toBeNull();
  });

  test('music:play — doğru kanal ise oynatır', () => {
    globals.getCurrentChannel.mockReturnValue({ _id: 'ch1' });
    const { initMusicPlayer } = loadModule();
    initMusicPlayer();
    const playHandler = mockSocket.on.mock.calls.find(c => c[0] === 'music:play')?.[1];
    playHandler?.({ channelId: 'ch1', track: { streamUrl: 'http://a.mp3', title: 'T' } });
    expect(document.getElementById('music-bar')).not.toBeNull();
  });

  test('music:stop — doğru kanal ise gizler', () => {
    globals.getCurrentChannel.mockReturnValue({ _id: 'ch1' });
    const { showMusicPlayer, initMusicPlayer } = loadModule();
    showMusicPlayer({ streamUrl: 'u', title: 'T' }, 'ch1');
    initMusicPlayer();
    const stopHandler = mockSocket.on.mock.calls.find(c => c[0] === 'music:stop')?.[1];
    stopHandler?.({ channelId: 'ch1' });
    expect(document.getElementById('music-bar')).toBeNull();
  });
});

describe('musicSkip() / musicStop()', () => {
  beforeEach(() => {
    buildDOM();
    mockSocket.emit.mockClear();
    globals.getCurrentChannel.mockReturnValue({ _id: 'ch1' });
    globals.getCurrentServer.mockReturnValue({ _id: 'srv1' });
  });

  test('musicSkip — music:ended emit eder', () => {
    const { musicSkip } = loadModule();
    musicSkip();
    expect(mockSocket.emit).toHaveBeenCalledWith('music:ended', { channelId: 'ch1' });
  });

  test('musicSkip — kanal yokken emit etmez', () => {
    globals.getCurrentChannel.mockReturnValueOnce(null);
    const { musicSkip } = loadModule();
    musicSkip();
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  test('musicStop — !stop komutu gönderir', () => {
    const { musicStop } = loadModule();
    musicStop();
    expect(mockSocket.emit).toHaveBeenCalledWith('message:send', expect.objectContaining({ content: '!stop' }));
  });

  test('musicStop — kanal veya server yokken emit etmez', () => {
    globals.getCurrentChannel.mockReturnValueOnce(null);
    const { musicStop } = loadModule();
    musicStop();
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });
});
