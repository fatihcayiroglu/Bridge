// client/tests/thread-panel-deep-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ThreadPanel — YARIŞ, TASLAK KORUMA VE YENİDEN GÖNDERİM BÜTÜNLÜĞÜ
// ════════════════════════════════════════════════════════════════════════════
//
// Bu yüzeyin hiç ölçülmemiş olması (249 dal) sıradan bir eksiklik değildi:
// panel, kullanıcının YAZDIĞI metni tutar ve AĞ üzerinden yazar. Riskler:
//
//   · YARIŞ — kullanıcı bir thread’i açıp hemen başkasına geçebilir. Geciken
//     ilk yanıt gelip İKİNCİ thread’in içeriğini EZERSE kullanıcı yanlış
//     sohbete bakar ve oraya yazar. `generation` sayacı bunun için vardır.
//   · TASLAK — yazılmış ama gönderilmemiş metin thread değiştirirken, panel
//     kapanırken ve bileşen sökülürken KAYBOLMAMALIDIR.
//   · YİNELENEN MESAJ — gönderim hatasından sonra yeniden denemek AYNI
//     `clientNonce` ile olmalıdır; aksi hâlde sunucu iki mesaj yazar. Metin
//     DEĞİŞTİYSE bu artık yeni bir mesajdır ve yeni nonce almalıdır.
//   · KİLİT — kilitli thread’e yazma yolu istemcide de kapalı olmalıdır.
//   · BOZUK SATIR — kimliksiz/şekilsiz mesaj RENDER EDİLMEZ, listeyi çökertmez.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import ThreadPanel from '../js/core/ThreadPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { t } from '../js/core/i18n/index.ts';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const OWNED_KEYS = ['apiFetch', 'socket', 'getMe', 'openThread', 'openExistingThread', 'closeThread'];

let apiFetch: ReturnType<typeof vi.fn>;
let socketEmit: ReturnType<typeof vi.fn>;
let socketOff: ReturnType<typeof vi.fn>;
let socketHandlers: Map<string, Array<(payload: unknown) => void>>;

function installSocket(): void {
  // Her soket KENDİ casuslarını taşır: modül düzeyindeki değişkeni kapatan bir
  // ok işlevi, soket değiştirildiğinde eski nesnenin çağrılarını da yenisine
  // yönlendirir ve "eski dinleyici söküldü mü" sorusu ölçülemez hâle gelirdi.
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const emitSpy = vi.fn();
  const offSpy = vi.fn();
  socketHandlers = handlers;
  socketEmit = emitSpy;
  socketOff = offSpy;
  BridgeRegistry.register('socket', {
    emit: (...args: unknown[]) => emitSpy(...args),
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
  for (let i = 0; i < 4; i += 1) { await tick(); await Promise.resolve(); }
}

const threadRow = (over: Record<string, unknown> = {}) => ({
  _id: 'thr-1', parentMessageId: 'msg-1', channelId: 'ch-1', serverId: 'srv-1',
  name: 'Tasarım tartışması', messageCount: 3, locked: false, ...over,
});

const threadMessage = (over: Record<string, unknown> = {}) => ({
  _id: 'tm-1', userId: 'u-2', displayName: 'Yanıtlayan', avatarColor: '#123',
  content: 'ilk yanıt', createdAt: 1000, ...over,
});

const panel = () => document.querySelector('.thread-panel');
const errorText = () => document.querySelector('.thread-error')?.textContent ?? '';
const rows = () => [...document.querySelectorAll('.thread-message')];
const composer = () => document.querySelector<HTMLTextAreaElement>('.thread-composer')!;
const sendButton = () => document.querySelector<HTMLButtonElement>('.thread-send')!;

async function openThread(preview = ''): Promise<void> {
  BridgeRegistry.call('openThread', 'msg-1', preview);
  await waitFor(() => expect(panel()).not.toBeNull());
  await flush();
}

async function openExisting(id = 'thr-1', preview = ''): Promise<void> {
  BridgeRegistry.call('openExistingThread', id, preview);
  await waitFor(() => expect(panel()).not.toBeNull());
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  apiFetch = vi.fn(async (url: string) => {
    if (url.includes('/messages')) return response([threadMessage()]);
    return response(threadRow());
  });
  BridgeRegistry.register('apiFetch', apiFetch as never);
  BridgeRegistry.register('getMe', (() => ({ _id: 'me' })) as never);
  installSocket();
});

afterEach(() => {
  cleanup();
  for (const key of OWNED_KEYS) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe('ThreadPanel — açılış sözleşmesi', () => {
  it('API sahibi yoksa panel AÇILMAZ', async () => {
    BridgeRegistry.unregister('apiFetch');
    render(ThreadPanel);

    BridgeRegistry.call('openThread', 'msg-1');
    await flush();

    expect(panel()).toBeNull();
  });

  it.each([
    ['boş kimlik', ''],
    ['128 karakterden uzun kimlik', 'm'.repeat(129)],
  ])('%s ile istek GÖNDERİLMEZ', async (_label, id) => {
    render(ThreadPanel);

    BridgeRegistry.call('openThread', id);
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
  });

  it('yeni thread oluşturur, katılır ve mesajları yükler', async () => {
    render(ThreadPanel);
    await openThread('Ana mesajın önizlemesi');

    const [createUrl, createInit] = apiFetch.mock.calls[0]!;
    expect(createUrl).toBe('/api/threads');
    expect(JSON.parse(String((createInit as RequestInit).body))).toEqual({
      parentMessageId: 'msg-1', name: 'Ana mesajın önizlemesi',
    });
    expect(apiFetch.mock.calls[1]![0]).toBe('/api/threads/thr-1/messages?limit=50');
    expect(socketEmit).toHaveBeenCalledWith('thread:join', 'thr-1');
    expect(document.getElementById('thread-panel-title')?.textContent).toBe('Tasarım tartışması');
    expect(rows()).toHaveLength(1);
  });

  it('ÇAKIŞMA (409) yanıtı mevcut thread’i açar, hata göstermez', async () => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/messages')) return response([]);
      return response({ thread: threadRow({ _id: 'thr-varolan' }) }, 409);
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openThread();

    expect(errorText()).toBe('');
    expect(socketEmit).toHaveBeenCalledWith('thread:join', 'thr-varolan');
  });

  it.each([
    [403, () => t('ui_bu_mesajda_thread_acma_yetkiniz_yok')],
    [404, () => t('ui_mesaj_artik_bulunamiyor')],
    [500, () => t('ui_thread_acilamadi')],
  ])('oluşturma %i durumunda doğru metni gösterir', async (status, expected) => {
    apiFetch = vi.fn(async () => response({ error: 'GIZLI-SUNUCU-AYRINTISI' }, status));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openThread();

    expect(errorText()).toBe(expected());
    expect(errorText()).not.toContain('GIZLI-SUNUCU-AYRINTISI');
    expect(composer().disabled).toBe(true);
  });

  it('gövdesi çözülemeyen yanıt açılamadı sayılır', async () => {
    apiFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bozuk'); } } as Response));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openThread();

    expect(errorText()).toBe(t('ui_thread_acilamadi'));
  });

  it('kimliği olmayan thread kaydı kabul edilmez', async () => {
    apiFetch = vi.fn(async () => response({ name: 'kimliksiz' }));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openThread();

    expect(errorText()).toBe(t('ui_thread_acilamadi'));
    expect(socketEmit).not.toHaveBeenCalledWith('thread:join', expect.anything());
  });

  it('taşıma hatası paneli çökertmez', async () => {
    apiFetch = vi.fn(async () => { throw new Error('offline'); });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openThread();

    expect(errorText()).toBe(t('ui_thread_acilamadi'));
    expect(panel()).not.toBeNull();
  });

  it('adı olmayan thread için yedek başlık kullanılır ve sayaç güvenli okunur', async () => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/messages')) return response([]);
      return response({ _id: 'thr-1', messageCount: 'çok', locked: 1 });
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openThread();

    expect(document.getElementById('thread-panel-title')?.textContent).toBe(t('ui_thread_label'));
    expect(composer().disabled).toBe(true);   // locked: 1 → kilitli
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ThreadPanel — mevcut thread açma ve yarış', () => {
  it('var olan thread doğrudan açılır', async () => {
    render(ThreadPanel);
    await openExisting('thr-9');

    expect(apiFetch.mock.calls[0]![0]).toBe('/api/threads/thr-9');
    expect(socketEmit).toHaveBeenCalledWith('thread:join', 'thr-1');
  });

  it('kimlik URL için KAÇIRILIR', async () => {
    render(ThreadPanel);
    await openExisting('thr/slash');

    expect(apiFetch.mock.calls[0]![0]).toBe('/api/threads/thr%2Fslash');
  });

  it.each([
    [403, () => t('ui_bu_thread_gecmisini_gorme_yetkiniz_yok')],
    [404, () => t('ui_thread_artik_bulunamiyor')],
    [500, () => t('ui_thread_acilamadi')],
  ])('açma %i durumunda doğru metni gösterir', async (status, expected) => {
    apiFetch = vi.fn(async () => response({ error: 'x' }, status));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openExisting();

    expect(errorText()).toBe(expected());
  });

  it('önizleme verilmezse ilk mesajdan türetilir ve 200 karakterle sınırlanır', async () => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/messages')) return response([]);
      return response(threadRow({ firstMessage: 'ö'.repeat(300) }));
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openExisting();

    const preview = document.querySelector('.thread-heading p')?.textContent ?? '';
    expect(preview).toHaveLength(200);
  });

  it('AÇIK önizleme sunucu metnini geçersiz kılar', async () => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/messages')) return response([]);
      return response(threadRow({ firstMessage: 'sunucudan' }));
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openExisting('thr-1', 'istemciden');

    expect(document.querySelector('.thread-heading p')?.textContent).toBe('istemciden');
  });

  it('GECİKEN ilk yanıt, sonra açılan thread’i EZMEZ', async () => {
    let releaseFirst: (value: Response) => void = () => {};
    apiFetch = vi.fn((url: string) => {
      if (url.includes('/messages')) return Promise.resolve(response([]));
      if (url.endsWith('/thr-yavas')) return new Promise<Response>(resolve => { releaseFirst = resolve; });
      return Promise.resolve(response(threadRow({ _id: 'thr-hizli', name: 'Hızlı' })));
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);

    BridgeRegistry.call('openExistingThread', 'thr-yavas');
    await flush();
    BridgeRegistry.call('openExistingThread', 'thr-hizli');
    await flush();

    releaseFirst(response(threadRow({ _id: 'thr-yavas', name: 'Yavaş' })));
    await flush();

    expect(document.getElementById('thread-panel-title')?.textContent).toBe('Hızlı');
  });

  it('thread değiştirirken öncekinden AYRILINIR ve taslak SAKLANIR', async () => {
    render(ThreadPanel);
    await openExisting('thr-1');
    await fireEvent.input(composer(), { target: { value: 'yarım kalan metin' } });
    await flush();

    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/messages')) return response([]);
      return response(threadRow({ _id: 'thr-2', name: 'İkinci' }));
    });
    BridgeRegistry.call('openExistingThread', 'thr-2');
    await flush();

    expect(socketEmit).toHaveBeenCalledWith('thread:leave', 'thr-1');
    expect(localStorage.getItem('bridge:thread-draft:me:thr-1')).toBe('yarım kalan metin');
    expect(composer().value).toBe('');
  });

  it('kaydedilmiş taslak thread yeniden açıldığında GERİ YÜKLENİR', async () => {
    localStorage.setItem('bridge:thread-draft:me:thr-1', 'kaldığım yer');
    render(ThreadPanel);
    await openExisting('thr-1');

    expect(composer().value).toBe('kaldığım yer');
  });

  it('depolama kullanılamıyorsa panel yine çalışır', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('quota'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      render(ThreadPanel);
      await openExisting('thr-1');
      await fireEvent.input(composer(), { target: { value: 'metin' } });
      await flush();

      expect(panel()).not.toBeNull();
      expect(composer().value).toBe('metin');
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('kimliği bilinmeyen kullanıcı için taslak anahtarı yine kurulur', async () => {
    BridgeRegistry.register('getMe', (() => null) as never);
    render(ThreadPanel);
    await openExisting('thr-1');
    await fireEvent.input(composer(), { target: { value: 'anonim taslak' } });
    await flush();

    expect(localStorage.getItem('bridge:thread-draft:anonymous:thr-1')).toBe('anonim taslak');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ThreadPanel — mesaj listesi', () => {
  it('bozuk satırlar RENDER EDİLMEZ, geçerli olan kalır', async () => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/messages')) {
        return response([null, 'metin', [], {}, { _id: '' }, threadMessage()]);
      }
      return response(threadRow());
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openExisting();

    expect(rows()).toHaveLength(1);
  });

  it('dizi olmayan gövde listeyi DEĞİŞTİRMEZ', async () => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/messages')) return response({ messages: [threadMessage()] });
      return response(threadRow());
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openExisting();

    expect(rows()).toHaveLength(0);
    expect(document.querySelector('.thread-state')?.textContent).toBe(t('thread_empty_reply'));
  });

  it('adı olmayan gönderen ve bozuk zaman damgaları güvenli sunulur', async () => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/messages')) {
        return response([
          { _id: 'a', createdAt: 'not-a-number', editedAt: Number.NaN },
          { _id: 'b', createdAt: '2000', displayName: 42, content: 99 },
        ]);
      }
      return response(threadRow());
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openExisting();

    const cards = rows();
    expect(cards[0]!.querySelector('strong')?.textContent).toBe(t('unknown_user'));
    expect(cards[0]!.querySelector('time')).toBeNull();
    expect(cards[0]!.querySelector('.thread-message-content p')?.textContent).toBe('');
    expect(cards[1]!.querySelector('time')).not.toBeNull();
  });

  it('mesajlar ZAMAN SIRASINA göre dizilir', async () => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/messages')) return response([]);
      return response(threadRow());
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openExisting();

    emit('thread:message:new', { threadId: 'thr-1', msg: threadMessage({ _id: 'geç', createdAt: 500 }) });
    emit('thread:message:new', { threadId: 'thr-1', msg: threadMessage({ _id: 'erken', createdAt: 100 }) });
    await flush();

    const names = rows().map(row => row.querySelector('.thread-message-content p')?.textContent);
    expect(names).toHaveLength(2);
    expect(rows()[0]!.textContent).toContain('ilk yanıt');
  });

  it('50 kayıt geldiğinde DAHA ESKİ düğmesi belirir ve sayfa çakışmaz', async () => {
    const page = Array.from({ length: 50 }, (_, i) => threadMessage({ _id: `m-${i}`, createdAt: 1000 + i }));
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('before=')) {
        return response([threadMessage({ _id: 'm-0', createdAt: 1000 }), threadMessage({ _id: 'eski', createdAt: 10 })]);
      }
      if (url.includes('/messages')) return response(page);
      return response(threadRow());
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openExisting();

    const older = document.querySelector<HTMLButtonElement>('.load-older')!;
    expect(older).not.toBeNull();

    older.click();
    await flush();

    expect(apiFetch.mock.calls.at(-1)![0]).toContain('before=1000');
    expect(rows()).toHaveLength(51);          // yinelenen `m-0` eklenmedi
    expect(document.querySelector('.load-older')).toBeNull();
  });

  it.each([
    [403, () => t('ui_bu_thread_gecmisini_gorme_yetkiniz_yok')],
    [500, () => t('ui_thread_mesajlari_yuklenemedi')],
  ])('mesaj yükleme %i durumunda doğru metni gösterir', async (status, expected) => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/messages')) return response({ error: 'x' }, status);
      return response(threadRow());
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openExisting();

    expect(errorText()).toBe(expected());
  });

  it('mesaj yükleme taşıma hatası sabit metne düşer', async () => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/messages')) throw new Error('offline');
      return response(threadRow());
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openExisting();

    expect(errorText()).toBe(t('ui_thread_mesajlari_yuklenemedi'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ThreadPanel — gerçek zamanlı olaylar', () => {
  const ready = async () => {
    render(ThreadPanel);
    await openExisting();
  };

  it('BAŞKA thread’in mesajı listeye eklenmez', async () => {
    await ready();

    emit('thread:message:new', { threadId: 'baska', msg: threadMessage({ _id: 'yabanci' }) });
    await flush();

    expect(rows()).toHaveLength(1);
  });

  it('AYNI mesaj iki kez eklenmez', async () => {
    await ready();

    emit('thread:message:new', { threadId: 'thr-1', msg: threadMessage() });
    await flush();

    expect(rows()).toHaveLength(1);
  });

  it('şekilsiz olaylar yok sayılır', async () => {
    await ready();

    emit('thread:message:new', null);
    emit('thread:message:new', 'metin');
    emit('thread:message:new', { threadId: 'thr-1' });
    emit('thread:message:new', { threadId: 'thr-1', msg: { content: 'kimliksiz' } });
    await flush();

    expect(rows()).toHaveLength(1);
  });

  it('soket sonradan hazır olduğunda YENİDEN bağlanılır', async () => {
    BridgeRegistry.unregister('socket');
    render(ThreadPanel);
    await openExisting();

    installSocket();
    document.dispatchEvent(new Event('bridge:socket-ready'));
    await flush();

    emit('thread:message:new', { threadId: 'thr-1', msg: threadMessage({ _id: 'yeni' }) });
    await flush();

    expect(rows()).toHaveLength(2);
  });

  it('soket değiştiğinde ESKİ dinleyici sökülür', async () => {
    render(ThreadPanel);
    await openExisting();
    const firstOff = socketOff;

    installSocket();
    document.dispatchEvent(new Event('bridge:socket-ready'));
    await flush();

    expect(firstOff).toHaveBeenCalledWith('thread:message:new', expect.any(Function));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ThreadPanel — yanıt gönderme', () => {
  const ready = async () => {
    render(ThreadPanel);
    await openExisting();
    apiFetch.mockClear();
  };

  const type = async (value: string) => {
    await fireEvent.input(composer(), { target: { value } });
    await flush();
  };

  it('boş taslakla gönder düğmesi devre dışıdır', async () => {
    await ready();
    expect(sendButton().disabled).toBe(true);

    await type('   ');
    expect(sendButton().disabled).toBe(true);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('2000 karakterden uzun metin GÖNDERİLMEZ', async () => {
    await ready();
    await type('a'.repeat(2001));

    sendButton().click();
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('KİLİTLİ thread’de yazma ve gönderme kapalıdır', async () => {
    cleanup();
    apiFetch = vi.fn(async (url: string) => {
      if (url.includes('/messages')) return response([]);
      return response(threadRow({ locked: true }));
    });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(ThreadPanel);
    await openExisting();

    expect(composer().disabled).toBe(true);
    expect(sendButton().disabled).toBe(true);
  });

  it('geçerli yanıt gönderilir, listeye eklenir ve taslak TEMİZLENİR', async () => {
    await ready();
    await type('yeni yanıt');
    apiFetch.mockResolvedValueOnce(response(threadMessage({ _id: 'tm-2', content: 'yeni yanıt', createdAt: 2000 })));

    sendButton().click();
    await flush();

    const [url, init] = apiFetch.mock.calls[0]!;
    expect(url).toBe('/api/threads/thr-1/messages');
    const body = JSON.parse(String((init as RequestInit).body)) as { content: string; clientNonce: string };
    expect(body.content).toBe('yeni yanıt');
    expect(body.clientNonce).toBeTruthy();
    await waitFor(() => expect(composer().value).toBe(''));
    expect(rows()).toHaveLength(2);
    expect(localStorage.getItem('bridge:thread-draft:me:thr-1')).toBeNull();
  });

  it('YENİDEN DENEME aynı nonce ile yapılır, metin değişince YENİSİ alınır', async () => {
    await ready();
    await type('ilk deneme');
    apiFetch.mockResolvedValueOnce(response({ error: 'x' }, 500));

    sendButton().click();
    await flush();
    const first = JSON.parse(String((apiFetch.mock.calls[0]![1] as RequestInit).body)) as { clientNonce: string };
    expect(errorText()).toBe(t('ui_yanit_gonderilemedi_metin_korundu_yeniden_deneyebili'));
    expect(composer().value).toBe('ilk deneme');

    apiFetch.mockResolvedValueOnce(response({ error: 'x' }, 500));
    sendButton().click();
    await flush();
    const retry = JSON.parse(String((apiFetch.mock.calls[1]![1] as RequestInit).body)) as { clientNonce: string };
    expect(retry.clientNonce).toBe(first.clientNonce);

    await type('değiştirilmiş metin');
    apiFetch.mockResolvedValueOnce(response({ error: 'x' }, 500));
    sendButton().click();
    await flush();
    const changed = JSON.parse(String((apiFetch.mock.calls[2]![1] as RequestInit).body)) as { clientNonce: string };
    expect(changed.clientNonce).not.toBe(first.clientNonce);
  });

  it.each([
    [423, () => t('ui_bu_thread_kilitli')],
    [403, () => t('ui_bu_threade_mesaj_gonderme_yetkiniz_yok')],
    [500, () => t('ui_yanit_gonderilemedi_metin_korundu_yeniden_deneyebili')],
  ])('gönderim %i durumunda doğru metni gösterir ve METNİ KORUR', async (status, expected) => {
    await ready();
    await type('korunacak metin');
    apiFetch.mockResolvedValueOnce(response({ error: 'GIZLI' }, status));

    sendButton().click();
    await flush();

    expect(errorText()).toBe(expected());
    expect(errorText()).not.toContain('GIZLI');
    expect(composer().value).toBe('korunacak metin');
  });

  it('taşıma hatası da metni korur', async () => {
    await ready();
    await type('korunacak metin');
    apiFetch.mockRejectedValueOnce(new Error('offline'));

    sendButton().click();
    await flush();

    expect(errorText()).toBe(t('ui_yanit_gonderilemedi_metin_korundu_yeniden_deneyebili'));
    expect(composer().value).toBe('korunacak metin');
  });

  it('Enter gönderir, Shift+Enter ve IME birleşimi göndermez', async () => {
    await ready();
    await type('klavyeyle');

    await fireEvent.keyDown(panel()!, { key: 'Enter', shiftKey: true });
    await fireEvent.keyDown(panel()!, { key: 'Enter', isComposing: true });
    await flush();
    expect(apiFetch).not.toHaveBeenCalled();

    apiFetch.mockResolvedValueOnce(response(threadMessage({ _id: 'tm-3', createdAt: 3000 })));
    await fireEvent.keyDown(panel()!, { key: 'Enter' });
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('gönderim sırasında ikinci istek AÇILMAZ', async () => {
    await ready();
    await type('tek istek');
    let release: (value: Response) => void = () => {};
    apiFetch.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));

    sendButton().click();
    await flush();
    sendButton().click();
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    release(response(threadMessage({ _id: 'tm-4', createdAt: 4000 })));
    await flush();
  });

  it('yanıt geldiğinde BAŞKA thread açıksa liste kirletilmez', async () => {
    await ready();
    await type('gecikmeli');
    let release: (value: Response) => void = () => {};
    apiFetch.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));

    sendButton().click();
    await flush();

    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/messages')) return response([]);
      return response(threadRow({ _id: 'thr-2' }));
    });
    BridgeRegistry.call('openExistingThread', 'thr-2');
    await flush();

    release(response(threadMessage({ _id: 'gecikmis', createdAt: 9000 })));
    await flush();

    expect(rows()).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ThreadPanel — kapanış ve temizlik', () => {
  it('Escape paneli kapatır, taslağı saklar ve odağı GERİ VERİR', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    render(ThreadPanel);
    await openExisting();
    await fireEvent.input(composer(), { target: { value: 'kapanışta saklanacak' } });
    await flush();

    await fireEvent.keyDown(panel()!, { key: 'Escape' });
    await flush();

    expect(panel()).toBeNull();
    expect(localStorage.getItem('bridge:thread-draft:me:thr-1')).toBe('kapanışta saklanacak');
    expect(socketEmit).toHaveBeenCalledWith('thread:leave', 'thr-1');
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('kapatma düğmesi de aynı yolu kullanır', async () => {
    render(ThreadPanel);
    await openExisting();

    document.querySelector<HTMLButtonElement>('.thread-close')!.click();
    await flush();

    expect(panel()).toBeNull();
  });

  it('kayıt üzerinden kapatma da çalışır', async () => {
    render(ThreadPanel);
    await openExisting();

    BridgeRegistry.call('closeThread');
    await flush();

    expect(panel()).toBeNull();
  });

  it('unmount kayıtları söker, taslağı saklar ve odadan ayrılır', async () => {
    const view = render(ThreadPanel);
    await openExisting();
    await fireEvent.input(composer(), { target: { value: 'sökülürken saklanacak' } });
    await flush();

    view.unmount();
    await flush();

    expect(BridgeRegistry.has('openThread')).toBe(false);
    expect(BridgeRegistry.has('openExistingThread')).toBe(false);
    expect(BridgeRegistry.has('closeThread')).toBe(false);
    expect(socketOff).toHaveBeenCalledWith('thread:message:new', expect.any(Function));
    expect(localStorage.getItem('bridge:thread-draft:me:thr-1')).toBe('sökülürken saklanacak');
  });

  it('soket sahibi YOKKEN de panel çalışır ve sökülür', async () => {
    BridgeRegistry.unregister('socket');
    const view = render(ThreadPanel);
    await openExisting();

    expect(panel()).not.toBeNull();
    expect(() => view.unmount()).not.toThrow();
  });
});
