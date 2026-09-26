// client/tests/server-events-panel-deep-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ServerEventsPanel — YETKİ SINIRI, ZAMAN DOĞRULAMA VE SAYFALAMA
// ════════════════════════════════════════════════════════════════════════════
//
// Etkinlik paneli hem OKUR hem YAZAR ve yazma yetkisini SUNUCUDAN sorar.
// Hiç ölçülmemiş 248 dalın taşıdığı riskler:
//
//   · YETKİ — "yönet" düğmeleri yalnız gerçekten yetkisi olana görünmelidir.
//     Yetki sorgusu BAŞARISIZ olursa yetki VARSAYILMAZ (fail-closed).
//   · ZAMAN — bitiş başlangıçtan önce olamaz; geçersiz tarih sessizce
//     "şimdi"ye dönüşmemelidir. Sunucuya her zaman ISO gönderilir.
//   · SAYFALAMA — "daha fazla" ikinci sayfayı EKLER, mevcut listeyi ezmez ve
//     aynı kaydı iki kez göstermez.
//   · YARIŞ — sunucu değiştirildiyse geciken yanıt listeyi kirletmemelidir.
//   · SİLME — ürün diyaloğu onaylanmadan istek gitmez.
//   · BOZUK SATIR — başlıksız/zamansız kayıt RENDER EDİLMEZ.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import ServerEventsPanel from '../js/core/ServerEventsPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { t } from '../js/core/i18n/index.ts';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const OWNED_KEYS = ['apiFetch', 'socket', 'currentServer', 'openServerEvents', 'closeServerEvents'];
const ADMINISTRATOR = 1 << 30;
const MANAGE_SERVER = 1 << 3;
const SRV = 'srv-1';

let apiFetch: ReturnType<typeof vi.fn>;
let socketOff: ReturnType<typeof vi.fn>;
let socketHandlers: Map<string, Array<(payload: unknown) => void>>;
let permissions = 0;

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

function emit(event: string): void {
  for (const handler of socketHandlers.get(event) ?? []) handler(null);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) { await tick(); await Promise.resolve(); }
}

const eventRow = (over: Record<string, unknown> = {}) => ({
  id: 'ev-1', title: 'Sürüm partisi', description: 'kutlama', location: 'Kadıköy',
  starts_at: '2026-10-01T18:00:00.000Z', ends_at: '2026-10-01T21:00:00.000Z',
  status: 'scheduled', rsvp_count: 4, my_rsvp: null, channel_id: 'ch-1', ...over,
});

function makeApi(list: unknown[] = [eventRow()], total = 1) {
  return vi.fn(async (url: string) => {
    if (url.includes('/me/permissions')) return response({ permissions });
    if (url.includes('/events')) return response({ events: list, total });
    return response({});
  });
}

const panel = () => document.querySelector('.events-panel');
const errorText = () => document.querySelector('.events-error')?.textContent ?? '';
const cards = () => [...document.querySelectorAll('.event-card')];
const filterButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.events-toolbar button')];
const createBox = () => document.querySelector('.create-box');
const createToggle = () => document.querySelector<HTMLButtonElement>('.header-actions .primary');

async function openPanel(): Promise<void> {
  BridgeRegistry.call('openServerEvents');
  await waitFor(() => expect(panel()).not.toBeNull());
  await flush();
}

async function chooseProductDialog(action: 'confirm' | 'cancel'): Promise<void> {
  await flush();
  const button = document.querySelector<HTMLButtonElement>(`[data-product-dialog-action="${action}"]`);
  if (!button) throw new Error(`ürün diyaloğu ${action} düğmesi yok`);
  button.click();
  await flush();
}

beforeEach(() => {
  permissions = 0;
  apiFetch = makeApi();
  BridgeRegistry.register('apiFetch', apiFetch as never);
  BridgeRegistry.register('currentServer', (() => ({ _id: SRV, name: 'Bridge Sunucusu' })) as never);
  installSocket();
});

afterEach(() => {
  cleanup();
  for (const key of OWNED_KEYS) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe('ServerEventsPanel — açılış', () => {
  it('sunucu seçili değilse panel AÇILMAZ', async () => {
    BridgeRegistry.register('currentServer', (() => null) as never);
    render(ServerEventsPanel);

    BridgeRegistry.call('openServerEvents');
    await flush();

    expect(panel()).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('sunucu sahibi ÇÖKERSE panel açılmaz', async () => {
    BridgeRegistry.register('currentServer', (() => { throw new Error('registry down'); }) as never);
    render(ServerEventsPanel);

    BridgeRegistry.call('openServerEvents');
    await flush();

    expect(panel()).toBeNull();
  });

  it('YAKLAŞAN filtresiyle açılır ve sunucu adını gösterir', async () => {
    render(ServerEventsPanel);
    await openPanel();

    expect(document.getElementById('events-title')?.textContent).toBe('Bridge Sunucusu');
    expect(apiFetch.mock.calls[0]![0]).toBe(`/api/servers/${SRV}/events?filter=upcoming&limit=20&offset=0`);
    expect(cards()).toHaveLength(1);
  });

  it('adı olmayan sunucu için yedek başlık kullanılır ve kimlik KAÇIRILIR', async () => {
    BridgeRegistry.register('currentServer', (() => ({ _id: 'srv/slash' })) as never);
    render(ServerEventsPanel);
    await openPanel();

    expect(document.getElementById('events-title')?.textContent).toBe(t('cp_category_server'));
    expect(apiFetch.mock.calls[0]![0]).toContain('/api/servers/srv%2Fslash/events');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ServerEventsPanel — liste ve bozuk satırlar', () => {
  it('bozuk kayıtlar RENDER EDİLMEZ', async () => {
    apiFetch = makeApi([
      null, 'metin', [], {},
      eventRow({ id: '' }),
      eventRow({ title: '' }),
      eventRow({ id: 'ev-bozuk-zaman', starts_at: 'yarın' }),
      eventRow(),
    ], 8);
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ServerEventsPanel);
    await openPanel();

    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.textContent).toContain('Sürüm partisi');
  });

  it('negatif/bozuk katılım sayısı SIFIRA indirilir, geçersiz yanıt NULL olur', async () => {
    apiFetch = makeApi([eventRow({ rsvp_count: -9, my_rsvp: 'belki' })]);
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ServerEventsPanel);
    await openPanel();

    expect(cards()[0]!.querySelector('.event-count')?.textContent)
      .toBe(t('ui_person_count', undefined, { count: 0 }));
    const pressed = [...cards()[0]!.querySelectorAll('.rsvp-actions button')]
      .filter(button => button.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(0);
  });

  it('bitişi olmayan etkinlikte tek zaman gösterilir', async () => {
    apiFetch = makeApi([eventRow({ ends_at: null, description: '', location: '' })]);
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ServerEventsPanel);
    await openPanel();

    expect(cards()[0]!.querySelector('.event-head p')?.textContent).not.toContain('–');
    expect(cards()[0]!.querySelector('.description')).toBeNull();
    expect(cards()[0]!.querySelector('.location')).toBeNull();
  });

  it('dizi olmayan gövde boş listeye indirgenir', async () => {
    apiFetch = makeApi(undefined as unknown as unknown[], 0);
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/me/permissions')) return response({ permissions: 0 });
      return response({ events: { rows: [] }, total: 'çok' });
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ServerEventsPanel);
    await openPanel();

    expect(cards()).toHaveLength(0);
    expect(document.querySelector('.events-state')?.textContent)
      .toBe(t('markup_bu_filtrede_etkinlik_yok_c0575a5'));
  });

  it.each([
    [403, () => t('ui_bu_etkinlige_erisimin_yok')],
    [404, () => t('ui_etkinlik_artik_bulunamiyor')],
    [429, () => t('ui_cok_hizli_islem_yapiliyor_biraz_sonra_tekrar_dene')],
    [500, () => t('ui_etkinlikler_yuklenemedi')],
  ])('yükleme %i durumunda doğru metni gösterir', async (status, expected) => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/me/permissions')) return response({ permissions: 0 });
      return response({ error: 'GIZLI-SUNUCU-AYRINTISI' }, status);
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ServerEventsPanel);
    await openPanel();

    expect(errorText()).toBe(expected());
    expect(errorText()).not.toContain('GIZLI-SUNUCU-AYRINTISI');
    expect(cards()).toHaveLength(0);
  });

  it('taşıma hatası paneli çökertmez', async () => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/me/permissions')) return response({ permissions: 0 });
      throw new Error('offline');
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ServerEventsPanel);
    await openPanel();

    expect(errorText()).toBe(t('ui_etkinlikler_yuklenemedi'));
    expect(panel()).not.toBeNull();
  });

  it('filtre değiştirmek listeyi YENİDEN yükler', async () => {
    render(ServerEventsPanel);
    await openPanel();
    apiFetch.mockClear();

    filterButtons()[1]!.click();
    await flush();
    expect(apiFetch.mock.calls[0]![0]).toContain('filter=past');

    filterButtons()[2]!.click();
    await flush();
    expect(apiFetch.mock.calls[1]![0]).toContain('filter=all');
    expect(filterButtons()[2]!.getAttribute('aria-pressed')).toBe('true');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ServerEventsPanel — sayfalama', () => {
  it('DAHA FAZLA ikinci sayfayı ekler ve yinelenenleri atar', async () => {
    let call = 0;
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/me/permissions')) return response({ permissions: 0 });
      call += 1;
      if (call === 1) return response({ events: [eventRow({ id: 'ev-1' })], total: 3 });
      return response({ events: [eventRow({ id: 'ev-1' }), eventRow({ id: 'ev-2' })], total: 3 });
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ServerEventsPanel);
    await openPanel();

    const more = document.querySelector<HTMLButtonElement>('.load-more')!;
    expect(more).not.toBeNull();

    more.click();
    await flush();

    expect(apiFetch.mock.calls.at(-1)![0]).toContain('offset=1');
    expect(cards()).toHaveLength(2);
  });

  it('toplam sayı listeden küçükse DAHA FAZLA gösterilmez', async () => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/me/permissions')) return response({ permissions: 0 });
      return response({ events: [eventRow(), eventRow({ id: 'ev-2' })], total: 0 });
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ServerEventsPanel);
    await openPanel();

    expect(cards()).toHaveLength(2);
    expect(document.querySelector('.load-more')).toBeNull();
  });

  it('panel KAPANDIYSA geciken sayfa listeye YAZILMAZ', async () => {
    let release: (value: Response) => void = () => {};
    apiFetch = vi.fn((url: string) => {
      if (url.includes('/me/permissions')) return Promise.resolve(response({ permissions: 0 }));
      return new Promise<Response>(resolve => { release = resolve; });
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ServerEventsPanel);

    BridgeRegistry.call('openServerEvents');
    await flush();
    BridgeRegistry.call('closeServerEvents');
    await flush();

    release(response({ events: [eventRow()], total: 1 }));
    await flush();

    expect(panel()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ServerEventsPanel — yönetim yetkisi', () => {
  it('yetkisiz kullanıcıda yönet düğmeleri GÖRÜNMEZ', async () => {
    render(ServerEventsPanel);
    await openPanel();

    expect(createToggle()).toBeNull();
    expect(document.querySelector('.event-manage')).toBeNull();
  });

  it.each([
    ['ADMINISTRATOR', ADMINISTRATOR],
    ['MANAGE_SERVER', MANAGE_SERVER],
  ])('%s biti yönetim açar', async (_label, bits) => {
    permissions = bits;
    render(ServerEventsPanel);
    await openPanel();

    expect(createToggle()).not.toBeNull();
    expect(document.querySelector('.event-manage')).not.toBeNull();
  });

  it('ilgisiz izin bitleri yönetim AÇMAZ', async () => {
    permissions = 1 << 5;
    render(ServerEventsPanel);
    await openPanel();

    expect(createToggle()).toBeNull();
  });

  it.each([
    ['yetki sorgusu reddedilirse', () => vi.fn(async (url: string) => {
      if (url.includes('/me/permissions')) return response({ error: 'x' }, 403);
      return response({ events: [eventRow()], total: 1 });
    })],
    ['yetki sorgusu PATLARSA', () => vi.fn(async (url: string) => {
      if (url.includes('/me/permissions')) throw new Error('offline');
      return response({ events: [eventRow()], total: 1 });
    })],
  ])('%s yönetim KAPALI kalır (fail-closed)', async (_label, factory) => {
    apiFetch = factory();
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ServerEventsPanel);
    await openPanel();

    expect(createToggle()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ServerEventsPanel — oluşturma ve düzenleme', () => {
  const fill = async (values: Record<string, string>) => {
    const box = createBox()!;
    const inputs = [...box.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')];
    const [titleInput, descriptionInput, locationInput, startInput, endInput] = inputs;
    const map: Array<[HTMLInputElement | HTMLTextAreaElement | undefined, string | undefined]> = [
      [titleInput, values.title], [descriptionInput, values.description], [locationInput, values.location],
      [startInput, values.startsAt], [endInput, values.endsAt],
    ];
    for (const [element, value] of map) {
      if (element && value !== undefined) await fireEvent.input(element, { target: { value } });
    }
    await flush();
  };

  const submit = async () => {
    document.querySelector<HTMLButtonElement>('.create-actions .primary')!.click();
    await flush();
  };

  beforeEach(() => { permissions = ADMINISTRATOR; });

  it('oluşturma kutusu açılıp KAPANABİLİR', async () => {
    render(ServerEventsPanel);
    await openPanel();

    expect(createBox()).toBeNull();
    createToggle()!.click();
    await flush();
    expect(createBox()).not.toBeNull();

    createToggle()!.click();
    await flush();
    expect(createBox()).toBeNull();
  });

  it.each([
    ['ad boşsa', { title: '   ', startsAt: '2026-10-01T18:00' }, () => t('ui_etkinlik_adi_gerekli')],
    ['başlangıç yoksa', { title: 'Etkinlik', startsAt: '' }, () => t('ui_gecerli_bir_baslangic_zamani_sec')],
    ['bitiş başlangıçtan önceyse', { title: 'Etkinlik', startsAt: '2026-10-01T18:00', endsAt: '2026-10-01T17:00' }, () => t('ui_bitis_zamani_baslangictan_sonra_olmali')],
    ['bitiş başlangıca eşitse', { title: 'Etkinlik', startsAt: '2026-10-01T18:00', endsAt: '2026-10-01T18:00' }, () => t('ui_bitis_zamani_baslangictan_sonra_olmali')],
  ])('%s istek GÖNDERİLMEZ', async (_label, values, expected) => {
    render(ServerEventsPanel);
    await openPanel();
    createToggle()!.click();
    await flush();
    apiFetch.mockClear();

    await fill(values);
    await submit();

    expect(errorText()).toBe(expected());
    expect(apiFetch.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
  });

  it('tarih denetimi GEÇERSİZ metni kabul etmez; alan boş kalır', async () => {
    // `datetime-local` denetimi geçersiz bir değeri hiç saklamaz. Bu yüzden
    // "bitiş yazıldı ama çözülemedi" durumu arayüzden ÜRETİLEMEZ; alan boş
    // kalır ve etkinlik bitişsiz oluşturulur.
    render(ServerEventsPanel);
    await openPanel();
    createToggle()!.click();
    await flush();
    apiFetch.mockClear();

    await fill({ title: 'Etkinlik', startsAt: '2026-10-01T18:00', endsAt: 'yarın' });
    const endInput = [...createBox()!.querySelectorAll<HTMLInputElement>('input')].at(-1)!;
    expect(endInput.value).toBe('');

    await submit();

    const post = apiFetch.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse(String((post[1] as RequestInit).body)).endsAt).toBeUndefined();
  });

  it('geçerli etkinlik ISO zaman damgalarıyla oluşturulur ve form SIFIRLANIR', async () => {
    render(ServerEventsPanel);
    await openPanel();
    createToggle()!.click();
    await flush();
    apiFetch.mockClear();

    await fill({ title: '  Sürüm partisi  ', description: '  kutlama  ', location: '  Kadıköy  ', startsAt: '2026-10-01T18:00', endsAt: '2026-10-01T21:00' });
    await submit();

    const post = apiFetch.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(post[0]).toBe(`/api/servers/${SRV}/events`);
    const body = JSON.parse(String((post[1] as RequestInit).body)) as Record<string, string>;
    expect(body.title).toBe('Sürüm partisi');
    expect(body.description).toBe('kutlama');
    expect(body.location).toBe('Kadıköy');
    expect(new Date(body.startsAt!).toISOString()).toBe(body.startsAt);
    expect(new Date(body.endsAt!).getTime()).toBeGreaterThan(new Date(body.startsAt!).getTime());
    await waitFor(() => expect(createBox()).toBeNull());
  });

  it('yalnız boşluktan ibaret açıklama/konum GÖNDERİLMEZ', async () => {
    render(ServerEventsPanel);
    await openPanel();
    createToggle()!.click();
    await flush();
    apiFetch.mockClear();

    await fill({ title: 'Etkinlik', description: '   ', location: '   ', startsAt: '2026-10-01T18:00' });
    await submit();

    const post = apiFetch.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.description).toBeUndefined();
    expect(body.location).toBeUndefined();
    expect(body.endsAt).toBeUndefined();
  });

  it.each([
    [403, () => t('ui_etkinligi_yonetme_yetkin_yok')],
    [429, () => t('ui_cok_hizli_islem_yapiliyor_biraz_sonra_tekrar_dene')],
    [500, () => t('ui_etkinlik_olusturulamadi')],
  ])('oluşturma %i durumunda form KORUNUR', async (status, expected) => {
    render(ServerEventsPanel);
    await openPanel();
    createToggle()!.click();
    await flush();
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/me/permissions')) return response({ permissions: ADMINISTRATOR });
      if (init?.method === 'POST') return response({ error: 'x' }, status);
      return response({ events: [eventRow()], total: 1 });
    });

    await fill({ title: 'Korunacak', startsAt: '2026-10-01T18:00' });
    await submit();

    expect(errorText()).toBe(expected());
    expect(createBox()).not.toBeNull();
    expect(createBox()!.querySelector<HTMLInputElement>('input')!.value).toBe('Korunacak');
  });

  it('oluşturma taşıma hatası sabit metne düşer', async () => {
    render(ServerEventsPanel);
    await openPanel();
    createToggle()!.click();
    await flush();
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/me/permissions')) return response({ permissions: ADMINISTRATOR });
      if (init?.method === 'POST') throw new Error('offline');
      return response({ events: [eventRow()], total: 1 });
    });

    await fill({ title: 'Etkinlik', startsAt: '2026-10-01T18:00' });
    await submit();

    expect(errorText()).toBe(t('ui_etkinlik_olusturulamadi'));
  });

  it('DÜZENLE mevcut değerleri yükler ve PATCH gönderir', async () => {
    render(ServerEventsPanel);
    await openPanel();

    document.querySelector<HTMLButtonElement>('.event-manage .secondary')!.click();
    await flush();

    const titleInput = createBox()!.querySelector<HTMLInputElement>('input')!;
    expect(titleInput.value).toBe('Sürüm partisi');

    apiFetch.mockClear();
    await fill({ title: 'Güncellenmiş ad' });
    await submit();

    const patch = apiFetch.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'PATCH')!;
    expect(patch[0]).toBe(`/api/servers/${SRV}/events/ev-1`);
    expect(JSON.parse(String((patch[1] as RequestInit).body)).title).toBe('Güncellenmiş ad');
    await waitFor(() => expect(createBox()).toBeNull());
  });

  it('düzenlemede de zaman doğrulaması uygulanır', async () => {
    render(ServerEventsPanel);
    await openPanel();
    document.querySelector<HTMLButtonElement>('.event-manage .secondary')!.click();
    await flush();
    apiFetch.mockClear();

    await fill({ title: '  ' });
    await submit();
    expect(errorText()).toBe(t('ui_etkinlik_adi_gerekli'));

    await fill({ title: 'Ad', startsAt: '', endsAt: '' });
    await submit();
    expect(errorText()).toBe(t('ui_gecerli_bir_baslangic_zamani_sec'));

    await fill({ startsAt: '2026-10-01T18:00', endsAt: '2026-10-01T17:00' });
    await submit();
    expect(errorText()).toBe(t('ui_bitis_zamani_baslangictan_sonra_olmali'));

    expect(apiFetch.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'PATCH')).toHaveLength(0);
  });

  it('düzenleme reddedilirse hata gösterilir ve liste tazelenir', async () => {
    render(ServerEventsPanel);
    await openPanel();
    document.querySelector<HTMLButtonElement>('.event-manage .secondary')!.click();
    await flush();
    apiFetch.mockClear();
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return response({ error: 'x' }, 403);
      return response({ events: [eventRow()], total: 1 });
    });

    await submit();

    expect(errorText()).toBe(t('ui_etkinligi_yonetme_yetkin_yok'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ServerEventsPanel — katılım yanıtı', () => {
  const rsvpButtons = () => [...cards()[0]!.querySelectorAll<HTMLButtonElement>('.rsvp-actions button')];

  it('yanıt POST ile kaydedilir ve liste tazelenir', async () => {
    render(ServerEventsPanel);
    await openPanel();
    apiFetch.mockClear();

    rsvpButtons()[0]!.click();
    await flush();

    const post = apiFetch.mock.calls[0]!;
    expect(post[0]).toBe(`/api/servers/${SRV}/events/ev-1/rsvp`);
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ status: 'going' });
    expect(apiFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it('mevcut yanıt KALDIRILABİLİR', async () => {
    apiFetch = makeApi([eventRow({ my_rsvp: 'going' })]);
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ServerEventsPanel);
    await openPanel();
    apiFetch.mockClear();

    const remove = rsvpButtons().at(-1)!;
    remove.click();
    await flush();

    expect(apiFetch.mock.calls[0]![0]).toBe(`/api/servers/${SRV}/events/ev-1/rsvp`);
    expect((apiFetch.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
  });

  it('yanıt verilmemişse KALDIR düğmesi yoktur', async () => {
    render(ServerEventsPanel);
    await openPanel();

    expect(rsvpButtons()).toHaveLength(3);
  });

  it.each([
    [403, () => t('ui_bu_etkinlige_erisimin_yok')],
    [404, () => t('ui_etkinlik_artik_bulunamiyor')],
    [500, () => t('ui_katilim_yaniti_kaydedilemedi')],
  ])('yanıt %i durumunda hata gösterir ve liste tazelenir', async (status, expected) => {
    render(ServerEventsPanel);
    await openPanel();
    let rsvpCall = 0;
    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rsvp')) { rsvpCall += 1; return response({ error: 'x' }, status); }
      if (url.includes('/me/permissions')) return response({ permissions: 0 });
      return response({ events: [eventRow()], total: 1 });
    });

    rsvpButtons()[1]!.click();
    await flush();

    expect(rsvpCall).toBe(1);
    expect(errorText()).toBe(expected());
  });

  it('yanıt taşıma hatası sabit metne düşer', async () => {
    render(ServerEventsPanel);
    await openPanel();
    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/rsvp')) throw new Error('offline');
      return response({ events: [eventRow()], total: 1 });
    });

    rsvpButtons()[2]!.click();
    await flush();

    expect(errorText()).toBe(t('ui_katilim_yaniti_kaydedilemedi'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ServerEventsPanel — silme', () => {
  beforeEach(() => { permissions = ADMINISTRATOR; });

  const deleteButton = () => document.querySelector<HTMLButtonElement>('.event-manage .danger')!;

  it('ONAYLANMAZSA istek GİTMEZ', async () => {
    render(ServerEventsPanel);
    await openPanel();
    apiFetch.mockClear();

    deleteButton().click();
    await chooseProductDialog('cancel');

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('onaylanırsa DELETE gider ve liste tazelenir', async () => {
    render(ServerEventsPanel);
    await openPanel();
    apiFetch.mockClear();

    deleteButton().click();
    await chooseProductDialog('confirm');

    expect(apiFetch.mock.calls[0]![0]).toBe(`/api/servers/${SRV}/events/ev-1`);
    expect((apiFetch.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
    expect(apiFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it('silme reddedilirse hata gösterilir', async () => {
    render(ServerEventsPanel);
    await openPanel();
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return response({ error: 'x' }, 403);
      if (url.includes('/me/permissions')) return response({ permissions: ADMINISTRATOR });
      return response({ events: [eventRow()], total: 1 });
    });

    deleteButton().click();
    await chooseProductDialog('confirm');

    expect(errorText()).toBe(t('ui_etkinligi_yonetme_yetkin_yok'));
  });

  it('DÜZENLENEN etkinlik silinirse düzenleyici KAPANIR', async () => {
    render(ServerEventsPanel);
    await openPanel();

    document.querySelector<HTMLButtonElement>('.event-manage .secondary')!.click();
    await flush();
    expect(createBox()).not.toBeNull();

    deleteButton().click();
    await chooseProductDialog('confirm');

    expect(createBox()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ServerEventsPanel — gerçek zamanlı ve temizlik', () => {
  it.each([
    'server:event:created', 'server:event:updated', 'server:event:deleted', 'server:event:rsvp',
  ])('%s olayı listeyi tazeler', async (event) => {
    render(ServerEventsPanel);
    await openPanel();
    apiFetch.mockClear();

    emit(event);
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('panel KAPALIYKEN olaylar istek üretmez', async () => {
    render(ServerEventsPanel);
    await openPanel();
    BridgeRegistry.call('closeServerEvents');
    await flush();
    apiFetch.mockClear();

    emit('server:event:updated');
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('soket sonradan hazır olduğunda yeniden bağlanılır', async () => {
    BridgeRegistry.unregister('socket');
    render(ServerEventsPanel);
    await openPanel();

    installSocket();
    document.dispatchEvent(new Event('bridge:socket-ready'));
    await flush();
    apiFetch.mockClear();

    emit('server:event:created');
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('yeniden bağlanma olayında ESKİ dinleyiciler sökülür', async () => {
    render(ServerEventsPanel);
    await openPanel();
    const firstOff = socketOff;

    installSocket();
    document.dispatchEvent(new Event('bridge:socket-reconnected'));
    await flush();

    expect(firstOff).toHaveBeenCalledTimes(4);
  });

  it('Escape ve arka plan tıklaması kapatır, panelin içi kapatmaz', async () => {
    render(ServerEventsPanel);
    await openPanel();

    await fireEvent.click(panel()!);
    await flush();
    expect(panel()).not.toBeNull();

    await fireEvent.keyDown(panel()!, { key: 'Escape' });
    await flush();
    expect(panel()).toBeNull();

    await openPanel();
    await fireEvent.click(document.querySelector('.events-overlay')!);
    await flush();
    expect(panel()).toBeNull();
  });

  it('kapanışta odak açan öğeye GERİ VERİLİR', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    render(ServerEventsPanel);
    await openPanel();
    BridgeRegistry.call('closeServerEvents');
    await flush();
    await new Promise(resolve => queueMicrotask(() => resolve(null)));

    expect(document.activeElement).toBe(opener);
  });

  it('unmount kayıtları ve dinleyicileri söker', async () => {
    const view = render(ServerEventsPanel);
    await openPanel();

    view.unmount();
    await flush();

    expect(BridgeRegistry.has('openServerEvents')).toBe(false);
    expect(BridgeRegistry.has('closeServerEvents')).toBe(false);
    expect(socketOff).toHaveBeenCalledTimes(4);
  });

  it('soket sahibi YOKKEN de panel çalışır', async () => {
    BridgeRegistry.unregister('socket');
    const view = render(ServerEventsPanel);
    await openPanel();

    expect(panel()).not.toBeNull();
    expect(() => view.unmount()).not.toThrow();
  });
});
