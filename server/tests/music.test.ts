// server/tests/music.test.ts
// music.js socket handler ve handleMusicCommand entegrasyon testleri
// Test kapsamı:
//   - handleMusicCommand: !play, !skip, !stop, !queue, !help
//   - !play: queue'ya ekleme, "now playing", queue dolu (max 25), geçersiz URL
//   - !skip: sıradaki parçaya geçiş, kuyruk boşsa durdur
//   - !stop: kuyruğu temizle ve durdur
//   - !queue: mevcut parçayı ve sırayı listele
//   - registerMusicHandlers: music:ended → sıradaki parça veya durdur
//   - formatDuration, isValidMusicUrl yardımcıları
//   - Bilinen komut değilse false döner

'use strict';
process.env.NODE_ENV = 'test';

// yt-dlp gerektiren dış bağımlılıkları stub'la
jest.mock('../music', () => {
  const { voiceQueues } = jest.requireActual('../music');

  const mockQueues: Record<string, unknown> = {};

  return {
    getVideoInfo:  jest.fn(),
    getStreamUrl:  jest.fn(),
    skipCurrent:   jest.fn((channelId) => {
      const q = mockQueues[channelId] || { queue: [], current: null };
      return q.queue.shift() || null;
    }),
    clearQueue:    jest.fn((channelId) => { mockQueues[channelId] = { queue: [], current: null }; }),
    getQueue:      jest.fn((channelId) => {
      if (!mockQueues[channelId]) mockQueues[channelId] = { queue: [], current: null };
      return mockQueues[channelId];
    }),
    isValidMusicUrl: jest.requireActual('../music').isValidMusicUrl,
    _mockQueues: mockQueues, // test erişimi için
  };
});

const {
  handleMusicCommand,
  registerMusicHandlers,
} = require('../socket/handlers/music');

const {
  getVideoInfo,
  getStreamUrl,
  getQueue,
  skipCurrent,
  clearQueue,
  isValidMusicUrl,
  _mockQueues,
} = require('../music');

// ── Yardımcılar ──────────────────────────────────────────────────

function makeUser(overrides = {}) {
  return { _id: 'u-test', displayName: 'DJ Tester', ...overrides };
}

function makeIo() {
  const emitted = [];
  return {
    _emitted: emitted,
    to(target) {
      return { emit(ev, data) { emitted.push({ ev, data, _target: target }); } };
    },
  };
}

function makeSocket(id = 'sock-music') {
  const handlers: Record<string, unknown> = {};
  return {
    id,
    on(event, fn) { handlers[event] = fn; },
    _trigger(event, data) { if (handlers[event]) handlers[event](data); },
  };
}

function clearMockQueues() {
  for (const k of Object.keys(_mockQueues)) delete _mockQueues[k];
}

function makeContext(overrides = {}) {
  return {
    channelId: 'ch-music',
    serverId:  'sv-music',
    user:      makeUser(),
    io:        makeIo(),
    socket:    makeSocket(),
    ...overrides,
  };
}

// systemMsg pattern: channelId, serverId, content — check emitted messages
function getSystemMsgs(io, pattern) {
  return io._emitted
    .filter(e => e.ev === 'message:new')
    .map(e => e.data.content)
    .filter(c => c && c.includes(pattern));
}

beforeEach(() => {
  clearMockQueues();
  jest.clearAllMocks();
  getQueue.mockImplementation((channelId) => {
    if (!_mockQueues[channelId]) _mockQueues[channelId] = { queue: [], current: null };
    return _mockQueues[channelId];
  });
});

// ════════════════════════════════════════════════════════════════
// isValidMusicUrl (gerçek implementasyon)
// ════════════════════════════════════════════════════════════════

describe('isValidMusicUrl', () => {
  it.each([
    ['https://youtube.com/watch?v=abc',     true],
    ['https://www.youtube.com/watch?v=abc', true],
    ['https://youtu.be/abc',                true],
    ['https://m.youtube.com/watch?v=abc',   true],
  ])('%s → %s', (url, expected) => {
    expect(isValidMusicUrl(url)).toBe(expected);
  });

  it.each([
    ['https://vimeo.com/123',     false],
    ['https://soundcloud.com/x',  true],
    ['not-a-url',                 false],
    ['',                          false],
  ])('%s → %s (geçersiz)', (url, expected) => {
    expect(isValidMusicUrl(url)).toBe(expected);
  });
});

// ════════════════════════════════════════════════════════════════
// !play
// ════════════════════════════════════════════════════════════════

describe('!play', () => {
  const VALID_URL = 'https://youtube.com/watch?v=test123';
  const MOCK_INFO = { title: 'Test Song', duration: 180, uploader: 'TestUser', thumbnail: '', webUrl: VALID_URL, id: 'test123' };
  const MOCK_STREAM = 'https://stream.example.com/audio.webm';

  it('kuyruk boşsa şarkıyı çalar ve music:play emit eder', async () => {
    getVideoInfo.mockResolvedValue(MOCK_INFO);
    getStreamUrl.mockResolvedValue(MOCK_STREAM);

    const ctx = makeContext();
    await handleMusicCommand({ content: `!play ${VALID_URL}`, ...ctx });

    const playEvt = ctx.io._emitted.find(e => e.ev === 'music:play');
    expect(playEvt).toBeDefined();
    expect(playEvt.data.track.title).toBe('Test Song');

    const q = getQueue('ch-music');
    expect(q.current).toBeDefined();
    expect(q.current.title).toBe('Test Song');
  });

  it('"Now playing" sistem mesajı gönderir', async () => {
    getVideoInfo.mockResolvedValue(MOCK_INFO);
    getStreamUrl.mockResolvedValue(MOCK_STREAM);

    const ctx = makeContext();
    await handleMusicCommand({ content: `!play ${VALID_URL}`, ...ctx });

    const msgs = getSystemMsgs(ctx.io, 'Now playing');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('Test Song');
  });

  it('kuyrukta şarkı varsa kuyruğa ekler', async () => {
    getVideoInfo.mockResolvedValue(MOCK_INFO);
    getStreamUrl.mockResolvedValue(MOCK_STREAM);

    const q = getQueue('ch-music');
    q.current = { title: 'Current Song' }; // zaten çalıyor

    const ctx = makeContext();
    await handleMusicCommand({ content: `!play ${VALID_URL}`, ...ctx });

    expect(q.queue).toHaveLength(1);
    expect(q.queue[0].title).toBe('Test Song');

    const queuedEvt = ctx.io._emitted.find(e => e.ev === 'music:queued');
    expect(queuedEvt).toBeDefined();
  });

  it('kuyruk doluysa (max 25) hata mesajı gönderir', async () => {
    getVideoInfo.mockResolvedValue(MOCK_INFO);
    getStreamUrl.mockResolvedValue(MOCK_STREAM);

    const q = getQueue('ch-music');
    q.current = { title: 'Current' };
    q.queue   = new Array(25).fill({ title: 'x' }); // max dolu

    const ctx = makeContext();
    await handleMusicCommand({ content: `!play ${VALID_URL}`, ...ctx });

    const msgs = getSystemMsgs(ctx.io, 'Queue full');
    expect(msgs).toHaveLength(1);
  });

  it('URL olmadan !play kullanım mesajı gönderir', async () => {
    const ctx = makeContext();
    await handleMusicCommand({ content: '!play', ...ctx });

    const msgs = getSystemMsgs(ctx.io, 'Usage');
    expect(msgs).toHaveLength(1);
  });

  it('geçersiz URL hata mesajı döner', async () => {
    getVideoInfo.mockRejectedValue(new Error('Only YouTube URLs are supported.'));

    const ctx = makeContext();
    await handleMusicCommand({ content: '!play https://vimeo.com/123', ...ctx });

    const errorMsgs = ctx.io._emitted
      .filter(e => e.ev === 'message:new')
      .map(e => e.data.content)
      .filter(c => c?.includes('❌'));
    expect(errorMsgs.length).toBeGreaterThan(0);
  });

  it('getVideoInfo başarısız olursa genel hata mesajı gösterir', async () => {
    getVideoInfo.mockRejectedValue(new Error('Network failure'));

    const ctx = makeContext();
    await handleMusicCommand({ content: `!play ${VALID_URL}`, ...ctx });

    const msgs = ctx.io._emitted
      .filter(e => e.ev === 'message:new')
      .map(e => e.data.content)
      .filter(c => c?.startsWith('❌'));
    expect(msgs.length).toBeGreaterThan(0);
    // Network failure iç hatası sızdırılmamalı
    expect(msgs[0]).not.toContain('Network failure');
    expect(msgs[0]).toContain('Could not process');
  });

  it('true döner (komut işlendi)', async () => {
    getVideoInfo.mockResolvedValue(MOCK_INFO);
    getStreamUrl.mockResolvedValue(MOCK_STREAM);

    const ctx = makeContext();
    const result = await handleMusicCommand({ content: `!play ${VALID_URL}`, ...ctx });
    expect(result).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// !skip
// ════════════════════════════════════════════════════════════════

describe('!skip', () => {
  it('sıradaki şarkıya geçer ve music:play emit eder', async () => {
    const nextTrack = { title: 'Next Song', duration: 200 };
    skipCurrent.mockReturnValue(nextTrack);
    const q = getQueue('ch-music');
    q.current = nextTrack; // skipCurrent sonrası mock set eder

    const ctx = makeContext();
    const result = await handleMusicCommand({ content: '!skip', ...ctx });

    expect(result).toBe(true);
    const playEvt = ctx.io._emitted.find(e => e.ev === 'music:play');
    expect(playEvt).toBeDefined();
    expect(playEvt.data.track.title).toBe('Next Song');
  });

  it('kuyruk boşsa music:stop emit eder', async () => {
    skipCurrent.mockReturnValue(null);
    const q = getQueue('ch-music');
    q.current = null;

    const ctx = makeContext();
    await handleMusicCommand({ content: '!skip', ...ctx });

    const stopEvt = ctx.io._emitted.find(e => e.ev === 'music:stop');
    expect(stopEvt).toBeDefined();
  });

  it('"Queue ended" mesajı gönderir', async () => {
    skipCurrent.mockReturnValue(null);
    getQueue.mockReturnValue({ current: null, queue: [] });

    const ctx = makeContext();
    await handleMusicCommand({ content: '!skip', ...ctx });

    const msgs = getSystemMsgs(ctx.io, 'Queue ended');
    expect(msgs).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════
// !stop
// ════════════════════════════════════════════════════════════════

describe('!stop', () => {
  it('clearQueue çağrılır ve music:stop emit edilir', async () => {
    const ctx = makeContext();
    const result = await handleMusicCommand({ content: '!stop', ...ctx });

    expect(result).toBe(true);
    expect(clearQueue).toHaveBeenCalledWith('ch-music');

    const stopEvt = ctx.io._emitted.find(e => e.ev === 'music:stop');
    expect(stopEvt).toBeDefined();
    expect(stopEvt.data.channelId).toBe('ch-music');
  });

  it('"Stopped" sistem mesajı gönderir', async () => {
    const ctx = makeContext();
    await handleMusicCommand({ content: '!stop', ...ctx });

    const msgs = getSystemMsgs(ctx.io, 'Stopped');
    expect(msgs).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════
// !queue
// ════════════════════════════════════════════════════════════════

describe('!queue', () => {
  it('kuyruk boşsa "Queue empty" mesajı gönderir', async () => {
    getQueue.mockReturnValue({ current: null, queue: [] });

    const ctx = makeContext();
    await handleMusicCommand({ content: '!queue', ...ctx });

    const msgs = getSystemMsgs(ctx.io, 'Queue empty');
    expect(msgs).toHaveLength(1);
  });

  it('mevcut parça ve sırayı listeler', async () => {
    getQueue.mockReturnValue({
      current: { title: 'Current Hit', duration: 200 },
      queue:   [
        { title: 'Next Song',  requestedBy: 'Alice' },
        { title: 'Third Song', requestedBy: 'Bob'   },
      ],
    });

    const ctx = makeContext();
    await handleMusicCommand({ content: '!queue', ...ctx });

    const msgs = ctx.io._emitted
      .filter(e => e.ev === 'message:new')
      .map(e => e.data.content);

    expect(msgs.length).toBeGreaterThan(0);
    const combined = msgs.join('\n');
    expect(combined).toContain('Current Hit');
    expect(combined).toContain('Next Song');
    expect(combined).toContain('Alice');
  });
});

// ════════════════════════════════════════════════════════════════
// !help
// ════════════════════════════════════════════════════════════════

describe('!help', () => {
  it('komut listesini gösterir', async () => {
    const ctx = makeContext();
    const result = await handleMusicCommand({ content: '!help', ...ctx });

    expect(result).toBe(true);
    const msgs = getSystemMsgs(ctx.io, 'Commands');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('!play');
    expect(msgs[0]).toContain('!skip');
    expect(msgs[0]).toContain('!stop');
    expect(msgs[0]).toContain('!queue');
  });
});

// ════════════════════════════════════════════════════════════════
// Bilinmeyen komut
// ════════════════════════════════════════════════════════════════

describe('bilinmeyen komut', () => {
  it('false döner', async () => {
    const ctx = makeContext();
    const result = await handleMusicCommand({ content: '!unknowncmd', ...ctx });
    expect(result).toBe(false);
  });

  it('normal mesaj (! içermeyen) false döner', async () => {
    const ctx = makeContext();
    const result = await handleMusicCommand({ content: 'merhaba dünya', ...ctx });
    expect(result).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// registerMusicHandlers — music:ended
// ════════════════════════════════════════════════════════════════

describe('registerMusicHandlers — music:ended', () => {
  it('sırada şarkı varsa sonrakini çalar', () => {
    const nextTrack = { title: 'Auto Next', duration: 150 };
    _mockQueues['ch-ended'] = { queue: [nextTrack], current: { title: 'Old' } };

    const socket = makeSocket();
    const io     = makeIo();
    const user   = makeUser();
    registerMusicHandlers(socket, io, user);

    socket._trigger('music:ended', { channelId: 'ch-ended' });

    const q = _mockQueues['ch-ended'];
    expect(q.current.title).toBe('Auto Next');
    expect(q.queue).toHaveLength(0);

    const playEvt = io._emitted.find(e => e.ev === 'music:play');
    expect(playEvt).toBeDefined();
    expect(playEvt.data.track.title).toBe('Auto Next');
  });

  it('kuyruk boşsa music:stop emit eder', () => {
    _mockQueues['ch-ended-empty'] = { queue: [], current: { title: 'Last' } };

    const socket = makeSocket();
    const io     = makeIo();
    const user   = makeUser();
    registerMusicHandlers(socket, io, user);

    socket._trigger('music:ended', { channelId: 'ch-ended-empty' });

    const q = _mockQueues['ch-ended-empty'];
    expect(q.current).toBeNull();

    const stopEvt = io._emitted.find(e => e.ev === 'music:stop');
    expect(stopEvt).toBeDefined();
  });
});
