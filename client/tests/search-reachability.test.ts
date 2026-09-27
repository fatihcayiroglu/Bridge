// client/tests/search-reachability.test.ts
// FAZ F — SEARCH_CLIENT: DORMANT → WORKING (davranışsal kanıt).
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU PAKET VAR
// ════════════════════════════════════════════════════════════════════════════
// Faz D'de arama UCU güvenlik açısından sertleştirilmişti (VIEW_CHANNELS
// kapsama denetimi, 17 test). Faz F ölçümü ise şunu gösterdi: o sertleştirilmiş
// uca ULAŞABİLEN sevk edilmiş bir istemci YOKTU — `SearchPanel.svelte` 16 build
// girişinin HİÇBİRİNİN import kapanışında değildi.
//
// Panel ÖLÜ olduğu için içindeki sözleşme hataları da hiç fark edilmemişti.
// Uyandırmadan ÖNCE düzeltilenler (üçü de bu pakette kilitlenir):
//   1. `/api/servers/:id/search` çağrılıyordu — BÖYLE BİR ROTA YOK (404).
//      Gerçek uç: `GET /api/search`.
//   2. `page` gönderiliyordu; sunucu `offset` okur.
//   3. `{ results }` bekleniyordu; sunucu `{ messages, channels, members }` döner.
// Ayrıca sunucu üye dalını `type=users` ile anahtarlar ('members' değil).
//
// "Bundle'da string görünüyor" KANIT DEĞİLDİR (Faz C4.7'deki yanlış teşhis tam
// olarak buydu). Burada gerçek mount köprüsü çalıştırılır, gerçek ürün açıcıları
// çağrılır ve gerçek istek yolu ölçülür.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { mountSearchPanel, unmountSearchPanel } from '../js/core/search-svelte.ts';
import { _activeTrapCount } from '../js/core/a11y/focusTrap.ts';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SERVER = { _id: 'srv-1', name: 'Test Sunucu' };

/** Sunucunun GERÇEK yanıt gövdesi (server/routes/search.ts:333). */
function body(over: Record<string, unknown> = {}) {
  return { messages: [], channels: [], members: [], hasMore: false, ...over };
}
const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b } as unknown as Response);

let fetchMock: ReturnType<typeof vi.fn>;

const panel   = () => document.querySelector('.search-overlay');
const input   = () => document.querySelector<HTMLInputElement>('.search-input');
const items   = () => [...document.querySelectorAll('.search-result-item')];
const urls    = () => fetchMock.mock.calls.map(c => String(c[0]));
const lastUrl = () => urls()[urls().length - 1] ?? '';

function boot(): void {
  const root = document.createElement('div');
  root.id = 'search-root';
  document.body.appendChild(root);
  mountSearchPanel(root);
  flushSync();
}

/** Komut Paleti'nin kullandığı kanonik sözleşme. */
function openViaRegistry(sid = SERVER._id): void {
  const open = BridgeRegistry.get<(s: string) => void>('openSearch');
  if (!open) throw new Error('openSearch KAYITLI DEĞİL — ürün açıcısı kopmuş');
  open(sid);
  flushSync();
}

/**
 * Kabuk düğmesinin GERÇEK çağrı biçimi.
 * `index.html` dispatcher'ı: `BridgeRegistry.call(action, el, ...arg)` —
 * yani İLK argüman TIKLANAN ELEMANDIR.
 */
function openViaShellButton(): void {
  const el = document.createElement('button');
  BridgeRegistry.call('openSearchFromShell', el);
  flushSync();
}

async function type(q: string): Promise<void> {
  const el = input()!;
  el.value = q;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  await vi.advanceTimersByTimeAsync(300);   // debounce 250ms
  flushSync();
}

async function settleSearch(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers();
  unmountSearchPanel();
  document.body.innerHTML = '';
  fetchMock = vi.fn(async () => ok(body()));
  BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
  BridgeRegistry.register('currentServer', () => SERVER);
});

afterEach(() => {
  unmountSearchPanel();
  for (const k of ['apiFetch', 'currentServer', 'openSearch', 'closeSearch', 'openSearchFromShell', 'navigateToChannel']) {
    BridgeRegistry.unregister(k);
  }
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// 1) ULAŞILABİLİRLİK — üretim yolu
// ════════════════════════════════════════════════════════════════════════════
describe('Faz F — SEARCH_CLIENT gerçekten ulaşılabilir', () => {
  it('üretim giriş noktası köprüyü İMPORT EDER', () => {
    const app = fs.readFileSync(path.join(CLIENT, 'js/app.ts'), 'utf8');
    expect(app).toMatch(/core\/search-svelte/);
  });

  it('kabukta GERÇEK bir kullanıcı açıcısı vardır', () => {
    const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
    expect(html).toMatch(/data-bridge-action="openSearchFromShell"/);
    // Erişilebilir ad ZORUNLU: ikon-only düğme ekran okuyucuda adsız kalmamalı.
    //
    // FAZ K/1 — sabit metin yerine ADIN VARLIĞI doğrulanır. Düğme artık sunucu
    // seçili değilken küresel aramaya düşüyor (önceden SESSİZCE hiçbir şey
    // yapmıyordu), bu yüzden "Sunucuda ara" adı YANLIŞ olurdu. Testin koruduğu
    // şey adın kendisi değil, adsız kalmaması.
    const button = html.match(/<button[^>]*id="btn-search"[^>]*>/)?.[0] ?? '';
    expect(button).toBeTruthy();
    expect(button).toMatch(/aria-label="[^"]+"/);
  });

  it('POZİTİF KONTROL: mount köprüsü paneli kurar ve açıcıları KAYDEDER', () => {
    boot();
    expect(BridgeRegistry.has('openSearch')).toBe(true);
    expect(BridgeRegistry.has('openSearchFromShell')).toBe(true);
    // Henüz açılmadı — panel görünmemeli.
    expect(panel()).toBeNull();
  });

  it('kayıt sözleşmesi ile açılır (Komut Paleti yolu)', () => {
    boot();
    openViaRegistry();
    expect(panel()).not.toBeNull();
  });

  it('KABUK DÜĞMESİ yolu ile açılır (ilk argüman ELEMANDIR)', () => {
    boot();
    openViaShellButton();
    // Adaptör `el`i yok sayıp aktif sunucuyu kanonik kaynaktan çözmeli.
    expect(panel()).not.toBeNull();
  });

  it('sunucu seçili DEĞİLKEN sunucu-içi panel AÇILMAZ', () => {
    // Sunucu kapsamı olmadan bu panel anlamsızdır (sorgusu `serverId` ister).
    BridgeRegistry.register('currentServer', () => null);
    boot();
    openViaShellButton();
    expect(panel()).toBeNull();
  });

  it('sunucu seçili DEĞİLKEN düğme KÜRESEL aramaya devreder', () => {
    // FAZ K/1 — ÖNCEKİ DAVRANIŞ BİR KUSURDU: düğme sessizce hiçbir şey
    // yapmıyordu. Görünür bir kontrole basıp hiçbir tepki almamak, kullanıcı
    // için bozuk bir uygulamadır. Küresel arama sunucu üyeliği gerektirmez.
    const openGlobal = vi.fn();
    BridgeRegistry.register('currentServer', () => null);
    BridgeRegistry.register('openGlobalSearch', openGlobal);
    try {
      boot();
      openViaShellButton();
      expect(openGlobal).toHaveBeenCalled();
      expect(panel()).toBeNull();
    } finally {
      BridgeRegistry.unregister('openGlobalSearch');
    }
  });

  it('TEK sahip: panel bir kez mount edilir', () => {
    boot();
    boot();   // ikinci çağrı — guard devreye girmeli
    expect(document.querySelectorAll('#search-root').length).toBeGreaterThan(0);
    openViaRegistry();
    expect(document.querySelectorAll('.search-overlay').length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2) GERÇEK İSTEK YOLU — sunucu sözleşmesi
// ════════════════════════════════════════════════════════════════════════════
describe('Faz F — arama GERÇEK /api/search ucuna gider', () => {
  it('doğru YOL kullanılır (eski 404 yolu DEĞİL)', async () => {
    boot(); openViaRegistry();
    await type('merhaba');

    expect(lastUrl()).toContain('/api/search?');
    // Regresyon kilidi: uydurma rota geri gelemez.
    expect(lastUrl()).not.toContain('/api/servers/');
  });

  it('sunucunun beklediği parametreleri gönderir (offset, serverId, limit)', async () => {
    boot(); openViaRegistry();
    await type('merhaba');

    const u = new URL('http://x' + lastUrl());
    expect(u.searchParams.get('q')).toBe('merhaba');
    expect(u.searchParams.get('serverId')).toBe(SERVER._id);
    expect(u.searchParams.get('offset')).toBe('0');
    expect(u.searchParams.get('limit')).toBe('20');
    // `page` sunucuda OKUNMAZ — gönderilmemeli.
    expect(u.searchParams.get('page')).toBeNull();
  });

  it('2 karakterden kısa sorgu İSTEK ATMAZ (sunucu da reddederdi)', async () => {
    boot(); openViaRegistry();
    await type('a');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sunucunun AYRI dizilerini sonuç listesine indirger', async () => {
    fetchMock = vi.fn(async () => ok(body({
      messages: [
        { _id: 'm1', content: 'merhaba dunya', channelId: 'c1',
          channelName: 'genel', displayName: 'Ali', createdAt: Date.now() },
      ],
    })));
    boot(); openViaRegistry();
    await type('merhaba');

    expect(items().length).toBe(1);
    expect(document.body.textContent).toContain('merhaba dunya');
    expect(document.body.textContent).toContain('genel');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3) DURUMLAR — yükleme / boş / hata
// ════════════════════════════════════════════════════════════════════════════
describe('Faz F — yükleme, boş ve hata durumları', () => {
  it('sonuç yokken BOŞ durumu gösterir, hata GÖSTERMEZ', async () => {
    boot(); openViaRegistry();
    await type('bulunamaz');

    expect(document.querySelector('.search-error')).toBeNull();
    expect(items().length).toBe(0);
  });

  it('HTTP hatasında hata durumu gösterir (role=alert)', async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 500 } as unknown as Response));
    boot(); openViaRegistry();
    await type('merhaba');

    const err = document.querySelector('.search-error');
    expect(err).not.toBeNull();
    expect(err!.getAttribute('role')).toBe('alert');
  });

  it('hata sonrası BAŞARILI arama hatayı TEMİZLER', async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 500 } as unknown as Response));
    boot(); openViaRegistry();
    await type('merhaba');
    expect(document.querySelector('.search-error')).not.toBeNull();

    fetchMock.mockImplementation(async () => ok(body({
      messages: [{ _id: 'm1', content: 'oldu', channelId: 'c1', channelName: 'genel' }],
    })));
    await type('merhaba2');

    expect(document.querySelector('.search-error')).toBeNull();
    expect(items().length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4) İZİN GÜVENLİĞİ — istemci yetki KARARI VERMEZ
// ════════════════════════════════════════════════════════════════════════════
describe('Faz F — izin güvenli render (sunucu tek yetkili)', () => {
  it('istemci sunucunun döndürdüğünü render eder; KENDİ izin filtresi YOKTUR', async () => {
    // Faz D sertleştirmesi sunucudadır (`viewableChannelIds`). İstemcide
    // ikinci bir filtre yazmak, güvenliği istemciye taşıdığı YANILGISINI
    // yaratır ve iki kaynak arasında sapma üretirdi. Sunucu ne dönerse o
    // gösterilir — görünürlük kararı SUNUCUNUNDUR.
    // Denetim KOD üzerinde yapılır, yorumlar üzerinde değil: bu dosyanın
    // yorumları Faz D sertleştirmesini AÇIKLAR ve `VIEW_CHANNELS` adını
    // geçirir. Yorumları soymadan yapılan kontrol, doğru davranışı yanlışlıkla
    // ihlal sayardı.
    const raw = fs.readFileSync(path.join(CLIENT, 'js/core/SearchPanel.svelte'), 'utf8');
    const code = raw
      .replace(/<!--[\s\S]*?-->/g, '')      // HTML yorumları
      .replace(/\/\*[\s\S]*?\*\//g, '')     // blok yorumlar
      .replace(/^\s*\/\/.*$/gm, '');        // satır yorumları
    expect(code).not.toMatch(/VIEW_CHANNELS|resolvePermissions|hasPerm/);

    fetchMock = vi.fn(async () => ok(body({
      messages: [{ _id: 'm1', content: 'gorunur', channelId: 'c1', channelName: 'genel' }],
    })));
    boot(); openViaRegistry();
    await type('gorunur');

    expect(items().length).toBe(1);
  });

  it('sunucu BOŞ döndürürse istemci hiçbir şey UYDURMAZ', async () => {
    boot(); openViaRegistry();
    await type('gizli');
    expect(items().length).toBe(0);
  });

  it('semantik arama BU panelden tetiklenmez (ayrı yetenek)', async () => {
    boot(); openViaRegistry();
    await type('merhaba');
    // SEMANTIC_SEARCH ayrı bir yetenektir ve Faz F'de aktive EDİLMEDİ.
    expect(urls().some(u => u.includes('/api/semantic'))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5) KLAVYE, ESCAPE, ODAK TUZAĞI
// ════════════════════════════════════════════════════════════════════════════
describe('Faz F — klavye ve odak davranışı', () => {
  it('açılınca odak arama kutusuna gider', () => {
    boot(); openViaRegistry();
    expect(document.activeElement).toBe(input());
  });

  it('modal odak tuzağı ETKİN olur ve kapanınca bırakılır', () => {
    const before = _activeTrapCount();
    boot(); openViaRegistry();
    expect(_activeTrapCount()).toBe(before + 1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();

    expect(panel()).toBeNull();
    expect(_activeTrapCount()).toBe(before);
  });

  it('Escape paneli kapatır', () => {
    boot(); openViaRegistry();
    expect(panel()).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();

    expect(panel()).toBeNull();
  });

  it('GİZLİ panel Escape\'i YUTMAZ', () => {
    boot();   // açılmadı
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.removeEventListener('keydown', spy);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
  });

  it('unmount sonrası kayıtlar BIRAKILIR (ölü bileşene çağrı gitmez)', () => {
    boot();
    expect(BridgeRegistry.has('openSearch')).toBe(true);

    unmountSearchPanel();
    flushSync();

    expect(BridgeRegistry.has('openSearch')).toBe(false);
    expect(BridgeRegistry.has('openSearchFromShell')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6) ABSENT YÜZEY UYDURULMADI
// ════════════════════════════════════════════════════════════════════════════
describe('Faz F — olmayan yetenek gösterilmez', () => {
  it('DOSYA sekmesi YOKTUR (sunucuda dosya arama dalı yok)', () => {
    boot(); openViaRegistry();
    const tabs = [...document.querySelectorAll('.search-tab')].map(t => t.textContent?.trim());
    expect(tabs.length).toBe(3);
    expect(tabs.join(' ')).not.toMatch(/Dosya/);
  });

  it('üye sekmesi sunucunun beklediği `type=users` ile sorar', async () => {
    boot(); openViaRegistry();
    const memberTab = [...document.querySelectorAll<HTMLElement>('.search-tab')]
      .find(t => /Üyeler/.test(t.textContent ?? ''));
    expect(memberTab, 'üye sekmesi bulunamadı').toBeTruthy();
    memberTab!.click();
    flushSync();
    await type('ali');

    expect(new URL('http://x' + lastUrl()).searchParams.get('type')).toBe('users');
  });
});

describe('Faz F — derin sonuç, sayfalama ve yaşam döngüsü davranışı', () => {
  it('mesaj/üye/kanal gövdelerini eksik alan fallbacks ile eşler ve sonuçları kapatır', async () => {
    fetchMock = vi.fn(async (url: string) => {
      const typeParam = new URL(`http://x${url}`).searchParams.get('type');
      if (typeParam === 'channels') {
        return ok(body({ channels: [{ _id: 7 }, { _id: 'c2', name: 'genel' }] }));
      }
      if (typeParam === 'users') {
        return ok(body({ members: [
          { _id: 'u1', displayName: 'Display' },
          { _id: 'u2', username: 'handle' },
          { _id: 'u3' },
        ] }));
      }
      return ok(body({ messages: [{ _id: 9 }] }));
    });
    boot(); openViaRegistry();
    await type('all');
    expect(items()).toHaveLength(1);
    expect(document.querySelector('.result-content')?.textContent).toBe('');

    const channelTab = [...document.querySelectorAll<HTMLButtonElement>('.search-tab')]
      .find(tab => /Kanallar/.test(tab.textContent ?? ''))!;
    channelTab.click();
    flushSync();
    await settleSearch();
    await vi.waitFor(() => expect(items()).toHaveLength(2));
    expect(document.querySelector('.result-name')?.textContent).toBe('');
    (items()[0] as HTMLButtonElement).click();
    flushSync();
    expect(panel()).toBeNull();

    openViaRegistry();
    await type('all');
    const memberTab = [...document.querySelectorAll<HTMLButtonElement>('.search-tab')]
      .find(tab => /Üyeler/.test(tab.textContent ?? ''))!;
    memberTab.click();
    flushSync();
    await settleSearch();
    await vi.waitFor(() => expect(items()).toHaveLength(3));
    expect(items().map(item => item.textContent?.trim())).toEqual(['👤 @Display', '👤 @handle', '👤 @']);
  });

  it('appends a deferred next page once, exposes loading state, and navigates a message result', async () => {
    const navigate = vi.fn();
    BridgeRegistry.register('navigateToChannel', navigate);
    let resolvePage!: (value: Response) => void;
    fetchMock = vi.fn(async (url: string) => {
      const offset = new URL(`http://x${url}`).searchParams.get('offset');
      if (offset === '20') return new Promise<Response>(resolve => { resolvePage = resolve; });
      return ok(body({
        messages: [{
          _id: 'm1', content: 'first', channelId: 'c1', channelName: 'general',
          username: 'alice', createdAt: Date.UTC(2024, 0, 1),
        }],
        hasMore: true,
      }));
    });
    boot(); openViaRegistry();
    await type('page');
    expect(document.querySelector('.search-count')?.textContent).toBe('1+ sonuç');

    const loadMore = document.querySelector<HTMLButtonElement>('.search-load-more')!;
    loadMore.click();
    flushSync();
    expect(document.querySelector<HTMLButtonElement>('.search-load-more')?.disabled).toBe(true);
    expect(document.querySelector('.search-load-more')?.textContent).toContain('Yükleniyor');
    loadMore.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolvePage(ok(body({ messages: [{ _id: 'm2' }], hasMore: false })));
    await settleSearch();
    await vi.waitFor(() => expect(items()).toHaveLength(2));
    expect(document.querySelector('.search-count')?.textContent).toBe('2 sonuç');
    expect(document.querySelector('.search-load-more')).toBeNull();
    loadMore.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    (items()[0] as HTMLButtonElement).click();
    flushSync();
    expect(navigate).toHaveBeenCalledWith('c1', 'm1');
    expect(panel()).toBeNull();
  });

  it('contains a missing fetch owner, refuses blank server ids, and cancels pending debounce on unmount', async () => {
    BridgeRegistry.unregister('apiFetch');
    boot(); openViaRegistry();
    await type('ownerless');
    expect(document.querySelector('.search-error')).not.toBeNull();

    BridgeRegistry.register('apiFetch', (...args: unknown[]) => fetchMock(...args));
    BridgeRegistry.call('closeSearch');
    flushSync();
    openViaRegistry('');
    await type('blank-server');
    expect(fetchMock).not.toHaveBeenCalled();

    BridgeRegistry.call('closeSearch');
    flushSync();
    openViaRegistry();
    const el = input()!;
    el.value = 'pending';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    el.value = 'replacement';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    unmountSearchPanel();
    flushSync();
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes absent result arrays and clears a populated panel without retaining stale labels', async () => {
    let populated = true;
    fetchMock = vi.fn(async (url: string) => {
      const typeParam = new URL(`http://x${url}`).searchParams.get('type');
      if (populated && typeParam === 'messages') {
        return ok(body({ messages: [{ _id: 'm1', content: 'visible' }] }));
      }
      return ok({ hasMore: false });
    });
    boot(); openViaRegistry();
    await type('visible');
    expect(items()).toHaveLength(1);
    expect(document.querySelector('.search-count')?.textContent).toBe('1 sonuç');

    populated = false;
    document.querySelector<HTMLButtonElement>('.search-clear')!.click();
    flushSync();
    expect(input()?.value).toBe('');
    expect(document.querySelector('.search-count')).toBeNull();
    expect(document.querySelector('.search-hint')).not.toBeNull();

    await type('absent');
    expect(items()).toHaveLength(0);
    for (const label of ['Kanallar', 'Üyeler']) {
      const tab = [...document.querySelectorAll<HTMLButtonElement>('.search-tab')]
        .find(candidate => candidate.textContent?.includes(label))!;
      tab.click();
      flushSync();
      await settleSearch();
      await vi.waitFor(() => expect(items()).toHaveLength(0));
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FAZ K/1 — KÜRESEL ARAMA da ULAŞILABİLİR olmalı
// ════════════════════════════════════════════════════════════════════════════
// `SearchPanel` tam olarak şu şekilde ölmüştü: gerçek bir uygulamaydı ama
// hiçbir giriş noktasının import kapanışında değildi. Aynı hata küresel arama
// için de sessizce tekrarlanabilir — sunucu ucu çalışır, panel yazılır, ve
// kullanıcıya HİÇ ulaşmaz. Bu blok o yolu kilitler.
describe('Faz K/1 — GLOBAL_SEARCH ulaşılabilir', () => {
  it('üretim giriş noktası köprüyü İMPORT EDER', () => {
    const app = fs.readFileSync(path.join(CLIENT, 'js/app.ts'), 'utf8');
    expect(app).toMatch(/core\/global-search-svelte/);
  });

  it('mount köprüsü paneli kurar ve açıcıyı KAYDEDER', async () => {
    const { mountGlobalSearch, unmountGlobalSearch } =
      await import('../js/core/global-search-svelte.ts');
    mountGlobalSearch();
    try {
      expect(BridgeRegistry.has('openGlobalSearch')).toBe(true);
    } finally {
      unmountGlobalSearch();
    }
  });

  it('sökme kayıtları BIRAKIR — ölü bileşene işaret kalmaz', async () => {
    const { mountGlobalSearch, unmountGlobalSearch } =
      await import('../js/core/global-search-svelte.ts');
    mountGlobalSearch();
    unmountGlobalSearch();
    expect(BridgeRegistry.has('openGlobalSearch')).toBe(false);
  });

  it('komut paleti artık ÇALIŞAN bir kısayol öğretir', () => {
    // Palet `Ctrl+F`i sunucu içi aramanın kısayolu olarak gösteriyordu ama o
    // tuş HİÇBİR YERE bağlı değildi: kullanıcıya çalışmayan bir kısayol
    // öğretiliyordu. Artık Ctrl+F küresel aramaya bağlıdır.
    const palette = fs.readFileSync(path.join(CLIENT, 'js/core/CommandPalettePanel.svelte'), 'utf8');
    const globalPanel = fs.readFileSync(path.join(CLIENT, 'js/core/GlobalSearchPanel.svelte'), 'utf8');

    expect(palette).toMatch(/id: 'open-global-search'/);
    expect(palette).toMatch(/openGlobalSearch/);
    // Kısayol etiketi yalnızca GERÇEKTEN bağlı olan komutta kalır.
    const serverSearchCmd = palette.slice(palette.indexOf("id: 'open-search'"), palette.indexOf("id: 'open-settings'"));
    expect(serverSearchCmd).not.toMatch(/Ctrl\+F/);
    expect(globalPanel).toMatch(/e\.key === 'f'/);
  });
});
