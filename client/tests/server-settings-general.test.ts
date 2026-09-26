// client/tests/server-settings-general.test.ts
// FAZ C1.5 — GENEL SEKMESİ: GERÇEK KALICILIK.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// `serverSettingsStore.ts` içindeki kalıcılık SAHTEYDİ:
//     async saveGeneral() { return true; }
//     async saveSlug()    { return true; }
//     async saveMedia()   { return true; }
// Hiçbiri ağ isteği atmıyordu. Kullanıcı "Sunucu ayarları kaydedildi" toast'ı
// görüyor, hiçbir şey kalıcı olmuyordu. C1.4 bunu bulduğu için Genel sekmesi
// yayından çıkarıldı; bu paket gerçek sözleşmeyi kanıtlar.
//
// KANONİK SÖZLEŞME — `PATCH /api/servers/:sid` (routes/servers/core.ts:344)
//   yetki  : SAHİP-ONLY (403)
//   alanlar: `name` (≤50, trim) ve `icon` (≤10, XSS doğrulamalı)
//   hatalar: 400 / 403 / 404
//   yanıt  : güncellenmiş sunucu nesnesi
//
// `slug` ve Keşif/Gizlilik artık ayrı, gerçek API sözleşmelerine bağlıdır;
// sahte başarı yerine her yüzey kendi kalıcılığını doğrular.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// ── KOPYA METNİ TEST SABİTİ DEĞİLDİR ──────────────────────────────────────
// Ham hata metni (`'Sunucu hatası. Birazdan tekrar dene.'`) i18n sözlüğüne
// taşındığında (`error_server`, `error_network`) üretim doğru davranmaya
// devam etti, testler ise bir dizgenin harflerini ölçtüğü için kırmızıya
// döndü. Sözleşme "kanonik ve güvenli mesaj gösterilir"dir.
import { t } from '../js/core/i18n/index.ts';
import { createServerSettingsStore, isStillCurrentServer } from '../js/core/server-settings/stores/serverSettingsStore.ts';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const SRV = { _id: 'srv-A', id: 'srv-A', name: 'Eski Ad', icon: '🌐', ownerId: 'u1' };

let fetchMock: ReturnType<typeof vi.fn>;

/** apiFetch/getAPI sınırlarını taklit eder (store bunları dinamik import eder). */
vi.mock('../js/core/api-fetch.js', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://test' }));

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function errResponse(status: number, error: string) {
  return { ok: false, status, json: async () => ({ error }) } as unknown as Response;
}

/** Kanonik geçerli sunucuyu ayarlar (C1.2 sözleşmesi). */
function setCurrent(server: unknown): void {
  BridgeRegistry.register('getCurrentServer', () => server);
}

beforeEach(() => {
  fetchMock = vi.fn(async () => okResponse({ ...SRV, name: 'Yeni Ad' }));
  setCurrent({ ...SRV });
});

afterEach(() => {
  BridgeRegistry.unregister('getCurrentServer');
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// Gerçek kalıcılık
// ════════════════════════════════════════════════════════════════════════════
describe('C1.5 — Genel gerçek kalıcılık', () => {
  it('kaydetme GERÇEK bir PATCH isteği atar (sahte başarı yok)', async () => {
    const store = createServerSettingsStore({ ...SRV });
    store.setName('Yeni Ad');

    const ok = await store.saveGeneral();

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://test/api/servers/srv-A');
    expect((init as RequestInit).method).toBe('PATCH');
  });

  it('gövde YALNIZ arka ucun desteklediği alanları taşır', async () => {
    const store = createServerSettingsStore({ ...SRV });
    store.setName('Yeni Ad');

    await store.saveGeneral();

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(Object.keys(body)).toEqual(['name']);      // icon değişmedi → gönderilmez
    expect(body.name).toBe('Yeni Ad');
    // slug/discovery ayrı uçlardadır — Genel PATCH'e karışmamalı.
    expect(body).not.toHaveProperty('slug');
    expect(body).not.toHaveProperty('description');
  });

  it('değişiklik yokken istek ATILMAZ', async () => {
    const store = createServerSettingsStore({ ...SRV });

    const ok = await store.saveGeneral();

    expect(ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isDirty() gerçek değişimi yansıtır (Kaydet düğmesi buna bağlı)', () => {
    const store = createServerSettingsStore({ ...SRV });
    expect(store.isDirty()).toBe(false);

    store.setName('Farklı');
    expect(store.isDirty()).toBe(true);

    store.setName('Eski Ad');
    expect(store.isDirty()).toBe(false);
  });
});

describe('Final23 — slug ve keşif/gizlilik gerçek kalıcılık', () => {
  it('loadSlug kanonik GET sonucunu store ve preview alanına yükler', async () => {
    fetchMock = vi.fn(async () => okResponse({ slug: 'bridge-lab' }));
    const store = createServerSettingsStore({ ...SRV });
    await store.loadSlug();
    expect(fetchMock).toHaveBeenCalledWith('http://test/api/servers/srv-A/slug');
    expect(store.slug).toBe('bridge-lab');
    expect(store.slugPreview).toBe('bridge-lab');
  });

  it('saveSlug gerçek PUT atar ve sahte başarı üretmez', async () => {
    fetchMock = vi.fn(async () => okResponse({ slug: 'bridge-prod' }));
    const store = createServerSettingsStore({ ...SRV, slug: 'bridge-old' });
    store.setSlug('Bridge-Prod');
    expect(await store.saveSlug()).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://test/api/servers/srv-A/slug');
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ slug: 'bridge-prod' });
    expect(store.slug).toBe('bridge-prod');
  });

  it('saveSlug geçersiz değeri ağdan önce reddeder', async () => {
    const store = createServerSettingsStore({ ...SRV });
    store.setSlug('!!');
    expect(await store.saveSlug()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('saveDiscovery private/public ve kategori sözleşmesini PATCH eder', async () => {
    fetchMock = vi.fn(async () => okResponse({ ok: true }));
    const store = createServerSettingsStore({ ...SRV, discoverable: false, category: 'edu' });
    store.setDiscoverable(true);
    store.setCategory('education');
    expect(await store.saveDiscovery()).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://test/api/discover/settings');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      serverId: 'srv-A', discoverable: true, category: 'education',
    });
    expect(store.isDiscoveryDirty()).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Hata yolları — başarısızlık ASLA başarı sayılmaz
// ════════════════════════════════════════════════════════════════════════════
describe('C1.5 — hata davranışı', () => {
  it('arka uç 403 dönerse BAŞARI raporlanmaz', async () => {
    fetchMock = vi.fn(async () => errResponse(403, 'Only the server owner can rename it'));
    const store = createServerSettingsStore({ ...SRV });
    store.setName('Yeni Ad');

    const ok = await store.saveGeneral();

    expect(ok).toBe(false);
    expect(store.error).toBe('Bu işlem için yetkin yok.');
    expect(String(store.error)).not.toContain('owner');
  });

  it('arka uç 400 dönerse BAŞARI raporlanmaz', async () => {
    fetchMock = vi.fn(async () => errResponse(400, 'Server name too long (max 50)'));
    const store = createServerSettingsStore({ ...SRV });
    store.setName('x'.repeat(20));

    expect(await store.saveGeneral()).toBe(false);
  });

  it('ağ hatası BAŞARI raporlanmaz', async () => {
    fetchMock = vi.fn(async () => { throw new Error('offline'); });
    const store = createValidStore('Yeni Ad');

    expect(await store.saveGeneral()).toBe(false);
    expect(store.error).toBe(t('error_network'));
    expect(String(store.error)).not.toContain('offline');
  });

  it('boş ad istemcide reddedilir (geçersiz istek atılmaz)', async () => {
    const store = createServerSettingsStore({ ...SRV });
    store.setName('   ');

    expect(await store.saveGeneral()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('50 karakterden uzun ad istemcide reddedilir', async () => {
    const store = createServerSettingsStore({ ...SRV });
    store.setName('a'.repeat(51));

    expect(await store.saveGeneral()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function createValidStore(name: string) {
  const store = createServerSettingsStore({ ...SRV });
  store.setName(name);
  return store;
}

// ════════════════════════════════════════════════════════════════════════════
// GÜVENLİK — bayat sunucu / kimlik koruması
// ════════════════════════════════════════════════════════════════════════════
describe('C1.5 — bayat sunucu koruması', () => {
  it('GÜVENLİK: sunucu A → B değişince A’nın kirli verisi B’ye YAZILMAZ', async () => {
    const store = createServerSettingsStore({ ...SRV });   // A için açıldı
    store.setName('A-icin-yeni-ad');

    // Kullanıcı B sunucusuna geçiyor.
    setCurrent({ _id: 'srv-B', id: 'srv-B', name: 'B', ownerId: 'u1' });

    const ok = await store.saveGeneral();

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();      // hiçbir yere yazılmadı
    expect(String(store.error)).toMatch(/sunucu değişti/i);
  });

  it('GÜVENLİK: geçerli sunucu yoksa `/api/servers/undefined` OLUŞMAZ', async () => {
    BridgeRegistry.unregister('getCurrentServer');
    const store = createServerSettingsStore({ ...SRV });
    store.setName('Yeni');

    expect(await store.saveGeneral()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GÜVENLİK: çift gönderim eşzamanlı yinelenen istek üretmez', async () => {
    let resolveIt: (r: Response) => void = () => {};
    fetchMock = vi.fn(() => new Promise<Response>(r => { resolveIt = r; }));
    const store = createValidStore('Yeni Ad');

    const first = store.saveGeneral();
    // Store, apiFetch'i DİNAMİK import eder; ilk çağrının isteğe ulaşması
    // gerçek bir tur bekleyebilir — waitFor ile bekle.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const second = await store.saveGeneral();   // ilk istek hâlâ uçuyor
    expect(second).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);   // YİNELENEN istek yok

    resolveIt(okResponse({ ...SRV, name: 'Yeni Ad' }));
    await first;
  });
});

describe('C1.5 — store durum sözleşmesi ve seyrek yanıtlar', () => {
  it('string kimlikli başlangıcı ve tüm görünür setter değişimlerini abonelere yayınlar', async () => {
    setCurrent({ id: 'srv-string', name: 'Reloaded', icon: 'R' });
    const store = createServerSettingsStore('srv-string');
    const snapshots: Array<Record<string, unknown>> = [];
    const unsubscribe = store.subscribe(value => snapshots.push(value));

    store.setTab('media');
    store.setError('problem');
    store.setName('Draft');
    store.setIcon('I');
    store.setBannerUrl('https://example.test/banner.png');
    store.setIconUrl('https://example.test/icon.png');
    await store.loadSlug();

    expect(store.serverId).toBe('srv-string');
    expect(store.activeTab).toBe('media');
    expect(store.icon).toBe('I');
    expect(snapshots.at(-1)).toMatchObject({
      activeTab: 'media', error: 'problem', name: 'Draft', icon: 'I',
      bannerUrl: 'https://example.test/banner.png', iconUrl: 'https://example.test/icon.png',
    });

    await store.reload();
    expect(store.name).toBe('Reloaded');
    expect(store.icon).toBe('R');
    expect(snapshots.at(-1)).toMatchObject({ name: 'Reloaded', icon: 'R', error: null });
    unsubscribe();
  });

  it('reload geçerli sunucu kaybolduğunda yakalanmış taslağı değiştirmez', async () => {
    const store = createServerSettingsStore({ id: 'srv-id-only', name: 'Before' });
    setCurrent({ id: 'srv-id-only', name: 'Current' });
    expect(isStillCurrentServer('srv-id-only')).toBe(true);
    await store.reload();
    expect(store.name).toBe('Current');

    BridgeRegistry.unregister('getCurrentServer');
    store.setName('Keep');
    await store.reload();
    expect(store.name).toBe('Keep');
  });

  it('eksik isteğe bağlı alanları boş başlangıç değerlerine indirger ve ikon kirini algılar', () => {
    const store = createServerSettingsStore({ id: 'sparse' });
    expect(store).toMatchObject({
      serverId: 'sparse', name: '', icon: '', slug: '', bannerUrl: '', iconUrl: '',
    });
    expect(store.isDirty()).toBe(false);
    store.setIcon('🌉');
    expect(store.isDirty()).toBe(true);

    const anonymous = createServerSettingsStore({});
    expect(anonymous.serverId).toBe('');

    const nullIcon = createServerSettingsStore({ ...SRV });
    nullIcon.icon = null as never;
    expect(nullIcon.isDirty()).toBe(true);
  });

  it('yalnız legacy id ve eksik name/icon alanlarıyla da doğru kapsamda kaydeder', async () => {
    setCurrent({ id: 'legacy-id' });
    fetchMock = vi.fn(async () => okResponse({}));
    const store = createServerSettingsStore({ id: 'legacy-id' });
    store.setName('Legacy');
    store.setIcon('L');

    expect(await store.saveGeneral()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('http://test/api/servers/legacy-id', expect.any(Object));
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)))
      .toEqual({ name: 'Legacy', icon: 'L' });
  });

  it('yalnız ikon değiştiğinde yalnız desteklenen icon alanını PATCH eder', async () => {
    fetchMock = vi.fn(async () => okResponse({ ...SRV, icon: '🎯' }));
    const store = createServerSettingsStore({ ...SRV });
    store.setIcon('🎯');

    expect(await store.saveGeneral()).toBe(true);
    const payload = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(payload).toEqual({ icon: '🎯' });
    expect(store.icon).toBe('🎯');
  });

  it('başarılı ama gövdesiz yanıtı sahte alanlarla doldurmadan kabul eder', async () => {
    fetchMock = vi.fn(async () => ({
      ok: true, status: 204, json: async () => { throw new SyntaxError('empty'); },
    } as unknown as Response));
    const store = createValidStore('Trimmed');

    expect(await store.saveGeneral()).toBe(true);
    expect(store.saving).toBe(false);
    expect(store.name).toBe('Trimmed');
  });

  it('seyrek başarılı yanıt alanlarını gönderilen güvenli değerlere tamamlar', async () => {
    fetchMock = vi.fn(async () => okResponse({}));
    const store = createServerSettingsStore({ ...SRV });
    store.setName('Fallback Name');
    store.setIcon('F');

    expect(await store.saveGeneral()).toBe(true);
    expect(store.name).toBe('Fallback Name');
    expect(store.icon).toBe('F');
  });

  it('JSON içermeyen HTTP hatasında durum kodlu hata üretir', async () => {
    fetchMock = vi.fn(async () => ({
      ok: false, status: 502, json: async () => { throw new SyntaxError('html'); },
    } as unknown as Response));
    const store = createValidStore('New');

    expect(await store.saveGeneral()).toBe(false);
    expect(store.error).toBe(t('error_server'));
  });

  it('Error olmayan taşıma reddini yerelleştirilmiş ağ hatasına indirger', async () => {
    fetchMock = vi.fn(async () => { throw 'offline'; });
    const store = createValidStore('New');

    expect(await store.saveGeneral()).toBe(false);
    expect(store.error).toBe('Sunucu ayarları kaydedilemedi.');
  });

  it('çalışma zamanında null gelen taslak alanlarını güvenli boş değerlere indirger', async () => {
    const store = createServerSettingsStore({ ...SRV });
    store.name = null as never;
    store.icon = null as never;
    expect(store.isDirty()).toBe(true);
    expect(await store.saveGeneral()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
