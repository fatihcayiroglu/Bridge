// client/tests/GlobalSearchPanel.test.ts
//
// FAZ K/1 — KURESEL ARAMA YUZEYI.
//
// ════════════════════════════════════════════════════════════════════════════
// NE KORUNUYOR
// ════════════════════════════════════════════════════════════════════════════
// • Ctrl/Cmd+K komut paletinde KALIR. Bu panel Ctrl/Cmd+F ile acilir.
//   Paleti devralmak calisan bir yuzeyi bozardi; test iki yonu de kilitler.
// • Dort durum da GERCEKTEN cizilir: son aramalar, yukleniyor, bos, hata.
//   Hata durumu ozellikle onemli: sessizce bos liste gostermek kullaniciya
//   "sonuc yok" der, oysa arama BOZUKTUR.
// • Klavye tek basina yeterlidir (ok/Enter/Escape) ve listbox sozlesmesi
//   (`aria-activedescendant`, `aria-selected`) gercekten guncellenir.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';

const registryMap: Record<string, unknown> = {};

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register:   (key: string, fn: unknown) => { registryMap[key] = fn; },
    unregister: (key: string) => { delete registryMap[key]; },
    has:        (key: string) => key in registryMap,
    get:        (key: string) => registryMap[key],
    call:       (key: string, ...args: unknown[]) => {
      const v = registryMap[key];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown)(...args) : v;
    },
  },
}));

vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Odak tuzagi jsdom'da gercek odak yonetimi gerektirir; bu paket panelin
// KENDI davranisini olcer, tuzagi degil.
vi.mock('../js/core/a11y/focusTrap.ts', () => ({ focusTrap: () => ({ destroy() {} }) }));

import GlobalSearchPanel from '../js/core/GlobalSearchPanel.svelte';
import {
  replaceLocalFirstHistory,
  resetLocalFirstHistoryRuntimeForTests,
} from '../js/core/local-first/history-runtime.ts';

// ── Yardimcilar ────────────────────────────────────────────────────────────

const channelRow = (over: Record<string, unknown> = {}) => ({
  _id: 'm1', source: 'channel', content: 'merhaba dunya', displayName: 'Ayse',
  userId: 'u1', createdAt: Date.now(), score: 3, channelId: 'c1',
  channelName: 'genel', serverId: 's1', ...over,
});

const dmRow = (over: Record<string, unknown> = {}) => ({
  _id: 'd1', source: 'dm', content: 'merhaba dm', displayName: 'Veli',
  userId: 'u2', createdAt: Date.now(), score: 2, dmId: 'conv1', ...over,
});

function mockApi(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response);
}

/** Paneli acar ve sorguyu yazar; debounce + istek tamamlanana kadar bekler. */
async function openWith(query: string) {
  (registryMap.openGlobalSearch as (q?: string) => void)('');
  await waitFor(() => expect(document.querySelector('.gs-panel')).toBeTruthy());

  if (query) {
    const input = document.querySelector<HTMLInputElement>('.gs-input')!;
    await fireEvent.input(input, { target: { value: query } });
  }
  return document.querySelector<HTMLElement>('.gs-panel')!;
}

const optionIds = () =>
  [...document.querySelectorAll('[role="option"]')].map(el => el.id);

const selectedId = () =>
  document.querySelector('[role="option"][aria-selected="true"]')?.id ?? null;

beforeEach(() => {
  for (const key of Object.keys(registryMap)) delete registryMap[key];
  vi.clearAllMocks();
  localStorage.clear();
  resetLocalFirstHistoryRuntimeForTests();
});

afterEach(() => {
  resetLocalFirstHistoryRuntimeForTests();
  cleanup();
});

// ════════════════════════════════════════════════════════════════════════════
describe('acilis / kapanis', () => {
  it('registry uzerinden acilir ve kapanir', async () => {
    render(GlobalSearchPanel);
    expect(document.querySelector('.gs-panel')).toBeNull();

    (registryMap.openGlobalSearch as () => void)();
    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeTruthy());

    (registryMap.closeGlobalSearch as () => void)();
    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeNull());
  });

  it('Ctrl+F paneli acar', async () => {
    render(GlobalSearchPanel);
    await fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeTruthy());
  });

  it('Ctrl+Shift+K de acar (palet refleksi icin)', async () => {
    render(GlobalSearchPanel);
    await fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeTruthy());
  });

  it('Ctrl+K bu paneli ACMAZ — komut paletinde kalir', async () => {
    // Calisan bir yuzeyi devralmak bozulma olurdu; kasitli sinir.
    render(GlobalSearchPanel);
    await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.querySelector('.gs-panel')).toBeNull();
  });

  it('Escape kapatir', async () => {
    render(GlobalSearchPanel);
    await openWith('');
    await fireEvent.keyDown(document.querySelector('.gs-panel')!, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeNull());
  });

  it('unmount kayitlari birakir — olu bilesene isaret kalmaz', () => {
    const { unmount } = render(GlobalSearchPanel);
    expect('openGlobalSearch' in registryMap).toBe(true);
    unmount();
    expect('openGlobalSearch' in registryMap).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('durumlar', () => {
  it('kisa sorguda ipucu gosterilir, ISTEK ATILMAZ', async () => {
    const api = mockApi({ results: [] });
    registryMap.apiFetch = api;
    render(GlobalSearchPanel);
    await openWith('a');

    expect(document.querySelector('.gs-hint')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  });

  it('sonuc yoksa BOS DURUM ve sorgu gosterilir', async () => {
    registryMap.apiFetch = mockApi({ results: [], hasMore: false });
    render(GlobalSearchPanel);
    await openWith('bulunamaz');

    await waitFor(() =>
      expect(document.querySelector('.gs-empty-title')?.textContent).toContain('bulunamaz'));
  });

  it('HATA acikca gosterilir — bos sonuc gibi sunulmaz', async () => {
    // "Sonuc yok" ile "arama bozuk" ayni gorunurse kullanici yaniltilir.
    registryMap.apiFetch = mockApi({}, false, 500);
    render(GlobalSearchPanel);
    await openWith('merhaba');

    await waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert).toBeTruthy();
      expect(alert!.textContent).toContain('hata');
    });
  });

  it('503 icin servis mesaji ayirt edilir', async () => {
    registryMap.apiFetch = mockApi({}, false, 503);
    render(GlobalSearchPanel);
    await openWith('merhaba');

    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')!.textContent).toContain('kullanılamıyor'));
  });

  it('hata sonrasi tekrar denenebilir', async () => {
    const api = mockApi({}, false, 500);
    registryMap.apiFetch = api;
    render(GlobalSearchPanel);
    await openWith('merhaba');

    await waitFor(() => expect(document.querySelector('.gs-retry')).toBeTruthy());
    const before = api.mock.calls.length;
    await fireEvent.click(document.querySelector('.gs-retry')!);
    await waitFor(() => expect(api.mock.calls.length).toBeGreaterThan(before));
  });

  it('apiFetch kayitli degilse ARIZA bildirilir', async () => {
    render(GlobalSearchPanel);
    await openWith('merhaba');
    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('P7 A6 offline local-first arama', () => {
  it('browser offline iken servera gitmeden hesap-bazli sifreli cache sonucunu gosterir', async () => {
    const userId = 'global-search-offline-user';
    await replaceLocalFirstHistory(userId, 'c-local', [{
      _id: 'local-1',
      channelId: 'c-local',
      channelName: 'yerel',
      serverId: 's-local',
      userId: 'author-local',
      displayName: 'Yerel Yazar',
      content: 'offline bridge needle',
      contentFormat: 1,
      createdAt: Date.now(),
    }]);

    const api = mockApi({
      results: [channelRow({ _id: 'server-should-not-run', content: 'offline bridge needle' })],
    });
    registryMap.apiFetch = api;
    registryMap.getMe = () => ({ _id: userId });
    registryMap.getSocketConnected = () => false;
    const online = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false });

    try {
      render(GlobalSearchPanel);
      await openWith('bridge needle');

      await waitFor(() => expect(optionIds()).toHaveLength(1), { timeout: 1500 });
      expect(api).not.toHaveBeenCalled();
    expect(document.body).toHaveTextContent('offline bridge needle');
    expect(document.body).toHaveTextContent('#yerel');

    // Context preview must come from the same local cache, not HTTP.
      await waitFor(() => expect(document.querySelector('.gs-ctx')).toBeTruthy(), { timeout: 1500 });
      expect(api).not.toHaveBeenCalled();
    } finally {
      if (online) Object.defineProperty(Navigator.prototype, 'onLine', online);
      else Reflect.deleteProperty(Navigator.prototype, 'onLine');
    }
  });

  it('socket kopuk olsa bile HTTP calisiyorsa online global search server-authoritative kalir', async () => {
    const userId = 'global-search-socket-only-user';
    await replaceLocalFirstHistory(userId, 'c-local', [{
      _id: 'local-shadow',
      channelId: 'c-local',
      content: 'server authority needle',
      contentFormat: 1,
      createdAt: Date.now(),
    }]);

    const api = mockApi({
      results: [channelRow({ _id: 'server-wins', content: 'server authority needle' })],
      hasMore: false,
    });
    registryMap.apiFetch = api;
    registryMap.getMe = () => ({ _id: userId });
    registryMap.getSocketConnected = () => false;

    render(GlobalSearchPanel);
    await openWith('authority needle');

    await waitFor(() => expect(optionIds()).toHaveLength(1));
    expect(api).toHaveBeenCalled();
    expect(optionIds()[0]).toContain('server-wins');
  });

  it('online server hatasini local cache ile maskelemez', async () => {
    const userId = 'global-search-authoritative-user';
    await replaceLocalFirstHistory(userId, 'c-local', [{
      _id: 'local-hidden',
      channelId: 'c-local',
      content: 'authoritative needle',
      contentFormat: 1,
      createdAt: Date.now(),
    }]);

    const api = mockApi({}, false, 503);
    registryMap.apiFetch = api;
    registryMap.getMe = () => ({ _id: userId });
    registryMap.getSocketConnected = () => true;

    render(GlobalSearchPanel);
    await openWith('authoritative needle');

    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
    expect(api).toHaveBeenCalled();
    expect(optionIds()).toEqual([]);
    expect(document.body).not.toHaveTextContent('local-hidden');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('sonuclar', () => {
  beforeEach(() => {
    registryMap.apiFetch = mockApi({ results: [channelRow(), dmRow()], hasMore: false });
  });

  it('kaynaga gore gruplanmis olarak cizilir', async () => {
    render(GlobalSearchPanel);
    await openWith('merhaba');

    await waitFor(() => expect(optionIds()).toHaveLength(2));
    const labels = [...document.querySelectorAll('.gs-group-label')].map(el => el.textContent);
    expect(labels).toContain('Mesajlar');
    expect(labels).toContain('Direkt mesajlar');
  });

  it('kanal baglami ve yazar gosterilir', async () => {
    render(GlobalSearchPanel);
    await openWith('merhaba');

    await waitFor(() => {
      expect(document.body.textContent).toContain('#genel');
      expect(document.body.textContent).toContain('Ayse');
    });
  });

  it('eslesme METIN olarak vurgulanir — HTML enjekte edilmez', async () => {
    registryMap.apiFetch = mockApi({
      results: [channelRow({ content: '<img src=x onerror=alert(1)> merhaba' })],
    });
    render(GlobalSearchPanel);
    await openWith('merhaba');

    await waitFor(() => expect(document.querySelector('mark')).toBeTruthy());
    expect(document.querySelector('.gs-hit-text')!.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('klavye gezinmesi', () => {
  beforeEach(() => {
    registryMap.apiFetch = mockApi({ results: [channelRow(), dmRow()] });
  });

  it('ok tuslari secimi tasir ve aria-selected guncellenir', async () => {
    render(GlobalSearchPanel);
    const panel = await openWith('merhaba');
    await waitFor(() => expect(optionIds()).toHaveLength(2));

    const [first, second] = optionIds();
    expect(selectedId()).toBe(first);

    await fireEvent.keyDown(panel, { key: 'ArrowDown' });
    await waitFor(() => expect(selectedId()).toBe(second));

    await fireEvent.keyDown(panel, { key: 'ArrowUp' });
    await waitFor(() => expect(selectedId()).toBe(first));
  });

  it('uclarda SARMA YOK', async () => {
    render(GlobalSearchPanel);
    const panel = await openWith('merhaba');
    await waitFor(() => expect(optionIds()).toHaveLength(2));
    const [first, second] = optionIds();

    await fireEvent.keyDown(panel, { key: 'ArrowUp' });
    expect(selectedId()).toBe(first);

    await fireEvent.keyDown(panel, { key: 'End' });
    await waitFor(() => expect(selectedId()).toBe(second));
    await fireEvent.keyDown(panel, { key: 'ArrowDown' });
    expect(selectedId()).toBe(second);
  });

  it('Home ve End uclara gider', async () => {
    render(GlobalSearchPanel);
    const panel = await openWith('merhaba');
    await waitFor(() => expect(optionIds()).toHaveLength(2));

    await fireEvent.keyDown(panel, { key: 'End' });
    await waitFor(() => expect(selectedId()).toBe(optionIds()[1]));
    await fireEvent.keyDown(panel, { key: 'Home' });
    await waitFor(() => expect(selectedId()).toBe(optionIds()[0]));
  });

  it('Enter secili sonucun kanonik sahibini cagirir', async () => {
    const navigate = vi.fn(() => true);
    registryMap.navigateToChannel = navigate;
    render(GlobalSearchPanel);
    const panel = await openWith('merhaba');
    await waitFor(() => expect(optionIds()).toHaveLength(2));

    await fireEvent.keyDown(panel, { key: 'Enter' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('c1', 'm1', undefined));
  });

  it('basarili gecis panelı kapatir', async () => {
    registryMap.navigateToChannel = vi.fn(() => true);
    render(GlobalSearchPanel);
    const panel = await openWith('merhaba');
    await waitFor(() => expect(optionIds()).toHaveLength(2));

    await fireEvent.keyDown(panel, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeNull());
  });

  it('GIDILEMEYEN sonuc kullaniciya bildirilir, panel ACIK kalir', async () => {
    // Eski davranis: panel kapanir, hicbir sey olmaz — olu baglanti.
    render(GlobalSearchPanel);   // navigateToChannel KAYITLI DEGIL
    const panel = await openWith('merhaba');
    await waitFor(() => expect(optionIds()).toHaveLength(2));

    await fireEvent.keyDown(panel, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
    expect(document.querySelector('.gs-panel')).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('son aramalar', () => {
  it('basarili aramadan sonra kaydedilir ve bos durumda gosterilir', async () => {
    registryMap.apiFetch = mockApi({ results: [channelRow()] });
    registryMap.navigateToChannel = vi.fn(() => true);
    render(GlobalSearchPanel);

    const panel = await openWith('merhaba');
    await waitFor(() => expect(optionIds()).toHaveLength(1));
    await fireEvent.keyDown(panel, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeNull());

    (registryMap.openGlobalSearch as () => void)();
    await waitFor(() =>
      expect(document.querySelector('.gs-recent-text')?.textContent).toBe('merhaba'));
  });

  it('BASARISIZ gecis son aramalara YAZILMAZ', async () => {
    registryMap.apiFetch = mockApi({ results: [channelRow()] });
    render(GlobalSearchPanel);   // gezinme sahibi yok → basarisiz

    const panel = await openWith('merhaba');
    await waitFor(() => expect(optionIds()).toHaveLength(1));
    await fireEvent.keyDown(panel, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());

    expect(localStorage.getItem('bridge:recent-searches')).toBeNull();
  });

  it('son arama tiklaninca kutuya yazilir', async () => {
    localStorage.setItem('bridge:recent-searches', JSON.stringify(['eski sorgu']));
    registryMap.apiFetch = mockApi({ results: [] });
    render(GlobalSearchPanel);
    await openWith('');

    await fireEvent.click(document.querySelector('.gs-recent-use')!);
    await waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('.gs-input')!.value).toBe('eski sorgu'));
  });

  it('tek kayit kaldirilabilir', async () => {
    localStorage.setItem('bridge:recent-searches', JSON.stringify(['a', 'b']));
    render(GlobalSearchPanel);
    await openWith('');

    await fireEvent.click(document.querySelectorAll('.gs-recent-drop')[0]!);
    await waitFor(() => expect(document.querySelectorAll('.gs-recent-use')).toHaveLength(1));
  });

  it('tumu temizlenebilir', async () => {
    localStorage.setItem('bridge:recent-searches', JSON.stringify(['a', 'b']));
    render(GlobalSearchPanel);
    await openWith('');

    await fireEvent.click(document.querySelector('.gs-clear')!);
    await waitFor(() => expect(document.querySelector('.gs-recent')).toBeNull());
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('erisilebilirlik', () => {
  it('panel modal diyalog olarak isaretlenir', async () => {
    render(GlobalSearchPanel);
    const panel = await openWith('');

    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-label')).toBeTruthy();
  });

  it('giris combobox sozlesmesini tasir', async () => {
    registryMap.apiFetch = mockApi({ results: [channelRow()] });
    render(GlobalSearchPanel);
    await openWith('merhaba');

    const input = document.querySelector('.gs-input')!;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe('gs-listbox');
    expect(input.getAttribute('aria-label')).toBeTruthy();

    await waitFor(() => {
      expect(input.getAttribute('aria-expanded')).toBe('true');
      // Ekran okuyucunun secili ogeyi duyurabilmesi icin ZORUNLU.
      expect(input.getAttribute('aria-activedescendant')).toBe(selectedId());
    });
  });

  it('sonuc listesi listbox olarak duyurulur', async () => {
    registryMap.apiFetch = mockApi({ results: [channelRow()] });
    render(GlobalSearchPanel);
    await openWith('merhaba');

    await waitFor(() => {
      const list = document.getElementById('gs-listbox')!;
      expect(list.getAttribute('role')).toBe('listbox');
      expect(list.getAttribute('aria-label')).toBeTruthy();
    });
  });

  it('durum degisimleri canli bolgede duyurulur', async () => {
    registryMap.apiFetch = mockApi({ results: [channelRow()] });
    render(GlobalSearchPanel);
    await openWith('merhaba');

    await waitFor(() => {
      const status = document.querySelector('[role="status"]')!;
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect(status.textContent).toContain('1');
    });
  });

  it('son arama kaldirma dugmesinin adi vardir', async () => {
    localStorage.setItem('bridge:recent-searches', JSON.stringify(['gizli']));
    render(GlobalSearchPanel);
    await openWith('');

    expect(document.querySelector('.gs-recent-drop')!.getAttribute('aria-label'))
      .toContain('gizli');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Kapsam derinligi: yarismalar, filtreler ve baglam onizlemesi
// ════════════════════════════════════════════════════════════════════════════
describe('yarismalar / filtreler / baglam', () => {
  it('eski arama yaniti yeni sorgunun sonucunu ezemez', async () => {
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    const first = new Promise<Response>(resolve => { resolveFirst = resolve; });
    const second = new Promise<Response>(resolve => { resolveSecond = resolve; });

    const api = vi.fn((url: string) => {
      const q = new URL(url, 'https://bridge.test').searchParams.get('q');
      if (q === 'ilk') return first;
      if (q === 'ikinci') return second;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ results: [] }) } as Response);
    });
    registryMap.apiFetch = api;
    render(GlobalSearchPanel);
    const panel = await openWith('ilk');
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));

    const input = panel.querySelector<HTMLInputElement>('.gs-input')!;
    await fireEvent.input(input, { target: { value: 'ikinci' } });
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));

    resolveSecond({
      ok: true, status: 200,
      json: async () => ({ results: [channelRow({ _id: 'new', content: 'ikinci sonuc' })] }),
    } as Response);
    await waitFor(() => expect(document.body.textContent).toContain('ikinci sonuc'));

    resolveFirst({
      ok: true, status: 200,
      json: async () => ({ results: [channelRow({ _id: 'old', content: 'ilk sonuc' })] }),
    } as Response);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(document.body.textContent).toContain('ikinci sonuc');
    expect(document.body.textContent).not.toContain('ilk sonuc');
  });

  it('sohbet sozdizimi ve UI filtresi server querysine gider; temizle ikisini de kaldirir', async () => {
    const api = mockApi({ results: [] });
    registryMap.apiFetch = api;
    render(GlobalSearchPanel);
    const panel = await openWith('from:ayse in:genel has:file merhaba');

    await waitFor(() => expect(api).toHaveBeenCalled());
    const firstUrl = String(api.mock.calls.at(-1)?.[0]);
    const firstParams = new URL(firstUrl, 'https://bridge.test').searchParams;
    expect(firstParams.get('q')).toBe('merhaba');
    expect(firstParams.get('from')).toBe('ayse');
    expect(firstParams.get('in')).toBe('genel');
    expect(firstParams.get('has')).toBe('file');
    expect(panel.textContent).toContain('Gönderen: ayse');
    expect(panel.textContent).toContain('#genel');

    const imageChip = [...panel.querySelectorAll<HTMLButtonElement>('.gs-chip')]
      .find(button => button.textContent?.trim() === 'Görsel')!;
    await fireEvent.click(imageChip);
    await waitFor(() => {
      const last = new URL(String(api.mock.calls.at(-1)?.[0]), 'https://bridge.test').searchParams;
      expect(last.get('has')).toBe('file'); // yazili sozdizimi, UI seciminden daha ozeldir
    });

    await fireEvent.click(panel.querySelector('.gs-chip-clear')!);
    await waitFor(() => {
      expect(panel.querySelector<HTMLInputElement>('.gs-input')!.value).toBe('merhaba');
      const last = new URL(String(api.mock.calls.at(-1)?.[0]), 'https://bridge.test').searchParams;
      expect(last.get('from')).toBeNull();
      expect(last.get('in')).toBeNull();
      expect(last.get('has')).toBeNull();
    });
  });

  it('UI has filtresi toggle edilir ve aktif durum aria-pressed ile duyurulur', async () => {
    const api = mockApi({ results: [] });
    registryMap.apiFetch = api;
    render(GlobalSearchPanel);
    const panel = await openWith('merhaba');
    await waitFor(() => expect(api).toHaveBeenCalled());

    const fileChip = [...panel.querySelectorAll<HTMLButtonElement>('.gs-chip')]
      .find(button => button.textContent?.trim() === 'Dosya')!;
    await fireEvent.click(fileChip);
    await waitFor(() => expect(fileChip.getAttribute('aria-pressed')).toBe('true'));
    await waitFor(() => {
      const last = new URL(String(api.mock.calls.at(-1)?.[0]), 'https://bridge.test').searchParams;
      expect(last.get('has')).toBe('file');
    });

    await fireEvent.click(fileChip);
    await waitFor(() => expect(fileChip.getAttribute('aria-pressed')).toBe('false'));
  });

  it('kanal-basligi aramasi tam kanal kimligine kilitlenir ve Temizle ile baska kanala kacmaz', async () => {
    const api = mockApi({ results: [] });
    registryMap.apiFetch = api;
    registryMap.getCurrentChannel = () => ({ _id: 'c-exact', name: 'genel' });
    render(GlobalSearchPanel);

    (registryMap.openChannelSearch as () => void)();
    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeTruthy());
    const panel = document.querySelector<HTMLElement>('.gs-panel')!;
    expect(panel.querySelector('[data-locked-scope="channel"]')?.textContent).toContain('#genel');

    const input = panel.querySelector<HTMLInputElement>('.gs-input')!;
    await fireEvent.input(input, { target: { value: 'in:baska merhaba' } });
    await waitFor(() => expect(api).toHaveBeenCalled());

    let params = new URL(String(api.mock.calls.at(-1)?.[0]), 'https://bridge.test').searchParams;
    expect(params.get('q')).toBe('merhaba');
    expect(params.get('channelId')).toBe('c-exact');
    expect(params.get('in')).toBeNull();

    const fileChip = [...panel.querySelectorAll<HTMLButtonElement>('.gs-chip')]
      .find(button => button.textContent?.trim() === 'Dosya')!;
    await fireEvent.click(fileChip);
    await waitFor(() => {
      params = new URL(String(api.mock.calls.at(-1)?.[0]), 'https://bridge.test').searchParams;
      expect(params.get('has')).toBe('file');
      expect(params.get('channelId')).toBe('c-exact');
    });

    const clear = panel.querySelector<HTMLButtonElement>('.gs-chip-clear')!;
    await fireEvent.click(clear);
    await waitFor(() => {
      params = new URL(String(api.mock.calls.at(-1)?.[0]), 'https://bridge.test').searchParams;
      expect(params.get('has')).toBeNull();
      expect(params.get('channelId')).toBe('c-exact');
    });
    expect(panel.querySelector('[data-locked-scope="channel"]')?.textContent).toContain('#genel');
  });

  it('secili isabetin baglamini yukler, duz metin cizer ve ayni isabeti cacheler', async () => {
    const contextCalls: string[] = [];
    const api = vi.fn(async (url: string) => {
      if (url.startsWith('/api/search/context?')) {
        contextCalls.push(url);
        return {
          ok: true, status: 200,
          json: async () => ({
            channelId: 'c1',
            messages: [
              { _id: 'before', userId: 'u0', displayName: 'Once', content: '<b>once</b>', createdAt: 1 },
              { _id: 'm1', userId: 'u1', displayName: 'Ayse', content: 'merhaba', createdAt: 2, isAnchor: true },
            ],
          }),
        } as Response;
      }
      return {
        ok: true, status: 200,
        json: async () => ({ results: [channelRow()], hasMore: false }),
      } as Response;
    });
    registryMap.apiFetch = api;
    render(GlobalSearchPanel);
    await openWith('merhaba');

    await waitFor(() => expect(document.querySelector('.gs-ctx')).toBeTruthy(), { timeout: 1500 });
    expect(document.querySelector('.gs-ctx')!.querySelector('b')).toBeNull();
    expect(document.querySelector('.gs-ctx')!.textContent).toContain('<b>once</b>');
    expect(document.querySelector('.gs-ctx-line.anchor')?.textContent).toContain('merhaba');
    expect(contextCalls).toHaveLength(1);

    // Secim ayni kayitta kalirsa effect yeniden degerlense bile cache ikinci fetch'i engeller.
    await fireEvent.mouseMove(document.querySelector('[role="option"]')!);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(contextCalls).toHaveLength(1);
  });

  it('baglam 404/null ve hata sonucu aramayi bozmaz; tekrar tekrar istek atmaz', async () => {
    let contextCount = 0;
    const api = vi.fn(async (url: string) => {
      if (url.startsWith('/api/search/context?')) {
        contextCount++;
        return contextCount === 1
          ? ({ ok: false, status: 404, json: async () => ({}) } as Response)
          : ({ ok: false, status: 500, json: async () => ({}) } as Response);
      }
      return {
        ok: true, status: 200,
        json: async () => ({ results: [channelRow(), dmRow()], hasMore: false }),
      } as Response;
    });
    registryMap.apiFetch = api;
    render(GlobalSearchPanel);
    const panel = await openWith('merhaba');
    await waitFor(() => expect(optionIds()).toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 320));
    expect(contextCount).toBe(1);
    expect(panel.querySelector('[role="alert"]')).toBeNull();

    await fireEvent.keyDown(panel, { key: 'ArrowDown' });
    await new Promise(resolve => setTimeout(resolve, 320));
    expect(contextCount).toBe(2);
    expect(panel.querySelector('[role="alert"]')).toBeNull();

    await fireEvent.keyDown(panel, { key: 'ArrowUp' });
    await new Promise(resolve => setTimeout(resolve, 320));
    expect(contextCount).toBe(2); // ilk null sonuc bos dizi olarak cachelenir
  });

  it('thread/gdm etiketleri, tarih dallari ve hasMore uyarisi cizilir', async () => {
    const now = Date.now();
    registryMap.apiFetch = mockApi({
      hasMore: true,
      results: [
        channelRow({ _id: 'today', createdAt: now, channelName: undefined }),
        { _id: 'th', source: 'thread', content: 'thread merhaba', displayName: '', userId: 'u', createdAt: now - 86_400_000 * 3, threadId: 't1', channelName: 'yardim' },
        { _id: 'gd', source: 'gdm', content: 'gdm merhaba', displayName: 'G', userId: 'u', createdAt: 0, dmId: 'g1' },
      ],
    });
    render(GlobalSearchPanel);
    await openWith('merhaba');

    await waitFor(() => expect(optionIds()).toHaveLength(3));
    expect(document.body.textContent).toContain('Kanal');
    expect(document.body.textContent).toContain('#yardim · konu');
    expect(document.body.textContent).toContain('Grup mesaji');
    expect(document.body.textContent).toContain('Bilinmeyen');
    expect(document.querySelector('.gs-more')?.textContent).toContain('Daha fazla sonuç');
    const times = [...document.querySelectorAll('.gs-hit-time')].map(el => el.textContent ?? '');
    expect(times.some(value => value.includes(':'))).toBe(true);
    expect(times.some(value => value.length > 0 && !value.includes(':'))).toBe(true);
    expect(times).toContain('');
  });

  it('Enter son arama yokken no-op; son arama varken ilk sorguyu kullanir', async () => {
    localStorage.setItem('bridge:recent-searches', JSON.stringify(['birinci', 'ikinci']));
    render(GlobalSearchPanel);
    const panel = await openWith('');
    await fireEvent.keyDown(panel, { key: 'Enter' });
    await waitFor(() => expect(panel.querySelector<HTMLInputElement>('.gs-input')!.value).toBe('birinci'));

    (registryMap.closeGlobalSearch as () => void)();
    localStorage.clear();
    (registryMap.openGlobalSearch as () => void)();
    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeTruthy());
    const emptyPanel = document.querySelector<HTMLElement>('.gs-panel')!;
    await fireEvent.keyDown(emptyPanel, { key: 'Enter' });
    expect(emptyPanel.querySelector<HTMLInputElement>('.gs-input')!.value).toBe('');
  });

  it('kapatma odagi acan elemana geri verir ve global kisayol acik paneli toggle eder', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    render(GlobalSearchPanel);
    await openWith('');
    await waitFor(() => expect(document.activeElement?.classList.contains('gs-input')).toBe(true));

    await fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeNull());
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('dayaniklilik ve ikincil erisilebilirlik yollari', () => {
  it('kapali panelde close ve bos listede gezinme guvenli no-op kalir; mevcut scrollIntoView kullanilir', async () => {
    const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const api = mockApi({ results: [channelRow(), dmRow()] });
      registryMap.apiFetch = api;
      render(GlobalSearchPanel);
      (registryMap.closeGlobalSearch as () => void)();
      await fireEvent.keyDown(window, { key: 'x' });
      await fireEvent.keyDown(window, { key: 'x', ctrlKey: true });
      expect(document.querySelector('.gs-panel')).toBeNull();

      const panel = await openWith('');
      for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
        await fireEvent.keyDown(panel, { key });
      }
      expect(selectedId()).toBeNull();

      const input = panel.querySelector<HTMLInputElement>('.gs-input')!;
      await fireEvent.input(input, { target: { value: 'merhaba' } });
      await waitFor(() => expect(optionIds()).toHaveLength(2));
      await fireEvent.keyDown(panel, { key: 'ArrowDown' });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }));
    } finally {
      if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('kapanirken DOMdan ayrilmis aciciya odak vermeye calismaz', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    render(GlobalSearchPanel);
    const panel = await openWith('');
    opener.remove();

    await fireEvent.keyDown(panel, { key: 'Escape' });

    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeNull());
    expect(opener.isConnected).toBe(false);
  });

  it('arama sahibi baglam isteginden once kaybolsa da sonuc tiklanabilir', async () => {
    registryMap.apiFetch = mockApi({ results: [channelRow()] });
    const navigate = vi.fn(() => true);
    registryMap.navigateToChannel = navigate;
    render(GlobalSearchPanel);
    await openWith('merhaba');
    await waitFor(() => expect(optionIds()).toHaveLength(1));

    delete registryMap.apiFetch;
    await new Promise(resolve => setTimeout(resolve, 260));
    await fireEvent.click(document.querySelector('[role="option"]')!);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('c1', 'm1', undefined));
    expect(document.querySelector('.gs-panel')).toBeNull();
  });

  it('kanalsiz thread etiketi ve adsiz baglam yazari icin anlasilir geri donusler cizer', async () => {
    const thread = {
      _id: 'thread-hit', source: 'thread', content: 'merhaba konu', displayName: 'Ada',
      userId: 'u1', createdAt: Date.now(), score: 1, threadId: 'thread-1',
    };
    registryMap.apiFetch = vi.fn(async (url: string) => {
      if (url.startsWith('/api/search/context?')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            messages: [{
              _id: 'context-1', userId: 'unknown', displayName: null,
              content: 'adsiz cevap', createdAt: 1, isAnchor: true,
            }],
          }),
        } as Response;
      }
      return {
        ok: true, status: 200, json: async () => ({ results: [thread] }),
      } as Response;
    });
    render(GlobalSearchPanel);
    await openWith('merhaba');

    await waitFor(() => expect(document.querySelector('.gs-ctx')).toBeTruthy(), { timeout: 1500 });
    expect(document.querySelector('.gs-hit-context')).toHaveTextContent('Konu');
    expect(document.querySelector('.gs-ctx-author')).toHaveTextContent('Bilinmeyen');
  });

  it('gec kalan baglam yaniti yeni secimin onizlemesini ezemez', async () => {
    let resolveFirst!: (value: Response) => void;
    const firstContext = new Promise<Response>(resolve => { resolveFirst = resolve; });
    registryMap.apiFetch = vi.fn(async (url: string) => {
      if (url.includes('id=m1')) return firstContext;
      if (url.includes('id=d1')) {
        return {
          ok: true, status: 200,
          json: async () => ({ messages: [{
            _id: 'dm-context', userId: 'u2', displayName: 'Veli', content: 'yeni baglam',
            createdAt: 2, isAnchor: true,
          }] }),
        } as Response;
      }
      return {
        ok: true, status: 200, json: async () => ({ results: [channelRow(), dmRow()] }),
      } as Response;
    });
    render(GlobalSearchPanel);
    const panel = await openWith('merhaba');
    await waitFor(() => expect((registryMap.apiFetch as ReturnType<typeof vi.fn>).mock.calls
      .some(call => String(call[0]).includes('id=m1'))).toBe(true), { timeout: 1500 });

    await fireEvent.keyDown(panel, { key: 'ArrowDown' });
    await waitFor(() => expect(document.body).toHaveTextContent('yeni baglam'), { timeout: 1500 });
    resolveFirst({
      ok: true, status: 200,
      json: async () => ({ messages: [{
        _id: 'stale-context', userId: 'u1', displayName: 'Eski', content: 'BAYAT BAGLAM',
        createdAt: 1, isAnchor: true,
      }] }),
    } as Response);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(document.body).not.toHaveTextContent('BAYAT BAGLAM');
  });

  it('iptal edilen arama ve baglam isteklerini kullanici hatasi olarak gostermez', async () => {
    const api = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/search/context?')) {
        if (url.includes('id=m1')) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ messages: [] }) } as Response);
      }
      const q = new URL(url, 'https://bridge.test').searchParams.get('q');
      if (q === 'birinci') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      return Promise.resolve({
        ok: true, status: 200, json: async () => ({ results: [channelRow(), dmRow()] }),
      } as Response);
    });
    registryMap.apiFetch = api;
    render(GlobalSearchPanel);
    const panel = await openWith('birinci');
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));

    const input = panel.querySelector<HTMLInputElement>('.gs-input')!;
    await fireEvent.input(input, { target: { value: 'ikinci' } });
    await waitFor(() => expect(optionIds()).toHaveLength(2));
    await waitFor(() => expect(api.mock.calls.some(call => String(call[0]).includes('id=m1'))).toBe(true), { timeout: 1500 });
    await fireEvent.keyDown(panel, { key: 'ArrowDown' });
    await waitFor(() => expect(api.mock.calls.some(call => String(call[0]).includes('id=d1'))).toBe(true), { timeout: 1500 });

    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('icerik tiklamasi paneli kapatmaz, arka plan tiklamasi kapatir', async () => {
    render(GlobalSearchPanel);
    const panel = await openWith('');
    await fireEvent.click(panel);
    expect(document.querySelector('.gs-panel')).toBeTruthy();

    await fireEvent.click(document.querySelector('.gs-overlay')!);
    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeNull());
  });

  it('aktif oge bulunmayan bir belge baglaminda da acilip kapanabilir', async () => {
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null });
    try {
      render(GlobalSearchPanel);
      const panel = await openWith('');
      await fireEvent.keyDown(panel, { key: 'Escape' });
      await waitFor(() => expect(document.querySelector('.gs-panel')).toBeNull());
    } finally {
      Reflect.deleteProperty(document, 'activeElement');
    }
  });

  it('hata sonrasi sorgu gecersiz uzunluga indirilince tekrar-dene eylemini kaldirir', async () => {
    registryMap.apiFetch = mockApi({}, false, 500);
    render(GlobalSearchPanel);
    const panel = await openWith('merhaba');
    await waitFor(() => expect(panel.querySelector('.gs-retry')).toBeTruthy());

    await fireEvent.input(panel.querySelector('.gs-input')!, { target: { value: 'a' } });

    await waitFor(() => expect(panel.querySelector('.gs-retry')).toBeNull());
    expect(panel.querySelector('.gs-hint')).toBeTruthy();
  });

  it('sonuc ekrandayken sorgu ayni olay turunda temizlenirse bos sorguyu gecmise yazmaz', async () => {
    registryMap.apiFetch = mockApi({ results: [channelRow()] });
    registryMap.navigateToChannel = vi.fn(() => true);
    render(GlobalSearchPanel);
    const panel = await openWith('merhaba');
    await waitFor(() => expect(optionIds()).toHaveLength(1));

    const input = panel.querySelector<HTMLInputElement>('.gs-input')!;
    const option = panel.querySelector<HTMLElement>('[role="option"]')!;
    input.value = '';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await waitFor(() => expect(document.querySelector('.gs-panel')).toBeNull());
    expect(localStorage.getItem('bridge:recent-searches')).toBeNull();
  });
});
