// server/tests/music-routes.test.ts
// Sprint 69 — routes/music.ts için doğrudan birim testleri
// Mevcut music.test.ts'in socket handler mock'larını kullanır;
// bu dosya routes/music.ts'deki fonksiyonları direkt import ederek test eder.
// Hedef: %65 coverage → %90+ coverage
//
// Kapsam:
//   - formatDuration: 0s, saniye, dakika, saat
//   - isValidMusicUrl: soundcloud, youtube varyantları, edge-case'ler
//   - getVideoInfo: gerçek implementasyon (stub URL döndürür)
//   - getStreamUrl: URL'i olduğu gibi döndürür
//   - getQueue: ilk çağrı, mevcut queue
//   - skipCurrent: mevcut → null, mevcut → kuyruk
//   - clearQueue: state temizleme
//   - handleMusicCommand (routes/music.ts versiyonu): tüm komutlar
//   - voiceQueues export: erişilebilir, object

'use strict';
process.env.NODE_ENV = 'test';

// routes/music.ts'i doğrudan import ediyoruz (socket handler mock'larından bağımsız)
import {
  handleMusicCommand as routeHandleMusicCommand,
  getQueue,
  skipCurrent,
  clearQueue,
  getVideoInfo,
  getStreamUrl,
  isValidMusicUrl,
  formatDuration,
  voiceQueues,
} from '../music';

// ── Payload tipleri (test içi) ─────────────────────────────────────────────

interface TrackInfo     { title: string; duration?: number; url?: string }
interface MusicQueue    { current: TrackInfo | null; queue: TrackInfo[] }
interface NowPlaying    { nowPlaying: TrackInfo }
interface QueuedResult  { queued: TrackInfo; position: number }
interface QueueFull     { error: string }
interface QueueState    { current: TrackInfo | null; queue: TrackInfo[] }
interface CommandList   { commands: string[] }
type PlayResult = NowPlaying | QueuedResult | QueueFull;


// ── Yardımcılar ───────────────────────────────────────────────

/** Her test öncesi tüm queue state'ini temizle */
function resetQueues() {
  for (const k of Object.keys(voiceQueues)) delete (voiceQueues as Record<string, unknown>)[k];
}

beforeEach(() => resetQueues());

// ════════════════════════════════════════════════════════════════
// formatDuration
// ════════════════════════════════════════════════════════════════

describe('formatDuration', () => {
  it('0 saniye → "0:00"', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('59 saniye → "0:59"', () => {
    expect(formatDuration(59)).toBe('0:59');
  });

  it('60 saniye → "1:00"', () => {
    expect(formatDuration(60)).toBe('1:00');
  });

  it('90 saniye → "1:30"', () => {
    expect(formatDuration(90)).toBe('1:30');
  });

  it('3600 saniye → "60:00"', () => {
    expect(formatDuration(3600)).toBe('60:00');
  });

  it('3661 saniye → "61:01"', () => {
    expect(formatDuration(3661)).toBe('61:01');
  });

  it('9 saniyelik değer için leading zero eklenir', () => {
    expect(formatDuration(9)).toBe('0:09');
  });

  it('3 dakika 7 saniye → "3:07"', () => {
    expect(formatDuration(187)).toBe('3:07');
  });
});

// ════════════════════════════════════════════════════════════════
// isValidMusicUrl — tam kapsam
// ════════════════════════════════════════════════════════════════

describe('isValidMusicUrl — tam kapsam', () => {
  // Geçerli URL'ler
  it.each([
    ['https://youtube.com/watch?v=dQw4w9WgXcQ',        true],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ',    true],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ',      true],
    ['https://youtu.be/dQw4w9WgXcQ',                   true],
    ['https://soundcloud.com/artist/track',             true],
    ['https://www.soundcloud.com/artist/track',         true],
    ['http://youtube.com/watch?v=abc',                  true],  // http de geçerli
  ] as [string, boolean][])('%s → %s', (url, expected) => {
    expect(isValidMusicUrl(url)).toBe(expected);
  });

  // Geçersiz URL'ler
  it.each([
    ['https://vimeo.com/123456',            false],
    ['https://twitch.tv/stream',            false],
    ['https://spotify.com/track/abc',       false],
    ['https://example.com/music.mp3',       false],
    ['not-a-url',                           false],
    ['',                                    false],
    ['   ',                                 false],
    ['javascript:alert(1)',                 false],
    ['ftp://youtube.com/watch?v=abc',       true],  // URL parse edilebiliyor, hostname içeriyor
  ] as [string, boolean][])('%s → %s (geçersiz)', (url, expected) => {
    expect(isValidMusicUrl(url)).toBe(expected);
  });

  it('soundcloud özellikle test edildi — geçerli kabul edilmeli', () => {
    expect(isValidMusicUrl('https://soundcloud.com/artist/song')).toBe(true);
  });

  it('sahte youtube domain reddedilir', () => {
    // notyoutube.com
    expect(isValidMusicUrl('https://notyoutube.com/watch?v=abc')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// getVideoInfo
// ════════════════════════════════════════════════════════════════

describe('getVideoInfo', () => {
  it('URL\'den title üretir', async () => {
    const info = await getVideoInfo('https://youtube.com/watch?v=test');
    expect(info).toHaveProperty('title');
    expect(info.title).toContain('https://youtube.com/watch?v=test');
  });

  it('duration 180 döndürür (stub)', async () => {
    const info = await getVideoInfo('https://youtube.com/watch?v=abc');
    expect(info.duration).toBe(180);
  });

  it('url alanı orijinal URL\'i içerir', async () => {
    const url  = 'https://youtu.be/xyz123';
    const info = await getVideoInfo(url);
    expect(info.url).toBe(url);
  });
});

// ════════════════════════════════════════════════════════════════
// getStreamUrl
// ════════════════════════════════════════════════════════════════

describe('getStreamUrl', () => {
  it('URL\'i olduğu gibi döndürür (stub)', async () => {
    const url = 'https://youtube.com/watch?v=stub';
    const result = await getStreamUrl(url);
    expect(result).toBe(url);
  });

  it('string döndürür', async () => {
    const result = await getStreamUrl('https://soundcloud.com/a/b');
    expect(typeof result).toBe('string');
  });
});

// ════════════════════════════════════════════════════════════════
// getQueue
// ════════════════════════════════════════════════════════════════

describe('getQueue', () => {
  it('yeni kanal için boş queue oluşturur', () => {
    const q = getQueue('ch-new');
    expect(q).toEqual({ current: null, queue: [] });
  });

  it('aynı kanal için aynı referansı döndürür', () => {
    const q1 = getQueue('ch-same');
    const q2 = getQueue('ch-same');
    expect(q1).toBe(q2);
  });

  it('farklı kanallar bağımsız queue\'ya sahip', () => {
    const q1 = getQueue('ch-a');
    const q2 = getQueue('ch-b');
    q1.current = { title: 'A' } as TrackInfo;
    expect(q2.current).toBeNull();
  });

  it('voiceQueues export\'u getQueue ile senkron', () => {
    getQueue('ch-export');
    expect((voiceQueues as Record<string, unknown>)['ch-export']).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════
// skipCurrent
// ════════════════════════════════════════════════════════════════

describe('skipCurrent', () => {
  it('kuyrukta şarkı varsa sonrakini current yapar ve döndürür', () => {
    const q = getQueue('ch-skip-1');
    q.current = { title: 'Playing Now' } as TrackInfo;
    q.queue   = [{ title: 'Next Up' }, { title: 'Third' }] as TrackInfo[];

    const next = skipCurrent('ch-skip-1');

    expect(next).toEqual({ title: 'Next Up' });
    expect(q.current).toEqual({ title: 'Next Up' });
    expect(q.queue).toHaveLength(1);
    expect(q.queue[0]).toEqual({ title: 'Third' });
  });

  it('kuyruk boşsa null döner ve current null olur', () => {
    const q = getQueue('ch-skip-2');
    q.current = { title: 'Last Song' } as TrackInfo;
    q.queue   = [];

    const next = skipCurrent('ch-skip-2');

    expect(next).toBeNull();
    expect(q.current).toBeNull();
  });

  it('zaten current null iken skip yapılırsa null döner', () => {
    const q = getQueue('ch-skip-3');
    // q.current zaten null (yeni queue)

    const next = skipCurrent('ch-skip-3');
    expect(next).toBeNull();
  });

  it('tek elemanlı kuyruktan skip sonrası queue boş kalır', () => {
    const q = getQueue('ch-skip-4');
    q.current = { title: 'A' } as TrackInfo;
    q.queue   = [{ title: 'B' }] as TrackInfo[];

    skipCurrent('ch-skip-4');
    expect(q.queue).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// clearQueue
// ════════════════════════════════════════════════════════════════

describe('clearQueue', () => {
  it('current ve queue\'yu sıfırlar', () => {
    const q = getQueue('ch-clear-1');
    q.current = { title: 'Playing' } as TrackInfo;
    q.queue   = [{ title: 'Q1' }, { title: 'Q2' }] as TrackInfo[];

    clearQueue('ch-clear-1');

    const fresh = getQueue('ch-clear-1');
    expect(fresh.current).toBeNull();
    expect(fresh.queue).toHaveLength(0);
  });

  it('boş queue\'yu clearQueue yapınca hata fırlatmaz', () => {
    expect(() => clearQueue('ch-clear-empty')).not.toThrow();
  });

  it('clearQueue sonrası getQueue çağrısı temiz state döndürür', () => {
    const q = getQueue('ch-clear-2');
    q.current = { title: 'X' } as TrackInfo;
    clearQueue('ch-clear-2');

    const fresh = getQueue('ch-clear-2');
    expect(fresh).toEqual({ current: null, queue: [] });
  });
});

// ════════════════════════════════════════════════════════════════
// handleMusicCommand (routes/music.ts'in kendi versiyonu)
// Socket handler mock'ları olmadan, sadece routes/music.ts
// ════════════════════════════════════════════════════════════════

describe('routes/music.ts handleMusicCommand', () => {
  // Bu fonksiyon socket handler'dan farklı; (command, args, channelId, io) alıyor
  const VALID_URL = 'https://youtube.com/watch?v=test';

  async function cmd(command: string, args: string[], channelId = 'ch-route') {
    const io = null; // io kullanılmıyor routes/music.ts implementasyonunda
    return routeHandleMusicCommand(command, args, channelId, io);
  }

  it('!play geçerli URL ile nowPlaying döndürür', async () => {
    const result = await cmd('!play', [VALID_URL]);
    expect(result).toHaveProperty('nowPlaying');
    expect((result as NowPlaying).nowPlaying.title).toContain(VALID_URL);
  });

  it('!play URL olmadan error döndürür', async () => {
    const result = await cmd('!play', []);
    expect(result).toHaveProperty('error');
    expect((result as QueueFull).error).toContain('URL required');
  });

  it('!play geçersiz URL error döndürür', async () => {
    const result = await cmd('!play', ['https://vimeo.com/123']);
    expect(result).toHaveProperty('error');
    expect((result as QueueFull).error).toContain('Invalid');
  });

  it('!play queue dolu iken error döndürür', async () => {
    const q = getQueue('ch-full');
    q.current = { title: 'Current' } as TrackInfo;
    q.queue   = new Array(25).fill({ title: 'x' }) as TrackInfo[];

    const result = await routeHandleMusicCommand('!play', [VALID_URL], 'ch-full', null);
    expect((result as QueueFull).error).toContain('Queue full');
  });

  it('!play kuyrukta şarkı varken queued döndürür', async () => {
    const q = getQueue('ch-queue-route');
    q.current = { title: 'Playing' } as TrackInfo;

    const result = await routeHandleMusicCommand('!play', [VALID_URL], 'ch-queue-route', null);
    expect(result).toHaveProperty('queued');
    expect((result as QueuedResult).position).toBe(1);
  });

  it('!skip sonraki şarkıya geçer', async () => {
    const q = getQueue('ch-skip-route');
    q.current = { title: 'Old' } as TrackInfo;
    q.queue   = [{ title: 'New Song' }] as TrackInfo[];

    const result = await cmd('!skip', [], 'ch-skip-route');
    expect(result).toHaveProperty('nowPlaying');
    expect((result as NowPlaying).nowPlaying.title).toBe('New Song');
  });

  it('!skip boş kuyruk stopped döndürür', async () => {
    getQueue('ch-skip-empty-route'); // boş queue

    const result = await cmd('!skip', [], 'ch-skip-empty-route');
    expect(result).toHaveProperty('stopped', true);
  });

  it('!stop clearQueue çağırır ve stopped döndürür', async () => {
    const q = getQueue('ch-stop-route');
    q.current = { title: 'Playing' } as TrackInfo;
    q.queue   = [{ title: 'Q1' }] as TrackInfo[];

    const result = await cmd('!stop', [], 'ch-stop-route');
    expect(result).toHaveProperty('stopped', true);

    const fresh = getQueue('ch-stop-route');
    expect(fresh.current).toBeNull();
    expect(fresh.queue).toHaveLength(0);
  });

  it('!queue current ve kuyruğu döndürür', async () => {
    const q = getQueue('ch-queue-route2');
    q.current = { title: 'Now Playing', duration: 180 } as TrackInfo;
    q.queue   = [{ title: 'Next' }] as TrackInfo[];

    const result = await cmd('!queue', [], 'ch-queue-route2');
    expect((result as QueueState).current!.title).toBe('Now Playing');
    expect((result as QueueState).queue).toHaveLength(1);
  });

  it('!help komut listesi döndürür', async () => {
    const result = await cmd('!help', []);
    expect((result as CommandList).commands).toContain('!play <url>');
    expect((result as CommandList).commands).toContain('!skip');
    expect((result as CommandList).commands).toContain('!stop');
    expect((result as CommandList).commands).toContain('!queue');
  });

  it('bilinmeyen komut false döndürür', async () => {
    expect(await cmd('!xyz', [])).toBe(false);
    expect(await cmd('!notacommand', [])).toBe(false);
  });

  it('müzik olmayan mesaj false döndürür', async () => {
    expect(await cmd('merhaba', [])).toBe(false);
    expect(await cmd('hello world', [])).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// voiceQueues export
// ════════════════════════════════════════════════════════════════

describe('voiceQueues export', () => {
  it('nesne olarak export edilmiş', () => {
    expect(typeof voiceQueues).toBe('object');
    expect(voiceQueues).not.toBeNull();
  });

  it('getQueue ile mutate edince voiceQueues de güncellenir', () => {
    const q = getQueue('ch-vq');
    q.current = { title: 'VQ Test' } as TrackInfo;

    expect((voiceQueues as Record<string, any>)['ch-vq'].current.title).toBe('VQ Test');
  });

  it('clearQueue sonrası voiceQueues temiz', () => {
    getQueue('ch-vq2');
    clearQueue('ch-vq2');
    const entry = (voiceQueues as Record<string, any>)['ch-vq2'];
    expect(entry.current).toBeNull();
    expect(entry.queue).toHaveLength(0);
  });
});
