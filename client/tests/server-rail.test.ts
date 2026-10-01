// client/tests/server-rail.test.ts
import { t } from '../js/core/i18n/index.ts';
// Faz 10.11 — Sunucu rail'i (ServerSwitcher) kanonik yakınsama ve izolasyon.
//
// ServerSwitcher rail'in TEK sahibidir; yerel kopya store tutmaz, gerçeği
// `GET /api/servers`ten okur ve `{#each … (server._id)}` ile anahtarlar.
//
// Bu süitte kilitlenen iki sözleşme:
//
//   1) YAKINSAMA — DiscoverPanel'den katılım `BridgeRegistry.call('loadServers')`
//      çağırır ve SAYFA YENİLEMEZ (DiscoverPanel.svelte:223). Uçuşta bir
//      yükleme varken gelen yenileme isteği DÜŞÜRÜLEMEZ; aksi hâlde yeni
//      katılınan sunucu rail'e hiç gelmez (sessiz no-op).
//
//      Not: EmptyServerStart'taki create/join yolları `window.location.reload()`
//      kullanır — bu ürünün açık mekanizmasıdır ve tam yakınsama sağlar;
//      burada yeniden test edilmez.
//
//   2) KULLANICI İZOLASYONU — Faz 10.7 sahiplik kuralı: her bileşen kendi özel
//      durumunu `bridge:auth-logout` üzerinde kendisi temizler. Rail çıkışta
//      unmount EDİLMEZ, bu yüzden A'nın sunucu adları B'ye taşınmamalıdır.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

let serverTruth: Array<Record<string, unknown>> = [];
let inFlightGate: (() => void) | null = null;
let fetchCount = 0;
let tokenAvailable = true;
let responseStatus = 200;
let responseOverride: unknown = undefined;
let fetchFailure: unknown = undefined;

vi.mock('../js/core/api-fetch.js', () => ({
  apiFetch: async () => {
    fetchCount += 1;
    if (fetchFailure !== undefined) throw fetchFailure;
    // GERÇEKÇİLİK: yanıt, isteğin GÖNDERİLDİĞİ andaki sunucu gerçeğini taşır.
    // Çözülme anında okumak, uçuştaki bayat isteğin sihirli biçimde taze veri
    // döndürmesine yol açan bir ölçüm artefaktı üretirdi.
    const snapshot = JSON.stringify(serverTruth);
    if (inFlightGate) {
      await new Promise<void>((resolve) => { inFlightGate = resolve; });
    }
    const body = responseOverride === undefined ? snapshot : JSON.stringify(responseOverride);
    return new Response(body, { status: responseStatus });
  },
}));

vi.mock('../js/core/auth-compat.js', () => ({ readToken: () => tokenAvailable ? 'test-token' : null }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => '' }));

import ServerSwitcher from '../js/core/ServerSwitcher.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

const settle = () => new Promise(r => setTimeout(r, 0));
const railText = () => { flushSync(); return host.textContent ?? ''; };
// YALNIZCA sunucu rozetleri. Rail'de kullanıcı verisi OLMAYAN kalıcı
// gezinme kontrolleri de vardır (ör. "Keşfet"); bunlar oturumdan bağımsızdır
// ve sızıntı sayılmaz. Sızıntı sözleşmesi SUNUCULAR hakkındadır, bu yüzden
// seçici sunucu düğmeleriyle sınırlanır.
const railTips = () => [...host.querySelectorAll('.server-icon:not(.discover-btn)')]
  .map(el => el.getAttribute('data-tip'))
  .filter((t): t is string => t !== null && t.length > 0);

const logout = () => { document.dispatchEvent(new CustomEvent('bridge:auth-logout')); flushSync(); };

async function mountRail(): Promise<void> {
  instance = mount(ServerSwitcher, { target: host });
  flushSync();
  await settle(); flushSync();
}

beforeEach(() => {
  serverTruth = [{ _id: 'srv-a', name: 'ZZALICESUNUCU', icon: '🅰' }];
  inFlightGate = null;
  fetchCount = 0;
  tokenAvailable = true;
  responseStatus = 200;
  responseOverride = undefined;
  fetchFailure = undefined;
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (instance) { unmount(instance); instance = null; }
  host?.remove();
  vi.restoreAllMocks();
});

describe('rail kanonik sunucu gerçeğini yansıtır', () => {
  it('sunucu listesi yüklenir (pozitif kontrol)', async () => {
    await mountRail();

    expect(railTips()).toContain('ZZALICESUNUCU');
  });

  it('tekrarlanan yüklemeler KOPYA rail öğesi üretmez', async () => {
    await mountRail();

    for (let i = 0; i < 3; i += 1) {
      BridgeRegistry.call('loadServers');
      await settle(); flushSync();
    }

    expect(railTips().filter(t => t === 'ZZALICESUNUCU')).toHaveLength(1);
  });

  it('sunucu seçimi merkezî duruma yazılır', async () => {
    const setCurrent = vi.fn();
    BridgeRegistry.register('setCurrentServer', setCurrent as never);
    await mountRail();

    const btn = host.querySelector('.server-icon') as HTMLButtonElement;
    btn.click();
    flushSync();

    expect(setCurrent).toHaveBeenCalled();
    expect((setCurrent.mock.calls.at(-1)?.[0] as { _id: string })._id).toBe('srv-a');
    BridgeRegistry.unregister('setCurrentServer');
  });

  it('registry salt-okunur listeyi verir, bozuk seçimi reddeder ve adı olmayan sunucuyu erişilebilir kılar', async () => {
    serverTruth = [{ _id: 'srv-icon', name: '   ', iconUrl: '/media/server.png' }];
    const name = document.createElement('span');
    name.id = 'sidebar-server-name';
    document.body.appendChild(name);
    const channels = vi.fn();
    const members = vi.fn();
    document.addEventListener('bridge:load-channels', channels);
    document.addEventListener('bridge:load-members', members);
    try {
      await mountRail();
      const available = BridgeRegistry.call<Array<{ _id: string }>>('getAvailableServers');
      expect(available?.map(server => server._id)).toEqual(['srv-icon']);
      expect(host.querySelector('[data-id="srv-icon"]')).toHaveAttribute('aria-label', 'Sunucu');
      expect((host.querySelector('[data-id="srv-icon"]') as HTMLElement).style.backgroundImage).toContain('/media/server.png');
      expect(name.textContent).toBe('Bridge');
      expect(channels).toHaveBeenCalled();
      expect(members).toHaveBeenCalled();

      const callsBeforeInvalid = channels.mock.calls.length;
      BridgeRegistry.call('selectServer', {});
      expect(channels).toHaveBeenCalledTimes(callsBeforeInvalid);
      BridgeRegistry.call('selectServer', { _id: 'manual', name: 'Manual' });
      expect(name.textContent).toBe('Manual');
    } finally {
      document.removeEventListener('bridge:load-channels', channels);
      document.removeEventListener('bridge:load-members', members);
      name.remove();
    }
  });

  it('token yokken ağ çağrısı yapmaz ve auth-success sonrası yükler', async () => {
    tokenAvailable = false;
    await mountRail();
    expect(fetchCount).toBe(0);
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await settle();
    expect(fetchCount).toBe(0);

    tokenAvailable = true;
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await settle(); flushSync();
    expect(fetchCount).toBe(1);
    expect(railTips()).toContain('ZZALICESUNUCU');
  });

  it('HTTP hatasını gösterir ve retry düğmesiyle toparlanır', async () => {
    responseStatus = 503;
    await mountRail();
    const retry = host.querySelector<HTMLButtonElement>('[aria-label*="yeniden dene"]')!;
    expect(retry).not.toBeNull();
    expect(retry.dataset.tip).toContain(t('sw_load_failed'));

    responseStatus = 200;
    retry.click();
    await settle(); flushSync();
    expect(host.querySelector('[aria-label*="yeniden dene"]')).toBeNull();
    expect(railTips()).toContain('ZZALICESUNUCU');
  });

  it('Error olmayan taşıma reddini sınırlar ve non-array gövdeyi boş liste sayar', async () => {
    fetchFailure = 'offline';
    await mountRail();
    // Rail artik her yukleme basarisizligi icin TEK kanonik ipucu metnini
    // kullanir; "bilinmeyen hata" gibi ayri bir dal yoktur.
    expect(host.querySelector(`[data-tip="${t('sw_load_failed')}"]`)).not.toBeNull();

    fetchFailure = undefined;
    responseOverride = { servers: serverTruth };
    BridgeRegistry.call('loadServers');
    await settle(); flushSync();
    expect(railTips()).toHaveLength(0);
    expect(host.querySelector('[aria-label*="yeniden dene"]')).toBeNull();
  });
});

describe('katılım sonrası yakınsama (Discover yolu — sayfa yenilemesi YOK)', () => {
  it('uçuşta yükleme varken gelen yenileme DÜŞÜRÜLMEZ', async () => {
    // İlk yükleme askıda kalsın.
    inFlightGate = () => {};
    instance = mount(ServerSwitcher, { target: host });
    flushSync();
    await settle();

    // Kullanıcı bu sırada Discover'dan bir sunucuya katılıyor:
    // sunucu gerçeği değişti ve rail yenilemesi isteniyor.
    serverTruth = [
      { _id: 'srv-a', name: 'ZZALICESUNUCU', icon: '🅰' },
      { _id: 'srv-new', name: 'ZZKATILINAN', icon: '🆕' },
    ];
    BridgeRegistry.call('loadServers');

    // Askıdaki ilk istek şimdi tamamlanıyor.
    const release = inFlightGate;
    inFlightGate = null;
    release?.();
    await settle(); flushSync();
    await settle(); flushSync();

    // Yeni katılınan sunucu rail'e GELMİŞ olmalı.
    expect(railTips()).toContain('ZZKATILINAN');
  });
});

describe('P4 — a queued load is awaitable (cold-start deep links)', () => {
  // MEASURED (Android 14 emulator, then reproduced in Chromium): a cold `bridge://channel/<id>`
  // called `loadServers` while the boot load was in flight; the call returned at once, the router
  // read an EMPTY list and showed "not available". Negative control: on the previous code the
  // registry call returned undefined and the list was empty when it settled.
  it('the registry loadServers resolves only after the list reflects the server', async () => {
    inFlightGate = () => {};
    instance = mount(ServerSwitcher, { target: host });
    flushSync();
    await settle();

    const servers = () => BridgeRegistry.call<Array<{ _id?: string }>>('getAvailableServers') ?? [];
    expect(servers()).toEqual([]);
    let settled = false;
    const queued = Promise.resolve(BridgeRegistry.call<Promise<void>>('loadServers')).then(() => { settled = true; });
    await settle();
    expect(settled).toBe(false);

    const release = inFlightGate;
    inFlightGate = null;
    release?.();
    await queued;
    expect(servers().map((s) => s._id)).toEqual(['srv-a']);
  });

  it('an idle load is awaitable too', async () => {
    await mountRail();
    serverTruth = [...serverTruth, { _id: 'srv-b', name: 'ZZB', icon: '🅱' }];
    await BridgeRegistry.call<Promise<void>>('loadServers');
    expect((BridgeRegistry.call<Array<{ _id?: string }>>('getAvailableServers') ?? []).map((s) => s._id)).toEqual(['srv-a', 'srv-b']);
  });
});

describe('kullanıcı izolasyonu — A → çıkış → B', () => {
  it('çıkış A\'nın sunucu listesini rail\'den KALDIRIR', async () => {
    await mountRail();
    expect(railTips()).toContain('ZZALICESUNUCU');

    // Yeni bir yükleme YAPILMADAN: çıkış tek başına rail'i temizlemeli.
    // (Aksi hâlde A'nın sunucu adları B giriş yapana kadar ekranda kalır.)
    logout();

    expect(railTips()).not.toContain('ZZALICESUNUCU');
  });

  it('B oturumunda A\'nın sunucuları GÖRÜNMEZ', async () => {
    await mountRail();
    logout();

    serverTruth = [{ _id: 'srv-b', name: 'ZZBOBSUNUCU', icon: '🅱' }];
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await settle(); flushSync();

    const tips = railTips();
    expect(tips).toContain('ZZBOBSUNUCU');
    expect(tips).not.toContain('ZZALICESUNUCU');
  });

  it('B\'nin listesi BOŞ olsa bile A\'nın sunucuları sızmaz', async () => {
    await mountRail();
    logout();

    serverTruth = [];
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await settle(); flushSync();

    // Hiçbir SUNUCU rozeti kalmamalı...
    expect(railTips()).toHaveLength(0);
    // ...ama kalıcı Keşfet kontrolü yerinde durmalı (kullanıcı verisi değildir).
    expect(host.querySelector('.discover-btn')).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SUNUCU KİMLİĞİ FALLBACK'İ — "AYNI 🌐 DUVARI" GERİLEMESİ (v1.124.1)
// ════════════════════════════════════════════════════════════════════════════
// CANLI ÜRÜNDE GÖZLENDİ: sanat eseri olmayan meşru sunucular rayda düzinelerce
// AYNI 🌐 ikonu olarak görünüyordu (sunucu oluşturma `icon`u '🌐' varsayıyor).
// Fallback artık ADdan türetilen baş harf(ler) + id'den türetilen kararlı renk
// gösterir; sunucular gizlenmez, ayırt edilebilir olur.
describe('sunucu kimliği fallback\'i — globe duvarı yerine baş harfler', () => {
  const initialsOf = (id: string) =>
    (host.querySelector(`[data-id="${id}"] .server-initials`) as HTMLElement | null)?.textContent ?? null;

  it('varsayılan 🌐 ikonlu sunucular AYIRT EDİLEBİLİR baş harfler gösterir, globe DEĞİL', async () => {
    serverTruth = [
      { _id: 's1', name: 'Alice Topluluğu', icon: '🌐' },
      { _id: 's2', name: 'Bob Sunucusu',    icon: '🌐' },
      { _id: 's3', name: ' Churrasco',       icon: '🌐' },
    ];
    await mountRail();

    // Rayda HİÇ ham globe metni kalmamalı.
    expect(railText()).not.toContain('🌐');

    // Her sunucu kendi baş harfini gösterir ve birbirinden farklıdır.
    expect(initialsOf('s1')).toBe('AT');   // "Alice Topluluğu"
    expect(initialsOf('s2')).toBe('BS');   // "Bob Sunucusu"
    expect(initialsOf('s3')).toBe('C');    // tek kelime → tek harf
    const set = new Set([initialsOf('s1'), initialsOf('s2'), initialsOf('s3')]);
    expect(set.size).toBe(3);

    // Arka plan rengi id'den deterministik olarak verilir (görsel ayrım).
    // jsdom hsl()'i rgb()'ye normalize eder; renk YİNE de uygulanır. Önemli
    // olan: bir arka plan rengi VAR ve sunucular arasında FARKLI.
    const bg1 = (host.querySelector('[data-id="s1"]') as HTMLElement).getAttribute('style') ?? '';
    const bg2 = (host.querySelector('[data-id="s2"]') as HTMLElement).getAttribute('style') ?? '';
    expect(bg1).toMatch(/background:\s*(rgb|hsl)\(/);
    expect(bg1).not.toBe(bg2);
  });

  it('kullanıcının SEÇTİĞİ özel emoji KORUNUR (baş harfe çevrilmez)', async () => {
    serverTruth = [{ _id: 's-emoji', name: 'Oyun Odası', icon: '🎮' }];
    await mountRail();
    expect(railText()).toContain('🎮');
    expect(host.querySelector('[data-id="s-emoji"] .server-initials')).toBeNull();
  });

  it('iconUrl varsa görsel kullanılır, baş harf ÜRETİLMEZ', async () => {
    serverTruth = [{ _id: 's-img', name: 'Görselli', iconUrl: '/media/s.png' }];
    await mountRail();
    expect(host.querySelector('[data-id="s-img"] .server-initials')).toBeNull();
    expect((host.querySelector('[data-id="s-img"]') as HTMLElement).style.backgroundImage).toContain('/media/s.png');
  });

  it('erişilebilirlik korunur: baş harf gösterilse de aria-label ADdır', async () => {
    serverTruth = [{ _id: 's-a11y', name: 'Erişilebilir Sunucu', icon: '🌐' }];
    await mountRail();
    const btn = host.querySelector('[data-id="s-a11y"]') as HTMLElement;
    expect(btn.getAttribute('aria-label')).toBe('Erişilebilir Sunucu');
    // Baş harf çapraz-okuyuculara tekrar okunmasın diye aria-hidden'dır.
    expect(btn.querySelector('.server-initials')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('adı olmayan sunucu güvenli bir yer tutucu gösterir (# ) ve çökmez', async () => {
    serverTruth = [{ _id: 's-noname', name: '   ', icon: '🌐' }];
    await mountRail();
    expect(initialsOf('s-noname')).toBe('#');
    expect(host.querySelector('[data-id="s-noname"]')).toHaveAttribute('aria-label', 'Sunucu');
  });
});
