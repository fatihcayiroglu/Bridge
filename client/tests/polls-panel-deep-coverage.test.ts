// client/tests/polls-panel-deep-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PollsPanel — OY BÜTÜNLÜĞÜ, YETKİ SINIRI VE MUTASYON GÜVENLİĞİ
// ════════════════════════════════════════════════════════════════════════════
//
// `PollsPanel.svelte` üretimde CANLI bir yüzeydir ve hiç ölçülmemişti
// (401 statement / 195 branch / 108 fonksiyon kapsam dışı). Taşıdığı riskler
// sıradan bir liste panelinden farklıdır:
//
//   · OY bir YAZMA işlemidir — yanlış delta hesabı sessizce yanlış oy atar.
//   · Sunucunun 403/404/409/429 kararları kullanıcıya doğru anlatılmalı;
//     ham gövde gösterilmemeli ama durumlar da birbirine karışmamalıdır.
//   · Kapatma/silme YALNIZCA sahibine görünmelidir.
//   · Bozuk satırlar (eksik seçenek, negatif sayaç) render EDİLMEMELİDİR.
//   · Silme onayı `window.confirm` değil ürün diyaloğudur; sürülmezse istek
//     GİTMEMELİDİR.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import PollsPanel from '../js/core/PollsPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { t } from '../js/core/i18n/index.ts';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function option(id: string, text: string, voteCount = 0, votedByMe = false) {
  return { id, text, voteCount, votedByMe };
}

function poll(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'poll-1',
    channelId: 'chan-1',
    question: 'Hangi renk?',
    options: [option('o1', 'Kırmızı', 2, false), option('o2', 'Mavi', 1, false)],
    multiSelect: false,
    allowVoteChange: true,
    expiresAt: null,
    closed: false,
    createdBy: 'me',
    ...overrides,
  };
}

const OWNED_KEYS = [
  'apiFetch', 'getCurrentChannel', 'getMe', 'socket', 'toast', 'openPolls', 'closePolls',
];

let apiFetch: ReturnType<typeof vi.fn>;
let toast: ReturnType<typeof vi.fn>;
let socketHandlers: Map<string, Array<(payload: unknown) => void>>;
let socketOff: ReturnType<typeof vi.fn>;

function installSocket(): void {
  socketHandlers = new Map();
  socketOff = vi.fn();
  BridgeRegistry.register('socket', {
    on(event: string, handler: (payload: unknown) => void) {
      const list = socketHandlers.get(event) ?? [];
      list.push(handler);
      socketHandlers.set(event, list);
    },
    off: (...args: unknown[]) => socketOff(...args),
  } as never);
}

function emit(event: string, payload: unknown): void {
  for (const handler of socketHandlers.get(event) ?? []) handler(payload);
}

async function flush(): Promise<void> {
  await tick();
  await Promise.resolve();
  await tick();
  await Promise.resolve();
}

async function openPanel(): Promise<void> {
  BridgeRegistry.call('openPolls');
  await waitFor(() => expect(document.querySelector('.polls-panel')).not.toBeNull());
  await flush();
}

async function chooseProductDialog(action: 'confirm' | 'cancel'): Promise<void> {
  await flush();
  const button = document.querySelector<HTMLButtonElement>(`[data-product-dialog-action="${action}"]`);
  if (!button) throw new Error(`ürün diyaloğu ${action} düğmesi yok`);
  button.click();
  await flush();
}

const panel = () => document.querySelector('.polls-panel');
const errorText = () => document.querySelector('.poll-error')?.textContent ?? '';
const cards = () => [...document.querySelectorAll('.poll-card')];
const questionInput = () => document.querySelector<HTMLInputElement>('.poll-create > .poll-input')!;
const optionInputs = () => [...document.querySelectorAll<HTMLInputElement>('.poll-option-edit .poll-input')];
const submitCreate = () => document.querySelector<HTMLButtonElement>('.poll-create-actions .primary')!;

async function typeCreateForm(q: string, opts: string[]): Promise<void> {
  await fireEvent.input(questionInput(), { target: { value: q } });
  const inputs = optionInputs();
  for (let i = 0; i < opts.length && i < inputs.length; i += 1) {
    await fireEvent.input(inputs[i]!, { target: { value: opts[i]! } });
  }
}

beforeEach(() => {
  apiFetch = vi.fn(async () => response([poll()]));
  toast = vi.fn();
  BridgeRegistry.register('apiFetch', apiFetch as never);
  BridgeRegistry.register('toast', toast as never);
  BridgeRegistry.register('getMe', (() => ({ _id: 'me' })) as never);
  BridgeRegistry.register('getCurrentChannel', (() => ({ _id: 'chan-1', name: 'genel', type: 'text' })) as never);
  installSocket();
});

afterEach(() => {
  cleanup();
  for (const key of OWNED_KEYS) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe('PollsPanel — açılış koşulu', () => {
  it('METİN kanalı yokken açılmaz ve nedeni söylenir', async () => {
    BridgeRegistry.register('getCurrentChannel', (() => null) as never);
    render(PollsPanel);

    BridgeRegistry.call('openPolls');
    await flush();

    expect(panel()).toBeNull();
    expect(toast).toHaveBeenCalledWith(t('ui_anketler_icin_once_bir_metin_kanali_sec'), 'error');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('SES kanalında da açılmaz — anketler metin kanalına aittir', async () => {
    BridgeRegistry.register('getCurrentChannel', (() => ({ _id: 'v1', type: 'voice' })) as never);
    render(PollsPanel);

    BridgeRegistry.call('openPolls');
    await flush();

    expect(panel()).toBeNull();
    expect(toast).toHaveBeenCalledWith(t('ui_anketler_icin_once_bir_metin_kanali_sec'), 'error');
  });

  it('metin kanalında açılır ve kanal adını başlıkta gösterir', async () => {
    render(PollsPanel);
    await openPanel();

    expect(panel()).not.toBeNull();
    expect(document.getElementById('polls-title')?.textContent).toBe('#genel');
    expect(apiFetch).toHaveBeenCalledWith('/api/channels/chan-1/polls');
  });

  it('kanal kimliği URL için KAÇIRILIR', async () => {
    BridgeRegistry.register('getCurrentChannel', (() => ({ _id: 'chan/slash', name: 'x', type: 'text' })) as never);
    render(PollsPanel);
    await openPanel();

    expect(apiFetch).toHaveBeenCalledWith('/api/channels/chan%2Fslash/polls');
  });

  it('adı olmayan kanal için güvenli bir yedek başlık kullanılır', async () => {
    BridgeRegistry.register('getCurrentChannel', (() => ({ _id: 'c9', type: 'TEXT' })) as never);
    render(PollsPanel);
    await openPanel();

    expect(document.getElementById('polls-title')?.textContent).toBe(`#${t('ui_channel_fallback')}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PollsPanel — bozuk satırlar RENDER EDİLMEZ', () => {
  it('eksik/geçersiz anketler süzülür, geçerli olan kalır', async () => {
    apiFetch = vi.fn(async () => response([
      null,
      'not-an-object',
      {},
      poll({ _id: '' }),
      poll({ question: '' }),
      poll({ _id: 'few', options: [option('o1', 'tek')] }),
      poll({ _id: 'bad-opts', options: [option('o1', 'a'), { id: 5, text: 'b' }] }),
      poll({ _id: 'ok' }),
    ]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.textContent).toContain('Hangi renk?');
  });

  it('negatif/kesirli oy sayısı SIFIRA indirilir, uydurulmaz', async () => {
    apiFetch = vi.fn(async () => response([
      poll({ options: [option('o1', 'A', -5), option('o2', 'B', 2.5)] }),
    ]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    const text = cards()[0]!.textContent ?? '';
    expect(text).toContain('0% · 0');
    expect(text).not.toContain('-5');
    expect(text).not.toContain('2.5');
  });

  it('dizi olmayan gövde boş listeye indirgenir', async () => {
    apiFetch = vi.fn(async () => response({ polls: [poll()] }));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    expect(cards()).toHaveLength(0);
    expect(document.querySelector('.poll-muted')?.textContent).toBe(t('poll_empty'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PollsPanel — sunucu kararları AYIRT EDİLİR (gövde sızmadan)', () => {
  it.each([
    [403, () => t('ui_bu_kanalda_bu_islem_icin_yetkin_yok')],
    [404, () => t('ui_kanal_veya_anket_artik_bulunamiyor')],
    [409, () => t('ui_anket_degisti_guncel_hali_yeniden_yuklendi')],
    [429, () => t('ui_cok_hizli_islem_yapiliyor_biraz_sonra_tekrar_dene')],
    [500, () => t('ui_anketler_yuklenemedi')],
  ])('yükleme %i durumunda doğru metni gösterir', async (status, expected) => {
    apiFetch = vi.fn(async () => response({ error: 'GIZLI-SUNUCU-AYRINTISI' }, status));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    expect(errorText()).toBe(expected());
    expect(errorText()).not.toContain('GIZLI-SUNUCU-AYRINTISI');
    expect(cards()).toHaveLength(0);
  });

  it('taşıma hatası paneli çökertmez, sabit metin gösterir', async () => {
    apiFetch = vi.fn(async () => { throw new Error('offline'); });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    expect(errorText()).toBe(t('ui_anketler_yuklenemedi'));
    expect(panel()).not.toBeNull();
  });

  it('API sahibi yoksa açıkça kullanılamıyor denir', async () => {
    BridgeRegistry.unregister('apiFetch');
    render(PollsPanel);
    await openPanel();

    expect(errorText()).toBe(t('ui_anketler_su_anda_kullanilamiyor'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PollsPanel — anket oluşturma', () => {
  it('boş soru REDDEDİLİR ve istek gitmez', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();

    submitCreate().click();
    await flush();

    expect(errorText()).toBe(t('ui_anket_sorusu_gerekli'));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('iki geçerli seçenek yoksa REDDEDİLİR', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();

    await typeCreateForm('Soru?', ['tek', '   ']);
    submitCreate().click();
    await flush();

    expect(errorText()).toBe(t('ui_en_az_iki_secenek_gerekli'));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('geçerli formu gönderir, gövdeyi KIRPILMIŞ değerlerle kurar ve formu sıfırlar', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response({ ok: true }));
    apiFetch.mockResolvedValueOnce(response([poll()]));

    await typeCreateForm('  Hangi renk?  ', ['  Kırmızı ', ' Mavi ']);
    submitCreate().click();
    await flush();

    const [url, init] = apiFetch.mock.calls[0]!;
    expect(url).toBe('/api/channels/chan-1/polls');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      question: 'Hangi renk?',
      options: ['Kırmızı', 'Mavi'],
      multiSelect: false,
      allowVoteChange: true,
      duration: 1440,
    });
    // Başarıdan sonra form temizlenir ve liste yeniden yüklenir.
    await waitFor(() => expect(questionInput().value).toBe(''));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('oluşturma reddedilirse form KORUNUR (kullanıcı yazdığını kaybetmez)', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response({ error: 'nope' }, 403));

    await typeCreateForm('Soru?', ['A', 'B']);
    submitCreate().click();
    await flush();

    expect(errorText()).toBe(t('ui_bu_kanalda_bu_islem_icin_yetkin_yok'));
    expect(questionInput().value).toBe('Soru?');
  });

  it('oluşturma taşıma hatası sabit metne düşer', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();
    apiFetch.mockRejectedValueOnce(new Error('offline'));

    await typeCreateForm('Soru?', ['A', 'B']);
    submitCreate().click();
    await flush();

    expect(errorText()).toBe(t('ui_anket_olusturulamadi'));
  });

  it('seçenek ekleme 10 ile SINIRLI, silme 2 ile sınırlıdır', async () => {
    render(PollsPanel);
    await openPanel();

    const add = [...document.querySelectorAll<HTMLButtonElement>('.poll-create-actions .secondary')][0]!;
    for (let i = 0; i < 15; i += 1) { add.click(); await tick(); }
    expect(optionInputs()).toHaveLength(10);
    expect(add.disabled).toBe(true);

    // İki seçeneğe kadar silinebilir; ikinin altına inilemez.
    for (let i = 0; i < 15; i += 1) {
      const remove = document.querySelector<HTMLButtonElement>('.poll-option-edit button');
      if (!remove) break;
      remove.click();
      await tick();
    }
    expect(optionInputs()).toHaveLength(2);
    expect(document.querySelector('.poll-option-edit button')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PollsPanel — oy verme', () => {
  it('tek seçimli ankette seçim DEĞİŞTİRİLİR, birikmez', async () => {
    render(PollsPanel);
    await openPanel();

    const inputs = [...document.querySelectorAll<HTMLInputElement>('.poll-votes input')];
    expect(inputs[0]!.type).toBe('radio');
    await fireEvent.change(inputs[0]!);
    await fireEvent.change(inputs[1]!);
    await flush();

    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response(poll({ options: [option('o1', 'Kırmızı', 2), option('o2', 'Mavi', 2, true)] })));
    document.querySelector<HTMLButtonElement>('.vote-submit')!.click();
    await flush();

    const [, init] = apiFetch.mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ optionIds: ['o2'] });
  });

  it('çok seçimli ankette DELTA gönderilir', async () => {
    apiFetch = vi.fn(async () => response([poll({
      multiSelect: true,
      options: [option('o1', 'A', 1, true), option('o2', 'B', 0, false), option('o3', 'C', 0, false)],
    })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    const inputs = [...document.querySelectorAll<HTMLInputElement>('.poll-votes input')];
    expect(inputs[0]!.type).toBe('checkbox');
    await fireEvent.change(inputs[1]!);   // B eklendi
    await flush();

    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response(poll({ multiSelect: true })));
    document.querySelector<HTMLButtonElement>('.vote-submit')!.click();
    await flush();

    const [, init] = apiFetch.mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ optionIds: ['o2'] });
  });

  it('tüm oylar kaldırılırsa DELETE kullanılır', async () => {
    apiFetch = vi.fn(async () => response([poll({
      multiSelect: true,
      options: [option('o1', 'A', 1, true), option('o2', 'B', 0, false)],
    })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    const inputs = [...document.querySelectorAll<HTMLInputElement>('.poll-votes input')];
    await fireEvent.change(inputs[0]!);   // seçili olan kaldırıldı
    await flush();

    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response(poll({ multiSelect: true, options: [option('o1', 'A', 0), option('o2', 'B', 0)] })));
    document.querySelector<HTMLButtonElement>('.vote-submit')!.click();
    await flush();

    const [url, init] = apiFetch.mock.calls[0]!;
    expect(url).toBe('/api/polls/poll-1/vote');
    expect((init as RequestInit).method).toBe('DELETE');
    expect((init as RequestInit).body).toBeUndefined();
  });

  it('DEĞİŞİKLİK yoksa istek GÖNDERİLMEZ', async () => {
    apiFetch = vi.fn(async () => response([poll({ options: [option('o1', 'A', 1, true), option('o2', 'B', 0)] })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();

    document.querySelector<HTMLButtonElement>('.vote-submit')!.click();
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('oy reddedilirse hata gösterilir ve liste YENİDEN YÜKLENİR', async () => {
    render(PollsPanel);
    await openPanel();

    const inputs = [...document.querySelectorAll<HTMLInputElement>('.poll-votes input')];
    await fireEvent.change(inputs[0]!);
    await flush();

    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response({ error: 'x' }, 409));
    apiFetch.mockResolvedValueOnce(response([poll()]));
    document.querySelector<HTMLButtonElement>('.vote-submit')!.click();
    await flush();

    expect(errorText()).toBe(t('ui_anket_degisti_guncel_hali_yeniden_yuklendi'));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('oy yanıtı BOZUKSA liste yeniden yüklenir (uydurma durum yok)', async () => {
    render(PollsPanel);
    await openPanel();

    const inputs = [...document.querySelectorAll<HTMLInputElement>('.poll-votes input')];
    await fireEvent.change(inputs[0]!);
    await flush();

    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response({ garbage: true }));
    apiFetch.mockResolvedValueOnce(response([poll()]));
    document.querySelector<HTMLButtonElement>('.vote-submit')!.click();
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('oy verme taşıma hatası sabit metne düşer', async () => {
    render(PollsPanel);
    await openPanel();
    const inputs = [...document.querySelectorAll<HTMLInputElement>('.poll-votes input')];
    await fireEvent.change(inputs[0]!);
    await flush();

    apiFetch.mockClear();
    apiFetch.mockRejectedValueOnce(new Error('offline'));
    document.querySelector<HTMLButtonElement>('.vote-submit')!.click();
    await flush();

    expect(errorText()).toBe(t('ui_oy_kaydedilemedi'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PollsPanel — kapalı anket ve oy değiştirme kuralı', () => {
  it('KAPALI ankette oylama girdileri devre dışıdır ve gönder düğmesi yoktur', async () => {
    apiFetch = vi.fn(async () => response([poll({ closed: true })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    for (const input of document.querySelectorAll<HTMLInputElement>('.poll-votes input')) {
      expect(input.disabled).toBe(true);
    }
    expect(document.querySelector('.vote-submit')).toBeNull();
    expect(cards()[0]!.textContent).toContain(t('ui_kapali'));
  });

  it('SÜRESİ GEÇMİŞ anket de kapalı sayılır', async () => {
    apiFetch = vi.fn(async () => response([poll({ expiresAt: Date.now() - 1000 })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    expect(document.querySelector('.vote-submit')).toBeNull();
    expect(cards()[0]!.textContent).toContain(t('ui_kapali'));
  });

  it('oy değiştirme kapalıyken ve oy verilmişse KİLİTLİ mesajı gösterilir', async () => {
    apiFetch = vi.fn(async () => response([poll({
      allowVoteChange: false,
      options: [option('o1', 'A', 1, true), option('o2', 'B', 0)],
    })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    expect(document.querySelector('.vote-submit')).toBeNull();
    expect(document.querySelector('.vote-locked')?.textContent).toBe(t('poll_vote_change_disabled'));
  });

  it('oy değiştirme kapalı ama HENÜZ oy verilmemişse oylama AÇIKTIR', async () => {
    apiFetch = vi.fn(async () => response([poll({ allowVoteChange: false })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    expect(document.querySelector('.vote-submit')).not.toBeNull();
  });

  it('yüzde hesabı toplam oya göredir ve sıfır toplamda 0 verir', async () => {
    apiFetch = vi.fn(async () => response([
      poll({ _id: 'p-zero', options: [option('o1', 'A', 0), option('o2', 'B', 0)] }),
      poll({ _id: 'p-some', options: [option('o1', 'A', 3), option('o2', 'B', 1)] }),
    ]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    expect(cards()[0]!.textContent).toContain('0% · 0');
    expect(cards()[1]!.textContent).toContain('75% · 3');
    expect(cards()[1]!.textContent).toContain('25% · 1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PollsPanel — sahiplik: kapatma ve silme', () => {
  it('SAHİBİ OLMAYAN anket için sahip eylemleri GÖRÜNMEZ', async () => {
    apiFetch = vi.fn(async () => response([poll({ createdBy: 'baskasi' })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PollsPanel);
    await openPanel();

    expect(document.querySelector('.poll-owner-actions')).toBeNull();
  });

  it('sahibi anketi kapatabilir ve liste yeniden yüklenir', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response({ ok: true }));
    apiFetch.mockResolvedValueOnce(response([poll({ closed: true })]));

    document.querySelector<HTMLButtonElement>('.poll-owner-actions .secondary')!.click();
    await flush();

    expect(apiFetch.mock.calls[0]![0]).toBe('/api/polls/poll-1/close');
    expect((apiFetch.mock.calls[0]![1] as RequestInit).method).toBe('POST');
    await waitFor(() => expect(document.querySelector('.vote-submit')).toBeNull());
  });

  it('kapatma reddedilirse hata gösterilir ve liste tazelenir', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response({ error: 'x' }, 500));
    apiFetch.mockResolvedValueOnce(response([poll()]));

    document.querySelector<HTMLButtonElement>('.poll-owner-actions .secondary')!.click();
    await flush();

    expect(errorText()).toBe(t('ui_anket_kapatilamadi'));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('silme ÜRÜN DİYALOĞU ile onaylanır; iptal edilirse istek GİTMEZ', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();

    document.querySelector<HTMLButtonElement>('.poll-owner-actions .danger-action')!.click();
    await chooseProductDialog('cancel');

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('silme onaylanırsa DELETE gider ve liste yenilenir', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response({ ok: true }));
    apiFetch.mockResolvedValueOnce(response([]));

    document.querySelector<HTMLButtonElement>('.poll-owner-actions .danger-action')!.click();
    await chooseProductDialog('confirm');

    expect(apiFetch.mock.calls[0]![0]).toBe('/api/polls/poll-1');
    expect((apiFetch.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
    await waitFor(() => expect(cards()).toHaveLength(0));
  });

  it('silme reddedilirse hata gösterilir', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response({ error: 'x' }, 403));
    apiFetch.mockResolvedValueOnce(response([poll()]));

    document.querySelector<HTMLButtonElement>('.poll-owner-actions .danger-action')!.click();
    await chooseProductDialog('confirm');

    expect(errorText()).toBe(t('ui_bu_kanalda_bu_islem_icin_yetkin_yok'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PollsPanel — gerçek zamanlı olaylar', () => {
  it.each(['poll:created', 'poll:updated', 'poll:deleted'])('%s olayı AYNI kanalda listeyi tazeler', async (event) => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();

    emit(event, { channelId: 'chan-1' });
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('BAŞKA kanalın olayı listeyi tazelemez', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();

    emit('poll:updated', { channelId: 'baska-kanal' });
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('iç içe `poll.channelId` de tanınır', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();

    emit('poll:updated', { poll: { channelId: 'chan-1' } });
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('panel KAPALIYKEN olaylar istek üretmez', async () => {
    render(PollsPanel);
    await openPanel();
    BridgeRegistry.call('closePolls');
    await flush();
    apiFetch.mockClear();

    emit('poll:updated', { channelId: 'chan-1' });
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('şekilsiz olaylar yok sayılır', async () => {
    render(PollsPanel);
    await openPanel();
    apiFetch.mockClear();

    emit('poll:updated', null);
    emit('poll:updated', 'metin');
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PollsPanel — kapanış, odak ve temizlik', () => {
  it('Escape paneli kapatır', async () => {
    render(PollsPanel);
    await openPanel();

    await fireEvent.keyDown(panel()!, { key: 'Escape' });
    await flush();

    expect(panel()).toBeNull();
  });

  it('arka plana tıklamak kapatır, panelin İÇİNE tıklamak kapatmaz', async () => {
    render(PollsPanel);
    await openPanel();

    await fireEvent.click(panel()!);
    await flush();
    expect(panel()).not.toBeNull();

    await fireEvent.click(document.querySelector('.polls-overlay')!);
    await flush();
    expect(panel()).toBeNull();
  });

  it('kapanışta odak açan öğeye GERİ VERİLİR', async () => {
    const opener = document.createElement('button');
    opener.id = 'poll-opener';
    document.body.appendChild(opener);
    opener.focus();

    render(PollsPanel);
    await openPanel();
    BridgeRegistry.call('closePolls');
    await flush();
    await new Promise(resolve => queueMicrotask(() => resolve(null)));

    expect(document.activeElement).toBe(opener);
  });

  it('unmount kayıtları ve soket dinleyicilerini SÖKER', async () => {
    const view = render(PollsPanel);
    await openPanel();

    view.unmount();
    await flush();

    expect(BridgeRegistry.has('openPolls')).toBe(false);
    expect(BridgeRegistry.has('closePolls')).toBe(false);
    expect(socketOff).toHaveBeenCalledTimes(3);
  });

  it('soket sahibi YOKKEN de panel çalışır', async () => {
    BridgeRegistry.unregister('socket');
    const view = render(PollsPanel);
    await openPanel();

    expect(panel()).not.toBeNull();
    expect(() => view.unmount()).not.toThrow();
  });
});
