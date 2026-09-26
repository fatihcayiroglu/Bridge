// client/tests/soundboard-paging-window-guards.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// ════════════════════════════════════════════════════════════════════════════
// soundboard.ts — SINIRSIZ HİSSEDEN KİTAPLIK, SINIRLI MİMARİ
// ════════════════════════════════════════════════════════════════════════════
// Ürün kuralı: kullanıcıya küçük bir ses sayısı tavanı GÖSTERİLMEZ. Kitaplık
// binlerce ses içerebilir. Bunun bedeli mimarinin sınırlı kalmasıdır —
// aksi hâlde "sınırsız" vaadi, donan bir sekmeye dönüşür.
//
// Bu paket o sınırların ÜÇÜNÜ birden ölçer:
//
//   1. SAYFALAMA — imleç (cursor) ile ilerler. Sunucu AYNI imleci tekrar
//      döndürürse istek döngüsü OLUŞMAMALIDIR; bozuk bir arka uç istemciyi
//      sonsuz isteğe sokamaz.
//   2. TEKİLLEŞTİRME — sayfalar çakışabilir (araya yeni ses eklenmesi
//      imleçleri kaydırır). Aynı ses İKİ KEZ eklenmez; güncel sürümü
//      YERİNDE değiştirilir, yoksa kullanıcı aynı sesi iki kez görür.
//   3. SINIRLI DOM — kaç ses yüklenirse yüklensin ekrandaki hücre sayısı
//      `SOUNDBOARD_DOM_WINDOW_SIZE` ile sınırlıdır ve kaydırma penceresi
//      kayar. Sınır olmasaydı 1500 ses 1500 düğüm demek olurdu.
//
// Ayrıca uçuş hâlindeki bir sayfanın İPTAL/HATA yolları ölçülür: panel
// kapandıysa geç gelen yanıt hiçbir şey yazmamalı, hata ise kullanıcıya
// AÇIKÇA söylenmelidir (sessiz başarısızlık yok).
import { beforeEach, describe, expect, it, vi } from 'vitest';

// KANONİK SÖZLÜĞE DEVRET.
// Önceki çift `(key, fallback) => fallback` biçimindeydi: yedek metni olmayan
// çağrılar HAM ANAHTAR döndürüyor, üçüncü argüman (`vars`) ise tamamen yok
// sayıldığı için `'{count} ses yüklendi'` gibi metinler YER TUTUCULARI
// YERLEŞTİRİLMEDEN kalıyordu. Böyle bir çift, ürünün yapmadığı bir davranışı
// ölçer; testler de gerçek metni değil çiftin kusurunu doğrular.
vi.mock('../js/core/i18n/index', async () => {
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { ...real };
});

import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import {
  SOUNDBOARD_DOM_WINDOW_SIZE, SOUNDBOARD_PAGE_SIZE,
  closeSoundboardPanel, initSoundboardSocket, loadMoreSoundboard, openSoundboard,
  setSoundboardMuted, setSoundboardVolume, stopSoundboard,
} from '../js/soundboard.ts';

const toast = vi.fn();
const apiFetch = vi.fn();

const response = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) } as unknown as Response);

const page = (items: unknown[], nextCursor: string | null = null, canManage = false): unknown =>
  ({ items, nextCursor, canManage });

const sound = (index: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ _id: `snd-${index}`, name: `Sound ${index}`, emoji: '🔊', url: `/sound-${index}.ogg`, scope: 'server', ...extra });

const batch = (from: number, count: number) =>
  Array.from({ length: count }, (_, offset) => sound(from + offset));

const flush = async (): Promise<void> => {
  await Promise.resolve(); await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
};

class AudioStub {
  static instances: AudioStub[] = [];
  src: string; volume = 1;
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  pause = vi.fn(); play = vi.fn(async () => undefined);
  constructor(src = '') { this.src = src; AudioStub.instances.push(this); }
}
class FakeSocket { on = vi.fn(() => this); off = vi.fn(() => this); emit = vi.fn(); }

const grid = () => document.getElementById('soundboard-grid') as HTMLElement;
const cells = () => document.querySelectorAll('.sound-cell');
const pageLabel = () => document.getElementById('soundboard-page-label')?.textContent ?? '';

/** Kaydırma ölçüleri jsdom'da hesaplanmaz; açıkça taklit edilir. */
function measurableGrid(scrollHeight = 10_000, clientHeight = 400): HTMLElement {
  const node = grid();
  Object.defineProperty(node, 'clientHeight', { configurable: true, value: clientHeight });
  Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  return node;
}

async function openWith(first: unknown): Promise<void> {
  // `openSoundboard` bir AÇMA/KAPAMA denetimidir: panel açıkken yeniden
  // çağrılmak onu KAPATIR. Testler arka arkaya kitaplık kurduğu için önce
  // açıkça kapatılır, yoksa ikinci kurulum sessizce hiç açılmazdı.
  closeSoundboardPanel();
  apiFetch.mockResolvedValueOnce(response(200, first));
  await openSoundboard();
  await flush();
}

beforeEach(() => {
  stopSoundboard(); closeSoundboardPanel();
  initSoundboardSocket(new FakeSocket())();
  document.body.innerHTML = '<div class="chat-area"></div>';
  localStorage.clear();
  toast.mockReset(); apiFetch.mockReset();
  AudioStub.instances.length = 0;
  vi.stubGlobal('toast', toast); vi.stubGlobal('apiFetch', apiFetch); BridgeRegistry.register('apiFetch', apiFetch as never); vi.stubGlobal('API', 'https://bridge.test');
  vi.stubGlobal('currentServer', { _id: 's1' }); vi.stubGlobal('Audio', AudioStub as unknown as typeof Audio);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:s') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  BridgeRegistry.unregister('getCurrentServer');
  BridgeRegistry.register('rtc', { isInVoice: () => true, currentChannelId: 'voice-1' } as never);
  BridgeRegistry.register('socket', { emit: vi.fn() } as never);
  setSoundboardMuted(false); setSoundboardVolume(0.8);
});

describe('cursor paging refuses to loop and never duplicates a sound', () => {
  it('stops paging when the backend repeats the same cursor', async () => {
    await openWith(page(batch(1, SOUNDBOARD_PAGE_SIZE), 'cursor-a'));
    apiFetch.mockClear();

    // Bozuk arka uç: AYNI imleci geri veriyor.
    apiFetch.mockResolvedValueOnce(response(200, page(batch(100, 5), 'cursor-a')));
    expect(await loadMoreSoundboard()).toBe(true);

    // İmleç tüketildi sayılır: ikinci çağrı isteğe DÖNÜŞMEZ.
    expect(await loadMoreSoundboard()).toBe(false);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('updates an overlapping sound in place instead of listing it twice', async () => {
    await openWith(page([sound(1, { name: 'Eski ad' }), sound(2)], 'cursor-a'));

    // Sayfalar çakıştı: `snd-1` ikinci sayfada da geldi, adı değişmiş.
    apiFetch.mockResolvedValueOnce(response(200, page(
      [sound(1, { name: 'Yeni ad' }), sound(3)], null)));
    expect(await loadMoreSoundboard()).toBe(true);

    expect(cells()).toHaveLength(3);
    const names = [...document.querySelectorAll('.sound-name')].map(n => n.textContent);
    expect(names).toContain('Yeni ad');
    expect(names).not.toContain('Eski ad');
    expect(names.filter(name => name === 'Yeni ad')).toHaveLength(1);
  });

  it('refuses to append without a panel, a cursor or while a page is in flight', async () => {
    // İmleç yok.
    await openWith(page([sound(1)], null));
    expect(await loadMoreSoundboard()).toBe(false);

    // Uçuşta ikinci çağrı.
    await openWith(page(batch(1, 4), 'cursor-a'));
    let release: (value: Response) => void = () => {};
    apiFetch.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const inFlight = loadMoreSoundboard();
    expect(await loadMoreSoundboard()).toBe(false);
    release(response(200, page(batch(10, 2), null)));
    expect(await inFlight).toBe(true);

    // Panel kapalı.
    closeSoundboardPanel();
    expect(await loadMoreSoundboard()).toBe(false);
  });

  it('discards a page that arrives after the panel was closed', async () => {
    await openWith(page(batch(1, 4), 'cursor-a'));
    let release: (value: Response) => void = () => {};
    apiFetch.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));

    const pending = loadMoreSoundboard();
    closeSoundboardPanel();
    release(response(200, page(batch(50, 4), null)));

    // Geç yanıt sökülmüş panele YAZMAZ ve hata gürültüsü üretmez.
    expect(await pending).toBe(false);
    expect(document.getElementById('soundboard-panel')).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('append failures are reported, never silent', () => {
  it('surfaces the server message when the next page is refused', async () => {
    await openWith(page(batch(1, 4), 'cursor-a'));
    apiFetch.mockResolvedValueOnce({
      ok: false, status: 500, json: vi.fn(async () => ({ error: 'Ses deposu yanıt vermiyor' })),
    } as unknown as Response);

    expect(await loadMoreSoundboard()).toBe(false);
    // Sunucunun `error` govdesi kullaniciya SIZMAZ: 500 kanonik metne eslenir.
    expect(toast).toHaveBeenCalledWith(t('error_server'), 'error');
    expect(toast).not.toHaveBeenCalledWith('Ses deposu yanıt vermiyor', 'error');
    // Yüklenmiş sesler KORUNUR; başarısız ek yükleme listeyi boşaltmaz.
    expect(cells()).toHaveLength(4);
  });

  it('falls back to a readable message when a bare value is thrown', async () => {
    await openWith(page(batch(1, 4), 'cursor-a'));
    apiFetch.mockImplementationOnce(() => { throw 'kablo koptu'; });

    expect(await loadMoreSoundboard()).toBe(false);
    expect(toast).toHaveBeenCalledWith('Sesler yüklenemedi', 'error');
  });

  it('releases the in-flight lock so a later page can still load', async () => {
    await openWith(page(batch(1, 4), 'cursor-a'));
    apiFetch.mockImplementationOnce(() => { throw new Error('geçici'); });
    expect(await loadMoreSoundboard()).toBe(false);

    apiFetch.mockResolvedValueOnce(response(200, page(batch(10, 3), null)));
    expect(await loadMoreSoundboard()).toBe(true);
    expect(cells()).toHaveLength(7);
  });
});

describe('the DOM stays bounded however large the library grows', () => {
  async function loadLibrary(total: number): Promise<void> {
    await openWith(page(batch(1, SOUNDBOARD_PAGE_SIZE), 'c1'));
    let loaded = SOUNDBOARD_PAGE_SIZE;
    let cursorIndex = 2;
    while (loaded < total) {
      const size = Math.min(SOUNDBOARD_PAGE_SIZE, total - loaded);
      const next = loaded + size < total ? `c${cursorIndex++}` : null;
      apiFetch.mockResolvedValueOnce(response(200, page(batch(loaded + 1, size), next)));
      expect(await loadMoreSoundboard()).toBe(true);
      loaded += size;
    }
  }

  it('caps rendered cells and never eagerly constructs audio', async () => {
    await loadLibrary(600);

    expect(cells().length).toBeLessThanOrEqual(SOUNDBOARD_DOM_WINDOW_SIZE);
    // Kullanıcıya küçük bir tavan GÖSTERİLMEZ: sayaç gerçek toplamı söyler.
    expect(pageLabel()).toContain('600');
    // 600 sesin hiçbiri için ses nesnesi kurulmaz — tembel yükleme.
    expect(AudioStub.instances).toHaveLength(0);
  });

  it('slides the window as the user scrolls without growing the DOM', async () => {
    await loadLibrary(600);
    const node = measurableGrid();

    const firstBefore = document.querySelector('.sound-cell')?.getAttribute('data-sound-id');
    node.scrollTop = 4_000;
    node.dispatchEvent(new Event('scroll'));
    await flush();

    const firstAfter = document.querySelector('.sound-cell')?.getAttribute('data-sound-id');
    expect(firstAfter).not.toBe(firstBefore);
    expect(cells().length).toBeLessThanOrEqual(SOUNDBOARD_DOM_WINDOW_SIZE);

    // Aynı konumda ikinci kaydırma yeniden çizim TETİKLEMEZ (pencere değişmedi).
    const stable = document.querySelector('.sound-cell');
    node.dispatchEvent(new Event('scroll'));
    await flush();
    expect(document.querySelector('.sound-cell')).toBe(stable);
  });

  it('ignores a scroll event delivered by anything other than the grid', async () => {
    await loadLibrary(600);
    const before = cells().length;
    const stray = document.createElement('div');
    stray.id = 'not-the-grid';
    document.getElementById('soundboard-panel')!.appendChild(stray);

    expect(() => stray.dispatchEvent(new Event('scroll'))).not.toThrow();
    await flush();
    expect(cells().length).toBe(before);
  });

  it('prefetches the next page when the user nears the end', async () => {
    await openWith(page(batch(1, SOUNDBOARD_PAGE_SIZE), 'c1'));
    const node = measurableGrid(800, 400);
    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response(200, page(batch(100, 4), null)));

    node.scrollTop = 400;              // dibe ulaşıldı
    node.dispatchEvent(new Event('scroll'));
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('redraws on resize only while a large library is open', async () => {
    await openWith(page([sound(1)], null));
    // Küçük kitaplık: yeniden boyutlandırma pencereyi yeniden hesaplamaz.
    expect(() => window.dispatchEvent(new Event('resize'))).not.toThrow();
    expect(cells()).toHaveLength(1);

    await loadLibrary(600);
    window.dispatchEvent(new Event('resize'));
    await flush();
    expect(cells().length).toBeLessThanOrEqual(SOUNDBOARD_DOM_WINDOW_SIZE);
  });
});

describe('search clearing is a real control, not just an input reset', () => {
  it('reveals the clear control only while a query is present', async () => {
    await openWith(page([sound(1)], null));
    const clear = document.querySelector<HTMLButtonElement>('[data-soundboard-action="clear-search"]')!;
    const search = document.getElementById('soundboard-search') as HTMLInputElement;
    expect(clear.hidden).toBe(true);

    search.value = 'davul';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(clear.hidden).toBe(false);
  });

  it('clears the field, cancels the pending debounce and refetches once', async () => {
    await openWith(page([sound(1)], null));
    const search = document.getElementById('soundboard-search') as HTMLInputElement;
    search.value = 'davul';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    // Sorgu GERÇEKTEN çalıştırılır; hiç gönderilmemiş bir sorguyu temizlemek
    // doğru olarak bir no-op'tur ve ölçülen şey o değildir.
    apiFetch.mockResolvedValue(response(200, page([sound(7)], null)));
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();

    search.value = 'davul2';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(response(200, page([sound(1)], null)));

    document.querySelector<HTMLButtonElement>('[data-soundboard-action="clear-search"]')!.click();
    await flush();

    expect(search.value).toBe('');
    expect(document.querySelector<HTMLButtonElement>('[data-soundboard-action="clear-search"]')!.hidden).toBe(true);
    expect(document.activeElement).toBe(search);

    // Bekleyen debounce İPTAL edilir: temizleme tek bir istek üretir, iki değil.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('runs the query immediately on Enter without waiting for the debounce', async () => {
    await openWith(page([sound(1)], null));
    const search = document.getElementById('soundboard-search') as HTMLInputElement;
    search.value = 'zil';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(response(200, page([sound(9)], null)));

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(String(apiFetch.mock.calls[0][0])).toContain('zil');

    // Debounce de iptal edilmiştir; ikinci bir istek gelmez.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
