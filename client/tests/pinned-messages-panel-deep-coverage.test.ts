// client/tests/pinned-messages-panel-deep-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PinnedMessagesPanel — SIRALAMA, YETKİ VE İYİMSER OLMAYAN KALDIRMA
// ════════════════════════════════════════════════════════════════════════════
//
// Bu panel kanonik sabitleme yollarını kullanır; İKİNCİ bir sabitleme servisi
// kurmaz. Hiç ölçülmemiş dalların taşıdığı riskler:
//
//   · SAHTE BAŞARI — "sabitlemeyi kaldır" satırı İYİMSER olarak silmez.
//     Sunucu reddederse ya da soket düşerse satırın kaybolması kullanıcıya
//     yalan söylerdi; panel yalnız yetkili `message:pinned` yayınıyla tazelenir.
//   · YETKİ — kaldırma düğmesi yalnız MANAGE_MESSAGES yetkisi olanda görünür;
//     yetki çözümü başarısızsa düğme GÖRÜNMEZ (fail-closed).
//   · BOZUK SATIR — `createdAt` PostgreSQL bigint'i olarak METİN gelebilir;
//     sıralama ve saat biçimlemesi bunu sessizce "Invalid Date"e çevirmemelidir.
//   · SEYREK SATIR — adı/içeriği olmayan kayıtlar `undefined` göstermemelidir.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import PinnedMessagesPanel from '../js/core/PinnedMessagesPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { t } from '../js/core/i18n/index.ts';

vi.mock('../js/core/permissions/myPermissions.ts', () => ({
  canManageMessages: (...args: unknown[]) => canManageMessages(...args),
}));

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const OWNED_KEYS = [
  'apiFetch', 'socket', 'getCurrentChannel', 'getCurrentServer', 'jumpToMessage',
  'openPinnedMessages', 'closePinnedMessages', 'cssColor', 'initials',
];

let apiFetch: ReturnType<typeof vi.fn>;
let socketEmit: ReturnType<typeof vi.fn>;
let jumpToMessage: ReturnType<typeof vi.fn>;
let canManageMessages: ReturnType<typeof vi.fn>;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) { await tick(); await Promise.resolve(); }
}

const pin = (over: Record<string, unknown> = {}) => ({
  _id: 'msg-1', userId: 'u-1', displayName: 'Yazar', avatarColor: '#123456',
  avatarUrl: null, content: 'sabitlenmiş içerik', createdAt: 1_700_000_000_000, ...over,
});

const panel = () => document.querySelector('.pin-panel');
const items = () => [...document.querySelectorAll('.pin-item')];
const stateText = () => document.querySelector('.pin-state-title')?.textContent ?? '';

async function openPanel(): Promise<void> {
  BridgeRegistry.call('openPinnedMessages');
  await waitFor(() => expect(panel()).not.toBeNull());
  await flush();
}

beforeEach(() => {
  apiFetch = vi.fn(async () => response([pin()]));
  socketEmit = vi.fn();
  jumpToMessage = vi.fn();
  canManageMessages = vi.fn(async () => false);
  BridgeRegistry.register('apiFetch', apiFetch as never);
  BridgeRegistry.register('socket', { emit: (...args: unknown[]) => socketEmit(...args) } as never);
  BridgeRegistry.register('getCurrentChannel', (() => ({ _id: 'ch-1', name: 'genel' })) as never);
  BridgeRegistry.register('getCurrentServer', (() => ({ _id: 'srv-1' })) as never);
  BridgeRegistry.register('jumpToMessage', jumpToMessage as never);
});

afterEach(() => {
  cleanup();
  for (const key of OWNED_KEYS) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe('PinnedMessagesPanel — yükleme', () => {
  it('kanal seçili değilken panel açılır ama istek gitmez', async () => {
    BridgeRegistry.register('getCurrentChannel', (() => null) as never);
    render(PinnedMessagesPanel);
    await openPanel();

    expect(apiFetch).not.toHaveBeenCalled();
    expect(stateText()).toBe(t('pinned_empty'));
  });

  it('kanal kimliği METİN değilse istek gitmez', async () => {
    BridgeRegistry.register('getCurrentChannel', (() => ({ _id: 42, name: 5 })) as never);
    render(PinnedMessagesPanel);
    await openPanel();

    expect(apiFetch).not.toHaveBeenCalled();
    expect(document.querySelector('.pin-chan')).toBeNull();
  });

  it('kanal adı başlıkta gösterilir ve kimlik KAÇIRILIR', async () => {
    BridgeRegistry.register('getCurrentChannel', (() => ({ _id: 'ch/slash', name: 'genel' })) as never);
    render(PinnedMessagesPanel);
    await openPanel();

    expect(document.querySelector('.pin-chan')?.textContent).toBe('#genel');
    expect(String(apiFetch.mock.calls[0]![0])).toContain('/api/channels/ch%2Fslash/pinned');
  });

  it('API sahibi yoksa açık hata gösterilir', async () => {
    BridgeRegistry.unregister('apiFetch');
    render(PinnedMessagesPanel);
    await openPanel();

    expect(stateText()).toBe(t('pin_load_error'));
  });

  it('sunucu yanıtı reddedilirse hata gösterilir ve YENİDEN DENENEBİLİR', async () => {
    apiFetch = vi.fn(async () => response({ error: 'GIZLI' }, 403));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PinnedMessagesPanel);
    await openPanel();

    expect(stateText()).toBe(t('pin_load_error'));
    expect(stateText()).not.toContain('GIZLI');

    apiFetch.mockResolvedValue(response([pin()]));
    document.querySelector<HTMLButtonElement>('.pin-retry')!.click();
    await flush();

    expect(items()).toHaveLength(1);
  });

  it('taşıma hatası paneli çökertmez', async () => {
    apiFetch = vi.fn(async () => { throw new Error('offline'); });
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PinnedMessagesPanel);
    await openPanel();

    expect(stateText()).toBe(t('pin_load_error'));
    expect(panel()).not.toBeNull();
  });

  it('kayıtlar `items` sarmalayıcısıyla da gelebilir', async () => {
    apiFetch = vi.fn(async () => response({ items: [pin(), pin({ _id: 'msg-2' })] }));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PinnedMessagesPanel);
    await openPanel();

    expect(items()).toHaveLength(2);
  });

  it('tanınmayan gövde BOŞ listeye indirgenir', async () => {
    apiFetch = vi.fn(async () => response({ rows: [pin()] }));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PinnedMessagesPanel);
    await openPanel();

    expect(items()).toHaveLength(0);
    expect(stateText()).toBe(t('pinned_empty'));
  });

  it('EN YENİ sabitlenen üstte olur; METİN zaman damgası da sıralanır', async () => {
    apiFetch = vi.fn(async () => response([
      pin({ _id: 'eski', createdAt: '1000', content: 'eski' }),
      pin({ _id: 'yeni', createdAt: '3000', content: 'yeni' }),
      pin({ _id: 'orta', createdAt: 2000, content: 'orta' }),
      pin({ _id: 'damgasiz', createdAt: undefined, content: 'damgasız' }),
    ]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PinnedMessagesPanel);
    await openPanel();

    const contents = items().map(node => node.querySelector('.pin-content')?.textContent);
    expect(contents).toEqual(['yeni', 'orta', 'eski', 'damgasız']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PinnedMessagesPanel — satır sunumu', () => {
  it('adı/içeriği olmayan kayıt "undefined" göstermez', async () => {
    apiFetch = vi.fn(async () => response([{ _id: 'msg-1' }]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PinnedMessagesPanel);
    await openPanel();

    expect(items()[0]!.querySelector('.pin-author')?.textContent).toBe(t('unknown_user'));
    expect(items()[0]!.querySelector('.pin-content')?.textContent).toBe('');
    expect(items()[0]!.querySelector('.pin-time')?.textContent).toBe('');
    expect(document.body.textContent).not.toContain('undefined');
  });

  it.each([
    ['boş dize', ''],
    ['null', null],
    ['sayı olmayan metin', 'yarın'],
  ])('geçersiz zaman damgası (%s) BOŞ gösterilir', async (_label, createdAt) => {
    apiFetch = vi.fn(async () => response([pin({ createdAt })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PinnedMessagesPanel);
    await openPanel();

    expect(items()[0]!.querySelector('.pin-time')?.textContent).toBe('');
  });

  it('geçerli zaman damgası biçimlenir', async () => {
    render(PinnedMessagesPanel);
    await openPanel();

    expect(items()[0]!.querySelector('.pin-time')?.textContent).not.toBe('');
  });

  it('avatar görseli varsa baş harf yerine GÖRSEL gösterilir', async () => {
    apiFetch = vi.fn(async () => response([pin({ avatarUrl: 'https://cdn.test/a.png' })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PinnedMessagesPanel);
    await openPanel();

    expect(items()[0]!.querySelector('.pin-avatar img')).not.toBeNull();
  });

  it('baş harf ve renk için KAYITLI yardımcılar tercih edilir', async () => {
    const cssColor = vi.fn((c: string) => '#00ff00');
    BridgeRegistry.register('cssColor', cssColor as never);
    BridgeRegistry.register('initials', ((n: string) => `BH:${n}`) as never);
    render(PinnedMessagesPanel);
    await openPanel();

    const avatar = items()[0]!.querySelector('.pin-avatar')!;
    expect(cssColor).toHaveBeenCalledWith('#123456');
    expect(avatar.getAttribute('style')).toContain('rgb(0, 255, 0)');
    expect(avatar.textContent?.trim()).toBe('BH:Yazar');
  });

  it('yardımcılar YOKSA güvenli yedekler kullanılır', async () => {
    apiFetch = vi.fn(async () => response([pin({ avatarColor: undefined, displayName: 'ahmet' })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PinnedMessagesPanel);
    await openPanel();

    const avatar = items()[0]!.querySelector('.pin-avatar')!;
    expect(avatar.getAttribute('style')).toContain('var(--brand');
    expect(avatar.textContent?.trim()).toBe('AH');
  });

  it('adsız kayıtta baş harf yedeği soru işaretidir', async () => {
    apiFetch = vi.fn(async () => response([pin({ displayName: '   ' })]));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(PinnedMessagesPanel);
    await openPanel();

    expect(items()[0]!.querySelector('.pin-avatar')?.textContent?.trim()).toBe('?');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PinnedMessagesPanel — yetki ve eylemler', () => {
  it('yetki YOKKEN kaldırma düğmesi görünmez', async () => {
    render(PinnedMessagesPanel);
    await openPanel();

    expect(document.querySelector('.pin-unpin')).toBeNull();
  });

  it('yetki VARKEN kaldırma düğmesi görünür', async () => {
    canManageMessages = vi.fn(async () => true);
    render(PinnedMessagesPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelector('.pin-unpin')).not.toBeNull());
  });

  it('sunucu seçili değilse yetki SORULMAZ', async () => {
    BridgeRegistry.register('getCurrentServer', (() => null) as never);
    render(PinnedMessagesPanel);
    await openPanel();

    expect(canManageMessages).not.toHaveBeenCalled();
    expect(document.querySelector('.pin-unpin')).toBeNull();
  });

  it('kaldırma İYİMSER değildir: satır DURUR, kanonik olay bekler', async () => {
    canManageMessages = vi.fn(async () => true);
    render(PinnedMessagesPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelector('.pin-unpin')).not.toBeNull());

    document.querySelector<HTMLButtonElement>('.pin-unpin')!.click();
    await flush();

    expect(socketEmit).toHaveBeenCalledWith('message:pin', {
      messageId: 'msg-1', channelId: 'ch-1', serverId: 'srv-1', pinned: false,
    });
    expect(items()).toHaveLength(1);
  });

  it('soket YOKKEN kaldırma çökme üretmez', async () => {
    canManageMessages = vi.fn(async () => true);
    BridgeRegistry.unregister('socket');
    render(PinnedMessagesPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelector('.pin-unpin')).not.toBeNull());

    expect(() => document.querySelector<HTMLButtonElement>('.pin-unpin')!.click()).not.toThrow();
  });

  it('MESAJA GİT paneli kapatır ve kanonik atlama sahibini çağırır', async () => {
    render(PinnedMessagesPanel);
    await openPanel();

    document.querySelector<HTMLButtonElement>('.pin-jump')!.click();
    await flush();

    expect(jumpToMessage).toHaveBeenCalledWith('msg-1');
    expect(panel()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PinnedMessagesPanel — kapanış ve gerçek zamanlı', () => {
  it('Escape kapatır ve odağı GERİ VERİR', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    render(PinnedMessagesPanel);
    await openPanel();

    await fireEvent.keyDown(panel()!, { key: 'Escape' });
    await flush();

    expect(panel()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('arka plana tıklamak kapatır', async () => {
    render(PinnedMessagesPanel);
    await openPanel();

    document.querySelector<HTMLElement>('.pin-overlay')!.click();
    await flush();

    expect(panel()).toBeNull();
  });

  it('kapatma düğmesi de kapatır ve liste TEMİZLENİR', async () => {
    render(PinnedMessagesPanel);
    await openPanel();

    document.querySelector<HTMLButtonElement>('.pin-close')!.click();
    await flush();

    expect(panel()).toBeNull();
    expect(items()).toHaveLength(0);
  });

  it('kapalı panel yeniden KAPATILAMAZ (yinelenen çağrı zararsızdır)', async () => {
    render(PinnedMessagesPanel);
    await openPanel();
    BridgeRegistry.call('closePinnedMessages');
    await flush();

    expect(() => BridgeRegistry.call('closePinnedMessages')).not.toThrow();
    expect(panel()).toBeNull();
  });

  it('SABİTLEME DEĞİŞTİ olayı açık paneli tazeler', async () => {
    render(PinnedMessagesPanel);
    await openPanel();
    apiFetch.mockClear();

    document.dispatchEvent(new Event('bridge:pin-changed'));
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('panel KAPALIYKEN olay istek üretmez', async () => {
    render(PinnedMessagesPanel);
    await openPanel();
    BridgeRegistry.call('closePinnedMessages');
    await flush();
    apiFetch.mockClear();

    document.dispatchEvent(new Event('bridge:pin-changed'));
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('unmount kayıtları ve dinleyiciyi söker', async () => {
    const view = render(PinnedMessagesPanel);
    await openPanel();

    view.unmount();
    await flush();

    expect(BridgeRegistry.has('openPinnedMessages')).toBe(false);
    expect(BridgeRegistry.has('closePinnedMessages')).toBe(false);

    apiFetch.mockClear();
    document.dispatchEvent(new Event('bridge:pin-changed'));
    await flush();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
