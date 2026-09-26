// client/tests/message-renderer-dialogs-embeds.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// MessageRenderer — RAPOR, DÜZENLEME GEÇMİŞİ, ÖNİZLEME VE MEDYA DALLARI
// ════════════════════════════════════════════════════════════════════════════
//
// `message-renderer-deep-coverage.test.ts` mobil eylem sayfasını ve kalıcı
// bağlantı yollarını ölçer. Bu dosya, o dosyanın DOKUNMADIĞI ve hiç ölçülmemiş
// kalan karar dallarını kapatır:
//
//   · RAPOR — kendi mesajını ya da teslim edilmemiş bir satırı raporlama YOLU
//     AÇILMAZ; gönderim sürerken pencere kapanmaz; başarısızlık sessiz kalmaz.
//   · DÜZENLEME GEÇMİŞİ — sunucu 403 ile "yetkin yok" derse bu ayrı bir metinle
//     anlatılır; bozuk satırlar RENDER EDİLMEZ ve güncel sürüm sona eklenir.
//   · BAĞLANTI ÖNİZLEMESİ — `javascript:`/`data:` şemaları link’e ÇEVRİLMEZ,
//     içeriği tamamen boş olan önizleme gösterilmez, en fazla üç tane çizilir.
//   · ÇIKARTMA — yalnız kanonik `/uploads/stickers/...` yolu render edilir;
//     yol geçişi denemesi ve harici URL REDDEDİLİR.
//   · KORUMALI MEDYA — 401 sonrası TEK bir yenileme denenir; ikinci hata
//     kullanıcıya açık biçimde bildirilir.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import MessageRenderer, { type MessageData } from '../js/core/MessageRenderer.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { t } from '../js/core/i18n/index.ts';

const mediaAuth = vi.hoisted(() => ({
  getMediaCredentialGeneration: vi.fn(() => 1),
  isProtectedMediaUrl: vi.fn(() => false),
  renewMediaCredential: vi.fn(async () => true),
  withMediaRetry: vi.fn((url: string, generation: number) => `${url}?g=${generation}`),
  resetMediaRenewalState: vi.fn(),
}));
vi.mock('../js/core/media-auth.ts', () => mediaAuth);

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const OWNED_KEYS = ['apiFetch', 'toast'];

let apiFetch: ReturnType<typeof vi.fn>;
let toast: ReturnType<typeof vi.fn>;

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) { await tick(); await Promise.resolve(); }
}

function message(overrides: Partial<MessageData> = {}): MessageData {
  return {
    _id: 'm-1', userId: 'yazar', displayName: 'Ada Lovelace',
    content: 'merhaba', createdAt: 1_754_000_000_000,
    channelId: 'ch-1', serverId: 'srv-1', ...overrides,
  };
}

function mount(props: Record<string, unknown> = {}) {
  return render(MessageRenderer, {
    props: { message: message(), currentUserId: 'ben', ...props },
  });
}

const reportDialog = () => document.querySelector('.report-dialog');
const historyDialog = () => document.querySelector('.edit-history-dialog:not(.report-dialog)');
const reportButton = () => document.querySelector<HTMLButtonElement>('.msg-actions button.danger[aria-label]');
const embeds = () => [...document.querySelectorAll('.msg-link-preview')];

beforeEach(() => {
  apiFetch = vi.fn(async () => response({ editHistory: [], current: null }));
  toast = vi.fn();
  BridgeRegistry.register('apiFetch', apiFetch as never);
  BridgeRegistry.register('toast', toast as never);
  mediaAuth.isProtectedMediaUrl.mockReturnValue(false);
  mediaAuth.renewMediaCredential.mockResolvedValue(true);
  mediaAuth.getMediaCredentialGeneration.mockReturnValue(1);
});

afterEach(() => {
  cleanup();
  for (const key of OWNED_KEYS) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe('MessageRenderer — raporlama', () => {
  const openReport = async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.msg-actions button')]
      .find(node => node.getAttribute('aria-label') === t('report_message'));
    if (!button) throw new Error('rapor düğmesi yok');
    button.click();
    await flush();
  };

  it('rapor yolu KENDİ mesajında açılmaz', async () => {
    mount({ message: message({ userId: 'ben' }), currentUserId: 'ben', onReport: vi.fn() });
    await flush();

    const labels = [...document.querySelectorAll('.msg-actions button')].map(n => n.getAttribute('aria-label'));
    expect(labels).not.toContain(t('report_message'));
  });

  it('TESLİM EDİLMEMİŞ satırda rapor yolu açılmaz', async () => {
    mount({ message: message({ pending: true }), onReport: vi.fn() });
    await flush();

    const labels = [...document.querySelectorAll('.msg-actions button')].map(n => n.getAttribute('aria-label'));
    expect(labels).not.toContain(t('report_message'));
  });

  it('rapor sahibi verilmemişse düğme çizilmez', async () => {
    mount();
    await flush();

    expect(reportButton()).toBeNull();
  });

  it('rapor penceresi VARSAYILAN nedenle açılır', async () => {
    mount({ onReport: vi.fn(async () => true) });
    await flush();
    await openReport();

    expect(reportDialog()).not.toBeNull();
    expect(document.querySelector<HTMLSelectElement>('.report-reason')!.value).toBe('spam');
  });

  it('rapor gönderimi NEDEN ve KIRPILMIŞ açıklama taşır', async () => {
    const onReport = vi.fn(async () => true);
    mount({ onReport });
    await flush();
    await openReport();

    await fireEvent.change(document.querySelector<HTMLSelectElement>('.report-reason')!, { target: { value: 'harassment' } });
    await fireEvent.input(document.querySelector<HTMLTextAreaElement>('.report-form textarea')!, { target: { value: '  taciz ediyor  ' } });
    await flush();

    document.querySelector<HTMLButtonElement>('.danger-submit')!.click();
    await flush();

    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ _id: 'm-1' }), 'harassment', 'taciz ediyor');
    await waitFor(() => expect(reportDialog()).toBeNull());
  });

  it('rapor REDDEDİLİRSE pencere açık kalır ve neden gösterilir', async () => {
    mount({ onReport: vi.fn(async () => false) });
    await flush();
    await openReport();

    document.querySelector<HTMLButtonElement>('.danger-submit')!.click();
    await flush();

    expect(reportDialog()).not.toBeNull();
    expect(document.querySelector('.edit-history-error')?.textContent)
      .toBe(t('ui_rapor_gonderilemedi_lutfen_tekrar_deneyin'));
  });

  it('rapor sahibi PATLARSA da kullanıcı bilgilendirilir', async () => {
    mount({ onReport: vi.fn(async () => { throw new Error('offline'); }) });
    await flush();
    await openReport();

    document.querySelector<HTMLButtonElement>('.danger-submit')!.click();
    await flush();

    expect(document.querySelector('.edit-history-error')?.textContent)
      .toBe(t('ui_rapor_gonderilemedi_lutfen_tekrar_deneyin'));
  });

  it('gönderim SÜRERKEN pencere kapatılamaz ve ikinci istek açılmaz', async () => {
    let release: (value: boolean) => void = () => {};
    const onReport = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    mount({ onReport });
    await flush();
    await openReport();

    document.querySelector<HTMLButtonElement>('.danger-submit')!.click();
    await flush();

    document.querySelector<HTMLButtonElement>('.edit-history-close')!.click();
    await flush();
    expect(reportDialog()).not.toBeNull();

    document.querySelector<HTMLButtonElement>('.danger-submit')!.click();
    await flush();
    expect(onReport).toHaveBeenCalledTimes(1);

    release(true);
    await flush();
  });

  it('İPTAL penceresi kapatır ve odağı GERİ VERİR', async () => {
    mount({ onReport: vi.fn(async () => true) });
    await flush();
    const trigger = [...document.querySelectorAll<HTMLButtonElement>('.msg-actions button')]
      .find(node => node.getAttribute('aria-label') === t('report_message'))!;
    trigger.click();
    await flush();

    [...document.querySelectorAll<HTMLButtonElement>('.report-actions button')][0]!.click();
    await flush();

    expect(reportDialog()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('Escape ve arka plan tıklaması da kapatır', async () => {
    mount({ onReport: vi.fn(async () => true) });
    await flush();
    await openReport();

    await fireEvent.keyDown(reportDialog()!, { key: 'Escape' });
    await flush();
    expect(reportDialog()).toBeNull();

    await openReport();
    document.querySelector<HTMLElement>('.edit-history-overlay')!.click();
    await flush();
    expect(reportDialog()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MessageRenderer — düzenleme geçmişi', () => {
  const openHistory = async () => {
    document.querySelector<HTMLButtonElement>('.msg-edited-btn')!.click();
    await flush();
  };

  it('DÜZENLENMEMİŞ mesajda geçmiş düğmesi yoktur', async () => {
    mount();
    await flush();

    expect(document.querySelector('.msg-edited-btn')).toBeNull();
  });

  it('API sahibi yoksa pencere AÇILMAZ', async () => {
    BridgeRegistry.unregister('apiFetch');
    mount({ message: message({ editedAt: 2_000 }) });
    await flush();

    await openHistory();

    expect(historyDialog()).toBeNull();
  });

  it('geçmiş yüklenir ve GÜNCEL sürüm sona eklenir', async () => {
    apiFetch = vi.fn(async () => response({
      editHistory: [{ content: 'ilk hâli', editedAt: 1_000 }],
      current: { content: 'son hâli', editedAt: 2_000 },
    }));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount({ message: message({ editedAt: 2_000 }) });
    await flush();

    await openHistory();

    expect(apiFetch).toHaveBeenCalledWith('/api/messages/m-1/history');
    const entries = [...document.querySelectorAll('.edit-history-body li')];
    expect(entries).toHaveLength(2);
    expect(entries[0]!.querySelector('p')?.textContent).toBe('ilk hâli');
    expect(entries[1]!.querySelector('strong')?.textContent).toBe(t('surface_guncel_surum_85e518'));
  });

  it('BOZUK geçmiş satırları render EDİLMEZ', async () => {
    apiFetch = vi.fn(async () => response({
      editHistory: [null, 'metin', [], {}, { content: 42 }, { content: 'geçerli', editedAt: 'dün' }],
      current: { content: 5 },
    }));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount({ message: message({ editedAt: 2_000 }) });
    await flush();

    await openHistory();

    const entries = [...document.querySelectorAll('.edit-history-body li')];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.querySelector('time')).toBeNull();
  });

  it('dizi olmayan geçmiş ve nesne olmayan güncel sürüm yok sayılır', async () => {
    apiFetch = vi.fn(async () => response({ editHistory: { rows: [] }, current: [1] }));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount({ message: message({ editedAt: 2_000 }) });
    await flush();

    await openHistory();

    expect(document.querySelector('.edit-history-body p')?.textContent).toBe(t('message_history_none'));
  });

  it.each([
    [403, () => t('ui_bu_mesajin_duzenleme_gecmisini_gorme_yetkiniz_yok')],
    [500, () => t('ui_duzenleme_gecmisi_yuklenemedi')],
  ])('geçmiş %i durumunda doğru metni gösterir', async (status, expected) => {
    apiFetch = vi.fn(async () => response({ error: 'GIZLI' }, status));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount({ message: message({ editedAt: 2_000 }) });
    await flush();

    await openHistory();

    expect(document.querySelector('.edit-history-error')?.textContent).toBe(expected());
    expect(document.body.textContent).not.toContain('GIZLI');
  });

  it('taşıma hatası pencereyi çökertmez', async () => {
    apiFetch = vi.fn(async () => { throw new Error('offline'); });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount({ message: message({ editedAt: 2_000 }) });
    await flush();

    await openHistory();

    expect(document.querySelector('.edit-history-error')?.textContent)
      .toBe(t('ui_duzenleme_gecmisi_yuklenemedi'));
  });

  it('YÜKLEME sürerken ikinci istek açılmaz', async () => {
    let release: (value: Response) => void = () => {};
    apiFetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    mount({ message: message({ editedAt: 2_000 }) });
    await flush();

    await openHistory();
    expect(document.querySelector('.edit-history-body p')?.textContent).toBe(t('message_history_loading'));

    await openHistory();
    expect(apiFetch).toHaveBeenCalledTimes(1);

    release(response({ editHistory: [], current: null }));
    await flush();
  });

  it('Escape, kapat düğmesi ve arka plan pencereyi kapatır', async () => {
    mount({ message: message({ editedAt: 2_000 }) });
    await flush();

    await openHistory();
    await fireEvent.keyDown(historyDialog()!, { key: 'Escape' });
    await flush();
    expect(historyDialog()).toBeNull();

    await openHistory();
    document.querySelector<HTMLButtonElement>('.edit-history-close')!.click();
    await flush();
    expect(historyDialog()).toBeNull();

    await openHistory();
    document.querySelector<HTMLElement>('.edit-history-overlay')!.click();
    await flush();
    expect(historyDialog()).toBeNull();
  });

  it('ARDIŞIK gruplamada da geçmiş düğmesi vardır', async () => {
    mount({ message: message({ editedAt: 2_000 }), compact: true });
    await flush();

    expect(document.querySelector('.msg-edited-inline')).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MessageRenderer — bağlantı önizlemeleri', () => {
  it('METİN olarak saklanmış JSON çözülür', async () => {
    mount({
      message: message({
        embeds: JSON.stringify([{ url: 'https://ornek.test/a', title: 'Başlık', description: 'Açıklama', siteName: 'Örnek' }]),
      }),
    });
    await flush();

    expect(embeds()).toHaveLength(1);
    expect(embeds()[0]!.querySelector('strong')?.textContent).toBe('Başlık');
    expect(embeds()[0]!.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('ÇÖZÜLEMEYEN JSON önizleme üretmez', async () => {
    mount({ message: message({ embeds: '{bozuk' }) });
    await flush();

    expect(embeds()).toHaveLength(0);
  });

  it('dizi olmayan değer önizleme üretmez', async () => {
    mount({ message: message({ embeds: { url: 'https://ornek.test' } }) });
    await flush();

    expect(embeds()).toHaveLength(0);
  });

  it.each([
    ['null satır', [null, { url: 'https://ornek.test/iyi', title: 'İyi' }]],
    ['metin satır', ['metin', { url: 'https://ornek.test/iyi', title: 'İyi' }]],
    ['dizi satır', [[], { url: 'https://ornek.test/iyi', title: 'İyi' }]],
    ['adressiz satır', [{ title: 'kimliksiz' }, { url: 'https://ornek.test/iyi', title: 'İyi' }]],
    ['içeriği tamamen boş satır', [{ url: 'https://ornek.test/bos' }, { url: 'https://ornek.test/iyi', title: 'İyi' }]],
  ])('%s atlanır, geçerli olan kalır', async (_label, list) => {
    mount({ message: message({ embeds: list }) });
    await flush();

    expect(embeds()).toHaveLength(1);
    expect(embeds()[0]!.getAttribute('href')).toBe('https://ornek.test/iyi');
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>'],
  ])('GÜVENSİZ %s şeması link’e çevrilmez', async (_label, url) => {
    mount({ message: message({ embeds: [{ url, title: 'kötü' }] }) });
    await flush();

    expect(embeds()).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain('javascript:');
    expect(document.body.innerHTML).not.toContain('data:text/html');
  });

  it('başlık yoksa SİTE ADINA, o da yoksa ALAN ADINA düşülür', async () => {
    mount({
      message: message({
        embeds: [
          { url: 'https://ornek.test/a', siteName: 'Örnek Site' },
          { url: 'https://baska.test/b', description: 'yalnız açıklama' },
        ],
      }),
    });
    await flush();

    expect(embeds()[0]!.querySelector('strong')?.textContent).toBe('Örnek Site');
    expect(embeds()[1]!.querySelector('strong')?.textContent).toBe('baska.test');
    expect(embeds()[1]!.querySelector('small')?.textContent).toBe('baska.test');
  });

  it('açıklaması olmayan önizlemede açıklama alanı ÇİZİLMEZ', async () => {
    mount({ message: message({ embeds: [{ url: 'https://ornek.test/a', title: 'Başlık' }] }) });
    await flush();

    expect(embeds()[0]!.querySelector('span')).toBeNull();
  });

  it('uzun alanlar KIRPILIR ve en fazla ÜÇ önizleme çizilir', async () => {
    mount({
      message: message({
        embeds: Array.from({ length: 5 }, (_, i) => ({
          url: `https://ornek.test/${i}`,
          title: 'b'.repeat(300),
          description: 'a'.repeat(700),
          siteName: 's'.repeat(200),
        })),
      }),
    });
    await flush();

    expect(embeds()).toHaveLength(3);
    expect(embeds()[0]!.querySelector('strong')?.textContent).toHaveLength(240);
    expect(embeds()[0]!.querySelector('span')?.textContent).toHaveLength(500);
    expect(embeds()[0]!.querySelector('small')?.textContent).toHaveLength(100);
  });

  it('önizleme yoksa kap ÇİZİLMEZ', async () => {
    mount();
    await flush();

    expect(document.querySelector('.msg-link-previews')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MessageRenderer — çıkartmalar', () => {
  const sticker = (over: Record<string, unknown> = {}) => message({
    type: 'sticker',
    sticker: { id: 's1', name: 'Kedi', url: '/uploads/stickers/kedi.png', width: 200, height: 200, ...over },
  });

  it('kanonik yol render edilir ve ölçüler sınırlanır', async () => {
    mount({ message: sticker({ width: 5000, height: 1 }) });
    await flush();

    const image = document.querySelector<HTMLImageElement>('.msg-sticker')!;
    expect(image.getAttribute('src')).toBe('/uploads/stickers/kedi.png');
    expect(image.getAttribute('width')).toBe('320');
    expect(image.getAttribute('height')).toBe('32');
    expect(document.querySelector('.msg-sticker-name')?.textContent).toBe('Kedi');
  });

  it('ölçü verilmezse VARSAYILAN boyut kullanılır', async () => {
    mount({ message: sticker({ width: undefined, height: 'çok' }) });
    await flush();

    const image = document.querySelector<HTMLImageElement>('.msg-sticker')!;
    expect(image.getAttribute('width')).toBe('160');
    expect(image.getAttribute('height')).toBe('160');
  });

  it('adı olmayan çıkartmada güvenli metin kullanılır', async () => {
    mount({ message: sticker({ name: '' }) });
    await flush();

    expect(document.querySelector<HTMLImageElement>('.msg-sticker')!.getAttribute('alt')).toBe(t('sticker'));
    expect(document.querySelector('.msg-sticker-name')).toBeNull();
  });

  it.each([
    ['harici adres', 'https://saldirgan.test/x.png'],
    ['yol geçişi', '/uploads/stickers/../../secret'],
    ['nokta ile başlayan ad', '/uploads/stickers/.gizli'],
    ['boş', ''],
  ])('kanonik OLMAYAN çıkartma yolu (%s) render edilmez', async (_label, url) => {
    mount({ message: sticker({ url }) });
    await flush();

    expect(document.querySelector('.msg-sticker-wrap')).toBeNull();
  });

  it('çıkartma türü olmayan mesajda çıkartma çizilmez', async () => {
    mount({ message: message({ sticker: { url: '/uploads/stickers/kedi.png' } }) });
    await flush();

    expect(document.querySelector('.msg-sticker-wrap')).toBeNull();
  });

  it('görsel YÜKLENEMEZSE erişilebilir bir yedek gösterilir', async () => {
    mount({ message: sticker() });
    await flush();

    await fireEvent.error(document.querySelector('.msg-sticker')!);
    await flush();

    expect(document.querySelector('.msg-sticker')).toBeNull();
    const fallback = document.querySelector('.msg-sticker-fallback')!;
    expect(fallback.getAttribute('aria-label')).toContain('Kedi');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MessageRenderer — görsel önizleyici ve korumalı medya', () => {
  const imageMessage = (over: Partial<MessageData> = {}) =>
    message({ fileUrl: '/uploads/files/a.png', fileName: 'a.png', fileType: 'image/png', ...over });

  it('görsel önizleyici açılır, Escape ile kapanır ve odak GERİ VERİLİR', async () => {
    mount({ message: imageMessage() });
    await flush();

    const trigger = document.querySelector<HTMLButtonElement>('.msg-attachment button')!;
    trigger.click();
    await flush();
    expect(document.querySelector('.image-viewer-dialog')).not.toBeNull();

    await fireEvent.keyDown(document.querySelector('.image-viewer-dialog')!, { key: 'Escape' });
    await flush();

    expect(document.querySelector('.image-viewer-dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('arka plana tıklamak kapatır, diyaloğun içi kapatmaz', async () => {
    mount({ message: imageMessage() });
    await flush();
    document.querySelector<HTMLButtonElement>('.msg-attachment button')!.click();
    await flush();

    document.querySelector<HTMLElement>('.image-viewer-dialog')!.click();
    await flush();
    expect(document.querySelector('.image-viewer-dialog')).not.toBeNull();

    document.querySelector<HTMLElement>('.image-viewer-overlay')!.click();
    await flush();
    expect(document.querySelector('.image-viewer-dialog')).toBeNull();
  });

  it('adı olmayan ekte güvenli başlık kullanılır', async () => {
    mount({ message: imageMessage({ fileName: undefined }) });
    await flush();
    document.querySelector<HTMLButtonElement>('.msg-attachment button')!.click();
    await flush();

    expect(document.querySelector('.image-viewer-dialog header strong')?.textContent).toBe(t('srv_tab_media'));
    expect(document.querySelector('.image-viewer-dialog')!.getAttribute('aria-label'))
      .toBe(t('surface_gorsel_onizlemesi_ab5419'));
  });

  it('KORUMALI olmayan medyada hata yenileme DENENMEZ', async () => {
    mount({ message: imageMessage() });
    await flush();

    await fireEvent.error(document.querySelector('.msg-attachment img')!);
    await flush();

    expect(mediaAuth.renewMediaCredential).not.toHaveBeenCalled();
    expect(document.querySelector('.msg-attachment-error')).not.toBeNull();
  });

  it('KORUMALI medyada 401 sonrası TEK yenileme denenir', async () => {
    mediaAuth.isProtectedMediaUrl.mockReturnValue(true);
    mediaAuth.getMediaCredentialGeneration.mockReturnValueOnce(1).mockReturnValue(2);
    mount({ message: imageMessage() });
    await flush();

    await fireEvent.error(document.querySelector('.msg-attachment img')!);
    await flush();

    expect(mediaAuth.renewMediaCredential).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLImageElement>('.msg-attachment img')!.getAttribute('src'))
      .toBe('/uploads/files/a.png?g=2');

    await fireEvent.error(document.querySelector('.msg-attachment img')!);
    await flush();

    expect(mediaAuth.renewMediaCredential).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.msg-attachment-error')).not.toBeNull();
  });

  it('yenileme BAŞARISIZ olursa açık hata gösterilir', async () => {
    mediaAuth.isProtectedMediaUrl.mockReturnValue(true);
    mediaAuth.renewMediaCredential.mockResolvedValue(false);
    mount({ message: imageMessage() });
    await flush();

    await fireEvent.error(document.querySelector('.msg-attachment img')!);
    await flush();

    expect(document.querySelector('.msg-attachment-error')).not.toBeNull();
  });

  it('YENİDEN DENE düğmesi yalnız korumalı medyada çıkar ve sayacı sıfırlar', async () => {
    mediaAuth.isProtectedMediaUrl.mockReturnValue(true);
    mediaAuth.renewMediaCredential.mockResolvedValue(false);
    mount({ message: imageMessage() });
    await flush();
    await fireEvent.error(document.querySelector('.msg-attachment img')!);
    await flush();

    const before = mediaAuth.renewMediaCredential.mock.calls.length;
    mediaAuth.renewMediaCredential.mockResolvedValue(true);
    document.querySelector<HTMLButtonElement>('.msg-attachment-error button')!.click();
    await flush();

    // Yeniden deneme, TÜKENMİŞ deneme sayacını sıfırlar: yeni bir yenileme
    // gerçekten başlatılır ve başarılı olursa hata durumu kalkar.
    expect(mediaAuth.renewMediaCredential.mock.calls.length).toBeGreaterThan(before);
    expect(document.querySelector('.msg-attachment-error')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MessageRenderer — sabitleme ve duyuru yayınlama', () => {
  it('yetki olmadan sabitleme düğmesi ÇİZİLMEZ', async () => {
    mount({ onPin: vi.fn(), canPin: false });
    await flush();

    expect(document.querySelector('[aria-pressed]')).toBeNull();
  });

  it.each([
    ['bekleyen', { pending: true }],
    ['kuyrukta', { queued: true }],
    ['başarısız', { failed: true }],
  ])('TESLİM EDİLMEMİŞ (%s) satırda sabitleme çizilmez', async (_label, state) => {
    mount({ message: message(state), onPin: vi.fn(), canPin: true });
    await flush();

    expect(document.querySelector('[aria-pressed]')).toBeNull();
  });

  it('yetkili kullanıcı sabitleyip kaldırabilir', async () => {
    const onPin = vi.fn();
    const view = mount({ onPin, canPin: true });
    await flush();

    const button = document.querySelector<HTMLButtonElement>('[aria-pressed]')!;
    expect(button.getAttribute('aria-label')).toBe(t('pin'));
    button.click();
    expect(onPin).toHaveBeenCalledWith(expect.objectContaining({ _id: 'm-1' }));

    await view.rerender({ message: message({ pinned: true }), currentUserId: 'ben', onPin, canPin: true });
    await flush();

    expect(document.querySelector('[aria-pressed]')!.getAttribute('aria-label')).toBe(t('unpin'));
    expect(document.querySelector('[aria-pressed]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('duyuru yayınlama yalnız yetki VE sahip varken çizilir', async () => {
    mount({ canCrosspost: true });
    await flush();
    const labelOf = () => [...document.querySelectorAll('.msg-actions button')]
      .map(n => n.getAttribute('aria-label'));
    expect(labelOf()).not.toContain(t('announcement_publish_followers'));

    cleanup();
    mount({ canCrosspost: true, onCrosspost: vi.fn() });
    await flush();
    expect(labelOf()).toContain(t('announcement_publish_followers'));
  });

  it('yayın SÜRERKEN düğme devre dışıdır', async () => {
    mount({ canCrosspost: true, onCrosspost: vi.fn(), crosspostBusy: true });
    await flush();

    const button = [...document.querySelectorAll<HTMLButtonElement>('.msg-actions button')]
      .find(node => node.getAttribute('aria-label') === t('announcement_publish_followers'))!;
    expect(button.disabled).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MessageRenderer — yazar sunumu', () => {
  it('adı olmayan yazar için kullanıcı adına, o da yoksa sabit ada düşülür', async () => {
    mount({ message: message({ displayName: undefined, username: 'ada' }) });
    await flush();
    expect(document.querySelector('.msg-author')?.textContent).toBe('ada');

    cleanup();
    mount({ message: message({ displayName: undefined, username: undefined }) });
    await flush();
    expect(document.querySelector('.msg-author')?.textContent).toBe(t('unknown_user'));
  });

  it('baş harfler ilk İKİ kelimeden üretilir', async () => {
    mount({ message: message({ displayName: '  ada   lovelace  king ', avatarUrl: null }) });
    await flush();

    expect(document.querySelector('.msg-avatar')?.textContent?.trim()).toBe('AL');
  });

  it('GÜVENLİ olmayan avatar rengi kullanılmaz', async () => {
    mount({ message: message({ avatarColor: 'red;background:url(x)', avatarUrl: null }) });
    await flush();

    const style = document.querySelector('.msg-avatar')?.getAttribute('style') ?? '';
    expect(style).not.toContain('url(');
  });

  it('avatar GÖRSELİ varsa baş harf yerine görsel çizilir', async () => {
    mount({ message: message({ avatarUrl: 'https://cdn.test/a.png' }) });
    await flush();

    expect(document.querySelector('.msg-avatar img')).not.toBeNull();
  });

  it('GÜVENSİZ avatar adresi görsel olarak kullanılmaz', async () => {
    mount({ message: message({ avatarUrl: 'javascript:alert(1)' }) });
    await flush();

    expect(document.querySelector('.msg-avatar img')).toBeNull();
  });
});
