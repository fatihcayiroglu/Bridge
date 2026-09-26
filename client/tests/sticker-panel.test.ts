// client/tests/sticker-panel.test.ts
import { t } from '../js/core/i18n/index.ts';
// FAZ C3 — STICKER PANELİ + AÇICI (güvenlik ve kapsam).
//
// KANITLANANLAR:
//   · paket/sticker adları HTML olarak render EDİLMEZ (XSS regresyonu)
//   · güvensiz URL taşıyan sticker hiç render edilmez
//   · MANAGE_SERVER kanıtlanmadan yönetim kontrolleri GÖRÜNMEZ (fail-closed)
//   · panel açılışta yakalanan serverId'yi kullanır
//   · sunucu değişince panel kapanır (bayat yüzey kalmaz)
//   · GÖNDERME yüzeyi YOKTUR (arka uç sözleşmesi yok)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import StickerOpener from '../js/core/stickers/StickerOpener.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { clearPermsCache } from '../js/core/permissions/myPermissions.ts';

const SID = 'srv-A';
const MANAGE_SERVER = 1 << 3;
const XSS = '<img src=x onerror="window.__pwned=1">';

let fetchMock: ReturnType<typeof vi.fn>;
let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

vi.mock('../js/core/api-fetch.js', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('../js/core/globals.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../js/core/globals.ts')>()), getAPI: () => 'http://test' }));

const ok = (b: unknown, status = 200) => ({ ok: true, status, json: async () => b } as unknown as Response);

const STICKER = (over: Record<string, unknown> = {}) => ({
  id: 'st-1', packId: 'pack-1', name: 'gulen', url: '/uploads/stickers/a.png',
  tags: [], width: 160, height: 160, ...over,
});
const PACK = (over: Record<string, unknown> = {}) => ({
  _id: 'pack-1', serverId: SID, name: 'Paket', description: '',
  authorId: 'u1', stickers: [STICKER()], createdAt: 1, ...over,
});

function makeFetch(packs: unknown[] = [PACK()], perms = MANAGE_SERVER) {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.endsWith('/me/permissions')) return ok({ permissions: perms });
    if (u.endsWith('/sticker-packs'))  return ok(packs);
    return ok(null, 204);
  });
}

const opener = () => host.querySelector<HTMLButtonElement>('.sticker-opener');
const panel  = () => host.ownerDocument.querySelector('.sp-card');
const imgs   = () => [...host.ownerDocument.querySelectorAll<HTMLImageElement>('.sp-img')];
const delBtn = () => [...host.ownerDocument.querySelectorAll<HTMLButtonElement>('.sp-btn')]
  .find(b => b.textContent?.includes('Paketi sil'));

/** Liste isteği (yetki ucu da `/permissions` ile bittiği için ayırt edilir). */
const listUrls = () => fetchMock.mock.calls
  .map(c => String(c[0]))
  .filter(u => u.endsWith('/sticker-packs'));
const permissionCalls = () => fetchMock.mock.calls
  .filter(c => String(c[0]).endsWith('/me/permissions'));
const deleteCalls = () => fetchMock.mock.calls
  .filter(c => (c[1] as RequestInit | undefined)?.method === 'DELETE');
const patchCalls = () => fetchMock.mock.calls
  .filter(c => (c[1] as RequestInit | undefined)?.method === 'PATCH');

/**
 * Panel açılır ve YÜKLEME BİTENE kadar beklenir.
 * Dikkat: `.sp-status` yükleme metnini de taşır — onun VARLIĞINI beklemek
 * testi yükleme sırasında ilerletirdi.
 */
async function openPanel(): Promise<void> {
  opener()!.click();
  await vi.waitFor(() => { flushSync(); expect(panel()).not.toBeNull(); });
  await vi.waitFor(() => { flushSync(); expect(listUrls().length).toBeGreaterThan(0); });
  await vi.waitFor(() => {
    flushSync();
    const status = host.ownerDocument.querySelector('.sp-status')?.textContent ?? '';
    expect(status).not.toMatch(/yükleniyor/i);
  });
}

beforeEach(() => {
  clearPermsCache();
  fetchMock = makeFetch();
  BridgeRegistry.register('getCurrentServer', () => ({ _id: SID, id: SID }));
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(StickerOpener, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  BridgeRegistry.unregister('getCurrentServer');
  clearPermsCache();
  delete (window as unknown as Record<string, unknown>).__pwned;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ════════════════════════════════════════════════════════════════════════════
describe('C3 — açıcı ve bağlam', () => {
  it('geçerli sunucu varsa açıcı görünür ve registry sahibi kurulur', () => {
    expect(opener()).not.toBeNull();
    expect(BridgeRegistry.has('openStickerPanel')).toBe(true);
  });

  it('unmount sonrası sahiplik BIRAKILIR', () => {
    unmount(instance!);
    instance = null;
    expect(BridgeRegistry.has('openStickerPanel')).toBe(false);
  });

  it('panel açılışta YAKALANAN serverId ile yükler', async () => {
    await openPanel();

    expect(listUrls()).toEqual([`http://test/api/servers/${SID}/sticker-packs`]);
  });

  it('GÜVENLİK: sunucu çözülemiyorsa açıcı GİZLENİR ve programatik açma da istek atmaz', async () => {
    unmount(instance!);
    BridgeRegistry.unregister('getCurrentServer');
    host.innerHTML = '';
    instance = mount(StickerOpener, { target: host });
    flushSync();

    expect(opener()).toBeNull();
    await BridgeRegistry.call<Promise<void>>('openStickerPanel');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('eski current-server sahibi yalnız `id` verirse uyumluluk yolunu kullanır', async () => {
    BridgeRegistry.register('getCurrentServer', () => ({ id: 'legacy-server' }));
    fetchMock = makeFetch([PACK({ serverId: 'legacy-server' })]);
    flushSync();

    await BridgeRegistry.call<Promise<void>>('openStickerPanel');
    await vi.waitFor(() => expect(listUrls()).toEqual([
      'http://test/api/servers/legacy-server/sticker-packs',
    ]));
  });

  it('GÜVENLİK: sunucu değişince panel KAPANIR (bayat yüzey kalmaz)', async () => {
    await openPanel();
    expect(panel()).not.toBeNull();

    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-B' } }));
    flushSync();

    expect(panel()).toBeNull();
  });

  it('kullanıcı yükleme sürerken kapatırsa sonradan yetki isteği başlatılmaz', async () => {
    let releaseList!: (response: Response) => void;
    let listJsonRead = false;
    fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/me/permissions')) return ok({ permissions: MANAGE_SERVER });
      if (u.endsWith('/sticker-packs')) {
        return new Promise<Response>(resolve => { releaseList = resolve; });
      }
      return ok(null, 204);
    });

    opener()!.click();
    await vi.waitFor(() => expect(listUrls()).toHaveLength(1));
    panel()!.querySelector<HTMLButtonElement>('.sp-close')!.click();
    flushSync();
    expect(panel()).toBeNull();

    releaseList({
      ok: true,
      status: 200,
      json: async () => { listJsonRead = true; return [PACK()]; },
    } as unknown as Response);
    await vi.waitFor(() => expect(listJsonRead).toBe(true));
    await Promise.resolve();

    expect(permissionCalls()).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C3 — GÜVENLİK: kullanıcı verisi HTML olarak render EDİLMEZ', () => {
  it('zararlı PAKET adı METİN olarak basılır', async () => {
    fetchMock = makeFetch([PACK({ name: XSS })]);
    await openPanel();

    expect(panel()!.querySelector('img[src="x"]')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(panel()!.textContent).toContain('onerror');
  });

  it('zararlı STICKER adı METİN olarak basılır (alt/başlık dahil)', async () => {
    fetchMock = makeFetch([PACK({ stickers: [STICKER({ name: XSS })] })]);
    await openPanel();

    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(imgs()[0]!.getAttribute('alt')).toBe(XSS);   // öznitelik = veri, kod değil
  });

  it('panelde SADECE beklenen img’ler vardır — enjekte edilmiş eleman yok', async () => {
    fetchMock = makeFetch([PACK({ name: XSS, description: XSS, stickers: [STICKER({ name: XSS })] })]);
    await openPanel();

    expect(panel()!.querySelectorAll('script, iframe')).toHaveLength(0);
    expect(imgs()).toHaveLength(1);
    expect(imgs()[0]!.getAttribute('src')).toBe('/uploads/stickers/a.png');
  });

  it('GÜVENLİK: güvensiz URL’li sticker HİÇ render edilmez', async () => {
    fetchMock = makeFetch([PACK({
      stickers: [STICKER(), STICKER({ id: 'st-2', url: 'javascript:alert(1)' })],
    })]);
    await openPanel();

    expect(imgs()).toHaveLength(1);
    expect(imgs().every(i => i.getAttribute('src')!.startsWith('/uploads/stickers/'))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C3 — GÜVENLİK: yönetim fail-closed', () => {
  it('MANAGE_SERVER varsa yönetim kontrolleri görünür', async () => {
    await openPanel();
    await vi.waitFor(() => { flushSync(); expect(delBtn()).toBeDefined(); });

    expect(delBtn()).toBeDefined();
  });

  it('MANAGE_SERVER YOKSA yönetim kontrolleri GÖRÜNMEZ', async () => {
    fetchMock = makeFetch([PACK()], 0);
    await openPanel();
    flushSync();

    expect(delBtn()).toBeUndefined();
    expect(panel()!.querySelector('.sp-rename-btn')).toBeNull();
  });

  it('yetki ucu HATA verirse yönetim GÖRÜNMEZ (yetki varsayılmaz)', async () => {
    fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/me/permissions')) throw new Error('offline');
      if (u.endsWith('/sticker-packs'))  return ok([PACK()]);
      return ok(null, 204);
    });
    await openPanel();
    flushSync();

    expect(delBtn()).toBeUndefined();
  });

  it('silme İKİ ADIMLIDIR — tek tıkla kalıcı veri kaybı olmaz', async () => {
    await openPanel();
    await vi.waitFor(() => { flushSync(); expect(delBtn()).toBeDefined(); });

    delBtn()!.click();
    flushSync();

    // Henüz istek YOK; önce onay istenir.
    expect(fetchMock.mock.calls.filter(c => (c[1] as RequestInit)?.method === 'DELETE')).toHaveLength(0);
    expect(panel()!.textContent).toContain('silinsin mi');
  });

  it('onaylanan silme doğru paketi siler ve yalnız gerçek başarıdan sonra kaldırır', async () => {
    await openPanel();
    await vi.waitFor(() => { flushSync(); expect(delBtn()).toBeDefined(); });

    delBtn()!.click();
    flushSync();
    [...panel()!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Sil')!.click();

    await vi.waitFor(() => { flushSync(); expect(deleteCalls()).toHaveLength(1); });
    expect(String(deleteCalls()[0]![0])).toBe(`http://test/api/servers/${SID}/sticker-packs/pack-1`);
    await vi.waitFor(() => { flushSync(); expect(panel()!.querySelectorAll('.sp-pack')).toHaveLength(0); });
  });

  it('yeniden adlandırma kırpılmış adı doğru paket/sticker sözleşmesiyle gönderir', async () => {
    await openPanel();
    await vi.waitFor(() => { flushSync(); expect(panel()!.querySelector('.sp-rename-btn')).not.toBeNull(); });

    panel()!.querySelector<HTMLButtonElement>('.sp-rename-btn')!.click();
    flushSync();
    const input = panel()!.querySelector<HTMLInputElement>('.sp-rename')!;
    input.value = '  Yeni ad  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => expect(patchCalls()).toHaveLength(1));
    const [url, init] = patchCalls()[0]!;
    expect(String(url)).toBe(`http://test/api/servers/${SID}/sticker-packs/pack-1/stickers/st-1`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: 'Yeni ad' });
    await vi.waitFor(() => { flushSync(); expect(panel()!.textContent).toContain('Yeni ad'); });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C3 — kapsam dürüstlüğü', () => {
  it('GÖNDERME yüzeyi GERÇEKTİR ve sahibine delege eder', async () => {
    // Bu test eskiden "gönderme yüzeyi YOKTUR" diyordu ve o zamanki ürün için
    // doğruydu. Gönderim bu arada UYGULANDI (`StickerPanel` gönder düğmesi →
    // `StickerOpener.onSend` → BridgeRegistry `sendSticker`). Korunan değer
    // aynı kaldı: düğme SAHTE başarı üretmez — sahibi reddederse panel açık
    // kalır ve kullanıcıya hata bildirilir.
    const send = vi.fn(() => true);
    BridgeRegistry.register('sendSticker', send as never);
    try {
      await openPanel();
      const sendBtn = [...panel()!.querySelectorAll<HTMLButtonElement>('button.sp-send-btn')][0];
      expect(sendBtn).toBeTruthy();
      sendBtn!.click();
      flushSync();
      expect(send).toHaveBeenCalledTimes(1);
      // Basarili gonderimde panel KAPANIR.
      await vi.waitFor(() => { flushSync(); expect(panel()).toBeNull(); });
    } finally {
      BridgeRegistry.unregister('sendSticker');
    }
  });

  it('sahibi REDDEDERSE panel açık kalır ve hata bildirilir', async () => {
    const send = vi.fn(() => false);
    const toast = vi.fn();
    BridgeRegistry.register('sendSticker', send as never);
    BridgeRegistry.register('toast', toast as never);
    try {
      await openPanel();
      const sendBtn = [...panel()!.querySelectorAll<HTMLButtonElement>('button.sp-send-btn')][0]!;
      sendBtn.click();
      flushSync();
      expect(send).toHaveBeenCalledTimes(1);
      expect(panel()).not.toBeNull();
      expect(toast).toHaveBeenCalledWith(t('ui_sticker_gonderim_kuyruguna_alinamadi'), 'error');
    } finally {
      BridgeRegistry.unregister('sendSticker');
      BridgeRegistry.unregister('toast');
    }
  });

  it('paket oluşturma yüzeyi yetki KANITLANANA kadar gizli kalır', async () => {
    let releasePermission!: (response: Response) => void;
    fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/me/permissions')) {
        return new Promise<Response>(resolve => { releasePermission = resolve; });
      }
      if (u.endsWith('/sticker-packs')) return ok([PACK()]);
      return ok(null, 204);
    });

    opener()!.click();
    await vi.waitFor(() => { flushSync(); expect(permissionCalls()).toHaveLength(1); });
    expect(panel()!.querySelector('.sp-create')).toBeNull();

    releasePermission(ok({ permissions: MANAGE_SERVER }));
    await vi.waitFor(() => {
      flushSync();
      expect([...panel()!.querySelectorAll('button')]
        .some(button => button.textContent?.includes('Yeni paket oluştur'))).toBe(true);
    });
  });
});
