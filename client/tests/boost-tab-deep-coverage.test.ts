// client/tests/boost-tab-deep-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// BoostTab — SUNUCU DEĞİŞİMİ, ONAYLI KALDIRMA VE SEYREK YANIT
// ════════════════════════════════════════════════════════════════════════════
//
// Hiç ölçülmemiş 61 dalın taşıdığı riskler:
//
//   · YANLIŞ SUNUCU — kullanıcı sekme açıkken sunucu değiştirebilir. Boost
//     bir KAYNAK taahhüdüdür; eski sunucuya yazılması gerçek bir kayıptır.
//     Bu yüzden hem yükleme hem mutasyon bağlamı yeniden doğrular.
//   · SESSİZ KALDIRMA — boost kaldırma ürün diyaloğuyla onaylanır; iptal
//     edilirse istek GİTMEZ.
//   · YARIŞ (409) — "zaten boost edilmiş" yanıtı BAŞARISIZLIK değildir;
//     kullanıcıya hata gösterilmeden durum tazelenir.
//   · SEYREK YANIT — eksik alanlar `undefined` göstermez, belgelenmiş
//     varsayılanlara düşer.
//   · GİZLİLİK — sunucu hata gövdesi HAM gösterilmez.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { t } from '../js/core/i18n/index.ts';

let apiMock: ReturnType<typeof vi.fn>;
let currentServer: { _id?: string; id?: string } | null = { _id: 'srv-1' };
let stillCurrent = true;
const registryMap: Record<string, unknown> = {};

vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: (...args: unknown[]) => apiMock(...args) }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => '' }));
vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    has: (k: string) => k in registryMap,
    call: (k: string) => {
      const v = registryMap[k];
      return typeof v === 'function' ? (v as () => unknown)() : v;
    },
    register: (k: string, fn: unknown) => { registryMap[k] = fn; },
    unregister: (k: string) => { delete registryMap[k]; },
    get: (k: string) => registryMap[k] ?? null,
  },
}));
vi.mock('../js/core/server-settings/stores/serverSettingsStore', () => ({
  getCurrentServerFromRegistry: () => currentServer,
  isStillCurrentServer: () => stillCurrent,
}));

import BoostTab from '../js/core/server-settings/tabs/BoostTab.svelte';

const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const fail = (status: number, body: unknown = {}) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

const payload = (over: Record<string, unknown> = {}) => ({
  count: 3, tier: 2, perks: ['Daha yüksek ses kalitesi'],
  uploadLimitMB: 100, audioBitrate: 256,
  boosters: [{ userId: 'baskasi', boostedAt: 1 }],
  ...over,
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) { await tick(); await Promise.resolve(); }
}

async function chooseProductDialog(action: 'confirm' | 'cancel'): Promise<void> {
  await flush();
  const button = document.querySelector<HTMLButtonElement>(`[data-product-dialog-action="${action}"]`);
  if (!button) throw new Error(`ürün diyaloğu ${action} düğmesi yok`);
  button.click();
  await flush();
}

const errorText = () => document.querySelector('.state.error')?.textContent ?? '';
const noticeText = () => document.querySelector('.state.success')?.textContent ?? '';
const metrics = () => [...document.querySelectorAll('.metrics strong')].map(n => n.textContent);
const actionButton = () => document.querySelector<HTMLButtonElement>('.btn.primary');
const retryButton = () => document.querySelector<HTMLButtonElement>('.btn:not(.primary)');

async function mount() {
  const view = render(BoostTab);
  await waitFor(() => expect(document.querySelector('.state[aria-live]')).toBeNull());
  await flush();
  return view;
}

beforeEach(() => {
  currentServer = { _id: 'srv-1' };
  stillCurrent = true;
  apiMock = vi.fn(async () => ok(payload()));
  for (const key of Object.keys(registryMap)) delete registryMap[key];
  registryMap.getMe = () => ({ _id: 'user-me' });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe('BoostTab — yükleme', () => {
  it('sunucu bağlamı yoksa istek GİTMEZ', async () => {
    currentServer = null;
    await mount();

    expect(apiMock).not.toHaveBeenCalled();
    expect(errorText()).toBe(t('ui_sunucu_degisti_boost_bilgileri_yeniden_yuklenmeli'));
  });

  it('sunucu ARADA değiştiyse veri yüklenmez', async () => {
    stillCurrent = false;
    await mount();

    expect(apiMock).not.toHaveBeenCalled();
  });

  it('eski `id` alanlı sunucu kaydı da tanınır ve kimlik KAÇIRILIR', async () => {
    currentServer = { id: 'srv/slash' };
    await mount();

    expect(String(apiMock.mock.calls[0]![0])).toBe('/api/servers/srv%2Fslash/boosts');
  });

  it('yüklenen ölçümler gösterilir', async () => {
    await mount();

    expect(metrics()).toEqual(['3', '100 MB', '256 kbps']);
    expect(document.querySelector('.tier')?.textContent)
      .toBe(t('boost_level', undefined, { level: 2 }));
    expect(document.querySelectorAll('.perks li')).toHaveLength(1);
  });

  it('SEYREK yanıt belgelenmiş varsayılanlara düşer', async () => {
    apiMock = vi.fn(async () => ok({}));
    await mount();

    expect(metrics()).toEqual(['0', '25 MB', '96 kbps']);
    expect(document.querySelector('.tier')?.textContent)
      .toBe(t('boost_level', undefined, { level: 0 }));
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('avantaj listesi boş veya dizi değilse açık bir metin gösterilir', async () => {
    apiMock = vi.fn(async () => ok(payload({ perks: [] })));
    await mount();
    expect(document.querySelector('.perks p')?.textContent).toBe(t('boost_no_benefits'));

    cleanup();
    apiMock = vi.fn(async () => ok(payload({ perks: 'liste' })));
    await mount();
    expect(document.querySelector('.perks p')?.textContent).toBe(t('boost_no_benefits'));
  });

  it('yükleme reddedilirse HAM gövde gösterilmez ve YENİDEN DENENEBİLİR', async () => {
    apiMock = vi.fn(async () => fail(403, { error: 'GIZLI-SUNUCU-AYRINTISI' }));
    await mount();

    expect(errorText()).not.toBe('');
    expect(errorText()).not.toContain('GIZLI-SUNUCU-AYRINTISI');
    expect(metrics()).toHaveLength(0);

    apiMock.mockResolvedValue(ok(payload()));
    retryButton()!.click();
    await flush();

    expect(metrics()).toEqual(['3', '100 MB', '256 kbps']);
  });

  it('taşıma hatası da açık bir metne düşer', async () => {
    apiMock = vi.fn(async () => { throw new Error('offline'); });
    await mount();

    expect(errorText()).not.toBe('');
    expect(errorText()).not.toContain('offline');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('BoostTab — boost verme ve kaldırma', () => {
  it('boost VERME onay istemez ve POST gönderir', async () => {
    await mount();
    apiMock.mockClear();

    actionButton()!.click();
    await flush();

    const post = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(post[0]).toBe('/api/servers/srv-1/boosts');
    expect(noticeText()).toBe(t('ui_sunucu_boost_edildi'));
  });

  it('kendi boostu varken düğme KALDIRMA anlamına gelir', async () => {
    apiMock = vi.fn(async () => ok(payload({ boosters: [{ userId: 'user-me' }] })));
    await mount();

    expect(actionButton()!.textContent?.trim()).toBe(t('ui_boostu_kaldir'));
    expect(actionButton()!.classList.contains('danger')).toBe(true);
  });

  it('kaldırma ONAYLANMAZSA istek GİTMEZ', async () => {
    apiMock = vi.fn(async () => ok(payload({ boosters: [{ userId: 'user-me' }] })));
    await mount();
    apiMock.mockClear();

    actionButton()!.click();
    await chooseProductDialog('cancel');

    expect(apiMock).not.toHaveBeenCalled();
  });

  it('kaldırma onaylanırsa DELETE gider', async () => {
    apiMock = vi.fn(async () => ok(payload({ boosters: [{ userId: 'user-me' }] })));
    await mount();
    apiMock.mockClear();

    actionButton()!.click();
    await chooseProductDialog('confirm');

    const del = apiMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'DELETE')!;
    expect(del).toBeDefined();
    expect(noticeText()).toBe(t('ui_boost_kaldirildi'));
  });

  it('ZATEN BOOST EDİLMİŞ (409) yanıtı hata sayılmaz', async () => {
    let call = 0;
    apiMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { call += 1; return fail(409, { error: 'already' }); }
      return ok(payload());
    });
    await mount();

    actionButton()!.click();
    await flush();

    expect(call).toBe(1);
    expect(errorText()).toBe('');
    expect(noticeText()).toBe(t('ui_sunucu_boost_edildi'));
  });

  it('KALDIRMADA 409 hata sayılır', async () => {
    apiMock = vi.fn(async (_url: string, init?: RequestInit) =>
      (init?.method === 'DELETE' ? fail(409, { error: 'x' }) : ok(payload({ boosters: [{ userId: 'user-me' }] }))));
    await mount();

    actionButton()!.click();
    await chooseProductDialog('confirm');

    expect(errorText()).not.toBe('');
    expect(noticeText()).toBe('');
  });

  it('boost reddedilirse HAM gövde gösterilmez', async () => {
    apiMock = vi.fn(async (_url: string, init?: RequestInit) =>
      (init?.method === 'POST' ? fail(403, { error: 'GIZLI-SUNUCU-AYRINTISI' }) : ok(payload())));
    await mount();

    actionButton()!.click();
    await flush();

    expect(errorText()).not.toBe('');
    expect(errorText()).not.toContain('GIZLI-SUNUCU-AYRINTISI');
  });

  it('taşıma hatası bildirilir', async () => {
    apiMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('offline');
      return ok(payload());
    });
    await mount();

    actionButton()!.click();
    await flush();

    expect(errorText()).not.toBe('');
    expect(noticeText()).toBe('');
  });

  it('SUNUCU DEĞİŞTİYSE mutasyon gönderilmez', async () => {
    await mount();
    apiMock.mockClear();
    stillCurrent = false;

    actionButton()!.click();
    await flush();

    expect(apiMock).not.toHaveBeenCalled();
    expect(errorText()).toBe(t('ui_sunucu_degisti_boost_islemi_iptal_edildi'));
  });

  it('bir işlem SÜRERKEN ikincisi başlatılamaz', async () => {
    let release: (value: Response) => void = () => {};
    await mount();
    apiMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise<Response>(resolve => { release = resolve; });
      return Promise.resolve(ok(payload()));
    });

    actionButton()!.click();
    await flush();
    const posts = () => apiMock.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'POST').length;
    expect(posts()).toBe(1);

    actionButton()!.click();
    await flush();
    expect(posts()).toBe(1);

    release(ok({}));
    await flush();
  });

  it('kimliği çözülemeyen kullanıcı için boost DURUMU varsayılmaz', async () => {
    registryMap.getMe = () => null;
    apiMock = vi.fn(async () => ok(payload({ boosters: [{ userId: '' }] })));
    await mount();

    expect(actionButton()!.classList.contains('danger')).toBe(false);
  });
});
