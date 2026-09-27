// client/tests/message-permalink.test.ts
//
// FAZ K+/4 — MESAJ KALICI BAĞLANTILARI.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUK
// ════════════════════════════════════════════════════════════════════════════
// Arama bir mesaja ATLAYABİLİYORDU ama kimse bir mesaja BAĞLANTI VEREMİYORDU.
// Sohbet ürününde bu günlük bir ihtiyaçtır.
//
// ── EN ÖNEMLİ İDDİA ───────────────────────────────────────────────────────
// Bağlantı bir ANAHTAR DEĞİLDİR. Yalnızca hedefi taşır; gidilebilirlik
// kanonik gezinme sahibi ve sunucu tarafından belirlenir. Bir bağlantı
// üretmek, o mesaja erişim vermez.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const registryMap: Record<string, unknown> = {};

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    has:  (k: string) => k in registryMap,
    call: (k: string, ...a: unknown[]) => {
      const v = registryMap[k];
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown)(...a) : v;
    },
    register:   (k: string, fn: unknown) => { registryMap[k] = fn; },
    unregister: (k: string) => { delete registryMap[k]; },
  },
}));

vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  buildPermalink, buildPermalinkPath, parsePermalink, copyToClipboard,
} from '../js/core/permalink/message-permalink.ts';

const LOC = { serverId: 's1', channelId: 'c1', messageId: 'm1' };

beforeEach(() => {
  for (const k of Object.keys(registryMap)) delete registryMap[k];
  vi.clearAllMocks();
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
});

afterEach(() => { vi.unstubAllGlobals(); });

// ════════════════════════════════════════════════════════════════════════════
describe('bağlantı üretimi', () => {
  it('sunucu / kanal / mesaj üçlüsünü taşır', () => {
    expect(buildPermalinkPath(LOC)).toBe('#/servers/s1/channels/c1/messages/m1');
  });

  it('SABIT bir adres GÖMMEZ — kaynak çağırandan gelir', () => {
    // Aynı örnek localhost, tünel ya da özel alan adından sunulabilir.
    expect(buildPermalink(LOC, 'https://bridge.example/app'))
      .toBe('https://bridge.example/app#/servers/s1/channels/c1/messages/m1');
  });

  it('mevcut hash ATILIR — bağlantılar üst üste binmez', () => {
    expect(buildPermalink(LOC, 'https://x.test/app#/servers/other/channels/z/messages/q'))
      .toBe('https://x.test/app#/servers/s1/channels/c1/messages/m1');
  });

  it('kimlikler URL için kaçılır', () => {
    const path = buildPermalinkPath({ serverId: 'a/b', channelId: 'c d', messageId: 'e?f' });
    expect(path).toContain('a%2Fb');
    expect(path).toContain('c%20d');
    expect(path).toContain('e%3Ff');
  });

  it('üretilen bağlantı geri ÇÖZÜLEBİLİR (round-trip)', () => {
    for (const loc of [LOC, { serverId: 'a-b_c', channelId: 'x.y', messageId: 'z:1' }]) {
      expect(parsePermalink(buildPermalinkPath(loc))).toEqual(loc);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('bağlantı çözümü', () => {
  it('geçerli yolu çözer', () => {
    expect(parsePermalink('#/servers/s1/channels/c1/messages/m1')).toEqual(LOC);
  });

  it('baştaki # olmadan da çalışır', () => {
    expect(parsePermalink('/servers/s1/channels/c1/messages/m1')).toEqual(LOC);
  });

  it('BİZE AİT OLMAYAN hash yok sayılır', () => {
    // Uygulamanın başka hash kullanımlarını çalmamak için.
    for (const hash of ['#/settings', '#section-2', '#', '', '#/servers/s1']) {
      expect(parsePermalink(hash)).toBeNull();
    }
  });

  it('BOZUK yol UYDURULMAZ', () => {
    // Yanlış hedefe gitmek, kullanıcıyı sessizce başka kanala götürürdü.
    for (const hash of [
      '#/servers/s1/channels/c1/messages',
      '#/servers/s1/channels/c1/messages/m1/extra',
      '#/server/s1/channel/c1/message/m1',
      '#/servers//channels/c1/messages/m1',
    ]) {
      expect(parsePermalink(hash)).toBeNull();
    }
  });

  it('bozuk yüzde kodlaması çökertmez', () => {
    expect(parsePermalink('#/servers/%E0%A4%A/channels/c1/messages/m1')).toBeNull();
  });

  it('beklenmeyen karakterli kimlik REDDEDİLİR', () => {
    // Rota metnine güvenilmez; şekli tanınmayan kimlik hedef olamaz.
    expect(parsePermalink('#/servers/<script>/channels/c1/messages/m1')).toBeNull();
    expect(parsePermalink(`#/servers/${'x'.repeat(200)}/channels/c1/messages/m1`)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('panoya kopyalama', () => {
  it('pano varsa yazar', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    expect(await copyToClipboard('https://x.test/#/a')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://x.test/#/a');
  });

  it('pano YOKSA sessizce başarılı DEMEZ', async () => {
    // Güvensiz bağlamda (http) `navigator.clipboard` yoktur; çağıran
    // kullanıcıya bağlantıyı elle kopyalatabilmelidir.
    vi.stubGlobal('navigator', {});
    expect(await copyToClipboard('x')).toBe(false);
  });

  it('pano hata fırlatırsa false döner', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    expect(await copyToClipboard('x')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('yönlendirici — kanonik sahibe devreder', () => {
  async function loadRouter() {
    vi.resetModules();
    return import('../js/core/permalink/permalink-router.ts');
  }

  it('kanonik gezinme sahibini kanal + MESAJ ile çağırır', async () => {
    const navigate = vi.fn(() => true);
    registryMap.navigateToChannel = navigate;
    registryMap.getAvailableServers = () => [{ _id: 's1', name: 'Takım' }];

    const { openLocation } = await loadRouter();
    expect(await openLocation(LOC)).toBe(true);
    expect(navigate).toHaveBeenCalledWith('c1', 'm1', { _id: 's1', name: 'Takım' });
  });

  it('İKİNCİ bir gezinme yolu KURMAZ', async () => {
    // Kanal seçiminin tek sahibi ChannelListManager'dır; arama sonuçları da
    // aynı sahibe gider. Ayrı bir yol zamanla ayrışırdı.
    registryMap.navigateToChannel = vi.fn(() => true);
    const { openLocation } = await loadRouter();
    await openLocation(LOC);

    expect(Object.keys(registryMap)).not.toContain('selectChannel');
  });

  it('ERİŞİLEMEYEN hedef kullanıcıya BİLDİRİLİR', async () => {
    // Sessiz başarısızlık, ürünün bozuk olduğu anlamına gelir.
    const toast = vi.fn();
    registryMap.navigateToChannel = () => false;
    registryMap.toast = toast;

    const { openLocation } = await loadRouter();
    expect(await openLocation(LOC)).toBe(false);
    expect(toast).toHaveBeenCalled();
    expect(String(toast.mock.calls[0]![0])).toMatch(/erişemiyorsunuz|mevcut değil/);
  });

  it('bağlantı ANAHTAR DEĞİLDİR — yetkiyi istemci vermez', async () => {
    // Sunucu/kanonik sahip reddederse bağlantı hiçbir kapı açmaz.
    const navigate = vi.fn(() => false);
    registryMap.navigateToChannel = navigate;
    registryMap.toast = vi.fn();

    const { openLocation } = await loadRouter();
    expect(await openLocation(LOC)).toBe(false);
    // Reddedilince BAŞKA bir yol denenmez.
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('sahip hiç hazır olmazsa zaman aşımıyla biter ve bildirir', async () => {
    vi.useFakeTimers();
    const toast = vi.fn();
    registryMap.toast = toast;

    const { openLocation } = await loadRouter();
    const promise = openLocation(LOC);
    await vi.advanceTimersByTimeAsync(13_000);

    expect(await promise).toBe(false);
    expect(toast).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('registry üzerinden açılabilir', async () => {
    registryMap.navigateToChannel = vi.fn(() => true);
    const { initPermalinkRouter } = await loadRouter();
    initPermalinkRouter();

    expect('openPermalink' in registryMap).toBe(true);
    expect(await (registryMap.openPermalink as (v: string) => Promise<boolean>)(
      '#/servers/s1/channels/c1/messages/m1')).toBe(true);
  });

  it('registry yolu da bozuk bağlantıyı reddeder', async () => {
    const navigate = vi.fn(() => true);
    registryMap.navigateToChannel = navigate;
    const { initPermalinkRouter } = await loadRouter();
    initPermalinkRouter();

    expect(await (registryMap.openPermalink as (v: string) => Promise<boolean>)('#/nonsense')).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sunucu listesi dizi degilse hedef ozeti olmadan guvenli bicimde gider', async () => {
    const navigate = vi.fn(() => true);
    registryMap.navigateToChannel = navigate;
    registryMap.getAvailableServers = () => ({ _id: 's1' });

    const { openLocation } = await loadRouter();
    expect(await openLocation(LOC)).toBe(true);
    expect(navigate).toHaveBeenCalledWith('c1', 'm1', undefined);
  });

  it('sunucu listesindeki eksik kayitlari atlayip hedefi bulur', async () => {
    const navigate = vi.fn(() => true);
    const server = { _id: 's1', name: 'Takim' };
    registryMap.navigateToChannel = navigate;
    registryMap.getAvailableServers = () => [null, {}, server];

    const { openLocation } = await loadRouter();
    await openLocation(LOC);
    expect(navigate).toHaveBeenCalledWith('c1', 'm1', server);
  });

  it('init idempotenttir ve registry yolu string olmayan degeri reddeder', async () => {
    registryMap.navigateToChannel = vi.fn(() => true);
    const { initPermalinkRouter } = await loadRouter();
    initPermalinkRouter();
    const firstOwner = registryMap.openPermalink;
    initPermalinkRouter();

    expect(registryMap.openPermalink).toBe(firstOwner);
    expect(await (firstOwner as (v: unknown) => Promise<boolean>)({ bad: true })).toBe(false);
  });

  it('acilista gelen gecerli hash adres cubugundan temizlenip acilir', async () => {
    const navigate = vi.fn(() => true);
    registryMap.navigateToChannel = navigate;
    window.history.replaceState(null, '', '#/servers/s1/channels/c1/messages/m1');

    const { initPermalinkRouter } = await loadRouter();
    initPermalinkRouter();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('c1', 'm1', undefined));
    expect(window.location.hash).toBe('');
  });

  it('bize ait olmayan hashchange olayini yok sayar', async () => {
    const navigate = vi.fn(() => true);
    registryMap.navigateToChannel = navigate;
    const { initPermalinkRouter } = await loadRouter();
    initPermalinkRouter();

    window.history.replaceState(null, '', '#/nonsense');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await Promise.resolve();

    expect(navigate).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/nonsense');
  });

  it('history adresi temizlemeyi reddetse de gecerli hedef acilir', async () => {
    const navigate = vi.fn(() => true);
    registryMap.navigateToChannel = navigate;
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new Error('history blocked');
    });
    window.location.hash = '#/servers/s1/channels/c1/messages/m1';

    const { initPermalinkRouter } = await loadRouter();
    initPermalinkRouter();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    replace.mockRestore();
  });
});
