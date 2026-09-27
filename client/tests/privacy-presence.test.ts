import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { createSettingsStore } from '../js/core/settings/stores/settingsStore.ts';
import PrivacyTab from '../js/core/settings/tabs/PrivacyTab.svelte';

let apiFetch: ReturnType<typeof vi.fn>;
let disconnect: ReturnType<typeof vi.fn>;
let connect: ReturnType<typeof vi.fn>;
let me: Record<string, unknown>;

beforeEach(() => {
  me = { _id: 'u1', dmPrivacy: 'everyone', presenceVisibility: 'visible' };
  apiFetch = vi.fn(async () => new Response(JSON.stringify({ ...me }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));
  disconnect = vi.fn();
  connect = vi.fn();
  BridgeRegistry.register('getMe', (() => me) as unknown as AnyFn);
  BridgeRegistry.register('apiFetch', apiFetch as unknown as AnyFn);
  BridgeRegistry.register('disconnectSocket', disconnect as unknown as AnyFn);
  BridgeRegistry.register('connectSocket', connect as unknown as AnyFn);
});

afterEach(() => {
  cleanup();
  for (const key of ['getMe', 'apiFetch', 'disconnectSocket', 'connectSocket']) BridgeRegistry.unregister(key);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Privacy-first presence controls', () => {
  it('sunucu truth değerleriyle açılır ve desteklenmeyen kontroller dürüstçe kapalıdır', () => {
    const view = render(PrivacyTab, { props: { store: createSettingsStore('privacy') } });
    expect((view.getByLabelText('Kimden DM alabilirim') as HTMLSelectElement).value).toBe('everyone');
    expect(view.getByRole('button', { name: 'Okundu bilgisi henüz değiştirilemiyor' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'Anonim veri tercihi henüz değiştirilemiyor' })).toBeDisabled();
  });

  it('gizli presence ve DM politikası gerçek PATCH ile kaydolur, socket kontrollü yenilenir', async () => {
    const view = render(PrivacyTab, { props: { store: createSettingsStore('privacy') } });
    await fireEvent.change(view.getByLabelText('Kimden DM alabilirim'), { target: { value: 'friends' } });
    await fireEvent.click(view.getByRole('button', { name: 'Çevrimiçi durumu kapat' }));
    await fireEvent.click(view.getByRole('button', { name: 'Kaydet' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
    const [, init] = apiFetch.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      dmPrivacy: 'friends', presenceVisibility: 'hidden',
    });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(me).toMatchObject({ dmPrivacy: 'friends', presenceVisibility: 'hidden' });
  });

  it('sunucu hatasında sahte başarı veya socket restart üretmez', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Rejected' }), { status: 400 }));
    const view = render(PrivacyTab, { props: { store: createSettingsStore('privacy') } });
    await fireEvent.click(view.getByRole('button', { name: 'Çevrimiçi durumu kapat' }));
    await fireEvent.click(view.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain(t('error_bad_request')));
    expect(disconnect).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('hidden/none sunucu truth ile açılır ve yalnız DM değişince socket yenilemez', async () => {
    me = { _id: 'u1', dmPrivacy: 'none', presenceVisibility: 'hidden' };
    const view = render(PrivacyTab, { props: { store: createSettingsStore('privacy') } });

    expect(view.getByLabelText('Kimden DM alabilirim')).toHaveValue('none');
    expect(view.getByRole('button', { name: 'Çevrimiçi durumu aç' })).toHaveAttribute('aria-pressed', 'false');
    expect(view.getByRole('button', { name: 'Kaydet' })).toBeDisabled();

    await fireEvent.change(view.getByLabelText('Kimden DM alabilirim'), { target: { value: 'everyone' } });
    await fireEvent.click(view.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
    expect(disconnect).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(me).toMatchObject({ dmPrivacy: 'everyone', presenceVisibility: 'hidden' });
  });

  it('getMe ve socket sahipleri yokken güvenli varsayımlarla kaydeder', async () => {
    BridgeRegistry.unregister('getMe');
    BridgeRegistry.unregister('disconnectSocket');
    BridgeRegistry.unregister('connectSocket');
    const save = vi.fn(async () => true);
    const view = render(PrivacyTab, { props: { store: { save, error: null } as never } });

    expect(view.getByLabelText('Kimden DM alabilirim')).toHaveValue('everyone');
    await fireEvent.click(view.getByRole('button', { name: 'Çevrimiçi durumu kapat' }));
    await fireEvent.click(view.getByRole('button', { name: 'Kaydet' }));

    await waitFor(() => expect(save).toHaveBeenCalledWith({
      dmPrivacy: 'everyone', presenceVisibility: 'hidden',
    }));
    expect(view.container).toHaveTextContent('Kaydedildi');
  });

  it('store false döndürdüğünde genel hata fallbackini gösterir', async () => {
    const save = vi.fn(async () => false);
    const view = render(PrivacyTab, { props: { store: { save, error: null } as never } });
    await fireEvent.change(view.getByLabelText('Kimden DM alabilirim'), { target: { value: 'friends' } });
    await fireEvent.click(view.getByRole('button', { name: 'Kaydet' }));

    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Kaydedilemedi'));
  });

  it('geçici başarı işaretini iki saniye sonra temizler', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => true);
    const view = render(PrivacyTab, { props: { store: { save, error: null } as never } });
    await fireEvent.change(view.getByLabelText('Kimden DM alabilirim'), { target: { value: 'friends' } });
    await fireEvent.click(view.getByRole('button', { name: 'Kaydet' }));
    await vi.waitFor(() => expect(view.container).toHaveTextContent('Kaydedildi'));

    await vi.advanceTimersByTimeAsync(2000);
    expect(view.container).not.toHaveTextContent('Kaydedildi');
  });
});
