// client/tests/channel-load.test.ts
// ChannelListManager.loadChannels — CANLI sözleşme testleri (gerçek bileşen).
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — CHANNEL_LOADCHANNELS_COVERAGE_GAP KAPATMA
// ════════════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: `ChannelListManager.svelte:104` içindeki `loadChannels` CANLI ve
// erişilebilir (app.ts:50 → channel-list-svelte.ts). Kanal listesini getiren
// TEK yol budur. Buna rağmen doğrudan hiçbir testi yoktu:
//   • tests/channel-list.test.ts yalnız ChannelItem/ChannelList sunumunu test eder
//     (loadChannels'a yalnız başlık yorumunda atıf yapar),
//   • emekliye ayrılan legacy süitlerin hiçbiri üretimi çalıştırmıyordu.
//
// Bu dosya GERÇEK bileşeni mount eder; yalnız dış sınırlar mock'lanır:
//   apiFetch (ağ) · readToken (oturum) · getAPI (ortam) ·
//   channel-list-svelte mount köprüsü (Svelte alt-görünüm) · logger.
// BridgeRegistry MOCK'LANMAZ — gerçek registry kullanılır ki
// `setCurrentServerChannels` yayılımı gerçekten ölçülebilsin.
//
// EN KRİTİK KAPSAM: `requestSeq` yarış koruması (:132-135, :147-150).
// Sunucu değiştirildiğinde geç dönen ESKİ yanıt yeni sunucunun kanallarını
// EZMEMELİDİR. Bu, kullanıcının yanlış sunucunun kanallarını görmesini
// engelleyen davranıştır ve başka hiçbir testte kapsanmıyordu.
//
// Üretim kodu bu turda DEĞİŞTİRİLMEMİŞTİR.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

const { mockApiFetch, mockReadToken, mockMountList } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockReadToken: vi.fn(() => 'test-token'),
  mockMountList: vi.fn(async () => true),
}));

vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: mockApiFetch }));
vi.mock('../js/core/auth-compat.js', () => ({ readToken: mockReadToken }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://localhost:3001' }));
vi.mock('../js/core/channel-list/channel-list-svelte.js', () => ({
  mountOrUpdateChannelList: mockMountList,
  unmountChannelList: vi.fn(),
}));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import ChannelListManager from '../js/core/ChannelListManager.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

type Channel = { _id: string; name: string; type?: string; serverId?: string };

/** Sunucunun kanal yanıtı. */
function okResponse(channels: Channel[]): Response {
  return { ok: true, status: 200, json: async () => channels } as unknown as Response;
}
function errResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

/** Elle çözülebilen yanıt — yarış senaryosu için. */
function deferredResponse(): { promise: Promise<Response>; resolve: (c: Channel[]) => void } {
  let resolve!: (c: Channel[]) => void;
  const promise = new Promise<Response>(res => {
    resolve = (channels: Channel[]) => res(okResponse(channels));
  });
  return { promise, resolve };
}

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;
let currentServerChannels: Channel[] = [];
let currentServer: { _id: string } | null = null;
let recordNavigation: ReturnType<typeof vi.fn>;

const REGISTRY_KEYS = [
  'setCurrentServerChannels', 'getCurrentServer', 'setCurrentChannel', 'recordNavigationLocation',
  'selectServer', 'toast', 'jumpToMessage', 'openChannelMenu', 'createChannelInCategory',
  'openCreateChannel', 'currentServer',
] as const;

/** Üretimdeki gerçek giriş noktası: `bridge:load-channels` olayı (:191-194). */
async function requestLoad(serverId: string): Promise<void> {
  document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId } }));
  await vi.waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
  await Promise.resolve();
  flushSync();
}

function lastUrl(): URL {
  return new URL(String(mockApiFetch.mock.calls.at(-1)?.[0]));
}

function requestedPaths(): string[] {
  return mockApiFetch.mock.calls.map(([raw]) => new URL(String(raw)).pathname);
}

/**
 * Askıda kalmış bir isteğin devamını SONUNA KADAR çalıştırır.
 * `await apiFetch(...)` → `await response.json()` → yarış kontrolü → atama
 * zinciri birden fazla mikrogörev sürer; yetersiz bekleme, korumayı hiç
 * çalıştırmadan "yeşil" bir test üretir (bu dosyada bir kez yaşandı ve
 * korumayı geçici kaldırarak doğrulandı).
 */
async function drainPending(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
}

beforeEach(() => {
  localStorage.clear();
  mockApiFetch.mockReset();
  mockReadToken.mockReturnValue('test-token');
  mockMountList.mockClear();
  currentServerChannels = [];
  currentServer = null;
  recordNavigation = vi.fn();

  host = document.createElement('div');
  document.body.appendChild(host);

  BridgeRegistry.register('setCurrentServerChannels', ((c: Channel[]) => { currentServerChannels = c ?? []; }) as AnyFn);
  BridgeRegistry.register('getCurrentServer', (() => currentServer) as AnyFn);
  BridgeRegistry.register('setCurrentChannel', ((): void => {}) as AnyFn);
  BridgeRegistry.register('recordNavigationLocation', recordNavigation as AnyFn);

  instance = mount(ChannelListManager, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  for (const k of REGISTRY_KEYS) BridgeRegistry.unregister(k);
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// İstek kurulumu
// ════════════════════════════════════════════════════════════════════════════
describe('loadChannels — istek sözleşmesi', () => {
  it('sunucu kapsamlı doğru uca gider', async () => {
    mockApiFetch.mockResolvedValue(okResponse([]));

    await requestLoad('srv-1');

    expect(requestedPaths()).toEqual([
      '/api/servers/srv-1/channels',
      '/api/servers/srv-1/categories',
    ]);
  });

  it('sunucu kimliği URL için KODLANIR', async () => {
    // encodeURIComponent (:129) — özel karakter yol yapısını bozmamalı.
    mockApiFetch.mockResolvedValue(okResponse([]));

    await requestLoad('srv/../evil');

    expect(String(mockApiFetch.mock.calls.at(-1)?.[0])).toContain('srv%2F..%2Fevil');
  });

  it('oturum belirteci yoksa istek ATILMAZ', async () => {
    mockReadToken.mockReturnValue(null as unknown as string);

    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-1' } }));
    await Promise.resolve();
    flushSync();

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('boş sunucu kimliği istek ATMAZ', async () => {
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: '' } }));
    await Promise.resolve();
    flushSync();

    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Başarılı sonuç yayılımı
// ════════════════════════════════════════════════════════════════════════════
describe('loadChannels — sonuç yayılımı', () => {
  it('kanallar AppState sınırına aktarılır', async () => {
    const channels = [{ _id: 'c1', name: 'genel', type: 'text' }];
    mockApiFetch.mockResolvedValue(okResponse(channels));

    await requestLoad('srv-1');

    expect(currentServerChannels).toEqual(channels);
  });

  it('dizi olmayan yanıt boş listeye indirgenir (fail-safe)', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ oops: true }) } as unknown as Response);

    await requestLoad('srv-1');

    expect(currentServerChannels).toEqual([]);
  });

  it('görünüm gerçek kanallarla güncellenir', async () => {
    const channels = [{ _id: 'c1', name: 'genel', type: 'text' }];
    mockApiFetch.mockResolvedValue(okResponse(channels));

    await requestLoad('srv-1');

    const props = mockMountList.mock.calls.at(-1)?.[1] as { channels: Channel[] };
    expect(props.channels).toEqual(channels);
  });

  it('kategori ucu askıda kalsa da yetkili kanal listesi hemen gösterilir', async () => {
    const neverCategories = new Promise<Response>(() => {});
    const channels = [{ _id: 'c1', name: 'genel', type: 'text' }];
    mockApiFetch
      .mockResolvedValueOnce(okResponse(channels))
      .mockReturnValueOnce(neverCategories);

    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-1' } }));

    await vi.waitFor(() => expect(currentServerChannels).toEqual(channels));
    const rendered = mockMountList.mock.calls
      .map((call) => call[1] as { channels: Channel[] })
      .some((props) => props.channels.some((channel) => channel._id === 'c1'));
    expect(rendered).toBe(true);
  });

  it('kategori ağ hatası kanalları gizlemez', async () => {
    const channels = [{ _id: 'c1', name: 'genel', type: 'text' }];
    mockApiFetch
      .mockResolvedValueOnce(okResponse(channels))
      .mockRejectedValueOnce(new Error('category service down'));

    await requestLoad('srv-1');

    await vi.waitFor(() => expect(currentServerChannels).toEqual(channels));
    expect(host.textContent ?? '').not.toMatch(/kanallar yüklenemedi/i);
  });

  it('navigateToChannel başarıyı döndürür ve yalnız kimlik tabanlı konumu kaydeder', async () => {
    const channels = [
      { _id: 'c1', name: 'genel', type: 'text' },
      { _id: 'c2', name: 'tasarım', type: 'text' },
    ];
    currentServer = { _id: 'srv-1' };
    mockApiFetch.mockResolvedValue(okResponse(channels));
    await requestLoad('srv-1');
    recordNavigation.mockClear(); // otomatik ilk kanal baseline'ını ayır

    const reached = await BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'c2', 'message-2');

    expect(reached).toBe(true);
    expect(recordNavigation).toHaveBeenCalledWith({
      type: 'channel', channelId: 'c2', messageId: 'message-2', server: { _id: 'srv-1', name: undefined },
    });
    expect(JSON.stringify(recordNavigation.mock.calls)).not.toMatch(/content|token|secret/i);
  });

  it('artık görünmeyen kanal için false döndürür ve history kaydı üretmez', async () => {
    currentServer = { _id: 'srv-1' };
    mockApiFetch.mockResolvedValue(okResponse([{ _id: 'c1', name: 'genel', type: 'text' }]));
    await requestLoad('srv-1');
    recordNavigation.mockClear();

    const reached = await BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'revoked-channel');

    expect(reached).toBe(false);
    expect(recordNavigation).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Yinelenen istek koruması
// ════════════════════════════════════════════════════════════════════════════
describe('loadChannels — yinelenen istek koruması', () => {
  it('aynı sunucu için ikinci istek ATILMAZ', async () => {
    mockApiFetch.mockResolvedValue(okResponse([{ _id: 'c1', name: 'genel', type: 'text' }]));
    await requestLoad('srv-1');
    expect(mockApiFetch).toHaveBeenCalledTimes(2);

    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-1' } }));
    await Promise.resolve();
    flushSync();

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it('registry force yolu aynı sunucu için YENİDEN yükler', async () => {
    // BridgeRegistry.register('loadChannels', …) force=true ile çağırır (:200).
    mockApiFetch.mockResolvedValue(okResponse([{ _id: 'c1', name: 'genel', type: 'text' }]));
    await requestLoad('srv-1');
    expect(mockApiFetch).toHaveBeenCalledTimes(2);

    BridgeRegistry.call('loadChannels', 'srv-1');
    await vi.waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(4));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Sunucu değişimi
// ════════════════════════════════════════════════════════════════════════════
describe('loadChannels — sunucu değişimi', () => {
  it('geçişte önceki sunucunun kanalları ANINDA temizlenir', async () => {
    mockApiFetch.mockResolvedValue(okResponse([{ _id: 'c1', name: 'eski', type: 'text' }]));
    await requestLoad('srv-1');
    expect(currentServerChannels).toHaveLength(1);

    // Yeni sunucu isteği askıda kalsın; temizlik yanıttan ÖNCE olmalı.
    const pending = deferredResponse();
    mockApiFetch.mockReturnValue(pending.promise);
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-2' } }));
    await Promise.resolve();
    flushSync();

    expect(currentServerChannels).toEqual([]);   // eski liste bir an bile kalmaz
  });
});

// ════════════════════════════════════════════════════════════════════════════
// YARIŞ KORUMASI — en kritik sözleşme (:132-135, :147-150)
// ════════════════════════════════════════════════════════════════════════════
describe('loadChannels — bayat yanıt yarış koruması', () => {
  it('geç dönen ESKİ yanıt yeni sunucunun kanallarını EZEMEZ', async () => {
    const slowOld = deferredResponse();
    const fastNew = deferredResponse();

    // 1) srv-1 isteği başlar ve askıda kalır.
    mockApiFetch
      .mockReturnValueOnce(slowOld.promise)
      .mockResolvedValueOnce(okResponse([]));
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-1' } }));
    await vi.waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));

    // 2) Kullanıcı srv-2'ye geçer; bu istek önce tamamlanır.
    mockApiFetch
      .mockReturnValueOnce(fastNew.promise)
      .mockResolvedValueOnce(okResponse([]));
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-2' } }));
    await vi.waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(4));

    fastNew.resolve([{ _id: 'c-new', name: 'yeni-sunucu', type: 'text' }]);
    await vi.waitFor(() => expect(currentServerChannels).toHaveLength(1));
    expect(currentServerChannels[0]._id).toBe('c-new');

    // 3) ŞİMDİ eski srv-1 yanıtı geç gelir — yok sayılmalı.
    slowOld.resolve([{ _id: 'c-old', name: 'eski-sunucu', type: 'text' }]);
    await drainPending();

    expect(currentServerChannels).toHaveLength(1);
    expect(currentServerChannels[0]._id).toBe('c-new');   // bayat yanıt EZMEDİ
  });

  it('bayat isteğin HATASI da güncel durumu bozmaz', async () => {
    const slowOld = deferredResponse();
    let rejectOld!: (e: Error) => void;
    const failingOld = new Promise<Response>((_, rej) => { rejectOld = rej; });
    void slowOld;

    mockApiFetch
      .mockReturnValueOnce(failingOld)
      .mockResolvedValueOnce(okResponse([]));
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-1' } }));
    await vi.waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));

    mockApiFetch
      .mockResolvedValueOnce(okResponse([{ _id: 'c-new', name: 'yeni', type: 'text' }]))
      .mockResolvedValueOnce(okResponse([]));
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-2' } }));
    await vi.waitFor(() => expect(currentServerChannels).toHaveLength(1));

    rejectOld(new Error('network'));
    await drainPending();

    expect(currentServerChannels[0]._id).toBe('c-new');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Hata yolu
// ════════════════════════════════════════════════════════════════════════════
describe('loadChannels — hata yolu', () => {
  it('HTTP hatası kullanıcıya görünür durum üretir', async () => {
    mockApiFetch.mockResolvedValue(errResponse(500));

    await requestLoad('srv-1');
    await vi.waitFor(() => {
      expect(host.textContent ?? '').toMatch(/HTTP 500|yüklenemedi|hata/i);
    });
  });

  it('hata sonrası kanal durumu sessizce BOZULMAZ', async () => {
    mockApiFetch.mockResolvedValue(errResponse(403));

    await requestLoad('srv-1');

    expect(currentServerChannels).toEqual([]);
  });
});

describe('ChannelListManager — malformed data and lifecycle isolation', () => {
  it('bozuk collapsed depolama şekli mount sırasında çökmez; yalnız güvenli string anahtarları taşır', async () => {
    unmount(instance!);
    instance = null;
    localStorage.setItem('bridge_collapsed_cats', JSON.stringify({ not: 'iterable' }));

    expect(() => {
      instance = mount(ChannelListManager, { target: host });
      flushSync();
    }).not.toThrow();

    unmount(instance!);
    instance = null;
    localStorage.setItem('bridge_collapsed_cats', JSON.stringify(['TEAM', 7, '__proto__', '', 'TEAM']));
    instance = mount(ChannelListManager, { target: host });
    flushSync();
    mockApiFetch.mockResolvedValue(okResponse([]));
    await requestLoad('srv-safe');

    const props = mockMountList.mock.calls.at(-1)?.[1] as { collapsedCategoryKeys: Set<string> };
    expect([...props.collapsedCategoryKeys]).toEqual(['TEAM']);
  });

  it('malformed ve yinelenen kanal/kategori kayıtlarını kanonik state ve keyed view öncesi eler', async () => {
    mockApiFetch
      .mockResolvedValueOnce({
        ok: true, status: 200, json: async () => [
          null,
          { _id: {}, name: 'bad-id' },
          { _id: 'missing-name' },
          { _id: 'c1', name: 'genel', type: 4, category: '__proto__', categoryId: '__proto__' },
          { _id: 'c1', name: 'duplicate' },
          { _id: 'c2', name: 'tasarım', categoryId: 'cat-1' },
        ],
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200, json: async () => [
          null,
          { _id: '__proto__', name: 'poison', position: 1 },
          { _id: 'cat-1', name: 'Takım', position: 'first' },
          { _id: 'cat-1', name: 'duplicate', position: 2 },
          { _id: 'nameless', position: 3 },
        ],
      } as unknown as Response);

    await requestLoad('srv-1');
    await vi.waitFor(() => {
      const props = mockMountList.mock.calls.at(-1)?.[1] as { categories: Array<{ _id: string; position: number }> };
      expect(props.categories).toEqual([{ _id: 'cat-1', name: 'Takım', position: 0, collapsed: undefined }]);
    });

    expect(currentServerChannels).toEqual([
      { _id: 'c1', name: 'genel' },
      { _id: 'c2', name: 'tasarım', categoryId: 'cat-1' },
    ]);
  });

  it('string olmayan event sunucu kimliğini URL sınırına sokmaz', async () => {
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: { toString: () => 'evil' } } }));
    await Promise.resolve();
    flushSync();

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('logout, uçuşta kalan eski kullanıcının kanal yanıtını ve seçimini geçersiz kılar', async () => {
    const pending = deferredResponse();
    mockApiFetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(okResponse([]));
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'tenant-a' } }));
    await vi.waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    expect(currentServerChannels).toEqual([]);

    pending.resolve([{ _id: 'private-a', name: 'tenant-a-private', type: 'text' }]);
    await drainPending();
    expect(currentServerChannels).toEqual([]);
    expect(await BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'private-a')).toBe(false);
  });

  it('unmount, geç dönen yanıtın paylaşılan AppState sahibine yazmasını engeller', async () => {
    const pending = deferredResponse();
    mockApiFetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(okResponse([]));
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'tenant-a' } }));
    await vi.waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));

    unmount(instance!);
    instance = null;
    pending.resolve([{ _id: 'late', name: 'late-private', type: 'text' }]);
    await drainPending();

    expect(currentServerChannels).toEqual([]);
    expect(BridgeRegistry.has('navigateToChannel')).toBe(false);
  });

  it('sunucular arası hedefi ancak yeni yetkili liste geldikten sonra seçer ve mesajı açar', async () => {
    mockApiFetch.mockResolvedValue(okResponse([{ _id: 'c1', name: 'genel', type: 'text' }]));
    await requestLoad('srv-1');

    const selectServer = vi.fn();
    const jump = vi.fn();
    const targetServer = { _id: 'srv-2', name: 'İkinci' };
    BridgeRegistry.register('selectServer', selectServer);
    BridgeRegistry.register('jumpToMessage', jump);
    const navigation = BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'c2', 'm2', targetServer)!;
    expect(selectServer).toHaveBeenCalledWith(targetServer);

    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue(okResponse([{ _id: 'c2', name: 'özel', type: 'text' }]));
    await requestLoad('srv-2');

    expect(await navigation).toBe(true);
    expect(jump).toHaveBeenCalledWith('m2');
  });

  // P4 (MEASURED, Android 14 emulator): a cold `bridge://channel/<id>` found the target server
  // already selected and its channel list in flight; the empty list was read as "no such
  // channel", a "not available" toast was shown and the first text channel won.
  it('P4: a target on the current server waits for its in-flight list instead of failing', async () => {
    const pending = deferredResponse();
    mockApiFetch.mockImplementation(() => pending.promise);
    const toast = vi.fn();
    const setChannel = vi.fn();
    BridgeRegistry.register('toast', toast);
    BridgeRegistry.register('setCurrentChannel', setChannel);
    await requestLoad('srv-1');

    const navigation = BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'c2', undefined, { _id: 'srv-1' })!;
    pending.resolve([{ _id: 'c1', name: 'genel', type: 'text' }, { _id: 'c2', name: 'hedef', type: 'text' }]);
    await drainPending();

    expect(await navigation).toBe(true);
    expect(toast).not.toHaveBeenCalled();
    const selected = setChannel.mock.calls.map(([c]) => (c as Channel | null)?._id ?? null).filter(Boolean);
    expect(selected).toEqual(['c2']);
  });

  it('P4: a channel missing from the arrived list is still refused (no permission bypass)', async () => {
    const pending = deferredResponse();
    mockApiFetch.mockImplementation(() => pending.promise);
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast);
    await requestLoad('srv-1');

    const navigation = BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'hidden', undefined, { _id: 'srv-1' })!;
    pending.resolve([{ _id: 'c1', name: 'genel', type: 'text' }]);
    await drainPending();

    expect(await navigation).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('kategori collapse tercihini güvenli ve yinelenmesiz olarak kalıcılaştırır', async () => {
    mockApiFetch.mockResolvedValue(okResponse([{ _id: 'c1', name: 'genel', type: 'text' }]));
    await requestLoad('srv-1');
    const props = mockMountList.mock.calls.at(-1)?.[1] as { onToggleCategory: (key: string) => void };

    props.onToggleCategory('TEAM');
    expect(JSON.parse(localStorage.getItem('bridge_collapsed_cats')!)).toEqual(['TEAM']);
    props.onToggleCategory('TEAM');
    expect(JSON.parse(localStorage.getItem('bridge_collapsed_cats')!)).toEqual([]);
  });
});

describe('ChannelListManager — deep view callback and selection contracts', () => {
  it('wires optional menu/category/create owners and persists both collapse directions', async () => {
    const openMenu = vi.fn();
    const createInCategory = vi.fn();
    const openCreate = vi.fn();
    BridgeRegistry.register('openChannelMenu', openMenu);
    BridgeRegistry.register('createChannelInCategory', createInCategory);
    BridgeRegistry.register('openCreateChannel', openCreate);
    mockApiFetch.mockResolvedValue(okResponse([{ _id: 'c1', name: 'general', type: 'text' }]));
    await requestLoad('srv-callbacks');
    const props = mockMountList.mock.calls.at(-1)?.[1] as {
      onOpenMenu?: (id: string, name: string, event: Event) => void;
      onCreateChannel?: () => void;
      onCreateInCategory?: (id: string, event: Event) => void;
      onToggleCategory: (key: string) => void;
    };
    const event = new Event('click');
    props.onOpenMenu?.('c1', 'general', event);
    props.onCreateInCategory?.('cat1', event);
    props.onCreateChannel?.();
    expect(openMenu).toHaveBeenCalledWith('c1', 'general', event);
    expect(createInCategory).toHaveBeenCalledWith('cat1', event);
    expect(openCreate).toHaveBeenCalledOnce();

    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => props.onToggleCategory('cat1')).not.toThrow();
    storage.mockRestore();
    props.onToggleCategory('cat1');
    expect(JSON.parse(localStorage.getItem('bridge_collapsed_cats')!)).toEqual([]);
  });

  it('keeps optional callbacks absent, contains view-mount failure, and reads invalid JSON safely', async () => {
    unmount(instance!);
    instance = null;
    localStorage.setItem('bridge_collapsed_cats', '{not-json');
    mockMountList.mockResolvedValueOnce(false);
    instance = mount(ChannelListManager, { target: host });
    flushSync();
    mockApiFetch.mockResolvedValue(okResponse([]));
    await requestLoad('srv-no-owners');
    const props = mockMountList.mock.calls.at(-1)?.[1] as {
      onOpenMenu?: unknown; onCreateInCategory?: unknown; collapsedCategoryKeys: Set<string>;
    };
    expect(props.onOpenMenu).toBeUndefined();
    expect(props.onCreateInCategory).toBeUndefined();
    expect([...props.collapsedCategoryKeys]).toEqual([]);
  });

  it('sanitizes every optional channel field and category count variant', async () => {
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [
        [],
        { _id: 'valid', name: 'Valid', type: 'forum', topic: 'Topic', category: 'Group', categoryId: null, position: 4 },
        { _id: 'bad-optional', name: 'Bad', type: 7, topic: {}, category: 'constructor', categoryId: 8, position: Infinity },
      ] } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [
        [], {}, { _id: 'cat', name: 'Category', position: 3, collapsed: true },
        { _id: 'cat2', name: 'Default position', position: NaN, collapsed: 'yes' },
      ] } as unknown as Response);
    await requestLoad('srv-sanitize');
    await vi.waitFor(() => {
      const props = mockMountList.mock.calls.at(-1)?.[1] as { categories: unknown[] };
      expect(props.categories).toHaveLength(2);
    });
    expect(currentServerChannels).toEqual([
      { _id: 'valid', name: 'Valid', type: 'forum', topic: 'Topic', category: 'Group', categoryId: null, position: 4 },
      { _id: 'bad-optional', name: 'Bad' },
    ]);
    const props = mockMountList.mock.calls.at(-1)?.[1] as { categories: Array<Record<string, unknown>> };
    expect(props.categories).toEqual([
      { _id: 'cat', name: 'Category', position: 3, collapsed: true },
      { _id: 'cat2', name: 'Default position', position: 0, collapsed: undefined },
    ]);
  });

  it('updates real header fallbacks and distinguishes all supported icon kinds', async () => {
    document.body.insertAdjacentHTML('beforeend', '<span id="ch-h-icon"></span><span id="ch-h-name"></span><span id="ch-h-topic"></span>');
    const setCurrent = vi.fn();
    BridgeRegistry.register('setCurrentChannel', setCurrent);
    const types = ['voice', 'forum', 'stage', 'announcement', 'unknown'] as const;
    mockApiFetch.mockResolvedValue(okResponse(types.map((type, index) => ({
      _id: `c${index}`, name: `Channel ${index}`, type, ...(index === 0 ? { topic: 'Voice topic' } : {}),
    }))));
    await requestLoad('srv-icons');
    for (let index = 0; index < types.length; index += 1) {
      BridgeRegistry.call('selectChannel', { _id: `c${index}`, name: `Channel ${index}`, type: types[index] });
      const expected = ['voice', 'forum', 'stage', 'announcement', 'text'][index];
      expect(document.getElementById('ch-h-icon')?.dataset.channelType).toBe(expected);
    }
    expect(document.getElementById('ch-h-topic')?.textContent).toBe('');
    expect(setCurrent).toHaveBeenCalledTimes(5);
  });

  it('rejects invalid selection/history IDs and re-emits only same voice/stage selections', async () => {
    mockApiFetch.mockResolvedValue(okResponse([
      { _id: 'voice', name: 'Voice', type: 'voice' },
      { _id: 'stage', name: 'Stage', type: 'stage' },
      { _id: 'text', name: 'Text', type: 'text' },
    ]));
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<{ channelId: string }>).detail.channelId);
    document.addEventListener('bridge:channel-selected', listener);
    await requestLoad('srv-select');
    events.length = 0;

    BridgeRegistry.call('selectChannel', null);
    BridgeRegistry.call('selectChannel', { _id: '', name: 'bad' });
    BridgeRegistry.call('selectChannel', { _id: 'voice', name: 'Voice', type: 'voice' });
    BridgeRegistry.call('selectChannel', { _id: 'voice', name: 'Voice', type: 'voice' });
    BridgeRegistry.call('selectChannel', { _id: 'stage', name: 'Stage', type: 'stage' });
    BridgeRegistry.call('selectChannel', { _id: 'stage', name: 'Stage', type: 'stage' });
    BridgeRegistry.call('selectChannel', { _id: 'text', name: 'Text', type: 'text' });
    BridgeRegistry.call('selectChannel', { _id: 'text', name: 'Text', type: 'text' });
    document.removeEventListener('bridge:channel-selected', listener);
    expect(events.filter(id => id === 'voice')).toHaveLength(2);
    expect(events.filter(id => id === 'stage')).toHaveLength(2);
    expect(events.filter(id => id === 'text')).toHaveLength(1);

    const reached = await BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'text', '   ');
    expect(reached).toBe(true);
    expect(recordNavigation).toHaveBeenLastCalledWith(expect.not.objectContaining({ messageId: expect.anything() }));
  });

  it('records legacy-server and no-server location variants without requiring an owner', async () => {
    mockApiFetch.mockResolvedValue(okResponse([
      { _id: 'c1', name: 'One', type: 'text' }, { _id: 'c2', name: 'Two', type: 'text' }, { _id: 'c3', name: 'Three', type: 'text' },
    ]));
    await requestLoad('srv-location');
    BridgeRegistry.unregister('getCurrentServer');
    BridgeRegistry.register('currentServer', () => ({ _id: 'legacy', name: 'Legacy' }));
    BridgeRegistry.call('selectChannel', { _id: 'c2', name: 'Two', type: 'text' });
    expect(recordNavigation).toHaveBeenLastCalledWith(expect.objectContaining({ server: { _id: 'legacy', name: 'Legacy' } }));

    BridgeRegistry.unregister('currentServer');
    BridgeRegistry.call('selectChannel', { _id: 'c3', name: 'Three', type: 'text' });
    expect(recordNavigation).toHaveBeenLastCalledWith({ type: 'channel', channelId: 'c3' });
    BridgeRegistry.unregister('recordNavigationLocation');
    expect(() => BridgeRegistry.call('selectChannel', { _id: 'c4', name: 'Four', type: 'text' })).not.toThrow();
  });
});

describe('ChannelListManager — deep navigation failure and teardown contracts', () => {
  it('rejects invalid navigation and cross-server navigation without a server owner', async () => {
    mockApiFetch.mockResolvedValue(okResponse([]));
    await requestLoad('srv-current');
    expect(await BridgeRegistry.call<Promise<boolean>>('navigateToChannel', '')).toBe(false);
    expect(await BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'missing', undefined, { _id: 'srv-other' })).toBe(false);
  });

  it('replaces a pending cross-server intent and fails a missing destination after authorized load', async () => {
    const selectServer = vi.fn();
    const toast = vi.fn();
    BridgeRegistry.register('selectServer', selectServer);
    BridgeRegistry.register('toast', toast);
    mockApiFetch.mockResolvedValue(okResponse([]));
    await requestLoad('srv-current');
    const first = BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'old-target', undefined, { _id: 'srv-old' })!;
    const second = BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'new-target', undefined, { _id: 'srv-new' })!;
    expect(await first).toBe(false);

    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue(okResponse([{ _id: 'different', name: 'Different', type: 'text' }]));
    await requestLoad('srv-new');
    expect(await second).toBe(false);
    expect(toast).toHaveBeenCalledWith('Bu konuşma artık kullanılamıyor.', 'warning');
  });

  it('times out a cross-server intent exactly once and ignores its stale timer after replacement', async () => {
    vi.useFakeTimers();
    const selectServer = vi.fn();
    const toast = vi.fn();
    BridgeRegistry.register('selectServer', selectServer);
    BridgeRegistry.register('toast', toast);
    const navigation = BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'missing', undefined, { _id: 'srv-timeout' })!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await navigation).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('fails pending navigation on channel transport error, logout, and destroy', async () => {
    const selectServer = vi.fn();
    BridgeRegistry.register('selectServer', selectServer);
    const byError = BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'error-target', undefined, { _id: 'srv-error' })!;
    mockApiFetch.mockResolvedValue(errResponse(500));
    await requestLoad('srv-error');
    expect(await byError).toBe(false);

    const byLogout = BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'logout-target', undefined, { _id: 'srv-logout' })!;
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    expect(await byLogout).toBe(false);

    const byDestroy = BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'destroy-target', undefined, { _id: 'srv-destroy' })!;
    unmount(instance!);
    instance = null;
    expect(await byDestroy).toBe(false);
  });

  it('retries visible channel failures and delegates create only when its canonical owner exists', async () => {
    mockApiFetch.mockResolvedValueOnce(errResponse(503)).mockResolvedValueOnce(okResponse([]));
    await requestLoad('srv-retry');
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue(okResponse([]));
    (host.querySelector('[role="alert"] button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));

    expect(() => BridgeRegistry.call('createChannel')).not.toThrow();
    const openCreate = vi.fn();
    BridgeRegistry.register('openCreateChannel', openCreate);
    BridgeRegistry.call('createChannel');
    expect(openCreate).toHaveBeenCalledOnce();
  });

  it('uses current server on mount and ignores malformed load events', async () => {
    unmount(instance!);
    instance = null;
    currentServer = { _id: 'boot-server' };
    mockApiFetch.mockResolvedValue(okResponse([]));
    instance = mount(ChannelListManager, { target: host });
    flushSync();
    await vi.waitFor(() => expect(requestedPaths()).toContain('/api/servers/boot-server/channels'));
    const before = mockApiFetch.mock.calls.length;
    document.dispatchEvent(new CustomEvent('bridge:load-channels'));
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: null }));
    await Promise.resolve();
    expect(mockApiFetch.mock.calls).toHaveLength(before);
  });

  it('keeps retained load/select/view callbacks inert after teardown', async () => {
    mockApiFetch.mockResolvedValue(okResponse([{ _id: 'c1', name: 'One', type: 'text' }]));
    await requestLoad('srv-retained');
    const load = BridgeRegistry.get<(id?: string) => void>('loadChannels')!;
    const select = BridgeRegistry.get<(channel: Channel) => void>('selectChannel')!;
    const props = mockMountList.mock.calls.at(-1)?.[1] as { onToggleCategory: (key: string) => void };
    const callsBefore = mockApiFetch.mock.calls.length;
    unmount(instance!);
    instance = null;
    load('after-destroy');
    select({ _id: 'after', name: 'After', type: 'text' });
    props.onToggleCategory('after');
    await Promise.resolve();
    expect(mockApiFetch.mock.calls).toHaveLength(callsBefore);
  });

  it('ignores a stale category response after a newer server load wins', async () => {
    let resolveOldCategories!: (value: Response) => void;
    const oldCategories = new Promise<Response>(resolve => { resolveOldCategories = resolve; });
    mockApiFetch
      .mockResolvedValueOnce(okResponse([{ _id: 'old-channel', name: 'Old', type: 'text' }]))
      .mockReturnValueOnce(oldCategories);
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'old-server' } }));
    await vi.waitFor(() => expect(currentServerChannels.some(channel => channel._id === 'old-channel')).toBe(true));

    mockApiFetch
      .mockResolvedValueOnce(okResponse([{ _id: 'new-channel', name: 'New', type: 'text' }]))
      .mockResolvedValueOnce(okResponse([{ _id: 'new-category', name: 'New Category', position: 1 } as unknown as Channel]));
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'new-server' } }));
    await vi.waitFor(() => expect(currentServerChannels.some(channel => channel._id === 'new-channel')).toBe(true));
    resolveOldCategories(okResponse([{ _id: 'old-category', name: 'Old Category', position: 1 } as unknown as Channel]));
    await drainPending();
    const props = mockMountList.mock.calls.at(-1)?.[1] as { categories: Array<{ _id: string }> };
    expect(props.categories.map(category => category._id)).not.toContain('old-category');
  });

  it('normalizes non-Error transport failures and supports registry server-id fallback', async () => {
    mockApiFetch.mockRejectedValue('offline-string');
    await requestLoad('srv-string-error');
    expect(host.querySelector('[role="alert"]')).toHaveTextContent(/yüklenemedi/i);

    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue(okResponse([]));
    BridgeRegistry.call('loadChannels');
    await vi.waitFor(() => expect(requestedPaths()).toContain('/api/servers/srv-string-error/channels'));
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    const before = mockApiFetch.mock.calls.length;
    BridgeRegistry.call('loadChannels');
    await Promise.resolve();
    expect(mockApiFetch.mock.calls).toHaveLength(before);
  });

  it('records a same-channel permalink and delegates its direct jump owner', async () => {
    const jump = vi.fn();
    BridgeRegistry.register('jumpToMessage', jump);
    mockApiFetch.mockResolvedValue(okResponse([{ _id: 'c1', name: 'One', type: 'text' }]));
    await requestLoad('srv-direct-jump');
    recordNavigation.mockClear();
    expect(await BridgeRegistry.call<Promise<boolean>>('navigateToChannel', 'c1', 'message-direct')).toBe(true);
    expect(jump).toHaveBeenCalledWith('message-direct');
    expect(recordNavigation).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'c1', messageId: 'message-direct' }));
  });
});
