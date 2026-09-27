// client/tests/message-input-schedule-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// MessageInputPanel — ZAMANLANMIŞ GÖNDERİM YÜZEYİ
// ════════════════════════════════════════════════════════════════════════════
//
// Zamanlanmış mesaj, kullanıcının metnini SUNUCUYA emanet ettiği bir yazma
// yoludur ve hiç ölçülmemişti. Riskler:
//
//   · KAPSAM YALANI — ek/yanıt/düzenleme ile zamanlama DESTEKLENMİYOR. Sessizce
//     yalnız metni göndermek, kullanıcının eklediği dosyayı kaybettirirdi.
//   · ZAMAN SINIRI — geçmişe ya da 30 günden öteye zamanlama sunucuda da
//     reddedilir; istemci bunu ÖNCEDEN ve açıkça söyler.
//   · YARIŞ — kanal değişince önceki listeleme yanıtı YENİ kanalın listesini
//     ezmemelidir (`scheduledLoadGeneration`).
//   · SIZINTI — liste GLOBAL uçtan gelir; yalnız AÇIK kanala ait satırlar
//     gösterilir.
//   · İPTAL — 404 zaten iptal edilmiş demektir ve satır listeden düşer;
//     409/400 farklı ve okunur nedenlerle anlatılır.

import { cleanup } from '@testing-library/svelte';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MessageInputPanel from '../js/core/MessageInputPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { resetOutboxMemory } from '../js/core/outbox-store.ts';
import { t } from '../js/core/i18n/index.ts';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const keys = [
  'apiFetch', 'socket', 'getSocketConnected', 'getCurrentChannel', 'getCurrentServer', 'getMe',
  'appendMessage', 'updateMessage', 'setDraft', 'getDraft', 'flushDraft', 'clearDraft',
  'setDraftAttachmentPending', 'getDraftAttachmentPending', 'toast', 'setReplyTarget',
  'startEditMessage',
];

let shell: HTMLDivElement;
let target: HTMLDivElement;
let instance: ReturnType<typeof mount> | null;
let channel: { _id?: string; serverId?: string; name?: string; type?: string } | null;
let currentServer: { _id?: string } | null;
let apiFetch: ReturnType<typeof vi.fn>;
let toast: ReturnType<typeof vi.fn>;
let draft: string;
let attachmentPending: boolean;

const input = () => shell.querySelector<HTMLTextAreaElement>('#msg-input')!;
const scheduleButton = () => shell.querySelector<HTMLButtonElement>('#btn-schedule-message')!;
const panel = () => target.querySelector<HTMLElement>('.composer-schedule');
const whenInput = () => target.querySelector<HTMLInputElement>('.schedule-input')!;
const confirmButton = () => target.querySelector<HTMLButtonElement>('.schedule-confirm')!;
const closeButton = () => [...target.querySelectorAll<HTMLButtonElement>('.composer-schedule > button')].at(-1)!;
const manageToggle = () => target.querySelector<HTMLButtonElement>('.schedule-manage-toggle')!;
const manager = () => target.querySelector<HTMLElement>('.schedule-manager');
const managerError = () => target.querySelector<HTMLElement>('.schedule-manager-error')?.textContent ?? '';
const managerState = () => target.querySelector<HTMLElement>('.schedule-manager-state')?.textContent ?? '';
const scheduleErrorText = () => target.querySelector<HTMLElement>('.composer-schedule .attach-error')?.textContent ?? '';
const rows = () => [...target.querySelectorAll<HTMLElement>('.schedule-list li')];

function type(value: string): void {
  input().value = value;
  input().dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function openSchedule(): void {
  scheduleButton().click();
  flushSync();
}

function setWhen(offsetMs: number): void {
  const at = new Date(Date.now() + offsetMs);
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  whenInput().value = local;
  whenInput().dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) { await tick(); await Promise.resolve(); }
  flushSync();
}

const scheduledRow = (over: Record<string, unknown> = {}) => ({
  _id: 'sch-1', channelId: 'channel-a', content: 'yarın gönderilecek',
  sendAt: Date.now() + 3_600_000, ...over,
});

beforeEach(() => {
  localStorage.clear();
  resetOutboxMemory();
  channel = { _id: 'channel-a', serverId: 'server-a', name: 'genel', type: 'text' };
  currentServer = { _id: 'server-a' };
  draft = '';
  attachmentPending = false;

  shell = document.createElement('div');
  shell.innerHTML = `
    <div id="msg-input-wrap">
      <input id="msg-file-input" type="file" hidden>
      <button id="btn-attach" type="button">attach</button>
      <button id="btn-schedule-message" type="button">schedule</button>
      <textarea id="msg-input"></textarea>
      <button type="button" data-bridge-action="sendMessage">send</button>
    </div>`;
  target = document.createElement('div');
  document.body.append(shell, target);

  apiFetch = vi.fn(async () => response([]));
  toast = vi.fn();
  BridgeRegistry.register('apiFetch', ((...args: unknown[]) => apiFetch(...args)) as AnyFn);
  BridgeRegistry.register('toast', toast as AnyFn);
  BridgeRegistry.register('getSocketConnected', () => true);
  BridgeRegistry.register('getCurrentChannel', () => channel);
  BridgeRegistry.register('getCurrentServer', () => currentServer);
  BridgeRegistry.register('getMe', () => ({ _id: 'user-a', username: 'ada', displayName: 'Ada' }));
  BridgeRegistry.register('appendMessage', vi.fn());
  BridgeRegistry.register('updateMessage', vi.fn());
  BridgeRegistry.register('setDraft', (value: string) => { draft = value; });
  BridgeRegistry.register('getDraft', () => draft);
  BridgeRegistry.register('flushDraft', vi.fn());
  BridgeRegistry.register('clearDraft', vi.fn(() => { draft = ''; }));
  BridgeRegistry.register('setDraftAttachmentPending', (value: boolean) => { attachmentPending = value; });
  BridgeRegistry.register('getDraftAttachmentPending', () => attachmentPending);
  BridgeRegistry.register('socket', { emit: vi.fn() } as unknown as AnyFn);

  instance = mount(MessageInputPanel, { target });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  cleanup();
  shell.remove();
  target.remove();
  for (const key of keys) BridgeRegistry.unregister(key);
  localStorage.clear();
  resetOutboxMemory();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe('MessageInputPanel — zamanlama penceresi', () => {
  it('panel varsayılan bir zamanla açılır ve kapatılabilir', () => {
    expect(panel()).toBeNull();

    openSchedule();
    expect(panel()).not.toBeNull();
    expect(whenInput().value).not.toBe('');

    closeButton().click();
    flushSync();
    expect(panel()).toBeNull();
  });

  it.each([
    ['boş metin', '   ', () => t('ui_zamanlamak_icin_once_bir_mesaj_yaz')],
  ])('%s zamanlanamaz', async (_label, value, expected) => {
    type(value);
    openSchedule();
    setWhen(3_600_000);
    apiFetch.mockClear();

    confirmButton().click();
    await settle();

    expect(scheduleErrorText()).toBe(expected());
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('YANIT hedefi varken zamanlama desteklenmez', async () => {
    type('yanıt metni');
    BridgeRegistry.call('setReplyTarget', { _id: 'm-1', content: 'orijinal' });
    flushSync();
    openSchedule();
    setWhen(3_600_000);
    apiFetch.mockClear();

    confirmButton().click();
    await settle();

    expect(scheduleErrorText()).toBe(t('ui_zamanlanmis_gonderim_su_anda_yalnizca_yeni_metin_mes'));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('DÜZENLEME sürerken zamanlama desteklenmez', async () => {
    BridgeRegistry.call('startEditMessage', { _id: 'm-1', content: 'eski metin' });
    flushSync();
    openSchedule();
    setWhen(3_600_000);
    apiFetch.mockClear();

    confirmButton().click();
    await settle();

    expect(scheduleErrorText()).toBe(t('ui_zamanlanmis_gonderim_su_anda_yalnizca_yeni_metin_mes'));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('kanal bağlamı yoksa zamanlanamaz', async () => {
    type('metin');
    openSchedule();
    setWhen(3_600_000);
    channel = null;
    currentServer = null;
    apiFetch.mockClear();

    confirmButton().click();
    await settle();

    expect(scheduleErrorText()).toBe(t('ui_kanal_su_anda_hazir_degil'));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('kanalda sunucu kimliği yoksa KAYITLI sunucudan tamamlanır', async () => {
    channel = { _id: 'channel-a', name: 'genel', type: 'text' };
    type('metin');
    openSchedule();
    setWhen(3_600_000);
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(response({ ok: true }, 201));

    confirmButton().click();
    await settle();

    const post = apiFetch.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse(String((post[1] as RequestInit).body)).serverId).toBe('server-a');
  });

  it.each([
    ['GEÇMİŞ zaman', -60_000, () => t('ui_gonderim_zamani_en_az_30_saniye_ileride_olmali')],
    ['30 saniyeden yakın', 10_000, () => t('ui_gonderim_zamani_en_az_30_saniye_ileride_olmali')],
    ['30 günden öte', 31 * 24 * 60 * 60_000, () => t('ui_mesajlar_en_fazla_30_gun_ileri_zamanlanabilir')],
  ])('%s reddedilir', async (_label, offset, expected) => {
    type('metin');
    openSchedule();
    setWhen(offset);
    apiFetch.mockClear();

    confirmButton().click();
    await settle();

    expect(scheduleErrorText()).toBe(expected());
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('ÇÖZÜLEMEYEN zaman değeri reddedilir', async () => {
    type('metin');
    openSchedule();
    whenInput().value = '';
    whenInput().dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    apiFetch.mockClear();

    confirmButton().click();
    await settle();

    expect(scheduleErrorText()).toBe(t('ui_gonderim_zamani_en_az_30_saniye_ileride_olmali'));
  });

  it('API sahibi yoksa açık bir neden gösterilir', async () => {
    type('metin');
    openSchedule();
    setWhen(3_600_000);
    BridgeRegistry.unregister('apiFetch');

    confirmButton().click();
    await settle();

    expect(scheduleErrorText()).toBe(t('ui_zamanlama_servisi_su_anda_hazir_degil'));
  });

  it('geçerli zamanlama ISO damgasıyla gönderilir, taslak TEMİZLENİR', async () => {
    type('yarın konuşuruz');
    openSchedule();
    setWhen(3_600_000);
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(response({ ok: true }, 201));

    confirmButton().click();
    await settle();

    const post = apiFetch.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(post[0]).toBe('/api/scheduled');
    const body = JSON.parse(String((post[1] as RequestInit).body)) as Record<string, string>;
    expect(body.channelId).toBe('channel-a');
    expect(body.content).toBe('yarın konuşuruz');
    expect(new Date(body.sendAt!).toISOString()).toBe(body.sendAt);
    expect(input().value).toBe('');
    expect(panel()).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('zamanlandı'), 'success');
  });

  it.each([
    [403, () => t('ui_bu_kanalda_mesaj_zamanlama_yetkin_yok')],
    [429, () => t('ui_cok_sik_zamanlama_yapiliyor_biraz_sonra_tekrar_dene')],
    [500, () => t('ui_mesaj_zamanlanamadi')],
  ])('sunucu %i durumunda metin KORUNUR', async (status, expected) => {
    type('korunacak metin');
    openSchedule();
    setWhen(3_600_000);
    apiFetch.mockResolvedValue(response({ error: 'GIZLI' }, status));

    confirmButton().click();
    await settle();

    expect(scheduleErrorText()).toBe(expected());
    expect(scheduleErrorText()).not.toContain('GIZLI');
    expect(input().value).toBe('korunacak metin');
    expect(panel()).not.toBeNull();
  });

  it('taşıma hatası da metni korur', async () => {
    type('korunacak metin');
    openSchedule();
    setWhen(3_600_000);
    apiFetch.mockRejectedValue(new Error('offline'));

    confirmButton().click();
    await settle();

    expect(scheduleErrorText()).toBe(t('ui_mesaj_zamanlanamadi_baglantini_kontrol_et'));
    expect(input().value).toBe('korunacak metin');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MessageInputPanel — bekleyen zamanlanmış mesajlar', () => {
  const openManager = async () => {
    openSchedule();
    manageToggle().click();
    await settle();
  };

  it('yönetici açılınca liste yüklenir ve YALNIZ bu kanalın satırları gösterilir', async () => {
    apiFetch.mockResolvedValue(response([
      scheduledRow({ _id: 'sch-1', sendAt: Date.now() + 7_200_000, content: 'ikinci' }),
      scheduledRow({ _id: 'sch-2', sendAt: Date.now() + 3_600_000, content: 'birinci' }),
      scheduledRow({ _id: 'sch-3', channelId: 'baska-kanal', content: 'başka kanal' }),
    ]));

    await openManager();

    expect(apiFetch).toHaveBeenCalledWith('/api/scheduled');
    const contents = rows().map(row => row.querySelector('p')?.textContent);
    expect(contents).toEqual(['birinci', 'ikinci']);
  });

  it('BOZUK satırlar render EDİLMEZ', async () => {
    apiFetch.mockResolvedValue(response([
      null, 'metin', [], {},
      scheduledRow({ _id: '' }),
      scheduledRow({ content: '' }),
      scheduledRow({ sendAt: 'yarın' }),
      scheduledRow({ _id: 'sch-ok' }),
    ]));

    await openManager();

    expect(rows()).toHaveLength(1);
  });

  it('dizi olmayan gövde BOŞ listeye indirgenir', async () => {
    apiFetch.mockResolvedValue(response({ items: [scheduledRow()] }));

    await openManager();

    expect(rows()).toHaveLength(0);
    expect(managerState()).toBe(t('schedule_empty'));
  });

  it('yükleme reddedilirse neden gösterilir', async () => {
    apiFetch.mockResolvedValue(response({ error: 'x' }, 500));

    await openManager();

    expect(managerError()).toBe(t('ui_bekleyen_mesajlar_yuklenemedi'));
  });

  it('taşıma hatası da bildirilir', async () => {
    apiFetch.mockRejectedValue(new Error('offline'));

    await openManager();

    expect(managerError()).toBe(t('ui_bekleyen_mesajlar_yuklenemedi'));
  });

  it('kanal bağlamı yoksa liste istenmez', async () => {
    channel = null;
    openSchedule();
    apiFetch.mockClear();

    manageToggle().click();
    await settle();

    expect(apiFetch).not.toHaveBeenCalled();
    expect(managerError()).toBe(t('ui_bekleyen_mesajlar_su_anda_yuklenemiyor'));
  });

  it('YENİLE düğmesi listeyi tekrar ister', async () => {
    apiFetch.mockResolvedValue(response([scheduledRow()]));
    await openManager();
    apiFetch.mockClear();

    target.querySelector<HTMLButtonElement>('.schedule-manager-head button')!.click();
    await settle();

    expect(apiFetch).toHaveBeenCalledWith('/api/scheduled');
  });

  it('yönetici KAPATILIP açılabilir', async () => {
    await openManager();
    expect(manager()).not.toBeNull();

    manageToggle().click();
    await settle();
    expect(manager()).toBeNull();
  });

  it('panel kapanınca GECİKEN yanıt listeye yazılmaz', async () => {
    let release: (value: Response) => void = () => {};
    apiFetch.mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));

    openSchedule();
    manageToggle().click();
    await settle();

    closeButton().click();
    flushSync();

    release(response([scheduledRow()]));
    await settle();

    expect(panel()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MessageInputPanel — zamanlanmış mesaj iptali', () => {
  const openWithRow = async () => {
    apiFetch.mockResolvedValue(response([scheduledRow()]));
    openSchedule();
    manageToggle().click();
    await settle();
    apiFetch.mockClear();
  };

  const cancelButton = () => target.querySelector<HTMLButtonElement>('.schedule-cancel')!;

  it('iptal isteği DELETE ile gider ve satır düşer', async () => {
    await openWithRow();
    apiFetch.mockResolvedValue(response({ ok: true }));

    cancelButton().click();
    await settle();

    expect(apiFetch).toHaveBeenCalledWith('/api/scheduled/sch-1', { method: 'DELETE' });
    expect(rows()).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith(t('ui_zamanlanmis_mesaj_iptal_edildi'), 'success');
  });

  it('404 zaten iptal edilmiş sayılır: satır düşer, BAŞARI bildirimi verilmez', async () => {
    await openWithRow();
    apiFetch.mockResolvedValue(response({ error: 'yok' }, 404));

    cancelButton().click();
    await settle();

    expect(rows()).toHaveLength(0);
    expect(toast).not.toHaveBeenCalled();
  });

  it.each([
    [409, () => t('ui_mesaj_gonderilmek_uzere_iptal_artik_uygulanamadi')],
    [400, () => t('ui_mesaj_zaten_gonderilmis_listeyi_yenileyebilirsin')],
    [500, () => t('ui_zamanlanmis_mesaj_iptal_edilemedi')],
  ])('%i durumunda satır KORUNUR ve neden gösterilir', async (status, expected) => {
    await openWithRow();
    apiFetch.mockResolvedValue(response({ error: 'x' }, status));

    cancelButton().click();
    await settle();

    expect(rows()).toHaveLength(1);
    expect(managerError()).toBe(expected());
  });

  it('taşıma hatası bağlantı uyarısıyla anlatılır', async () => {
    await openWithRow();
    apiFetch.mockRejectedValue(new Error('offline'));

    cancelButton().click();
    await settle();

    expect(managerError()).toBe(t('ui_zamanlanmis_mesaj_iptal_edilemedi_baglantini_kontrol'));
    expect(rows()).toHaveLength(1);
  });

  it('bir iptal SÜRERKEN ikincisi başlatılamaz', async () => {
    await openWithRow();
    let release: (value: Response) => void = () => {};
    apiFetch.mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));

    cancelButton().click();
    await settle();
    expect(apiFetch).toHaveBeenCalledTimes(1);

    cancelButton().click();
    await settle();
    expect(apiFetch).toHaveBeenCalledTimes(1);

    release(response({ ok: true }));
    await settle();
  });

  it('API sahibi yoksa iptal denenmez', async () => {
    await openWithRow();
    BridgeRegistry.unregister('apiFetch');

    cancelButton().click();
    await settle();

    expect(rows()).toHaveLength(1);
  });
});
