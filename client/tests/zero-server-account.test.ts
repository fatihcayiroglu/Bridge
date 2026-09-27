// client/tests/zero-server-account.test.ts
// ÜRÜN KURALI: HESAP != SUNUCU ÜYELİĞİ.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// `EmptyServerStart.svelte` sıfır sunuculu kullanıcıya KAPATILAMAZ tam ekran
// bir modal gösteriyordu (`position:fixed; inset:0; z-index:10000;
// aria-modal="true"`) ve dosyada tek bir kapat/atla kontrolü YOKTU.
// Yeni kayıt olan bir kullanıcı bir sunucuya katılmadan/kurmadan uygulama
// kabuğuna hiç ulaşamıyordu.
//
// Sunucusu olmayan kimliği doğrulanmış kullanıcı MEŞRUDUR: Bridge herkese açık
// çok kullanıcılı bir üründür, hesap ile sunucu üyeliği aynı şey değildir.
// Arka uç zaten doğruydu — `routes/auth.ts` kayıt sırasında üyelik OLUŞTURMAZ;
// kusur yalnızca istemci kapısındaydı.
//
// Bu paket GERÇEK bileşeni mount eder; klon/taklit bileşen yoktur.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import EmptyServerStart from '../js/core/EmptyServerStart.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

const backdrop = () => host.querySelector('.empty-server-backdrop');
const closeBtn = () => host.querySelector<HTMLButtonElement>('.ess-close');

let apiFetchMock: ReturnType<typeof vi.fn>;

/** `/api/servers` yanıtını kanonik API istemcisi üzerinden kontrol eder. */
function stubApi(servers: unknown[], status = 200): void {
  apiFetchMock = vi.fn(async () => {
    return {
      ok: status === 200, status,
      json: async () => servers,
    } as unknown as Response;
  });
  BridgeRegistry.register('getMe', () => ({ _id: 'user-1' }));
  BridgeRegistry.register('apiFetch', apiFetchMock);
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Ham fetch kullanılmamalı'))));
}

/** Bileşen açılışta async fetch yapar; mikro görevleri boşalt. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  window.localStorage.clear();
  for (const k of ['checkEmptyServerStart', 'openServerStart', 'closeServerStart', 'getMe', 'apiFetch']) {
    BridgeRegistry.unregister(k);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function mountWith(servers: unknown[]): Promise<void> {
  stubApi(servers);
  instance = mount(EmptyServerStart, { target: host });
  await settle();
}

// ════════════════════════════════════════════════════════════════════════════
// Sıfır sunuculu hesap kabuğa ulaşabilmeli
// ════════════════════════════════════════════════════════════════════════════
describe('sıfır sunuculu hesap — kabuk erişimi', () => {
  it('1: sunucusuz kullanıcıya başlangıç ekranı gösterilir', async () => {
    await mountWith([]);

    expect(backdrop()).not.toBeNull();
  });

  it('1b: ekran KAPATILABİLİR — kapat kontrolü VARDIR', async () => {
    await mountWith([]);

    // Asıl kusur buydu: hiçbir kapatma yolu yoktu.
    expect(closeBtn()).not.toBeNull();
    expect(closeBtn()!.getAttribute('aria-label')).toMatch(/kapat/i);
  });

  it('1c: kapatınca kullanıcı uygulama kabuğuna ulaşır (engel kalkar)', async () => {
    await mountWith([]);

    closeBtn()!.click();
    flushSync();

    expect(backdrop()).toBeNull();
  });

  it('1d: ESC ile de kapatılabilir', async () => {
    await mountWith([]);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();

    expect(backdrop()).toBeNull();
  });

  it('2: kapatmak ÖRTÜK ÜYELİK oluşturmaz (yazma isteği yok)', async () => {
    await mountWith([]);
    apiFetchMock.mockClear();

    closeBtn()!.click();
    flushSync();
    await settle();

    // Hiçbir POST/PUT/PATCH gitmemeli — katılma/oluşturma dayatılmaz.
    for (const call of apiFetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
    }
  });

  it('3: kapatıldıktan sonra yeniden kontrol onu GERİ GETİRMEZ', async () => {
    await mountWith([]);
    closeBtn()!.click();
    flushSync();

    // auth-success sonrası app.ts bunu çağırır; dayatma tekrarlanmamalı.
    await BridgeRegistry.call('checkEmptyServerStart');
    await settle();

    expect(backdrop()).toBeNull();
  });

  it('4/5: açıkça istenirse (Sunucu Ekle) TEKRAR açılabilir', async () => {
    await mountWith([]);
    closeBtn()!.click();
    flushSync();
    expect(backdrop()).toBeNull();

    BridgeRegistry.call('openServerStart');
    flushSync();

    expect(backdrop()).not.toBeNull();   // Discover/katılma isteğe bağlı kalır
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Mevcut kullanıcılar etkilenmemeli
// ════════════════════════════════════════════════════════════════════════════
describe('sunucusu olan kullanıcılar etkilenmez', () => {
  it('6: sunucusu olan kullanıcıya başlangıç ekranı HİÇ gösterilmez', async () => {
    await mountWith([{ _id: 's1', name: 'Sunucum' }]);

    expect(backdrop()).toBeNull();
  });

  it('7: oturum yoksa ekran gösterilmez (önceki hesap sızıntısı yok)', async () => {
    stubApi([]);
    BridgeRegistry.register('getMe', () => null);
    instance = mount(EmptyServerStart, { target: host });
    await settle();

    expect(backdrop()).toBeNull();
  });
});
