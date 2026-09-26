// client/tests/dm-panel-send-lifecycle.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// DM PANELİ — İYİMSER GÖNDERİM, TESLİM ONAYI VE YENİDEN DENEME
// ════════════════════════════════════════════════════════════════════════════
//
// Bir DM "gönderildi" göründüğü hâlde sunucuya ulaşmamışsa kullanıcı yanıt
// bekler ve mesaj kaybolur. Bu dosya o teslim sözleşmesinin ölçülmemiş
// dallarını kapatır:
//
//   · TESLİM ONAYI GELMEZSE — iyimser satır sonsuza dek "gönderiliyor"
//     kalmamalı, belirli bir süre sonra YENİDEN DENENEBİLİR olmalıdır.
//   · BAĞLANTI KOPARSA — askıdaki her satır aynı nonce ile yeniden
//     denenebilir; sunucunun nonce sözleşmesi kopya satır üretmez.
//   · SUNUCU HATASI — `error:message` yalnız KENDİ gönderimimizin nonce'una
//     uygulanmalı; başka bir olayın hatası satırımızı düşürmemelidir.
//   · TEKRAR TESLİM — aynı `_id` iki kez gelirse satır ÇİFTLENMEZ.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import DmPanel from '../js/core/DmPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { t } from '../js/core/i18n/index.ts';

type Handler = (payload: unknown) => void;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeSocket() {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ event: string; payload: unknown }> = [];
  return {
    sent,
    on(event: string, fn: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
    off(event: string, fn: Handler) { handlers.set(event, (handlers.get(event) ?? []).filter(item => item !== fn)); },
    emit(event: string, payload: unknown) { sent.push({ event, payload }); },
    fire(event: string, payload?: unknown) { for (const fn of [...(handlers.get(event) ?? [])]) fn(payload); },
  };
}

const CONVERSATIONS = [{
  _id: 'row-a', dmId: 'dm-a', unreadCount: 0,
  other: { _id: 'user-a', displayName: 'Ada Lovelace', avatarColor: '#123456' },
}];

const OWNED = [
  'apiFetch', 'socket', 'getMe', 'recordNavigationLocation', 'toast', 'saveForLater',
  'showFriendsPanel', 'startDmCall', 'showDmPanel', 'openDmPanel', 'getDmConversations',
  'openDm', 'closeDmPanel',
];

let socket: ReturnType<typeof makeSocket>;
let apiFetch: ReturnType<typeof vi.fn>;

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) { await tick(); await Promise.resolve(); }
}

async function openConversation(): Promise<void> {
  render(DmPanel);
  await waitFor(() => expect(BridgeRegistry.call<unknown[]>('getDmConversations')).toHaveLength(1));
  BridgeRegistry.call('openDm', 'user-a');
  await waitFor(() => expect(document.querySelector('.dm-composer textarea')).not.toBeNull());
  await flush();
}

async function send(text: string): Promise<string> {
  const box = document.querySelector<HTMLTextAreaElement>('.dm-composer textarea')!;
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await flush(2);
  document.querySelector<HTMLFormElement>('.dm-composer')!.requestSubmit();
  await flush();
  const last = socket.sent.filter(entry => entry.event === 'dm:send').at(-1);
  return String((last?.payload as { clientNonce?: string } | undefined)?.clientNonce ?? '');
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.dm-message')];
const failedText = (): string[] => [...document.querySelectorAll('.dm-failed')].map(n => n.textContent ?? '');
const retryButton = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('.dm-retry');

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  if (!globalThis.CSS) Object.defineProperty(globalThis, 'CSS', { configurable: true, value: {} });
  Object.defineProperty(globalThis.CSS, 'escape', { configurable: true, value: (value: string) => value });

  apiFetch = vi.fn(async (urlValue: unknown) => {
    const url = String(urlValue);
    if (url.endsWith('/api/dm')) return json(CONVERSATIONS);
    if (url.includes('/dm-a/messages')) return json([]);
    return json({});
  });
  socket = makeSocket();
  BridgeRegistry.register('apiFetch', ((...args: unknown[]) => apiFetch(...args)) as AnyFn);
  BridgeRegistry.register('socket', socket as unknown as AnyFn);
  BridgeRegistry.register('getMe', () => ({ id: 'me', displayName: 'Ben', avatarColor: '#00ff00' }));
});

afterEach(() => {
  cleanup();
  for (const key of OWNED) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('iyimser gönderim', () => {
  it('gönderim anında satır "gönderiliyor" olarak çizilir ve nonce ile yollanır', async () => {
    await openConversation();

    const nonce = await send('merhaba');

    expect(nonce).toBeTruthy();
    expect(socket.sent.filter(e => e.event === 'dm:send')).toHaveLength(1);
    expect(socket.sent.at(-1)!.payload).toMatchObject({ toUserId: 'user-a', content: 'merhaba' });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.className).toContain('pending');
    expect(rows()[0]!.textContent).toContain(t('dm_sending', 'Gönderiliyor…'));
    // Askidaki satir kaydedilemez: henuz kanonik bir kimligi yoktur.
    expect(document.querySelector('.dm-save')).toBeNull();
  });

  it('sunucu onayı satırı kalıcı hâle getirir ve kopya üretmez', async () => {
    await openConversation();
    const nonce = await send('merhaba');

    socket.fire('dm:message', {
      _id: 'canonical-1', dmId: 'dm-a', userId: 'me', displayName: 'Ben',
      content: 'merhaba', clientNonce: nonce, createdAt: 1,
    });
    await flush();

    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.className).not.toContain('pending');
    expect(rows()[0]!.dataset.id).toBe('canonical-1');
    expect(document.querySelector('.dm-save')).not.toBeNull();
  });

  it('aynı kanonik satır ikinci kez teslim edilse de çiftlenmez', async () => {
    await openConversation();
    const nonce = await send('merhaba');
    const payload = {
      _id: 'canonical-1', dmId: 'dm-a', userId: 'me', displayName: 'Ben',
      content: 'merhaba', clientNonce: nonce, createdAt: 1,
    };

    socket.fire('dm:message', payload);
    await flush();
    socket.fire('dm:message', payload);
    await flush();

    expect(rows()).toHaveLength(1);
  });

  it('nonce taşımayan yeniden teslim, aynı içerikli askıdaki satırın yerine geçer', async () => {
    await openConversation();
    await send('merhaba');

    socket.fire('dm:message', {
      _id: 'canonical-1', dmId: 'dm-a', userId: 'me', displayName: 'Ben', content: 'merhaba', createdAt: 1,
    });
    await flush();

    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.dataset.id).toBe('canonical-1');
  });

  it('boş taslak ve 2000 karakteri aşan içerik gönderilmez', async () => {
    await openConversation();

    const empty = await send('    ');
    expect(empty).toBe('');

    const box = document.querySelector<HTMLTextAreaElement>('.dm-composer textarea')!;
    box.value = 'x'.repeat(2001);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(2);
    document.querySelector<HTMLFormElement>('.dm-composer')!.requestSubmit();
    await flush();

    expect(socket.sent.filter(e => e.event === 'dm:send')).toHaveLength(0);
    expect(document.querySelector('.bridge-error')?.textContent)
      .toContain('Mesajlar en fazla 2000 karakter olabilir.');
  });
});

describe('teslim onayı alınamadığında', () => {
  it('zaman aşımı satırı yeniden denenebilir yapar', async () => {
    // Konusma GERCEK zamanlayicilarla acilir (`waitFor` onlara dayanir);
    // sahte zamanlayici yalnizca gonderim penceresi icin devreye girer.
    await openConversation();
    vi.useFakeTimers();
    await send('merhaba');
    expect(rows()[0]!.className).toContain('pending');

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();

    expect(rows()[0]!.className).toContain('failed');
    expect(failedText().join(' ')).toContain(t('ui_sunucudan_teslim_onayi_alinamadi_yeniden_deneyin', 'Sunucudan teslim onayı alınamadı. Yeniden deneyin.'));
    expect(retryButton()).not.toBeNull();
  });

  it('bağlantı koparsa askıdaki her satır aynı nonce ile denenebilir kalır', async () => {
    await openConversation();
    const nonce = await send('merhaba');

    socket.fire('disconnect');
    await flush();

    expect(rows()[0]!.className).toContain('failed');
    expect(failedText().join(' ')).toContain(t('delivery_connection_lost', 'Bağlantı kesildi. Mesajın durumunu doğrulamak için yeniden deneyin.'));

    retryButton()!.click();
    await flush();

    const retried = socket.sent.filter(e => e.event === 'dm:send');
    expect(retried).toHaveLength(2);
    // AYNI nonce: sunucu kopya satir uretmez.
    expect((retried[1]!.payload as { clientNonce: string }).clientNonce).toBe(nonce);
    expect(rows()[0]!.className).toContain('pending');
  });

  it('sunucu hata olayı yalnız kendi gönderimimizin nonce\'una uygulanır', async () => {
    await openConversation();
    const nonce = await send('merhaba');

    // Baska bir olayin hatasi ve taninmayan nonce satiri DUSURMEZ.
    socket.fire('error:message', { event: 'message:send', clientNonce: nonce, code: 'RATE_LIMITED' });
    socket.fire('error:message', { event: 'dm:send', clientNonce: 'baska-nonce', code: 'RATE_LIMITED' });
    socket.fire('error:message', { event: 'dm:send' });
    socket.fire('error:message', 'metin');
    socket.fire('error:message', null);
    await flush();
    expect(rows()[0]!.className).toContain('pending');

    socket.fire('error:message', { event: 'dm:send', clientNonce: nonce, code: 'RATE_LIMITED' });
    await flush();

    expect(rows()[0]!.className).toContain('failed');
    expect(failedText().join(' ')).toContain(t('delivery_rate_limit', 'Çok hızlı mesaj gönderiyorsunuz. Biraz sonra yeniden deneyin.'));
  });

  it('olay adı taşımayan hata da kendi nonce\'umuza uygulanır', async () => {
    await openConversation();
    const nonce = await send('merhaba');

    socket.fire('error:message', { clientNonce: nonce, code: 'DM_POLICY_DENIED' });
    await flush();

    expect(failedText().join(' ')).toContain(t('delivery_dm_blocked', 'Bu kullanıcıyla şu anda mesajlaşamazsınız.'));
  });

  it('başarısız satır yeniden denenip onaylanınca kalıcı olur', async () => {
    await openConversation();
    const nonce = await send('merhaba');
    socket.fire('error:message', { event: 'dm:send', clientNonce: nonce, code: 'RATE_LIMITED' });
    await flush();

    retryButton()!.click();
    await flush();
    socket.fire('dm:message', {
      _id: 'canonical-1', dmId: 'dm-a', userId: 'me', displayName: 'Ben',
      content: 'merhaba', clientNonce: nonce, createdAt: 2,
    });
    await flush();

    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.className).not.toContain('failed');
    expect(retryButton()).toBeNull();
  });

  it('başarısız olmayan satır için yeniden deneme çağrısı istek üretmez', async () => {
    await openConversation();
    await send('merhaba');
    const before = socket.sent.length;

    // Askidaki satirda yeniden deneme dugmesi HIC cizilmez.
    expect(retryButton()).toBeNull();
    expect(socket.sent).toHaveLength(before);
  });
});

describe('teslim sonrası okundu ve rozet davranışı', () => {
  it('karşı taraftan gelen mesaj aktif konuşmada okundu bildirir', async () => {
    await openConversation();
    socket.sent.length = 0;

    socket.fire('dm:message', {
      _id: 'in-1', dmId: 'dm-a', userId: 'user-a', displayName: 'Ada', content: 'selam', createdAt: 3,
    });
    await flush();

    expect(socket.sent.filter(e => e.event === 'dm:read')).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  it('kendi mesajımız için okundu bildirimi yollanmaz', async () => {
    await openConversation();
    socket.sent.length = 0;

    socket.fire('dm:message', {
      _id: 'own-1', dmId: 'dm-a', userId: 'me', displayName: 'Ben', content: 'selam', createdAt: 3,
    });
    await flush();

    expect(socket.sent.filter(e => e.event === 'dm:read')).toHaveLength(0);
  });
});
