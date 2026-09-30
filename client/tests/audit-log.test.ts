import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';

const { mockApiFetch, mockToast, currentServer } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockToast: vi.fn(),
  currentServer: { value: { _id: 'srv-1', name: 'Test' } as { _id: string; name?: string } | null },
}));

vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: mockApiFetch }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://localhost:3001' }));
vi.mock('../js/core/utils.js', () => ({ toast: mockToast, escHtml: (value: unknown) => String(value ?? '') }));
vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    get: (key: string) => key === 'getCurrentServer' ? () => currentServer.value : null,
    call: (key: string) => key === 'getCurrentServer' ? currentServer.value : undefined,
    // Completed against the canonical BridgeRegistry surface (register /
    // unregister / call / get / has); a missing member throws before any
    // assertion runs.
    register: () => {},
    unregister: () => {},
    has: (key: string) => key === 'getCurrentServer',
  },
}));

import AuditLogTab from '../js/core/server-settings/tabs/AuditLogTab.svelte';

interface Entry {
  _id?: string;
  createdAt: number;
  action?: string;
  actorName?: string;
  targetName?: string;
  channelName?: string;
  detail?: string;
  old?: { allow: number; deny: number } | null;
  new?: { allow: number; deny: number } | null;
  undo?: { supported: boolean; canUndo: boolean; reason?: string };
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    _id: 'audit-1', createdAt: 1_754_000_000_000, action: 'ban',
    actorName: 'Ada', targetName: 'Bob', undo: { supported: false, canUndo: false },
    ...overrides,
  };
}

function entriesResponse(entries: Entry[], total = entries.length, status = 200): Response {
  return new Response(JSON.stringify({ entries, total }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

const preview = () => document.querySelector('.al-preview') as HTMLElement;
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find(candidate => candidate.textContent?.trim().includes(name)) as HTMLButtonElement;

beforeEach(() => {
  currentServer.value = { _id: 'srv-1', name: 'Test' };
  mockApiFetch.mockReset();
  mockToast.mockReset();
  mockApiFetch.mockResolvedValue(entriesResponse([]));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:audit') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Audit Log admin UX', () => {
  it('sekme açılınca kanonik sunucu kapsamını otomatik yükler ve toplamı gösterir', async () => {
    mockApiFetch.mockResolvedValue(entriesResponse([entry()], 7));
    render(AuditLogTab);

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce());
    const url = new URL(String(mockApiFetch.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/servers/srv-1/audit-log');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('ui')).toBe('1');
    await waitFor(() => expect(preview().textContent).toContain('Üye yasaklandı'));
    expect(document.querySelector('.al-list-head')?.textContent).toContain('7 kayıt');
    expect(preview().textContent).toContain('Ada');
    expect(preview().textContent).toContain('Bob');
  });

  it('geriye dönük düz dizi yanıtını da kabul eder', async () => {
    mockApiFetch.mockResolvedValue(new Response(JSON.stringify([entry()]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    render(AuditLogTab);
    await waitFor(() => expect(document.querySelectorAll('.al-entry')).toHaveLength(1));
  });

  it('yükleniyor, boş ve ağ hatası durumlarını birbirinden ayırır', async () => {
    let release: ((value: Response) => void) | undefined;
    mockApiFetch.mockReturnValue(new Promise<Response>(resolve => { release = resolve; }));
    render(AuditLogTab);
    await waitFor(() => expect(preview().textContent).toContain('yükleniyor'));

    release?.(entriesResponse([]));
    await waitFor(() => expect(preview().textContent).toContain('eşleşen denetim kaydı yok'));
    cleanup();

    // Istisnanin ham `message`'i kullaniciya gosterilmez; siniflandirilamayan
    // bir hata icin cagiranin kanonik yedek metni yazilir.
    mockApiFetch.mockRejectedValue(new Error('Ağ kesildi'));
    render(AuditLogTab);
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain(t('ui_denetim_gunlugu_yuklenemedi')));
    expect(preview().textContent).not.toContain('eşleşen denetim kaydı yok');
  });

  it('HTTP yetki hatasını sessiz boş listeye dönüştürmez', async () => {
    mockApiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'No permission' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    }));
    render(AuditLogTab);

    // Sunucu govdesi SIZMAZ: 403 kanonik yetki metnine eslenir.
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain(t('error_forbidden')));
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('No permission');
  });

  it('tarih ve işlem filtrelerini aynı kanonik uca yollar', async () => {
    render(AuditLogTab);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce());
    await fireEvent.input(document.getElementById('al-after')!, { target: { value: '2026-01-01' } });
    await fireEvent.input(document.getElementById('al-before')!, { target: { value: '2026-01-31' } });
    await fireEvent.change(document.getElementById('al-action')!, { target: { value: 'PERM_UPDATE' } });
    await fireEvent.click(button('Filtrele'));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    const url = new URL(String(mockApiFetch.mock.calls[1][0]));
    expect(url.searchParams.get('after')).toBe('2026-01-01');
    expect(url.searchParams.get('before')).toBe('2026-01-31');
    expect(url.searchParams.get('action')).toBe('PERM_UPDATE');
  });

  it('izin bitmaskelerini adlandırılmış önce/sonra değişikliklerine dönüştürür', async () => {
    mockApiFetch.mockResolvedValue(entriesResponse([entry({
      action: 'PERM_UPDATE', channelName: 'staff', targetName: 'Moderator',
      old: { allow: 1 << 0, deny: 0 }, new: { allow: 0, deny: (1 << 0) | (1 << 8) },
      undo: { supported: true, canUndo: false, reason: 'Daha yeni değişiklik var.' },
    })]));
    render(AuditLogTab);

    await waitFor(() => expect(preview().textContent).toContain('#staff'));
    expect(preview().textContent).toContain('VIEW_CHANNELS');
    expect(preview().textContent).toContain('İzin ver → Reddet');
    await fireEvent.click(button('Ayrıntıları gör'));
    expect(preview().textContent).toContain('SEND_MESSAGES');
    expect(preview().textContent).toContain('Daha yeni değişiklik var.');
  });

  it('Geri al yalnız sunucunun güvenli bulduğu kayıtta görünür ve iki aşamalı onay kullanır', async () => {
    const reversible = entry({
      action: 'PERM_UPDATE', channelName: 'staff', old: { allow: 1, deny: 0 },
      new: { allow: 0, deny: 1 }, undo: { supported: true, canUndo: true },
    });
    mockApiFetch
      .mockResolvedValueOnce(entriesResponse([reversible]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(entriesResponse([]));
    render(AuditLogTab);
    await waitFor(() => expect(button('Geri al')).toBeTruthy());

    await fireEvent.click(button('Geri al'));
    expect(button('Geri almayı onayla')).toBeTruthy();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    await fireEvent.click(button('Geri almayı onayla'));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(3));
    expect(String(mockApiFetch.mock.calls[1][0])).toContain('/audit-log/audit-1/undo');
    expect(mockApiFetch.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(mockToast).toHaveBeenCalledWith('İzin değişikliği güvenle geri alındı.', 'success');
  });

  it('desteklenmeyen moderasyon işlemlerinde sahte Geri al kontrolü üretmez', async () => {
    mockApiFetch.mockResolvedValue(entriesResponse([entry({ action: 'kick' })]));
    render(AuditLogTab);
    await waitFor(() => expect(preview().textContent).toContain('Üye sunucudan çıkarıldı'));
    expect(button('Geri al')).toBeUndefined();
  });

  it('sunucu işlem sırasında çakışma bildirirse nedeni kayda bağlar', async () => {
    mockApiFetch
      .mockResolvedValueOnce(entriesResponse([entry({
        action: 'PERM_DELETE', old: { allow: 1, deny: 0 }, new: null,
        undo: { supported: true, canUndo: true },
      })]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Bu hedefte daha yeni bir yönetici değişikliği var.' }), {
        status: 409, headers: { 'Content-Type': 'application/json' },
      }));
    render(AuditLogTab);
    await waitFor(() => expect(button('Geri al')).toBeTruthy());
    await fireEvent.click(button('Geri al'));
    await fireEvent.click(button('Geri almayı onayla'));

    // 409 kanonik cakisma metnine eslenir; sunucunun acikla-mesaji gosterilmez.
    await waitFor(() => expect(preview().textContent).toContain(t('error_conflict')));
    expect(button('Geri al')).toBeUndefined();
  });

  it('kullanıcı kontrollü actor/target/detail alanlarını HTML olarak enjekte etmez', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    mockApiFetch.mockResolvedValue(entriesResponse([entry({ actorName: payload, targetName: payload, detail: payload })]));
    render(AuditLogTab);
    await waitFor(() => expect(preview().textContent).toContain(payload));
    expect(preview().querySelector('img')).toBeNull();
    expect(preview().querySelector('[onerror]')).toBeNull();
  });

  it('CSV/JSON dışa aktarmayı olmayan /export rotası yerine yetkili apiFetch ile yapar', async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.href);
    });
    mockApiFetch
      .mockResolvedValueOnce(entriesResponse([]))
      .mockResolvedValueOnce(new Response('timestamp,actor', { status: 200, headers: { 'Content-Type': 'text/csv' } }));
    render(AuditLogTab);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce());
    await fireEvent.click(button('CSV indir'));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    const url = new URL(String(mockApiFetch.mock.calls[1][0]));
    expect(url.pathname).toBe('/api/servers/srv-1/audit-log');
    expect(url.pathname).not.toContain('/export');
    expect(url.searchParams.get('format')).toBe('csv');
    expect(url.searchParams.get('limit')).toBe('500');
    // The download follows `await response.blob()`, one async step after the
    // second fetch call: wait for it instead of racing it (failed under Node 22).
    await waitFor(() => expect(clicked).toEqual(['blob:audit']));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audit');
  });

  it('logs yanıtını, eksik toplamı ve seyrek kayıt alanlarını güvenli fallbacks ile gösterir', async () => {
    const permissionBits = (1 << 0) | (1 << 1) | (1 << 8);
    mockApiFetch.mockResolvedValue(new Response(JSON.stringify({
      logs: [
        entry({
          _id: undefined, createdAt: 'invalid-date' as unknown as number, action: undefined, actorName: '', targetName: '',
          detail: 'Ayrıntılı not', undo: { supported: false, canUndo: false },
        }),
        entry({
          _id: 'perm-many', action: 'PERM_UPDATE', old: { allow: 0, deny: permissionBits },
          new: { allow: (1 << 0), deny: 0 }, undo: { supported: true, canUndo: false, reason: 'Sabitlendi' },
        }),
        entry({ _id: 'custom', action: 'CUSTOM_EVENT' }),
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(AuditLogTab);

    await waitFor(() => expect(document.querySelectorAll('.al-entry')).toHaveLength(3));
    expect(document.querySelector('.al-list-head')?.textContent).toContain('3 kayıt');
    expect(preview().textContent).toContain('Yönetici işlemi');
    expect(preview().textContent).toContain('Bilinmeyen yönetici');
    expect(preview().textContent).toContain('Sunucu');
    expect(preview().textContent).toContain('Tarih bilinmiyor');
    expect(preview().textContent).toContain('custom event');
    expect(preview().textContent).toContain('+1 değişiklik');

    const detailButtons = [...document.querySelectorAll<HTMLButtonElement>('.al-link')];
    await fireEvent.click(detailButtons[0]);
    expect(preview().textContent).toContain('Ayrıntılı not');
    await fireEvent.click(detailButtons[0]);
    expect(preview().textContent).not.toContain('Not: Ayrıntılı not');
    await fireEvent.click(detailButtons[1]);
    expect(preview().textContent).toContain('Reddet');
    expect(preview().textContent).toContain('Devral');
    expect(preview().textContent).toContain('Sabitlendi');
  });

  it('yanıt gövdesi veya taşıma hatası ayrıntı vermediğinde sabit hata metnine düşer', async () => {
    mockApiFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    }));
    render(AuditLogTab);
    // 500 durum koduyla siniflandirilir: kanonik sunucu hatasi metni.
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain(t('error_server')));

    mockApiFetch.mockResolvedValueOnce(new Response('not-json', { status: 502 }));
    await fireEvent.click(button(t('retry')));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    // 502 de kanonik sunucu hatasi metnine eslenir.
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('error_server'));

    mockApiFetch.mockRejectedValueOnce('offline');
    await fireEvent.click(button(t('retry')));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(3));
    // Response OLMAYAN red siniflandirilamaz: cagiranin yedek metni.
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain(t('ui_denetim_gunlugu_yuklenemedi'));
  });

  it('dizi alanı içermeyen başarılı nesne yanıtını güvenli boş listeye indirger', async () => {
    mockApiFetch.mockResolvedValue(new Response('{}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    render(AuditLogTab);
    await waitFor(() => expect(preview().textContent).toContain('eşleşen denetim kaydı yok'));
    expect(document.querySelector('.al-list-head')?.textContent).toContain('0 kayıt');
  });

  it('yükleme ve dışa aktarma sırasında ikinci işlemi tek-uçuş korumasıyla yoksayar', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    let releaseLoad!: (value: Response) => void;
    mockApiFetch.mockReturnValueOnce(new Promise<Response>(resolve => { releaseLoad = resolve; }));
    render(AuditLogTab);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce());
    document.querySelector<HTMLButtonElement>('.al-refresh')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(mockApiFetch).toHaveBeenCalledOnce();
    releaseLoad(entriesResponse([]));
    await waitFor(() => expect(preview().textContent).toContain('eşleşen'));

    let releaseExport!: (value: Response) => void;
    mockApiFetch.mockReturnValueOnce(new Promise<Response>(resolve => { releaseExport = resolve; }));
    await fireEvent.click(button('JSON indir'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    button('CSV indir').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    releaseExport(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    // Final21 Faz 19: metin artık çevrilir (önceden her dilde sabit Türkçe'ydi).
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(t('audit_log_downloaded', undefined, { format: 'JSON' }), 'success'));
  });

  it('geri alma iptalini, başka ayrıntıya geçişi ve non-Error geri alma başarısızlığını kapsar', async () => {
    let rejectUndo!: (reason?: unknown) => void;
    mockApiFetch
      .mockResolvedValueOnce(entriesResponse([
        entry({ _id: 'undo-1', action: 'PERM_UPDATE', old: { allow: 1, deny: 0 }, new: { allow: 0, deny: 1 }, undo: { supported: true, canUndo: true } }),
        entry({ _id: 'other', action: 'kick', detail: 'other row' }),
      ]))
      .mockReturnValueOnce(new Promise<Response>((_resolve, reject) => { rejectUndo = reject; }));
    render(AuditLogTab);
    await waitFor(() => expect(button('Geri al')).toBeTruthy());

    await fireEvent.click(button('Geri al'));
    expect(button('Vazgeç')).toBeTruthy();
    await fireEvent.click(button('Vazgeç'));
    expect(button('Vazgeç')).toBeUndefined();

    await fireEvent.click(button('Geri al'));
    const details = [...document.querySelectorAll<HTMLButtonElement>('.al-link')];
    await fireEvent.click(details[1]);
    expect(button('Vazgeç')).toBeUndefined();

    await fireEvent.click(button('Geri al'));
    const confirm = button('Geri almayı onayla');
    await fireEvent.click(confirm);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    rejectUndo('offline');
    await waitFor(() => expect(preview().textContent).toContain('Değişiklik güvenle geri alınamadı'));
  });

  it('sunucu kapsamı yokken yükleme ve export ağ çağrısı üretmez', async () => {
    currentServer.value = null;
    render(AuditLogTab);
    await Promise.resolve();
    expect(mockApiFetch).not.toHaveBeenCalled();
    await fireEvent.click(button('CSV indir'));
    await fireEvent.click(button('JSON indir'));
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('export HTTP ve non-Error taşıma hatalarını güvenli fallback ile gösterir', async () => {
    mockApiFetch
      .mockResolvedValueOnce(entriesResponse([]))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      }))
      .mockRejectedValueOnce('offline');
    render(AuditLogTab);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce());

    await fireEvent.click(button('CSV indir'));
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain(t('error_server')));
    await fireEvent.click(button('JSON indir'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(3));
    // Response OLMAYAN bir red siniflandirilamaz; yalnizca o zaman cagiranin
    // yedek metni gosterilir.
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('ui_disa_aktarma_basarisiz'));
  });
});
