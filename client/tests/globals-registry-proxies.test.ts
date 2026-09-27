// client/tests/globals-registry-proxies.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// `globals.ts` UYUMLULUK PROXY'LERİ — KANONİK DURUMA KÖPRÜ
// ════════════════════════════════════════════════════════════════════════════
//
// `currentServer` ve `currentServerChannels` artık kendi durumlarını TUTMAZ;
// her okuma kanonik kaydı (BridgeRegistry) sorgular. Bu köprünün sessizce
// bozulması iki farklı üretim kusuru üretir:
//
//   · İKİNCİ BİR DURUM KAYNAĞI — proxy yerel hedefe düşer ve eski/boş veriyle
//     çalışır; kullanıcı sunucu değiştirdiğinde eski sunucunun kanalları
//     görünmeye devam eder.
//   · SESSİZ YAZMA KAYBI — `set` tuzağı hedefsizken `false` döndürür; katı
//     modda bu bir TypeError'dır. Yutulursa yazma kaybolur ve hata hiçbir
//     yerde görünmez.
//
// `globals.test.ts` yalnız `getAPI` ve export yüzeyini ölçüyordu; proxy
// davranışı ve `getRtc` hiç ölçülmemişti.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

type Globals = typeof import('../js/core/globals.ts');

async function loadModule(): Promise<Globals> {
  return await import('../js/core/globals.ts');
}

const KEYS = ['currentServer', 'getCurrentServer', 'currentServerChannels', 'rtc'] as const;

beforeEach(() => {
  for (const key of KEYS) BridgeRegistry.unregister(key);
});

afterEach(() => {
  for (const key of KEYS) BridgeRegistry.unregister(key);
  vi.restoreAllMocks();
});

describe('currentServer proxy okuması', () => {
  it('kanonik kaydı doğrudan değer olarak okur', async () => {
    const { currentServer } = await loadModule();
    BridgeRegistry.register('currentServer', { _id: 'srv-1', name: 'Team' });

    expect(currentServer._id).toBe('srv-1');
    expect(currentServer.name).toBe('Team');
  });

  it('kayıt bir getter fonksiyonuysa çağırır — fonksiyonun kendisini döndürmez', async () => {
    const { currentServer } = await loadModule();
    let live: Record<string, unknown> | null = { _id: 'srv-1' };
    BridgeRegistry.register('currentServer', () => live);

    expect(currentServer._id).toBe('srv-1');
    // Kanonik durum degisince proxy ANINDA yeni degeri yansitir.
    live = { _id: 'srv-2' };
    expect(currentServer._id).toBe('srv-2');
  });

  it('birincil kayıt yoksa `getCurrentServer` kaydına düşer', async () => {
    const { currentServer } = await loadModule();
    BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-fallback' }));

    expect(currentServer._id).toBe('srv-fallback');
  });

  it('hiç kayıt yoksa ya da kayıt nesne değilse `undefined` verir; yerel kopyaya düşmez', async () => {
    const { currentServer } = await loadModule();
    expect(currentServer._id).toBeUndefined();

    for (const value of ['srv-1', 42, null, true]) {
      BridgeRegistry.register('currentServer', () => value);
      expect(currentServer._id).toBeUndefined();
    }
  });
});

describe('currentServer proxy yazması', () => {
  it('kanonik nesneye yazar; ikinci bir durum kopyası yaratmaz', async () => {
    const { currentServer } = await loadModule();
    const canonical: Record<string, unknown> = { _id: 'srv-1' };
    BridgeRegistry.register('currentServer', canonical);

    currentServer.name = 'Yeni Ad';

    expect(canonical.name).toBe('Yeni Ad');
    expect(currentServer.name).toBe('Yeni Ad');
  });

  it('getter kaydı üzerinden de canlı nesneye yazar', async () => {
    const { currentServer } = await loadModule();
    const canonical: Record<string, unknown> = { _id: 'srv-1' };
    BridgeRegistry.register('getCurrentServer', () => canonical);

    expect(Reflect.set(currentServer, 'icon', 'x')).toBe(true);
    expect(canonical.icon).toBe('x');
  });

  it('kanonik hedef yokken yazma sessizce başarılı olmaz', async () => {
    const { currentServer } = await loadModule();

    // Katı modda basarisiz `set` tuzagi TypeError firlatir: kayip yazma
    // GORULMEDEN gecemez.
    expect(() => { currentServer.name = 'kayıp'; }).toThrow(TypeError);
    expect(Reflect.set(currentServer, 'name', 'kayıp')).toBe(false);

    BridgeRegistry.register('currentServer', () => 'nesne değil');
    expect(Reflect.set(currentServer, 'name', 'kayıp')).toBe(false);
  });
});

describe('currentServerChannels proxy', () => {
  it('kanonik diziyi yansıtır ve dizi yöntemleri gerçek veriyle çalışır', async () => {
    const { currentServerChannels } = await loadModule();
    BridgeRegistry.register('currentServerChannels', [
      { _id: 'c1', name: 'genel', type: 'text' },
      { _id: 'c2', name: 'ses', type: 'voice', bitrate: 64_000 },
    ]);

    expect(currentServerChannels).toHaveLength(2);
    expect(currentServerChannels[1]?.name).toBe('ses');
    expect([...currentServerChannels].map(channel => channel._id)).toEqual(['c1', 'c2']);
    expect(currentServerChannels.find(channel => channel.type === 'voice')?.bitrate).toBe(64_000);
  });

  it('HasProperty soran dizi yöntemleri de canlı veriyi görür (delik döndürmez)', async () => {
    const { currentServerChannels } = await loadModule();
    BridgeRegistry.register('currentServerChannels', [
      { _id: 'c1', name: 'genel', type: 'text' },
      { _id: 'c2', name: 'ses', type: 'voice', bitrate: 64_000 },
      { _id: 'c3', name: 'duyuru', type: 'text' },
    ]);

    // `filter`/`map`/`forEach` once HasProperty(this, i) sorar; bu soruyu
    // `get` degil `has` tuzagi yanitlar. Tuzak yokken hepsi BOS donuyordu ve
    // Sunucu Ayarlari → Webhook sekmesindeki kanal listesi hep bos kaliyordu.
    expect(currentServerChannels.filter(channel => channel.type === 'text').map(channel => channel._id))
      .toEqual(['c1', 'c3']);
    expect(currentServerChannels.map(channel => channel._id)).toEqual(['c1', 'c2', 'c3']);

    let visited = 0;
    currentServerChannels.forEach(() => { visited += 1; });
    expect(visited).toBe(3);

    expect(currentServerChannels.some(channel => channel.type === 'voice')).toBe(true);
    expect(0 in currentServerChannels).toBe(true);
    expect(9 in currentServerChannels).toBe(false);
  });

  it('kayıt bir getter fonksiyonuysa çağrılır ve değişim anında görünür', async () => {
    const { currentServerChannels } = await loadModule();
    let live = [{ _id: 'c1' }];
    BridgeRegistry.register('currentServerChannels', () => live);

    expect(currentServerChannels).toHaveLength(1);
    live = [{ _id: 'c1' }, { _id: 'c2' }];
    expect(currentServerChannels).toHaveLength(2);
  });

  it('kayıt yoksa ya da dizi değilse boş listeye düşer', async () => {
    const { currentServerChannels } = await loadModule();
    expect(currentServerChannels).toHaveLength(0);

    for (const value of [null, 'kanal', { length: 3 }, 7]) {
      BridgeRegistry.register('currentServerChannels', () => value);
      expect(currentServerChannels).toHaveLength(0);
      expect([...currentServerChannels]).toEqual([]);
      expect(currentServerChannels.filter(() => true)).toEqual([]);
      expect(0 in currentServerChannels).toBe(false);
    }
  });
});

describe('getRtc()', () => {
  it('kayıtlı ses motorunu döndürür', async () => {
    const { getRtc } = await loadModule();
    const engine = { joinVoice: () => undefined };
    BridgeRegistry.register('rtc', engine);

    expect(getRtc()).toBe(engine);
  });

  it('motor yokken `null` döner — kurucu sınıfa DÜŞMEZ', async () => {
    const { getRtc } = await loadModule();

    // Sinif nesnesine dusulseydi istege bagli cagrilar sessiz no-op olurdu.
    expect(getRtc()).toBeNull();
  });
});
