import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { flushSync } from 'svelte';

const { state, channels, toastMock } = vi.hoisted(() => ({
  state: {
    current: { _id: 's1' } as { _id: string } | null,
    stillCurrent: true,
    apiMock: vi.fn() as ReturnType<typeof vi.fn>,
  },
  channels: [] as Array<{ _id: string; name: string; type?: string }>,
  toastMock: vi.fn(),
}));

vi.mock('../js/core/server-settings/stores/serverSettingsStore', () => ({
  getCurrentServerFromRegistry: () => state.current,
  isStillCurrentServer: () => state.stillCurrent,
}));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => '', currentServerChannels: channels }));
vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: (...args: unknown[]) => state.apiMock(...args) }));
vi.mock('../js/core/utils.js', () => ({ toast: (...args: unknown[]) => toastMock(...args) }));

import WebhookTab from '../js/core/server-settings/tabs/WebhookTab.svelte';
const response = (ok: boolean, body: unknown, status = ok ? 200 : 400) => ({ ok, status, json: async () => body }) as Response;

beforeEach(() => {
  state.current = { _id: 's1' }; state.stillCurrent = true; channels.splice(0, channels.length,
    { _id: 'c1', name: 'genel', type: 'text' }, { _id: 'v1', name: 'ses', type: 'voice' });
  state.apiMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return response(true, { _id: 'w2', token: 'secret-token', name: 'Deploy', channelId: 'c1' });
    if (init?.method === 'DELETE') return response(true, {});
    if (url.includes('/webhooks')) return response(true, [{ _id: 'w1', name: 'GitHub', channelId: 'c1' }]);
    return response(true, []);
  });
  toastMock.mockReset(); document.body.innerHTML = '';
});
afterEach(() => cleanup());

describe('WebhookTab behavior', () => {
  it('loads only text-channel hooks and labels them with channel name', async () => {
    render(WebhookTab);
    await waitFor(() => expect(document.body.textContent).toContain('GitHub'));
    expect(document.body.textContent).toContain('#genel');
    expect(state.apiMock.mock.calls.some(c => String(c[0]).includes('/channels/c1/webhooks'))).toBe(true);
    expect(state.apiMock.mock.calls.some(c => String(c[0]).includes('/channels/v1/webhooks'))).toBe(false);
  });

  it('requires a name and creates through the currently selected tenant channel', async () => {
    render(WebhookTab); await waitFor(() => expect(document.querySelector('select')).not.toBeNull());
    const create = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Oluştur'))!;
    await fireEvent.click(create);
    expect(toastMock).toHaveBeenCalledWith('Kanal ve isim zorunlu', 'error');
    const input = document.querySelector<HTMLInputElement>('input.input-field')!;
    await fireEvent.input(input, { target: { value: ' Deploy ' } });
    await fireEvent.click(create);
    await waitFor(() => expect(state.apiMock.mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const post = state.apiMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(String(post[0])).toContain('/channels/c1/webhooks');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ name: 'Deploy' });
  });

  it('fails closed after server switch and does not mutate the old tenant', async () => {
    render(WebhookTab); await waitFor(() => expect(document.querySelector('input.input-field')).not.toBeNull());
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'Deploy' } });
    state.stillCurrent = false;
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Oluştur'))!);
    expect(state.apiMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/Sunucu değişti/i), 'error');
  });

  it('surfaces safe create/delete failures without reflecting raw server text', async () => {
    state.apiMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response(false, { error: 'blocked' }, 403);
      if (init?.method === 'DELETE') return response(false, {}, 500);
      return response(true, [{ _id: 'w1', name: 'GitHub', channelId: 'c1' }]);
    });
    render(WebhookTab); await waitFor(() => expect(document.body.textContent).toContain('GitHub'));
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'Deploy' } });
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Oluştur'))!);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('yetkin yok'), 'error'));
    expect(toastMock).not.toHaveBeenCalledWith('blocked', 'error');
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Sil')!);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Silinemedi', 'error'));
  });

  it('shows the secret URL only after create and handles clipboard rejection safely', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(WebhookTab);
    await waitFor(() => expect(document.body.textContent).toContain('GitHub'));
    expect(document.querySelector('.webhook-secret')).toBeNull();
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'Deploy' } });
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Oluştur'))!);
    const secret = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.webhook-secret');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(secret.textContent).toContain('/api/webhooks/w2?token=secret-token');
    const copy = [...secret.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('URL Kopyala'))!;
    await fireEvent.click(copy);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Webhook URL kopyalanamadı', 'error'));
  });

  it('shows an honest empty state when list calls fail or return malformed data', async () => {
    state.apiMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response(true, { hooks: [] }))
      .mockResolvedValueOnce(response(false, {}, 503));
    channels.splice(0, channels.length,
      { _id: 'c1', name: 'bir', type: 'text' },
      { _id: 'c2', name: 'iki', type: 'text' },
      { _id: 'c3', name: 'üç', type: 'text' });

    render(WebhookTab);

    await waitFor(() => expect(document.body.textContent).toMatch(/Henüz webhook yok|No webhooks/i));
    expect(state.apiMock).toHaveBeenCalledTimes(3);
  });

  it('requires a text channel even when a name is present', async () => {
    channels.splice(0, channels.length, { _id: 'v1', name: 'ses', type: 'voice' });
    render(WebhookTab);
    await waitFor(() => expect(document.querySelector('input.input-field')).not.toBeNull());
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'Deploy' } });

    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Oluştur'))!);

    expect(toastMock).toHaveBeenCalledWith('Kanal ve isim zorunlu', 'error');
    expect(state.apiMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
  });

  it('fails closed when the captured server is unavailable', async () => {
    state.current = null;
    render(WebhookTab);
    await waitFor(() => expect(document.querySelector('input.input-field')).not.toBeNull());
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'Deploy' } });

    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Oluştur'))!);

    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/Sunucu değişti|server changed/i), 'error');
  });

  it('rejects deletion for a webhook whose channel is outside the current text list', async () => {
    state.apiMock = vi.fn(async () => response(true, [
      { _id: 'w1', name: 'Foreign', channelId: 'foreign' },
    ]));
    render(WebhookTab);
    const remove = await waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Sil');
      expect(button).toBeTruthy();
      return button!;
    });

    await fireEvent.click(remove);

    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/ait değil|does not belong/i), 'error');
    expect(state.apiMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toHaveLength(0);
  });

  it('rejects a malformed webhook without a channel id before deletion', async () => {
    state.apiMock = vi.fn(async () => response(true, [
      { _id: 'w1', name: 'Broken', channelId: '' },
    ]));
    render(WebhookTab);
    const remove = await waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Sil');
      expect(button).toBeTruthy();
      return button!;
    });

    await fireEvent.click(remove);

    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/Kanal seçilmedi|No channel/i), 'error');
    expect(state.apiMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toHaveLength(0);
  });

  it('creates, clears the input, reloads, and supports Enter submission', async () => {
    render(WebhookTab);
    await waitFor(() => expect(document.body.textContent).toContain('GitHub'));
    const input = document.querySelector<HTMLInputElement>('input.input-field')!;
    await fireEvent.input(input, { target: { value: 'Deploy' } });
    await fireEvent.keyDown(input, { key: 'Tab' });
    expect(state.apiMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);

    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(state.apiMock.mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true));
    await waitFor(() => expect(input.value).toBe(''));
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/Webhook.*oluşturuldu|Webhook.*created/i), 'success');
  });

  it('does not pretend a webhook is usable when create omits its one-time token', async () => {
    state.apiMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' ? response(true, { _id: 'w2', name: 'Deploy', channelId: 'c1' }) : response(true, []));
    render(WebhookTab);
    await waitFor(() => expect(document.querySelector('input.input-field')).not.toBeNull());
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'Deploy' } });
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Oluştur'))!);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/gizli URL|secret URL/i), 'error'));
    expect(document.querySelector('.webhook-secret')).toBeNull();
  });

  it('uses bounded fallback messages for create and delete network failures', async () => {
    state.apiMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' || init?.method === 'DELETE') throw new Error('secret detail');
      return response(true, [{ _id: 'w1', name: 'GitHub', channelId: 'c1' }]);
    });
    render(WebhookTab);
    await waitFor(() => expect(document.body.textContent).toContain('GitHub'));
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'Deploy' } });
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Oluştur'))!);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/oluşturulamadı|create failed/i), 'error'));

    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Sil')!);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/silinemedi|delete failed/i), 'error'));
  });

  it('classifies a 400 create response without reading its error body', async () => {
    state.apiMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? response(false, {}, 400) : response(true, []));
    render(WebhookTab);
    await waitFor(() => expect(document.querySelector('input.input-field')).not.toBeNull());
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'Deploy' } });

    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Oluştur'))!);

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('İstek geçersiz'), 'error'));
  });

  it('encodes channel and webhook ids and reloads after successful delete', async () => {
    channels.splice(0, channels.length, { _id: 'c/1', name: 'genel', type: 'text' });
    state.apiMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? response(true, {})
        : response(true, [{ _id: 'w/1', name: 'GitHub', channelId: 'c/1' }]));
    render(WebhookTab);
    const remove = await waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Sil');
      expect(button).toBeTruthy();
      return button!;
    });
    expect(state.apiMock.mock.calls.some(c => String(c[0]).includes('/channels/c%2F1/webhooks'))).toBe(true);

    await fireEvent.click(remove);

    await waitFor(() => expect(state.apiMock.mock.calls.some(c => String(c[0]).endsWith('/webhooks/w%2F1'))).toBe(true));
    expect(toastMock).toHaveBeenCalledWith('Webhook silindi', 'success');
  });

  it('copies the one-time created webhook URL, replaces the timer, and clears the label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(WebhookTab);
    await waitFor(() => expect(document.body.textContent).toContain('GitHub'));
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'Deploy' } });
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Oluştur'))!);
    const secret = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.webhook-secret');
      expect(el).toBeTruthy();
      return el!;
    });
    const copy = [...secret.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('URL Kopyala'))!;

    vi.useFakeTimers();
    await fireEvent.click(copy);
    await Promise.resolve();
    flushSync();
    expect(writeText).toHaveBeenCalledWith('/api/webhooks/w2?token=secret-token');
    expect(copy.textContent).toContain('Kopyalandı');
    await fireEvent.click(copy);
    await Promise.resolve();
    vi.advanceTimersByTime(1800);
    flushSync();
    expect(copy.textContent).toContain('URL Kopyala');
    vi.useRealTimers();
  });

  it('handles an unavailable clipboard implementation for the one-time URL', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    render(WebhookTab);
    await waitFor(() => expect(document.body.textContent).toContain('GitHub'));
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'Deploy' } });
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Oluştur'))!);
    const secret = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.webhook-secret');
      expect(el).toBeTruthy();
      return el!;
    });
    const copy = [...secret.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('URL Kopyala'))!;
    await fireEvent.click(copy);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/kopyalanamadı|could not copy/i), 'error'));
  });

  it('clears an active one-time-URL copy timer when the tab is destroyed', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const view = render(WebhookTab);
    await waitFor(() => expect(document.body.textContent).toContain('GitHub'));
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'Deploy' } });
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Oluştur'))!);
    const secret = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.webhook-secret');
      expect(el).toBeTruthy();
      return el!;
    });
    const copy = [...secret.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('URL Kopyala'))!;
    await fireEvent.click(copy);
    await waitFor(() => expect(copy.textContent).toContain('Kopyalandı'));
    expect(() => view.unmount()).not.toThrow();
  });

  it('falls back to the channel id when a channel has no display name', async () => {
    channels.splice(0, channels.length, { _id: 'c1', type: 'text' } as never);
    render(WebhookTab);

    await waitFor(() => expect(document.body.textContent).toContain('#c1'));
  });
});
