// server/tests/music.test.ts
// music.js socket handler ve handleMusicCommand entegrasyon testleri
// Test kapsamı:
//   - handleMusicCommand: !play, !skip, !stop, !queue, !help
//   - !play: queue'ya ekleme, "now playing", queue dolu (max 25), geçersiz URL
//   - !skip: sıradaki parçaya geçiş, kuyruk boşsa durdur
//   - !stop: kuyruğu temizle ve durdur
//   - !queue: mevcut parçayı ve sırayı listele
import type { SocketListener } from './helpers/socketDoubles';
import { EmittedLog, asRecord, dataOf, findEmitted, requireEmitted, requireEmittedData } from './helpers/socketDoubles';
import type { MusicQueue } from '../music';
//   - registerMusicHandlers: music:ended → sıradaki parça veya durdur
//   - formatDuration, isValidMusicUrl yardımcıları
//   - Bilinen komut değilse false döner

'use strict';
process.env.NODE_ENV = 'test';

// yt-dlp gerektiren dış bağımlılıkları stub'la
jest.mock('../music', () => {
  const { voiceQueues } = jest.requireActual('../music');

  // Kuyruk ikizi URUN tipiyle (`MusicQueue`) tutulur. `Record<string, unknown>`
  // oldugu icin `q.queue.shift()` "q is of type 'unknown'" veriyordu; tip
  // yazilinca hem hata kapandi hem de ikiz urunun gercek sekline baglandi.
  const mockQueues: Record<string, MusicQueue> = {};

  const queueFor = (channelId: string): MusicQueue => {
    const existing = mockQueues[channelId];
    if (existing) return existing;
    const created: MusicQueue = { queue: [], current: null };
    mockQueues[channelId] = created;
    return created;
  };
  const skip = (channelId: string) => {
    const q = queueFor(channelId);
    const next = q.queue.shift() ?? null;
    q.current = next;
    return next;
  };

  return {
    getVideoInfo:  jest.fn(),
    getStreamUrl:  jest.fn(),
    skipCurrent:   jest.fn(skip),
    skipSharedMusicQueue: jest.fn(async (channelId) => skip(channelId)),
    clearQueue:    jest.fn((channelId) => { mockQueues[channelId] = { queue: [], current: null }; }),
    clearSharedMusicQueue: jest.fn(async (channelId) => { mockQueues[channelId] = { queue: [], current: null }; }),
    getQueue:      jest.fn(queueFor),
    readMusicQueue: jest.fn(async (channelId) => queueFor(channelId)),
    mutateMusicQueue: jest.fn(async (channelId, fn) => fn(queueFor(channelId))),
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
  readMusicQueue,
  skipSharedMusicQueue,
  clearSharedMusicQueue,
  isValidMusicUrl,
  _mockQueues,
} = require('../music');

// ── Yardımcılar ──────────────────────────────────────────────────

function makeUser(overrides = {}) {
  return { _id: 'u-test', displayName: 'DJ Tester', ...overrides };
}

function makeIo() {
  const emitted: EmittedLog = [];
  return {
    _emitted: emitted,
    to(target: string) {
      return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _target: target }); } };
    },
  };
}

function makeSocket(id: string = 'sock-music') {
  const handlers: Record<string, unknown> = {};
  const rooms = new Set<string>();
  return {
    id,
    rooms,
    currentVoiceChannel: undefined as string | undefined,
    on(event: string, fn: SocketListener) { handlers[event] = fn; },
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    _trigger(event: string, data: unknown) {
      const fn = handlers[event];
      return typeof fn === 'function' ? (fn as (payload: unknown) => unknown)(data) : undefined;
    },
  };
}

/**
 * `music:ended` YALNIZCA o sesli kanalda BULUNAN soketten kabul edilir
 * (socket/handlers/music.ts:136-137):
 *
 *     if (activeVoice !== channelId || !socket.rooms.has(`voice:${channelId}`)) return;
 *
 * Bu bir GÜVENLİK koşuludur: aksi hâlde herhangi bir istemci, üyesi olmadığı
 * bir kanalda çalan parçayı atlatabilirdi. Testlerdeki sahte soketin `rooms`
 * kümesi ve `currentVoiceChannel` alanı YOKTU, bu yüzden handler sessizce
 * dönüyordu. Yardımcı ön koşulu AÇIKÇA kurar.
 */
function joinVoice(socket: { rooms: Set<string>; currentVoiceChannel?: string }, channelId: string) {
  socket.currentVoiceChannel = channelId;
  socket.rooms.add(`voice:${channelId}`);
  return socket;
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
function getSystemMsgs(io: { _emitted: EmittedLog }, pattern: string): string[] {
  return io._emitted
    .filter(e => e.ev === 'message:new')
    .map(e => dataOf(e).content)
    .filter((c): c is string => typeof c === 'string' && c.includes(pattern));
}

beforeEach(() => {
  clearMockQueues();
  jest.clearAllMocks();
  getQueue.mockImplementation((channelId: string) => {
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

    const playEvt = requireEmittedData(ctx.io._emitted, 'music:play');
    expect(playEvt).toBeDefined();
    expect(asRecord(playEvt.track)?.title).toBe('Test Song');

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

    const queuedEvt = requireEmitted(ctx.io._emitted, 'music:queued');
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

  it('geçersiz/non-HTTP(S) URL upstream çözümlemeye gitmeden reddedilir', async () => {
    const ctx = makeContext();
    await handleMusicCommand({ content: '!play ftp://youtube.com/watch?v=123', ...ctx });

    const errorMsgs = ctx.io._emitted
      .filter(e => e.ev === 'message:new')
      .map(e => dataOf(e).content)
      .filter((c): c is string => typeof c === 'string' && c.includes('❌'));
    expect(errorMsgs).toContain('❌ Only YouTube or SoundCloud HTTP(S) URLs are supported.');
    expect(getVideoInfo).not.toHaveBeenCalled();
    expect(getStreamUrl).not.toHaveBeenCalled();
  });

  it('getVideoInfo başarısız olursa genel hata mesajı gösterir', async () => {
    getVideoInfo.mockRejectedValue(new Error('Network failure'));

    const ctx = makeContext();
    await handleMusicCommand({ content: `!play ${VALID_URL}`, ...ctx });

    const msgs = ctx.io._emitted
      .filter(e => e.ev === 'message:new')
      .map(e => dataOf(e).content)
      .filter((c): c is string => typeof c === 'string' && c.startsWith('❌'));
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
    skipSharedMusicQueue.mockResolvedValueOnce(nextTrack);

    const ctx = makeContext();
    const result = await handleMusicCommand({ content: '!skip', ...ctx });

    expect(result).toBe(true);
    const playEvt = requireEmittedData(ctx.io._emitted, 'music:play');
    expect(playEvt).toBeDefined();
    expect(asRecord(playEvt.track)?.title).toBe('Next Song');
  });

  it('kuyruk boşsa music:stop emit eder', async () => {
    skipSharedMusicQueue.mockResolvedValueOnce(null);

    const ctx = makeContext();
    await handleMusicCommand({ content: '!skip', ...ctx });

    const stopEvt = requireEmittedData(ctx.io._emitted, 'music:stop');
    expect(stopEvt).toBeDefined();
  });

  it('"Queue ended" mesajı gönderir', async () => {
    skipSharedMusicQueue.mockResolvedValueOnce(null);

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
    expect(clearSharedMusicQueue).toHaveBeenCalledWith('ch-music');

    const stopEvt = requireEmittedData(ctx.io._emitted, 'music:stop');
    expect(stopEvt).toBeDefined();
    expect(stopEvt.channelId).toBe('ch-music');
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
    readMusicQueue.mockResolvedValueOnce({ current: null, queue: [] });

    const ctx = makeContext();
    await handleMusicCommand({ content: '!queue', ...ctx });

    const msgs = getSystemMsgs(ctx.io, 'Queue empty');
    expect(msgs).toHaveLength(1);
  });

  it('mevcut parça ve sırayı listeler', async () => {
    readMusicQueue.mockResolvedValueOnce({
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
      .map(e => dataOf(e).content);

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
  it('sırada şarkı varsa sonrakini çalar', async () => {
    const nextTrack = { title: 'Auto Next', duration: 150 };
    _mockQueues['ch-ended'] = { queue: [nextTrack], current: { title: 'Old' } };

    const socket = makeSocket();
    const io     = makeIo();
    const user   = makeUser();
    registerMusicHandlers(socket, io, user);

    joinVoice(socket, 'ch-ended');
    await socket._trigger('music:ended', { channelId: 'ch-ended' });

    const q = _mockQueues['ch-ended'];
    expect(q.current.title).toBe('Auto Next');
    expect(q.queue).toHaveLength(0);

    const playEvt = requireEmittedData(io._emitted, 'music:play');
    expect(playEvt).toBeDefined();
    expect(asRecord(playEvt.track)?.title).toBe('Auto Next');
  });

  it('kuyruk boşsa music:stop emit eder', async () => {
    _mockQueues['ch-ended-empty'] = { queue: [], current: { title: 'Last' } };

    const socket = makeSocket();
    const io     = makeIo();
    const user   = makeUser();
    registerMusicHandlers(socket, io, user);

    joinVoice(socket, 'ch-ended-empty');
    await socket._trigger('music:ended', { channelId: 'ch-ended-empty' });

    const q = _mockQueues['ch-ended-empty'];
    expect(q.current).toBeNull();

    const stopEvt = requireEmittedData(io._emitted, 'music:stop');
    expect(stopEvt).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════
// music:ended — SESLİ KANAL ÜYELİĞİ ZORUNLU
// ════════════════════════════════════════════════════════════════
// Koruma bu dosyada yalnızca DOLAYLI olarak ölçülüyordu: ön koşul
// kurulmadığı için testler zaten düşüyordu. Kaldırılsaydı hiçbir test
// "yetkisiz atlatma" yüzünden kırmızıya dönmezdi. Açıkça ölçülür.
describe('music:ended — sesli kanalda OLMAYAN soket kuyruğu ilerletemez', () => {
  it('currentVoiceChannel eşleşmiyorsa hiçbir şey yapmaz', async () => {
    const nextTrack = { title: 'Calinmasin', duration: 10 };
    _mockQueues['ch-guard'] = { queue: [nextTrack], current: { title: 'Mevcut' } };

    const socket = makeSocket();
    const io     = makeIo();
    registerMusicHandlers(socket, io, makeUser());

    // BAŞKA bir kanaldayız; 'ch-guard' için yetkimiz yok.
    joinVoice(socket, 'baska-kanal');
    await socket._trigger('music:ended', { channelId: 'ch-guard' });

    expect(_mockQueues['ch-guard'].current.title).toBe('Mevcut');
    expect(_mockQueues['ch-guard'].queue).toHaveLength(1);
    expect(findEmitted(io._emitted, 'music:play')).toBeUndefined();
  });

  it('voice odasına katılmamış soket (yalnız alan atanmış) reddedilir', async () => {
    // `currentVoiceChannel` doğru ama soket GERÇEKTEN odada değil: iki koşul
    // da gereklidir, biri diğerinin yerine geçemez.
    _mockQueues['ch-guard2'] = { queue: [{ title: 'X' }], current: { title: 'Mevcut' } };

    const socket = makeSocket();
    const io     = makeIo();
    registerMusicHandlers(socket, io, makeUser());

    (socket as unknown as { currentVoiceChannel?: string }).currentVoiceChannel = 'ch-guard2';
    // socket.rooms'a EKLENMEDİ.
    await socket._trigger('music:ended', { channelId: 'ch-guard2' });

    expect(_mockQueues['ch-guard2'].current.title).toBe('Mevcut');
    expect(findEmitted(io._emitted, 'music:play')).toBeUndefined();
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
