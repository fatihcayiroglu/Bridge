// client/tests/forum-channel-panel-deep-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ForumChannelPanel — YETKİ BAŞLIĞI, FİLTRE ANAHTARI VE MODERASYON
// ════════════════════════════════════════════════════════════════════════════
//
// Forum yüzeyi listeyi SUNUCU BAŞLIĞINDAN gelen yetkiye göre zenginleştirir ve
// moderasyon işlemleri yazar. Hiç ölçülmemiş 147 dalın riskleri:
//
//   · YETKİ BAŞLIĞI — `X-Bridge-Forum-Can-Manage` yoksa/`1` değilse moderasyon
//     düğmeleri GÖRÜNMEMELİDİR. Yükleme başarısızsa yetki DÜŞÜRÜLMELİDİR;
//     bir önceki kanalın yetkisi taşınmamalıdır.
//   · KANAL DEĞİŞİMİ — geciken yanıt YENİ kanalın listesini ezmemelidir.
//   · FİLTRE ANAHTARI — sıralama/etiket değişimi tek bir yükleme tetikler;
//     aynı anahtar tekrar yüklenmez (gereksiz istek yok).
//   · MODERASYON — reddedilen sabitleme/kilitleme işleminin NEDENİ, zorunlu
//     tazeleme tarafından silinmemelidir.
//   · BOZUK SATIR — adsız/kimliksiz kayıt RENDER EDİLMEZ; etiket listesi
//     yalnız metin taşır ve 5 ile sınırlıdır.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import ForumChannelPanel from '../js/core/ForumChannelPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { t } from '../js/core/i18n/index.ts';

function response(body: unknown, status = 200, canManage = false): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name === 'X-Bridge-Forum-Can-Manage' ? (canManage ? '1' : '0') : null) },
    json: async () => body,
  } as unknown as Response;
}

const OWNED_KEYS = ['apiFetch', 'socket', 'openExistingThread'];
const CH = 'ch-forum';

let apiFetch: ReturnType<typeof vi.fn>;
let openExistingThread: ReturnType<typeof vi.fn>;
let socketOff: ReturnType<typeof vi.fn>;
let socketHandlers: Map<string, Array<(payload: unknown) => void>>;

function installSocket(): void {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const offSpy = vi.fn();
  socketHandlers = handlers;
  socketOff = offSpy;
  BridgeRegistry.register('socket', {
    on(event: string, handler: (payload: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off: (...args: unknown[]) => offSpy(...args),
  } as never);
}

function emit(event: string, payload: unknown): void {
  for (const handler of socketHandlers.get(event) ?? []) handler(payload);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) { await tick(); await Promise.resolve(); }
}

const threadRow = (over: Record<string, unknown> = {}) => ({
  _id: 'thr-1', channelId: CH, name: 'Duyuru başlığı', firstMessage: 'ilk ileti',
  tags: ['duyuru', 'sürüm'], createdAt: 1_000, lastMessageAt: 2_000,
  messageCount: 4, participantCount: 2, pinned: false, locked: false, ...over,
});

const surface = () => document.querySelector('.forum-surface');
const errorText = () => document.querySelector('.forum-error')?.textContent ?? '';
const cards = () => [...document.querySelectorAll('.thread-card')];
const sortButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.sort-group button')];
const createBox = () => document.querySelector('.create-box');
const createToggle = () => document.querySelector<HTMLButtonElement>('.forum-header .primary')!;

function mount(props: Record<string, unknown> = {}) {
  return render(ForumChannelPanel, {
    props: { active: true, channelId: CH, channelName: 'forum-kanali', ...props },
  });
}

beforeEach(() => {
  apiFetch = vi.fn(async () => response([threadRow()]));
  openExistingThread = vi.fn();
  BridgeRegistry.register('apiFetch', apiFetch as never);
  BridgeRegistry.register('openExistingThread', openExistingThread as never);
  installSocket();
});

afterEach(() => {
  cleanup();
  for (const key of OWNED_KEYS) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe('ForumChannelPanel — yükleme koşulu', () => {
  it('etkin değilken hiçbir şey render edilmez ve istek gitmez', async () => {
    mount({ active: false });
    await flush();

    expect(surface()).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('kanal kimliği yokken istek gitmez', async () => {
    mount({ channelId: '' });
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('API sahibi yoksa liste boş kalır', async () => {
    BridgeRegistry.unregister('apiFetch');
    mount();
    await flush();

    expect(surface()).not.toBeNull();
    expect(cards()).toHaveLength(0);
  });

  it('etkin kanal için sıralamayla birlikte yüklenir ve kimlik KAÇIRILIR', async () => {
    const { unmount } = mount({ channelId: 'ch/slash' });
    await flush();

    expect(apiFetch.mock.calls[0]![0]).toBe('/api/threads/channel/ch%2Fslash?sort=latest');
    unmount();
  });

  it('kanal adı yoksa yedek başlık kullanılır', async () => {
    mount({ channelName: '' });
    await flush();

    expect(document.getElementById('forum-title')?.textContent).toBe('#forum');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ForumChannelPanel — liste ve bozuk satırlar', () => {
  it('bozuk kayıtlar RENDER EDİLMEZ', async () => {
    apiFetch = vi.fn(async () => response([
      null, 'metin', [], {},
      { _id: 'kimlikli-adsiz' },
      { name: 'adli-kimliksiz' },
      threadRow(),
    ]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();

    expect(cards()).toHaveLength(1);
  });

  it('dizi olmayan gövde BOŞ listeye indirgenir', async () => {
    apiFetch = vi.fn(async () => response({ threads: [threadRow()] }));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();

    expect(cards()).toHaveLength(0);
    expect(document.querySelector('.forum-state')?.textContent).toBe(t('forum_empty'));
  });

  it('etiketler yalnız METİN taşır ve 5 ile sınırlıdır', async () => {
    apiFetch = vi.fn(async () => response([
      threadRow({ tags: ['a', 42, null, 'b', 'c', 'd', 'e', 'f', 'g'] }),
    ]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();

    const tags = [...cards()[0]!.querySelectorAll('.tags span')].map(node => node.textContent);
    expect(tags).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('sayısal alanlar güvenli okunur ve negatif değerler SIFIRLANIR', async () => {
    apiFetch = vi.fn(async () => response([
      threadRow({ messageCount: -3, participantCount: 'çok', createdAt: 'dün', lastMessageAt: undefined }),
    ]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();

    const meta = [...cards()[0]!.querySelectorAll('.thread-meta span')].map(node => node.textContent);
    expect(meta[0]).toBe(t('ui_reply_count', undefined, { count: 0 }));
    expect(meta[1]).toBe(t('ui_participant_count', undefined, { count: 1 }));
    expect(meta[2]).toBe('');
  });

  it.each([
    ['az önce', 10_000, () => t('ui_az_once')],
    ['dakika', 5 * 60_000, () => t('rel_minutes_ago', undefined, { count: 5 })],
    ['saat', 3 * 3_600_000, () => t('rel_hours_ago', undefined, { count: 3 })],
    ['gün', 2 * 86_400_000, () => t('rel_days_ago', undefined, { count: 2 })],
  ])('göreli zaman %s olarak sunulur', async (_label, ago, expected) => {
    apiFetch = vi.fn(async () => response([threadRow({ lastMessageAt: Date.now() - ago })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();

    const meta = [...cards()[0]!.querySelectorAll('.thread-meta span')].map(node => node.textContent);
    expect(meta[2]).toBe(expected());
  });

  it('sabitlenmiş ve kilitli iletiler işaretlenir', async () => {
    apiFetch = vi.fn(async () => response([threadRow({ pinned: true, locked: 1 })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();

    const title = cards()[0]!.querySelector('.thread-title')!;
    expect(title.textContent).toContain('📌');
    expect(title.textContent).toContain('🔒');
  });

  it('ilk iletisi olmayan kayıtta önizleme alanı YOKTUR', async () => {
    apiFetch = vi.fn(async () => response([threadRow({ firstMessage: '', tags: [] })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();

    expect(cards()[0]!.querySelector('.thread-main p')).toBeNull();
    expect(cards()[0]!.querySelector('.tags')).toBeNull();
  });

  it.each([
    [403, () => t('ui_bu_forumu_kullanma_yetkin_yok')],
    [404, () => t('ui_forum_kanali_artik_bulunamiyor')],
    [429, () => t('ui_cok_hizli_islem_yapiliyor_biraz_sonra_tekrar_dene')],
    [500, () => t('ui_forum_iletileri_yuklenemedi')],
  ])('yükleme %i durumunda doğru metni gösterir', async (status, expected) => {
    apiFetch = vi.fn(async () => response({ error: 'GIZLI-SUNUCU-AYRINTISI' }, status));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();

    expect(errorText()).toBe(expected());
    expect(errorText()).not.toContain('GIZLI-SUNUCU-AYRINTISI');
    expect(cards()).toHaveLength(0);
  });

  it('taşıma hatası yüzeyi çökertmez', async () => {
    apiFetch = vi.fn(async () => { throw new Error('offline'); });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();

    expect(errorText()).toBe(t('ui_forum_iletileri_yuklenemedi'));
    expect(surface()).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ForumChannelPanel — filtreler', () => {
  it('sıralama değişimi TEK yükleme tetikler ve aynı anahtar tekrarlanmaz', async () => {
    mount();
    await flush();
    apiFetch.mockClear();

    sortButtons()[1]!.click();
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0]![0]).toContain('sort=new');

    sortButtons()[1]!.click();
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(1);

    sortButtons()[2]!.click();
    await flush();
    expect(apiFetch.mock.calls[1]![0]).toContain('sort=top');
    expect(sortButtons()[2]!.getAttribute('aria-pressed')).toBe('true');
  });

  it('arama metni KIRPILIR ve 100 karakterle sınırlanır', async () => {
    mount();
    await flush();
    apiFetch.mockClear();

    const input = document.querySelector<HTMLInputElement>('.forum-search input')!;
    await fireEvent.input(input, { target: { value: `   ${'a'.repeat(150)}   ` } });
    await fireEvent.submit(document.querySelector('.forum-search')!);
    await flush();

    const url = new URL(String(apiFetch.mock.calls[0]![0]), 'https://bridge.test');
    expect(url.searchParams.get('search')).toHaveLength(100);
  });

  it('yalnız boşluktan ibaret arama parametre EKLEMEZ', async () => {
    mount();
    await flush();
    apiFetch.mockClear();

    await fireEvent.input(document.querySelector<HTMLInputElement>('.forum-search input')!, { target: { value: '   ' } });
    await fireEvent.submit(document.querySelector('.forum-search')!);
    await flush();

    expect(String(apiFetch.mock.calls[0]![0])).not.toContain('search=');
  });

  it('etiket süzgeci mevcut etiketlerden kurulur ve isteğe eklenir', async () => {
    mount();
    await flush();
    apiFetch.mockClear();

    const select = document.querySelector<HTMLSelectElement>('.tag-filter')!;
    const options = [...select.options].map(option => option.value);
    expect(options).toEqual(['', 'duyuru', 'sürüm']);

    await fireEvent.change(select, { target: { value: 'duyuru' } });
    await flush();

    expect(apiFetch.mock.calls.some(call => String(call[0]).includes('tag=duyuru'))).toBe(true);
  });

  it('kanal değişince liste TEMİZLENİR ve yeniden yüklenir', async () => {
    const view = mount();
    await flush();
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(response([threadRow({ _id: 'thr-2', name: 'İkinci kanal' })]));

    await view.rerender({ active: true, channelId: 'ch-2', channelName: 'ikinci' });
    await flush();

    expect(apiFetch.mock.calls[0]![0]).toContain('/api/threads/channel/ch-2');
    expect(cards()[0]!.textContent).toContain('İkinci kanal');
  });

  it('kanal kapatılınca liste ve hata TEMİZLENİR', async () => {
    const view = mount();
    await flush();

    await view.rerender({ active: false, channelId: CH, channelName: 'forum-kanali' });
    await flush();

    expect(surface()).toBeNull();
  });

  it('GECİKEN yanıt YENİ kanalın listesini EZMEZ', async () => {
    let release: (value: Response) => void = () => {};
    apiFetch = vi.fn((url: string) => {
      if (url.includes('/ch-yavas')) return new Promise<Response>(resolve => { release = resolve; });
      return Promise.resolve(response([threadRow({ _id: 'thr-hizli', name: 'Hızlı kanal' })]));
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    const view = mount({ channelId: 'ch-yavas' });
    await flush();

    await view.rerender({ active: true, channelId: 'ch-hizli', channelName: 'hizli' });
    await flush();

    release(response([threadRow({ _id: 'thr-yavas', name: 'Yavaş kanal' })]));
    await flush();

    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.textContent).toContain('Hızlı kanal');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ForumChannelPanel — yönetim yetkisi', () => {
  it('yetki başlığı 1 DEĞİLSE moderasyon düğmeleri görünmez', async () => {
    mount();
    await flush();

    expect(document.querySelector('.thread-manage')).toBeNull();
  });

  it('yetki başlığı 1 ise moderasyon düğmeleri görünür', async () => {
    apiFetch = vi.fn(async () => response([threadRow()], 200, true));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();

    expect(document.querySelector('.thread-manage')).not.toBeNull();
  });

  it('yükleme BAŞARISIZ olursa yetki DÜŞÜRÜLÜR', async () => {
    let ok = true;
    apiFetch = vi.fn(async () => (ok ? response([threadRow()], 200, true) : response({ error: 'x' }, 403)));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();
    expect(document.querySelector('.thread-manage')).not.toBeNull();

    ok = false;
    sortButtons()[1]!.click();
    await flush();

    expect(document.querySelector('.thread-manage')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ForumChannelPanel — ileti oluşturma', () => {
  const fillCreate = async (values: { title?: string; firstMessage?: string; tags?: string }) => {
    const box = createBox()!;
    const inputs = [...box.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')];
    const [titleInput, messageInput, tagsInput] = inputs;
    if (titleInput && values.title !== undefined) await fireEvent.input(titleInput, { target: { value: values.title } });
    if (messageInput && values.firstMessage !== undefined) await fireEvent.input(messageInput, { target: { value: values.firstMessage } });
    if (tagsInput && values.tags !== undefined) await fireEvent.input(tagsInput, { target: { value: values.tags } });
    await flush();
  };

  const submitCreate = async () => {
    document.querySelector<HTMLButtonElement>('.create-actions .primary')!.click();
    await flush();
  };

  it('oluşturma kutusu açılıp kapanır ve hata TEMİZLENİR', async () => {
    apiFetch = vi.fn(async () => response({ error: 'x' }, 500));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();
    expect(errorText()).not.toBe('');

    createToggle().click();
    await flush();

    expect(createBox()).not.toBeNull();
    expect(errorText()).toBe('');
  });

  it('başlıksız ileti oluşturulamaz', async () => {
    mount();
    await flush();
    createToggle().click();
    await flush();
    apiFetch.mockClear();

    await fillCreate({ title: '   ' });
    await submitCreate();

    expect(errorText()).toBe(t('ui_ileti_basligi_gerekli'));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('etiketler AYIKLANIR, tekilleştirilir ve kırpılır', async () => {
    mount();
    await flush();
    createToggle().click();
    await flush();
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(response({ thread: threadRow({ _id: 'thr-yeni' }) }));

    await fillCreate({
      title: '  Yeni başlık  ',
      firstMessage: '  ilk ileti  ',
      tags: ` a , a ,b,, ${'x'.repeat(40)} ,c,d,e,f `,
    });
    await submitCreate();

    const post = apiFetch.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as { name: string; firstMessage: string; tags: string[] };
    expect(body.name).toBe('Yeni başlık');
    expect(body.firstMessage).toBe('ilk ileti');
    expect(body.tags).toHaveLength(5);
    expect(body.tags[0]).toBe('a');
    expect(body.tags[2]).toHaveLength(20);
  });

  it('oluşturulan ileti hemen AÇILIR ve form sıfırlanır', async () => {
    mount();
    await flush();
    createToggle().click();
    await flush();
    apiFetch.mockResolvedValue(response({ thread: threadRow({ _id: 'thr-yeni', firstMessage: 'açılış' }) }));

    await fillCreate({ title: 'Yeni' });
    await submitCreate();

    expect(openExistingThread).toHaveBeenCalledWith('thr-yeni', 'açılış');
    expect(createBox()).toBeNull();
  });

  it('yanıtta ileti YOKSA panel açılmaz ama form yine sıfırlanır', async () => {
    mount();
    await flush();
    createToggle().click();
    await flush();
    apiFetch.mockResolvedValue(response({ thread: null }));

    await fillCreate({ title: 'Yeni' });
    await submitCreate();

    expect(openExistingThread).not.toHaveBeenCalled();
    expect(createBox()).toBeNull();
  });

  it.each([
    [403, () => t('ui_bu_forumu_kullanma_yetkin_yok')],
    [500, () => t('ui_forum_iletisi_olusturulamadi')],
  ])('oluşturma %i durumunda form KORUNUR', async (status, expected) => {
    mount();
    await flush();
    createToggle().click();
    await flush();
    apiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      (init?.method === 'POST' ? response({ error: 'x' }, status) : response([threadRow()])));

    await fillCreate({ title: 'Korunacak' });
    await submitCreate();

    expect(errorText()).toBe(expected());
    expect(createBox()).not.toBeNull();
    expect(createBox()!.querySelector<HTMLInputElement>('input')!.value).toBe('Korunacak');
  });

  it('oluşturma taşıma hatası sabit metne düşer', async () => {
    mount();
    await flush();
    createToggle().click();
    await flush();
    apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('offline');
      return response([threadRow()]);
    });

    await fillCreate({ title: 'Etkinlik' });
    await submitCreate();

    expect(errorText()).toBe(t('ui_forum_iletisi_olusturulamadi'));
  });

  it('gövdesi çözülemeyen başarılı yanıt panel açmaz', async () => {
    mount();
    await flush();
    createToggle().click();
    await flush();
    apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return { ok: true, status: 201, headers: { get: () => null }, json: async () => { throw new Error('bozuk'); } } as unknown as Response;
      }
      return response([threadRow()]);
    });

    await fillCreate({ title: 'Yeni' });
    await submitCreate();

    expect(openExistingThread).not.toHaveBeenCalled();
    expect(errorText()).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ForumChannelPanel — moderasyon', () => {
  const manageButtons = () => [...cards()[0]!.querySelectorAll<HTMLButtonElement>('.thread-manage button')];

  const mountManaged = async (row: Record<string, unknown> = {}) => {
    apiFetch = vi.fn(async () => response([threadRow(row)], 200, true));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount();
    await flush();
  };

  it('sabitleme isteği DOĞRU gövdeyle gider ve liste tazelenir', async () => {
    await mountManaged();
    apiFetch.mockClear();

    manageButtons()[0]!.click();
    await flush();

    const patch = apiFetch.mock.calls[0]!;
    expect(patch[0]).toBe('/api/threads/thr-1/pin');
    expect((patch[1] as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ pinned: true });
    expect(apiFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it('sabitlenmiş ileti KALDIRILABİLİR', async () => {
    await mountManaged({ pinned: true });
    apiFetch.mockClear();

    manageButtons()[0]!.click();
    await flush();

    expect(JSON.parse(String((apiFetch.mock.calls[0]![1] as RequestInit).body))).toEqual({ pinned: false });
  });

  it('kilitleme isteği ayrı bir alan yazar', async () => {
    await mountManaged();
    apiFetch.mockClear();

    manageButtons()[1]!.click();
    await flush();

    expect(apiFetch.mock.calls[0]![0]).toBe('/api/threads/thr-1/lock');
    expect(JSON.parse(String((apiFetch.mock.calls[0]![1] as RequestInit).body))).toEqual({ locked: true });
  });

  it.each([
    [403, () => t('ui_bu_forumu_kullanma_yetkin_yok')],
    [404, () => t('ui_forum_kanali_artik_bulunamiyor')],
    [500, () => t('ui_forum_iletisi_guncellenemedi')],
  ])('moderasyon %i durumunda NEDEN görünür kalır', async (status, expected) => {
    await mountManaged();
    apiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      (init?.method === 'PATCH' ? response({ error: 'x' }, status) : response([threadRow()], 200, true)));

    manageButtons()[0]!.click();
    await flush();

    expect(errorText()).toBe(expected());
  });

  it('moderasyon taşıma hatası sabit metne düşer', async () => {
    await mountManaged();
    apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') throw new Error('offline');
      return response([threadRow()], 200, true);
    });

    manageButtons()[1]!.click();
    await flush();

    expect(errorText()).toBe(t('ui_forum_iletisi_guncellenemedi'));
  });

  it('ileti başlığına tıklamak thread panelini açar', async () => {
    mount();
    await flush();

    document.querySelector<HTMLButtonElement>('.thread-open')!.click();
    await flush();

    expect(openExistingThread).toHaveBeenCalledWith('thr-1', 'ilk ileti');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ForumChannelPanel — gerçek zamanlı ve temizlik', () => {
  it.each(['forum:thread:created', 'forum:thread:updated', 'forum:thread:deleted'])(
    '%s olayı AYNI kanalda listeyi tazeler', async (event) => {
      mount();
      await flush();
      apiFetch.mockClear();

      emit(event, { channelId: CH });
      await flush();

      expect(apiFetch).toHaveBeenCalledTimes(1);
    });

  it('BAŞKA kanalın olayı tazelemez', async () => {
    mount();
    await flush();
    apiFetch.mockClear();

    emit('forum:thread:updated', { channelId: 'baska-kanal' });
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('kanalı belirtmeyen olay temkinli biçimde tazeler', async () => {
    mount();
    await flush();
    apiFetch.mockClear();

    emit('forum:thread:updated', null);
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('yüzey ETKİN DEĞİLKEN olaylar istek üretmez', async () => {
    const view = mount();
    await flush();
    await view.rerender({ active: false, channelId: CH, channelName: 'forum-kanali' });
    await flush();
    apiFetch.mockClear();

    emit('forum:thread:created', { channelId: CH });
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('soket sonradan hazır olduğunda yeniden bağlanılır', async () => {
    BridgeRegistry.unregister('socket');
    mount();
    await flush();

    installSocket();
    document.dispatchEvent(new Event('bridge:socket-ready'));
    await flush();
    apiFetch.mockClear();

    emit('forum:thread:created', { channelId: CH });
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('yeniden bağlanmada ESKİ dinleyiciler sökülür', async () => {
    mount();
    await flush();
    const firstOff = socketOff;

    installSocket();
    document.dispatchEvent(new Event('bridge:socket-reconnected'));
    await flush();

    expect(firstOff).toHaveBeenCalledTimes(3);
  });

  it('unmount dinleyicileri söker', async () => {
    const view = mount();
    await flush();

    view.unmount();
    await flush();

    expect(socketOff).toHaveBeenCalledTimes(3);
  });

  it('soket sahibi YOKKEN de yüzey çalışır', async () => {
    BridgeRegistry.unregister('socket');
    const view = mount();
    await flush();

    expect(surface()).not.toBeNull();
    expect(() => view.unmount()).not.toThrow();
  });
});
