// client/tests/settings-persistence.test.ts
// Faz 11 §32 — AYARLAR GERÇEKTEN KAYDEDİLMELİ YA DA DÜRÜSTÇE SÖYLEMELİ.
//
// BULUNAN: `settings/stores/settingsStore.ts` içindeki `save()` yalnız
// `saving` bayrağını çevirip KOŞULSUZ `true` dönüyordu:
//
//   async save(payload = {}) { ...commit({saving:true,...payload});
//                              commit({saving:false}); return true; }
//
// Ağ çağrısı yok, kalıcılık yok. ProfileTab bunu çağırıp başarı gösteriyordu:
// kullanıcı görünen adını değiştirip "kaydedildi" görüyor, ama sunucuda
// hiçbir şey değişmiyor ve yeniden yüklemede eski ad geri geliyordu.
//
// SUNUCUDA GERÇEK UÇ VAR: `PATCH /api/me` (routes/auth.ts:425) şunları kabul
// eder: displayName, status, bio, website, location, pronouns, bannerColor.
// Bu yüzden doğru düzeltme kontrolü gizlemek değil, gerçek ucu bağlamaktır.
//
// `statusText` / `statusEmoji` alanlarının sunucu karşılığı YOKTUR; bunlar
// gönderilmez ve kullanıcıya kalıcı oldukları söylenmez.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { createSettingsStore } from '../js/core/settings/stores/settingsStore.ts';

let calls: Array<{ url: string; method?: string; body?: unknown }> = [];
let nextResponse: Response;

beforeEach(() => {
  calls = [];
  nextResponse = new Response(JSON.stringify({ _id: 'u1', displayName: 'Yeni Ad' }), { status: 200 });
  BridgeRegistry.register('apiFetch', ((url: string, opts?: RequestInit) => {
    calls.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(String(opts.body)) : undefined });
    return Promise.resolve(nextResponse);
  }) as unknown as AnyFn);
});

afterEach(() => {
  BridgeRegistry.unregister('apiFetch');
  vi.restoreAllMocks();
});

describe('settingsStore.save — gerçek kalıcılık', () => {
  it('profil kaydı SUNUCUYA gider', async () => {
    const store = createSettingsStore();

    const ok = await store.save({ displayName: 'Yeni Ad' });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/me');
    expect(calls[0].method).toBe('PATCH');
    expect((calls[0].body as Record<string, unknown>).displayName).toBe('Yeni Ad');
  });

  it('DM ve presence gizlilik tercihleri kanonik /api/me ucuna gider', async () => {
    const store = createSettingsStore('privacy');
    const ok = await store.save({ dmPrivacy: 'friends', presenceVisibility: 'hidden' });
    expect(ok).toBe(true);
    expect(calls[0].body).toEqual({ dmPrivacy: 'friends', presenceVisibility: 'hidden' });
  });

  it('sunucu reddederse save BAŞARI DÖNMEZ', async () => {
    nextResponse = new Response(JSON.stringify({ error: 'Nothing to update' }), { status: 400 });
    const store = createSettingsStore();

    const ok = await store.save({ displayName: 'X' });

    expect(ok).toBe(false);   // sahte başarı YOK
  });

  it('ağ hatası sessizce başarı olarak raporlanmaz', async () => {
    BridgeRegistry.register('apiFetch', (() => Promise.reject(new Error('ağ yok'))) as unknown as AnyFn);
    const store = createSettingsStore();

    const ok = await store.save({ displayName: 'X' });

    expect(ok).toBe(false);
  });

  it('SUNUCUNUN DESTEKLEMEDİĞİ alanlar gönderilmez', async () => {
    const store = createSettingsStore();

    await store.save({ displayName: 'Ad', statusText: 'merhaba', statusEmoji: '🙂' });

    const body = calls[0].body as Record<string, unknown>;
    expect(body.displayName).toBe('Ad');
    // `PATCH /api/me` bu alanları tanımıyor; göndermek sessiz veri kaybı olurdu.
    expect(body.statusText).toBeUndefined();
    expect(body.statusEmoji).toBeUndefined();
  });

  it('gönderilecek desteklenen alan yoksa ağ çağrısı YAPILMAZ', async () => {
    const store = createSettingsStore();

    const ok = await store.save({ statusText: 'yalnız bu' });

    expect(calls).toHaveLength(0);
    expect(ok).toBe(false);
    expect(store.error).toContain('değişiklik yok');
    expect(store.saving).toBe(false);
  });

  it('apiFetch sahibi kayıtlı değilse görünür hata ve false döndürür', async () => {
    BridgeRegistry.unregister('apiFetch');
    const store = createSettingsStore();

    await expect(store.save({ displayName: 'Yeni' })).resolves.toBe(false);
    expect(store.error).toBe('Ayarlar kaydedilemedi.');
    expect(store.error).not.toContain('apiFetch');
    expect(store.saving).toBe(false);
  });

  it('Error olmayan ağ reddini güvenli genel mesaja dönüştürür', async () => {
    BridgeRegistry.register('apiFetch', (() => Promise.reject('kapalı')) as unknown as AnyFn);
    const store = createSettingsStore();

    await expect(store.save({ displayName: 'Yeni' })).resolves.toBe(false);
    expect(store.error).toBe('Ayarlar kaydedilemedi.');
  });

  it('observable yardımcı mutasyonları birleştirir ve abonelikten çıkmayı destekler', async () => {
    const store = createSettingsStore('devices');
    const snapshots: Array<Record<string, unknown>> = [];
    const unsubscribe = store.subscribe(state => snapshots.push({ ...state }));

    store.setTab('appearance');
    store.setError('uyarı');
    store.setLayoutMode('focus');
    store.setDevicePreference('mic', 'a');
    store.setDevicePreference('speaker', 'b');
    store.setPrivacyOption('dm', 'friends');
    store.setPrivacyOption('presence', 'hidden');
    await store.reload();

    expect(store.activeTab).toBe('appearance');
    expect(store.error).toBe('uyarı');
    expect(store.layoutMode).toBe('focus');
    expect(store.devices).toEqual({ mic: 'a', speaker: 'b' });
    expect(store.privacy).toEqual({ dm: 'friends', presence: 'hidden' });
    expect(snapshots.at(-1)).toMatchObject({
      activeTab: 'appearance', error: 'uyarı', layoutMode: 'focus',
      devices: { mic: 'a', speaker: 'b' },
      privacy: { dm: 'friends', presence: 'hidden' },
    });

    const count = snapshots.length;
    unsubscribe();
    store.setError(null);
    expect(snapshots).toHaveLength(count);
  });
});
