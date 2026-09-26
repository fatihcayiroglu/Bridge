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

// ══════════════════════════════════════════════════════════════════════════
// TIPLER URUNDEN GELIR — TESTTE KOPYASI TUTULMAZ
// ══════════════════════════════════════════════════════════════════════════
// Burada eskiden urun tiplerinin ELDE YAZILMIS bir kopyasi vardi
// (`TrackInfo`, `NowPlaying`, `QueuedResult`, ...) ve kopya ESKIMISTI:
// `MusicTrack.duration` ile `url` urunde ZORUNLU iken kopyada istege bagliydi.
// Sonuc: testler `makeTrack('X')` yazip eksik parca uretiyor,
// urun imzasina uymadigi icin 19 strict hatasi cikiyordu — ve daha kotusu,
// olculen sey urunun gercekten tasidigi veri DEGILDI.
//
// Artik tip tek yerde yasar. Urun `MusicTrack`i degistirirse bu dosya
// DERLEMEDE kirilir; sessizce eskimez.

import type { MusicTrack, MusicCommandResult } from '../music';

/** TAM bir `MusicTrack` uretir; test yalnizca ilgilendigi alani gecer. */
function makeTrack(title: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
  return { title, duration: 0, url: `https://youtube.com/watch?v=${encodeURIComponent(title)}`, ...overrides };
}

// ── Sonuc daraltmasi: CAST DEGIL, DOGRULAMA ───────────────────────────────
// `MusicCommandResult` bir BIRLESIMDIR. Eskiden `(result as NowPlaying)`
// yaziliyordu; yanlis dal dondugunde bu, `undefined okunuyor` gibi okunmasi
// zor bir kazaya donusuyordu. Asagidakiler hangi dalin beklendigini ACIK
// yazar ve gelmediyse NE geldigini soyler.

function expectNowPlaying(result: MusicCommandResult): MusicTrack {
  if (result && typeof result === 'object' && 'nowPlaying' in result) return result.nowPlaying;
  throw new Error(`'nowPlaying' bekleniyordu, gelen: ${JSON.stringify(result)}`);
}

function expectQueued(result: MusicCommandResult): { queued: MusicTrack; position: number } {
  if (result && typeof result === 'object' && 'queued' in result) return result;
  throw new Error(`'queued' bekleniyordu, gelen: ${JSON.stringify(result)}`);
}

function expectError(result: MusicCommandResult): string {
  if (result && typeof result === 'object' && 'error' in result) return result.error;
  throw new Error(`'error' bekleniyordu, gelen: ${JSON.stringify(result)}`);
}

function expectQueueState(result: MusicCommandResult): { current: MusicTrack | null; queue: MusicTrack[] } {
  if (result && typeof result === 'object' && 'queue' in result && 'current' in result) return result;
  throw new Error(`kuyruk durumu bekleniyordu, gelen: ${JSON.stringify(result)}`);
}

function expectCommands(result: MusicCommandResult): string[] {
  if (result && typeof result === 'object' && 'commands' in result) return result.commands;
  throw new Error(`'commands' bekleniyordu, gelen: ${JSON.stringify(result)}`);
}


// ── Yardımcılar ───────────────────────────────────────────────

/** Her test öncesi tüm queue state'ini temizle */
function resetQueues() {
  for (const k of Object.keys(voiceQueues)) delete voiceQueues[k];
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
    ['ftp://youtube.com/watch?v=abc',       false], // yalnız HTTP(S) kabul edilir
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
    q1.current = makeTrack('A');
    expect(q2.current).toBeNull();
  });

  it('voiceQueues export\'u getQueue ile senkron', () => {
    getQueue('ch-export');
    expect(voiceQueues['ch-export']).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════
// skipCurrent
// ════════════════════════════════════════════════════════════════

describe('skipCurrent', () => {
  it('kuyrukta şarkı varsa sonrakini current yapar ve döndürür', () => {
    const q = getQueue('ch-skip-1');
    q.current = makeTrack('Playing Now');
    q.queue   = [makeTrack('Next Up'), makeTrack('Third')];

    const next = skipCurrent('ch-skip-1');

    expect(next).toEqual(makeTrack('Next Up'));
    expect(q.current).toEqual(makeTrack('Next Up'));
    expect(q.queue).toHaveLength(1);
    expect(q.queue[0]).toEqual(makeTrack('Third'));
  });

  it('kuyruk boşsa null döner ve current null olur', () => {
    const q = getQueue('ch-skip-2');
    q.current = makeTrack('Last Song');
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
    q.current = makeTrack('A');
    q.queue   = [makeTrack('B')];

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
    q.current = makeTrack('Playing');
    q.queue   = [makeTrack('Q1'), makeTrack('Q2')];

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
    q.current = makeTrack('X');
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
    expect(expectNowPlaying(result).title).toContain(VALID_URL);
  });

  it('!play URL olmadan error döndürür', async () => {
    const result = await cmd('!play', []);
    expect(result).toHaveProperty('error');
    expect(expectError(result)).toContain('URL required');
  });

  it('!play geçersiz URL error döndürür', async () => {
    const result = await cmd('!play', ['https://vimeo.com/123']);
    expect(result).toHaveProperty('error');
    expect(expectError(result)).toContain('Invalid');
  });

  it('!play queue dolu iken error döndürür', async () => {
    const q = getQueue('ch-full');
    q.current = makeTrack('Current');
    q.queue   = Array.from({ length: 25 }, (_, i) => makeTrack(`x${i}`));

    const result = await routeHandleMusicCommand('!play', [VALID_URL], 'ch-full', null);
    expect(expectError(result)).toContain('Queue full');
  });

  it('!play kuyrukta şarkı varken queued döndürür', async () => {
    const q = getQueue('ch-queue-route');
    q.current = makeTrack('Playing');

    const result = await routeHandleMusicCommand('!play', [VALID_URL], 'ch-queue-route', null);
    expect(result).toHaveProperty('queued');
    expect(expectQueued(result).position).toBe(1);
  });

  it('!skip sonraki şarkıya geçer', async () => {
    const q = getQueue('ch-skip-route');
    q.current = makeTrack('Old');
    q.queue   = [makeTrack('New Song')];

    const result = await cmd('!skip', [], 'ch-skip-route');
    expect(result).toHaveProperty('nowPlaying');
    expect(expectNowPlaying(result).title).toBe('New Song');
  });

  it('!skip boş kuyruk stopped döndürür', async () => {
    getQueue('ch-skip-empty-route'); // boş queue

    const result = await cmd('!skip', [], 'ch-skip-empty-route');
    expect(result).toHaveProperty('stopped', true);
  });

  it('!stop clearQueue çağırır ve stopped döndürür', async () => {
    const q = getQueue('ch-stop-route');
    q.current = makeTrack('Playing');
    q.queue   = [makeTrack('Q1')];

    const result = await cmd('!stop', [], 'ch-stop-route');
    expect(result).toHaveProperty('stopped', true);

    const fresh = getQueue('ch-stop-route');
    expect(fresh.current).toBeNull();
    expect(fresh.queue).toHaveLength(0);
  });

  it('!queue current ve kuyruğu döndürür', async () => {
    const q = getQueue('ch-queue-route2');
    q.current = makeTrack('Now Playing', { duration: 180 });
    q.queue   = [makeTrack('Next')];

    const result = await cmd('!queue', [], 'ch-queue-route2');
    expect(expectQueueState(result).current?.title).toBe('Now Playing');
    expect(expectQueueState(result).queue).toHaveLength(1);
  });

  it('!help komut listesi döndürür', async () => {
    const result = await cmd('!help', []);
    expect(expectCommands(result)).toContain('!play <url>');
    expect(expectCommands(result)).toContain('!skip');
    expect(expectCommands(result)).toContain('!stop');
    expect(expectCommands(result)).toContain('!queue');
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
    q.current = makeTrack('VQ Test');

    expect(voiceQueues['ch-vq']?.current?.title).toBe('VQ Test');
  });

  it('clearQueue sonrası voiceQueues temiz', () => {
    getQueue('ch-vq2');
    clearQueue('ch-vq2');
    const entry = voiceQueues['ch-vq2'];
    expect(entry.current).toBeNull();
    expect(entry.queue).toHaveLength(0);
  });
});
