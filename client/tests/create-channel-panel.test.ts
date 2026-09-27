// client/tests/create-channel-panel.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// ════════════════════════════════════════════════════════════════════════════
// CreateChannelPanel.svelte — OLUŞTURMA SÖZLEŞMESİ VE HATA DÜRÜSTLÜĞÜ
// ════════════════════════════════════════════════════════════════════════════
// Bu panel bir YAZMA yüzeyidir: sunucuda kalıcı bir kanal yaratır. Üç şeyin
// aynı anda doğru olması gerekir:
//
//   1. Kullanıcı sonucu ÖNCEDEN görür. Ad, sunucudakiyle AYNI kurala göre
//      slug'lanır; önizleme ile gerçek sonuç ayrışırsa kullanıcı beklemediği
//      adla bir kanal yaratır.
//   2. Yetki reddi (403) ve doğrulama reddi (400) AYRI mesajlar üretir;
//      ikisini "bir hata oldu" diye birleştirmek kullanıcıyı çıkmaza sokar.
//   3. Başarı yolunda liste ve seçim KANONİK sahiplere delege edilir; panel
//      kendi kanal listesini TUTMAZ (ikinci bir doğruluk kaynağı olurdu).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import CreateChannelPanel from '../js/core/CreateChannelPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const KEYS = ['apiFetch', 'currentServer', 'loadChannels', 'selectChannel', 'openCreateChannel', 'closeCreateChannel'];

function response(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const apiFetch = vi.fn();
const loadChannels = vi.fn();
const selectChannel = vi.fn();
let server: { _id?: string; name?: string } | null = { _id: 's1', name: 'Takım' };

const card = () => document.querySelector('.cc-card');
const nameInput = () => document.querySelector('.cc-name') as HTMLInputElement;
const submitButton = () => document.querySelector('.cc-go') as HTMLButtonElement;
const hint = () => document.querySelector('#cc-hint')?.textContent?.trim() ?? '';
const errorText = () => document.querySelector('.cc-error')?.textContent?.trim() ?? '';

function open(): void {
  render(CreateChannelPanel);
  BridgeRegistry.call('openCreateChannel');
  flushSync();
}

async function type(value: string): Promise<void> {
  await fireEvent.input(nameInput(), { target: { value } });
  flushSync();
}

beforeEach(() => {
  document.body.innerHTML = '';
  for (const key of KEYS) BridgeRegistry.unregister(key);
  apiFetch.mockReset();
  loadChannels.mockReset();
  selectChannel.mockReset();
  server = { _id: 's1', name: 'Takım' };
  BridgeRegistry.register('apiFetch', apiFetch as never);
  BridgeRegistry.register('currentServer', (() => server) as never);
});

afterEach(() => {
  cleanup();
  for (const key of KEYS) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('name preview matches the server naming rule', () => {
  it('slugs the typed name and shows the exact channel that will be created', async () => {
    open();
    expect(hint()).toContain('Küçük harf');

    await type('Genel Sohbet!');
    expect(hint()).toContain('#genel-sohbet-');

    await type('  ');
    // Boş slug önizlemeyi geri alır ve gönderimi kilitler.
    expect(hint()).toContain('Küçük harf');
    expect(submitButton().disabled).toBe(true);
  });

  it('truncates an over-long name to the same length the server enforces', async () => {
    open();
    await type('a'.repeat(80));
    const preview = hint().replace(/^.*#/, '');
    expect(preview.length).toBe(32);
  });

  it('refuses to submit an empty name without issuing a request', async () => {
    open();
    await fireEvent.submit(document.querySelector('.cc-form')!);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('creation failures are reported distinctly', () => {
  it('names the missing server rather than failing silently', async () => {
    server = null;
    open();
    await type('genel');
    await fireEvent.click(submitButton());
    await waitFor(() => expect(errorText()).toContain('sunucu seçin'));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('distinguishes a permission refusal from a validation refusal', async () => {
    open();
    await type('genel');

    apiFetch.mockResolvedValueOnce(response(403));
    await fireEvent.click(submitButton());
    await waitFor(() => expect(errorText()).toContain('yetkiniz yok'));

    apiFetch.mockResolvedValueOnce(response(400, { error: 'Bu ad zaten kullanılıyor.' }));
    await fireEvent.click(submitButton());
    await waitFor(() => expect(errorText()).toBe(t('error_bad_request')));

    apiFetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => { throw new Error('bad json'); } } as Response);
    await fireEvent.click(submitButton());
    // Govde okunamasa bile DURUM KODU siniflandirilir: kanonik 400 metni.
    await waitFor(() => expect(errorText()).toBe(t('error_bad_request')));
  });

  it('reports an unexpected status and a transport rejection with a retryable message', async () => {
    open();
    await type('genel');

    // 503 bir Response'tur: durum koduna gore kanonik sunucu metnine eslenir.
    apiFetch.mockResolvedValueOnce(response(503));
    await fireEvent.click(submitButton());
    await waitFor(() => expect(errorText()).toBe(t('error_server')));

    // Tasima reddi (Response degil) `catch` dalinda ele alinir ve panelin
    // kendi "tekrar deneyin" metni gosterilir.
    apiFetch.mockRejectedValueOnce(new Error('offline'));
    await fireEvent.click(submitButton());
    await waitFor(() => expect(errorText()).toBe(t('ui_kanal_olusturulamadi_lutfen_tekrar_deneyin')));
  });

  it('reports the absence of an API client instead of throwing into the void', async () => {
    BridgeRegistry.unregister('apiFetch');
    open();
    await type('genel');
    await fireEvent.click(submitButton());
    await waitFor(() => expect(errorText()).toContain('Kanal oluşturulamadı'));
  });

  it('keeps the panel open and the typed name intact after a failure', async () => {
    open();
    await type('genel');
    apiFetch.mockResolvedValueOnce(response(403));
    await fireEvent.click(submitButton());
    await waitFor(() => expect(errorText()).not.toBe(''));
    expect(card()).not.toBeNull();
    expect(nameInput().value).toBe('genel');
  });
});

describe('successful creation delegates to the canonical owners', () => {
  it('refreshes the channel list, selects the new channel and closes', async () => {
    BridgeRegistry.register('loadChannels', loadChannels as never);
    BridgeRegistry.register('selectChannel', selectChannel as never);
    open();
    await type('Yeni Kanal');

    apiFetch.mockResolvedValueOnce(response(200, { _id: 'c9', name: 'yeni-kanal' }));
    await fireEvent.click(submitButton());
    await waitFor(() => expect(card()).toBeNull());

    const [url, init] = apiFetch.mock.calls[0]!;
    expect(String(url)).toContain('/api/servers/s1/channels');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'yeni-kanal', type: 'text' });
    expect(loadChannels).toHaveBeenCalledWith('s1');
    expect(selectChannel).toHaveBeenCalledWith({ _id: 'c9', name: 'yeni-kanal' });
  });

  it('creates a voice channel when the voice type is chosen', async () => {
    open();
    const voice = [...document.querySelectorAll<HTMLInputElement>('input[name="cc-type"]')]
      .find(input => input.value === 'voice')!;
    await fireEvent.change(voice);
    await type('lounge');

    apiFetch.mockResolvedValueOnce(response(200, { _id: 'c10' }));
    await fireEvent.click(submitButton());
    await waitFor(() => expect(card()).toBeNull());
    expect(JSON.parse(String(apiFetch.mock.calls[0]![1].body)).type).toBe('voice');
  });

  // Final21 Phase 16: forum, announcement and stage were implemented and rendered, but the
  // dialog only offered text and voice, so a normal user could never create them. Measured
  // in a real browser before exposing them (p16-channel-types-probe 7/7).
  it('offers every channel type the product renders, in a stable order', () => {
    open();
    const values = [...document.querySelectorAll<HTMLInputElement>('input[name="cc-type"]')].map(input => input.value);
    expect(values).toEqual(['text', 'voice', 'announcement', 'forum', 'stage']);
  });

  it.each(['announcement', 'forum', 'stage'])('creates a %s channel when that type is chosen', async (kind) => {
    open();
    const option = [...document.querySelectorAll<HTMLInputElement>('input[name="cc-type"]')]
      .find(input => input.value === kind)!;
    await fireEvent.change(option);
    await type(`new-${kind}`);

    apiFetch.mockResolvedValueOnce(response(200, { _id: `c-${kind}` }));
    await fireEvent.click(submitButton());
    await waitFor(() => expect(card()).toBeNull());
    expect(JSON.parse(String(apiFetch.mock.calls[0]![1].body))).toEqual({ name: `new-${kind}`, type: kind });
  });

  it('succeeds even when no list or selection owner is registered', async () => {
    open();
    await type('genel');
    apiFetch.mockResolvedValueOnce(response(200, {}));
    await fireEvent.click(submitButton());
    await waitFor(() => expect(card()).toBeNull());
    expect(loadChannels).not.toHaveBeenCalled();
    expect(selectChannel).not.toHaveBeenCalled();
  });

  it('resets to the text type and an empty name on the next open', async () => {
    open();
    const voice = [...document.querySelectorAll<HTMLInputElement>('input[name="cc-type"]')]
      .find(input => input.value === 'voice')!;
    await fireEvent.change(voice);
    await type('lounge');
    BridgeRegistry.call('closeCreateChannel');
    flushSync();

    BridgeRegistry.call('openCreateChannel');
    flushSync();
    expect(nameInput().value).toBe('');
    expect((document.querySelector('input[name="cc-type"][value="text"]') as HTMLInputElement).checked).toBe(true);
  });
});

describe('dismissal surfaces', () => {
  it('closes on Escape, on the backdrop and on the explicit controls', async () => {
    open();
    await fireEvent.keyDown(window, { key: 'Escape' });
    flushSync();
    expect(card()).toBeNull();

    BridgeRegistry.call('openCreateChannel'); flushSync();
    (document.querySelector('.cc-card') as HTMLElement).click();
    flushSync();
    expect(card()).not.toBeNull();

    (document.querySelector('.cc-overlay') as HTMLElement).click();
    flushSync();
    expect(card()).toBeNull();

    BridgeRegistry.call('openCreateChannel'); flushSync();
    (document.querySelector('.cc-x') as HTMLButtonElement).click();
    flushSync();
    expect(card()).toBeNull();

    BridgeRegistry.call('openCreateChannel'); flushSync();
    (document.querySelector('.cc-ghost') as HTMLButtonElement).click();
    flushSync();
    expect(card()).toBeNull();
  });

  it('ignores Escape while the panel is not open', async () => {
    render(CreateChannelPanel);
    flushSync();
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
