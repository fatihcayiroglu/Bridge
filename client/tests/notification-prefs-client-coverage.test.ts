// client/tests/notification-prefs-client-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// BİLDİRİM TERCİHLERİ VERİ KATMANI
// ════════════════════════════════════════════════════════════════════════════
//
// Bu katmanın iki sözleşmesi doğrudan kullanıcıya yansır:
//
//   · SÜRESİ DOLMUŞ SESSİZLİK — sunucu `muteUntil`i kendiliğinden temizlemez.
//     Süresi geçmiş bir erteleme hâlâ "Sessize alındı" gösterilirse kullanıcı
//     bildirim aldığı hâlde almadığını sanır (ya da tersi).
//   · SESSİZ BAŞARI YOK — kaydetme uçları hata FIRLATIR. Yutulsaydı,
//     kaydedilmemiş bir ayar kaydedilmiş gibi görünür ve kullanıcı beklenmedik
//     bildirim alır ya da mesaj kaçırır.
//
// Ayrıca dikkat kelimeleri bir GÜVEN SINIRIDIR: hem sunucudan gelen liste hem
// kullanıcının girdiği liste normalize edilip sınırlanmalıdır.

import { describe, expect, it, vi } from 'vitest';
import {
  LEVELS,
  LEVEL_DESCRIPTION_KEY,
  LEVEL_LABEL_KEY,
  MAX_WATCH_WORDS,
  SNOOZE_OPTIONS,
  describeMute,
  fetchPrefs,
  isMuteActive,
  normalizePref,
  normalizeWatchWord,
  normalizeWatchWords,
  resetChannel,
  saveChannelLevel,
  saveServerLevel,
  saveWatchWords,
  snoozeUntil,
  type ChannelPref,
} from '../js/core/notifications/notification-prefs-client.ts';
import { t } from '../js/core/i18n/index.ts';

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

function pref(over: Partial<ChannelPref> = {}): ChannelPref {
  return { channelId: 'c-1', level: 'mute', muteUntil: null, ...over };
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function api(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return Object.assign(fn, { calls });
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe('sabit tercih tabloları', () => {
  it('her seviye için etiket ve açıklama anahtarı vardır', () => {
    for (const level of [...LEVELS, 'default'] as const) {
      expect(LEVEL_LABEL_KEY[level]).toBeTruthy();
      expect(LEVEL_DESCRIPTION_KEY[level]).toBeTruthy();
    }
    // `default` bir SECENEK degildir; yalnizca miras alinan durumdur.
    expect(LEVELS).toEqual(['all', 'mentions', 'mute']);
  });

  it('erteleme seçenekleri mutlak zamana çevrilir; süresiz seçenek null kalır', () => {
    const byId = Object.fromEntries(SNOOZE_OPTIONS.map(option => [option.id, option]));
    expect(snoozeUntil(byId['15m']!, NOW)).toBe(NOW + 900_000);
    expect(snoozeUntil(byId['1h']!, NOW)).toBe(NOW + 3_600_000);
    expect(snoozeUntil(byId['8h']!, NOW)).toBe(NOW + 8 * 3_600_000);
    expect(snoozeUntil(byId['24h']!, NOW)).toBe(NOW + 86_400_000);
    expect(snoozeUntil(byId['until']!, NOW)).toBeNull();
  });
});

describe('kanal tercihi normalizasyonu', () => {
  it('tanınmayan satırlar ve sunucu ad alanı kanal listesine sızmaz', () => {
    for (const raw of [null, undefined, 'c-1', 42, [], {}, { channelId: '' }, { channelId: 'server:srv-1' }]) {
      expect(normalizePref(raw)).toBeNull();
    }
  });

  it('bilinmeyen seviye `default`a, geçersiz muteUntil `null`a düşer', () => {
    expect(normalizePref({ channelId: 'c-1', level: 'scream', muteUntil: 'yarın' }))
      .toEqual({ channelId: 'c-1', level: 'default', muteUntil: null });
    expect(normalizePref({ channelId: 'c-1' }))
      .toEqual({ channelId: 'c-1', level: 'default', muteUntil: null });
    expect(normalizePref({ channelId: 'c-1', level: 'mute', muteUntil: -5 }).muteUntil).toBeNull();
    expect(normalizePref({ channelId: 'c-1', level: 'mute', muteUntil: Number.NaN }).muteUntil).toBeNull();
    expect(normalizePref({ channelId: 7, level: 'all' })!.channelId).toBe('7');
    expect(normalizePref({ channelId: 'c-1', level: 'mute', muteUntil: '1700000000000' }).muteUntil).toBe(1_700_000_000_000);
  });
});

describe('sessize alma durumu', () => {
  it('yalnız `mute` seviyesi sessizdir', () => {
    for (const level of ['all', 'mentions', 'default'] as const) {
      expect(isMuteActive(pref({ level, muteUntil: NOW + 10_000 }), NOW)).toBe(false);
      expect(describeMute(pref({ level }), NOW)).toBe('');
    }
  });

  it('süresiz sessizlik etkindir; süresi geçmiş erteleme etkin DEĞİLDİR', () => {
    expect(isMuteActive(pref({ muteUntil: null }), NOW)).toBe(true);
    expect(isMuteActive(pref({ muteUntil: NOW + 1 }), NOW)).toBe(true);
    expect(isMuteActive(pref({ muteUntil: NOW }), NOW)).toBe(false);
    expect(isMuteActive(pref({ muteUntil: NOW - 1 }), NOW)).toBe(false);
  });

  it('kalan süre dakika/saat/gün olarak anlatılır ve dolmuş erteleme ayrı metin verir', () => {
    expect(describeMute(pref({ muteUntil: null }), NOW)).toBe(t('notif_muted_indefinitely'));
    expect(describeMute(pref({ muteUntil: NOW - 1 }), NOW)).toBe(t('surface_erteleme_suresi_doldu_121782'));
    expect(describeMute(pref({ muteUntil: NOW + 15 * 60_000 }), NOW)).toBe(t('notif_muted_minutes', undefined, { count: 15 }));
    expect(describeMute(pref({ muteUntil: NOW + 3 * 3_600_000 }), NOW)).toBe(t('notif_muted_hours', undefined, { count: 3 }));
    expect(describeMute(pref({ muteUntil: NOW + 2 * 86_400_000 }), NOW)).toBe(t('notif_muted_days', undefined, { count: 2 }));
    // Sinirlar: 60 dk saat olur, 24 sa gun olur.
    expect(describeMute(pref({ muteUntil: NOW + 60 * 60_000 }), NOW)).toBe(t('notif_muted_hours', undefined, { count: 1 }));
    expect(describeMute(pref({ muteUntil: NOW + 24 * 3_600_000 }), NOW)).toBe(t('notif_muted_days', undefined, { count: 1 }));
  });
});

describe('dikkat kelimeleri normalizasyonu', () => {
  it('yalnız 2-32 karakterlik harf/rakam/alt çizgi/tire kabul edilir', () => {
    expect(normalizeWatchWord('  Bridge ')).toBe('bridge');
    expect(normalizeWatchWord('takım-2')).toBe('takım-2');
    expect(normalizeWatchWord('a'.repeat(32))).toBe('a'.repeat(32));

    for (const bad of ['a', '', '   ', 'a'.repeat(33), 'boşluk var', 'nokta.', '<img>', 7, null, undefined, {}]) {
      expect(normalizeWatchWord(bad)).toBeNull();
    }
  });

  it('liste tekilleştirilir, tavan uygulanır ve dizi olmayan girdi boş liste verir', () => {
    expect(normalizeWatchWords(['Bridge', 'bridge', 'BRIDGE', 'svelte'])).toEqual(['bridge', 'svelte']);
    expect(normalizeWatchWords(['ok', 'a', null, 'iki kelime', 'yes'])).toEqual(['ok', 'yes']);

    const many = Array.from({ length: MAX_WATCH_WORDS + 5 }, (_, i) => `kelime${i}`);
    expect(normalizeWatchWords(many)).toHaveLength(MAX_WATCH_WORDS);

    for (const bad of [null, 'bridge', 42, { 0: 'a', length: 1 }]) {
      expect(normalizeWatchWords(bad)).toEqual([]);
    }
  });
});

describe('tercih okuma', () => {
  it('sunucu kimliği yoksa ağa çıkılmaz ve boş anlık görüntü döner', async () => {
    const client = api(() => response({}));

    expect(await fetchPrefs(client, '')).toEqual({
      serverLevel: 'default', serverMuteUntil: null, channels: [], watchWords: [],
    });
    expect(client.calls).toHaveLength(0);
  });

  it('sunucu kimliği URL\'e kodlanır ve yanıt normalize edilir', async () => {
    const client = api(() => response({
      serverLevel: 'scream',
      serverMuteUntil: 'yarın',
      channels: [
        { channelId: 'c-1', level: 'mute', muteUntil: 1_700_000_000_000 },
        { channelId: 'server:srv-1', level: 'mute' },
        null,
        { channelId: '' },
      ],
      watchWords: ['Bridge', 'bridge', 'a'],
    }));

    const snapshot = await fetchPrefs(client, 'srv/1?x=2');

    expect(client.calls[0]!.url).toBe('/api/notification-prefs?serverId=srv%2F1%3Fx%3D2');
    expect(snapshot).toEqual({
      serverLevel: 'default',
      serverMuteUntil: null,
      channels: [{ channelId: 'c-1', level: 'mute', muteUntil: 1_700_000_000_000 }],
      watchWords: ['bridge'],
    });
  });

  it('kanal alanı dizi değilse boş kalır ve geçerli sunucu seviyesi korunur', async () => {
    const client = api(() => response({ serverLevel: 'mentions', serverMuteUntil: 123, channels: 'hepsi' }));

    expect(await fetchPrefs(client, 'srv-1')).toEqual({
      serverLevel: 'mentions', serverMuteUntil: 123, channels: [], watchWords: [],
    });
  });

  it('2xx dışı yanıt durum koduyla birlikte fırlatılır', async () => {
    const client = api(() => response({ error: 'nope' }, 403));

    await expect(fetchPrefs(client, 'srv-1')).rejects.toMatchObject({ message: 'HTTP 403', status: 403 });
  });
});

describe('tercih yazma', () => {
  it('sunucu seviyesi yazılır; `mute` dışındaki seviyelerde erteleme temizlenir', async () => {
    const client = api(() => response({}));

    await saveServerLevel(client, 'srv-1', 'mute', NOW + 60_000);
    expect(client.calls[0]!.url).toBe('/api/notification-prefs/server');
    expect(client.calls[0]!.init?.method).toBe('PUT');
    expect(bodyOf(client.calls[0]!.init)).toEqual({ serverId: 'srv-1', level: 'mute', muteUntil: NOW + 60_000 });

    await saveServerLevel(client, 'srv-1', 'all', NOW + 60_000);
    expect(bodyOf(client.calls[1]!.init)).toEqual({ serverId: 'srv-1', level: 'all', muteUntil: null });

    await saveServerLevel(client, 'srv-1', 'mute');
    expect(bodyOf(client.calls[2]!.init)).toEqual({ serverId: 'srv-1', level: 'mute', muteUntil: null });
  });

  it('kanal seviyesi aynı kuralı izler', async () => {
    const client = api(() => response({}));

    await saveChannelLevel(client, 'c-1', 'mute', 42);
    expect(bodyOf(client.calls[0]!.init)).toEqual({ channelId: 'c-1', level: 'mute', muteUntil: 42 });

    await saveChannelLevel(client, 'c-1', 'mentions', 42);
    expect(bodyOf(client.calls[1]!.init)).toEqual({ channelId: 'c-1', level: 'mentions', muteUntil: null });
  });

  it('varsayılana dönüş kanal kimliğini kodlar ve DELETE kullanır', async () => {
    const client = api(() => response({}));

    await resetChannel(client, 'c/1 #2');

    expect(client.calls[0]!.url).toBe('/api/notification-prefs/c%2F1%20%232');
    expect(client.calls[0]!.init?.method).toBe('DELETE');
  });

  it('yazma uçları başarısızlığı yutmaz', async () => {
    const failing = api(() => response({ error: 'x' }, 500));

    await expect(saveServerLevel(failing, 's', 'all')).rejects.toMatchObject({ status: 500 });
    await expect(saveChannelLevel(failing, 'c', 'all')).rejects.toMatchObject({ status: 500 });
    await expect(resetChannel(failing, 'c')).rejects.toMatchObject({ status: 500 });
    await expect(saveWatchWords(failing, 's', ['bridge'])).rejects.toMatchObject({ status: 500 });
  });
});

describe('dikkat kelimesi yazma', () => {
  it('geçerli liste gönderilir ve sunucunun döndürdüğü liste yeniden normalize edilir', async () => {
    const client = api(() => response({ watchWords: ['Bridge', 'bridge', 'svelte', 'a'] }));

    const result = await saveWatchWords(client, 'srv-1', ['bridge', 'svelte']);

    expect(client.calls[0]!.url).toBe('/api/notification-prefs/keywords');
    expect(bodyOf(client.calls[0]!.init)).toEqual({ serverId: 'srv-1', keywords: ['bridge', 'svelte'] });
    expect(result).toEqual(['bridge', 'svelte']);
  });

  it('geçersiz ya da tavanı aşan liste ağa hiç çıkmaz', async () => {
    const client = api(() => response({ watchWords: [] }));

    // Normalizasyon bir kelimeyi DUSURURSE girdi gecersizdir.
    await expect(saveWatchWords(client, 'srv-1', ['bridge', 'a'])).rejects.toThrow('Invalid watch words');
    await expect(saveWatchWords(client, 'srv-1', ['bridge', 'BRIDGE'])).rejects.toThrow('Invalid watch words');
    await expect(saveWatchWords(client, 'srv-1', Array.from({ length: MAX_WATCH_WORDS + 1 }, (_, i) => `kelime${i}`)))
      .rejects.toThrow('Invalid watch words');

    expect(client.calls).toHaveLength(0);
  });

  it('sunucu bozuk bir liste döndürürse boş liste ile devam edilir', async () => {
    const client = api(() => response({ watchWords: 'bridge' }));

    expect(await saveWatchWords(client, 'srv-1', ['bridge'])).toEqual([]);
  });
});
